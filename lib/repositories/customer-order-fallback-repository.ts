import "server-only";

import type {
  EligibleCustomerOrder,
  FallbackCustomerOrder,
} from "@/lib/domain/customer-order-fallback";

/**
 * Layer 2: the same buyer's orders on the SAME storefront, without the listing.
 *
 * STRICTLY READ-ONLY. One SELECT against the source pool, which the caller pins
 * `default_transaction_read_only=on` for. No snapshot, no cache, no write.
 *
 * ------------------------------------------------------------------------
 * THIS IS NOT THE MATCHER, AND CANNOT WEAKEN IT
 * ------------------------------------------------------------------------
 * `FIND_CANDIDATE_ORDERS` still decides which order a conversation is about,
 * from buyer + storefront + item. Nothing here touches it, and the caller runs
 * this ONLY where that matcher established nothing — see
 * `resolveFallbackCustomerOrder`. A conversation with a verified or ambiguous
 * match never reaches this query.
 *
 * THE BUYER AND STOREFRONT PREDICATES ARE THE MATCHER'S OWN, UNCHANGED.
 * `ci.ebay_buyer_id = $4` is the same exact equality — nothing lower-cased,
 * trimmed or fuzzy-matched — and `o.sub_source_id = $2` is the same storefront
 * pin. Exactly ONE predicate is dropped, the item, and dropping it is the whole
 * definition of layer 2.
 *
 * ------------------------------------------------------------------------
 * NO `ORDER BY`, AND THAT IS THE POINT
 * ------------------------------------------------------------------------
 * A ranking clause is what would let two orders become one answer, and there is
 * deliberately nothing here to rank with. `LIMIT 2` reads only as far as the one
 * question being asked — is there exactly one? — and the caller returns nothing
 * at all for any other count. A second row is not a runner-up; it is a refusal.
 *
 * `listing_match` is derived rather than assumed. Layer 2 runs only after layer
 * 1 found nothing, so no order here can carry the conversation's listing; asking
 * anyway costs one cheap EXISTS and means the flag would tell the truth if the
 * two layers ever disagreed.
 *
 * THE BUYER IS AN `EXISTS`, NOT A JOIN, so one order is one row by construction.
 * A join to `customers.customer_info` multiplies the order by its identity rows,
 * and the usual fix — `DISTINCT ON (o.id)` — would be silently choosing which
 * duplicate survives. That matters more here than anywhere: a fanned-out single
 * order would look like two, and two means this refuses to answer.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * Every order this buyer has on this storefront — the list a reviewer chooses
 * from when the strict matcher found nothing.
 *
 * SAME PREDICATES AS LAYER 2, WITHOUT THE REFUSAL. `findSoleSameStorefrontOrder`
 * stops at two rows because it must not pick; this one returns them all because
 * a PERSON picks. The buyer and storefront predicates are identical and equally
 * exact — the difference is who decides, not what is eligible.
 *
 * NEWEST FIRST, FOR READING ONLY. The sort puts the likeliest candidate where a
 * reviewer looks first and carries no other meaning: nothing downstream reads
 * position, the first row is not preselected, and a selection is validated by
 * membership of this set rather than by rank within it. The 18-month
 * measurement is why that matters — 46% of same-storefront orders in the
 * listing-mismatch class POST-DATE the message, so "newest" is frequently not
 * the answer and must never be treated as one.
 *
 * ONE ROW PER ORDER. `DISTINCT ON (o.id)` collapses the shipment join, taking
 * the most recent shipment exactly as the strict matcher does. The product
 * columns come from the `lines` LATERAL and are NULL unless the order has a
 * single line, so a multi-line order is listed and selectable but never shows
 * an arbitrarily-chosen product.
 */
const LIST_ELIGIBLE_ORDERS = `
SELECT * FROM (
  SELECT DISTINCT ON (o.id)
    o.id::text                    AS order_row_id,
    o.order_id                    AS order_number,
    o.order_date::text            AS order_date,
    o.order_date                  AS sort_date,
    o.status                      AS order_status,
    o.sub_source_id               AS storefront_id,
    ss.name                       AS storefront_name,
    lines.line_count              AS order_line_count,
    lines.item_ref                AS order_item_ref,
    lines.sku                     AS order_sku,
    lines.product_title           AS order_product_title,
    sh.tracking_number            AS tracking_number,
    sh.status                     AS shipment_status,
    sh.shipment_created_at::text  AS shipment_created_at,
    sh.cancelled_at::text         AS shipment_cancelled_at,
    cs.name                       AS carrier_service,
    cs.carrier                    AS carrier,
    oi.shipped_time::text         AS shipped_time,
    sa.address_line_1             AS address_line_1,
    sa.address_line_2             AS address_line_2,
    sa.address_line_3             AS address_line_3,
    sa.city                       AS city,
    sa.region                     AS region,
    sa.postcode                   AS postcode,
    EXISTS (
      SELECT 1
      FROM order_management.order_item_info oii2
      WHERE oii2.order_id = o.id
        AND oii2.item_id = $5
    )                             AS listing_match
  FROM order_management.orders o
  JOIN order_management.sub_source ss ON ss.id = o.sub_source_id
  LEFT JOIN customers.shipping_address sa ON sa.order_id = o.id
  LEFT JOIN order_management.shipment sh ON sh.order_id = o.id
  LEFT JOIN order_management.carrier_service cs ON cs.id = sh.carrier_service_id
  LEFT JOIN order_management.order_info oi ON oi.order_id = o.id
  LEFT JOIN LATERAL (
    SELECT count(*)                                                AS line_count,
           CASE WHEN count(*) = 1 THEN min(oii.item_id) END        AS item_ref,
           CASE WHEN count(*) = 1
                THEN min(coalesce(oii.real_sku, oii.item_sku)) END AS sku,
           CASE WHEN count(*) = 1 THEN min(oii.item_title) END     AS product_title
    FROM order_management.order_item_info oii
    WHERE oii.order_id = o.id
  ) lines ON true
  WHERE ss.source_id = $1::int
    AND o.sub_source_id = $2::int
    AND EXISTS (
      SELECT 1
      FROM customers.customer_info ci
      WHERE ci.order_id = o.id
        AND ci.ebay_buyer_id = $3
    )
  ORDER BY o.id, sh.shipment_created_at DESC NULLS LAST
) ordered
ORDER BY ordered.sort_date DESC NULLS LAST, ordered.order_row_id DESC
LIMIT $4::int`;

type EligibleOrderRow = {
  order_row_id: string;
  order_number: string | null;
  order_date: string | null;
  order_status: string | null;
  storefront_id: number | null;
  storefront_name: string | null;
  order_line_count?: string | number | null;
  order_item_ref?: string | null;
  order_sku?: string | null;
  order_product_title?: string | null;
  tracking_number?: string | null;
  shipment_status?: string | null;
  shipment_created_at?: string | null;
  shipment_cancelled_at?: string | null;
  carrier_service?: string | null;
  carrier?: string | null;
  shipped_time?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  address_line_3?: string | null;
  city?: string | null;
  region?: string | null;
  postcode?: string | null;
  listing_match?: boolean | null;
};

/** How many orders a reviewer is offered. Display only; not a relevance cut. */
export const MAX_ELIGIBLE_ORDERS = 25;

/** eBay, on `sub_source.source_id` — a platform check, never a region guess. */
const EBAY_SOURCE_ID = 2;

/**
 * Two rows is all that is ever needed: one to answer with, or two to refuse on.
 * Reading more would be gathering candidates for a ranking that must not exist.
 */
const REFUSAL_THRESHOLD = 2;

/**
 * THE ORDERED PRODUCT IS RESOLVED BY THE DATABASE, OR NOT AT ALL.
 *
 * `lines` reads the order's own line items once. The three `CASE WHEN
 * line_count = 1` expressions are what make the ambiguity un-guessable: on a
 * multi-line order the database itself returns NULL for the item reference, the
 * SKU and the title, so no code further up can pick a line even by accident.
 * `line_count` still comes back, because "several products, none identified" is
 * a finding worth stating rather than an absence to hide.
 *
 * `min()` is safe here ONLY because these columns are read exclusively when
 * `line_count = 1`, where the minimum over one row is that row.
 *
 * `coalesce(real_sku, item_sku)` is the precedence the strict matcher already
 * applies — the corrected SKU where one was recorded. The value is returned
 * verbatim: no trim, no split, no normalisation anywhere on this path.
 */
const FIND_SAME_STOREFRONT_ORDERS = `
SELECT o.order_id          AS order_number,
       o.order_date::text  AS order_date,
       o.status            AS order_status,
       o.sub_source_id     AS storefront_id,
       ss.name             AS storefront_name,
       EXISTS (
         SELECT 1
         FROM order_management.order_item_info oii
         WHERE oii.order_id = o.id
           AND oii.item_id = $3
       )                   AS listing_match,
       lines.line_count    AS order_line_count,
       lines.item_ref      AS order_item_ref,
       lines.sku           AS order_sku,
       lines.product_title AS order_product_title
FROM order_management.orders o
JOIN order_management.sub_source ss ON ss.id = o.sub_source_id
LEFT JOIN LATERAL (
  SELECT count(*)                                                    AS line_count,
         CASE WHEN count(*) = 1 THEN min(oii.item_id) END            AS item_ref,
         CASE WHEN count(*) = 1
              THEN min(coalesce(oii.real_sku, oii.item_sku)) END     AS sku,
         CASE WHEN count(*) = 1 THEN min(oii.item_title) END         AS product_title
  FROM order_management.order_item_info oii
  WHERE oii.order_id = o.id
) lines ON true
WHERE ss.source_id = $1::int
  AND o.sub_source_id = $2::int
  AND EXISTS (
    SELECT 1
    FROM customers.customer_info ci
    WHERE ci.order_id = o.id
      AND ci.ebay_buyer_id = $4
  )
LIMIT ${REFUSAL_THRESHOLD}`;

type FallbackOrderRow = {
  order_number: string | null;
  order_date: string | null;
  order_status: string | null;
  storefront_id: number | null;
  storefront_name: string | null;
  listing_match: boolean | null;
  order_line_count?: string | number | null;
  order_item_ref?: string | null;
  order_sku?: string | null;
  order_product_title?: string | null;
};

/**
 * Blank is an absence; anything else is returned BYTE-FOR-BYTE.
 *
 * `.trim()` is used to TEST for emptiness and never to produce the result — a
 * SKU passes through this function and must come out exactly as the source
 * stored it, leading and trailing characters included. See `lib/domain/sku.ts`.
 */
function blankToNull(value: string | null | undefined): string | null {
  // `undefined` as well as null: a row read through a projection that does not
  // select one of these columns arrives without the key at all, and crashing on
  // a missing optional field would take the whole request down over an absence.
  return value == null || value.trim() === "" ? null : value;
}

/**
 * The ONE order this buyer has on this storefront, or null.
 *
 * Null for every count that is not exactly one — none, and more than one — and
 * null for a single row whose order number or storefront the source did not
 * record, because an order a reviewer cannot identify is not an answer either.
 */
export async function findSoleSameStorefrontOrder(
  client: Queryable,
  options: {
    readonly buyerUsername: string;
    readonly subSourceId: number;
    readonly currentListingItemRef: string | null;
  },
): Promise<FallbackCustomerOrder | null> {
  const { rows } = await client.query({
    text: FIND_SAME_STOREFRONT_ORDERS,
    values: [
      EBAY_SOURCE_ID,
      options.subSourceId,
      options.currentListingItemRef,
      options.buyerUsername,
    ],
  });

  // Not "take the first of many" — anything but exactly one is a refusal.
  if (rows.length !== 1) return null;

  const row = rows[0] as FallbackOrderRow;
  const orderNumber = blankToNull(row.order_number);
  if (orderNumber === null || row.storefront_id === null) return null;

  return {
    orderNumber,
    orderDate: blankToNull(row.order_date),
    orderStatus: blankToNull(row.order_status),
    storefrontId: Number(row.storefront_id),
    storefrontName: blankToNull(row.storefront_name),
    listingMatch: row.listing_match === true,
    orderLineCount: Number(row.order_line_count ?? 0),
    // Already NULL from the database on a multi-line order — see the query.
    orderItemRef: blankToNull(row.order_item_ref),
    orderSku: blankToNull(row.order_sku),
    orderProductTitle: blankToNull(row.order_product_title),
  };
}

/** The address lines the source recorded, joined into the one approved fact. */
function formatAddress(row: EligibleOrderRow): string | null {
  const parts = [
    row.address_line_1,
    row.address_line_2,
    row.address_line_3,
    row.city,
    row.region,
    row.postcode,
  ].filter((part): part is string => typeof part === "string" && part.trim() !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * Every order this buyer has on this storefront, newest first.
 *
 * FOR A PERSON TO CHOOSE FROM, and for the server to validate a choice against
 * — the same set answers both questions, so a selection can only ever name an
 * order the reviewer was actually offered. An order dropped here for want of an
 * identifiable number is therefore also unselectable, which is the correct
 * pairing.
 */
export async function listEligibleCustomerOrders(
  client: Queryable,
  options: {
    readonly buyerUsername: string;
    readonly subSourceId: number;
    readonly currentListingItemRef: string | null;
    readonly limit?: number;
  },
): Promise<EligibleCustomerOrder[]> {
  const { rows } = await client.query({
    text: LIST_ELIGIBLE_ORDERS,
    values: [
      EBAY_SOURCE_ID,
      options.subSourceId,
      options.buyerUsername,
      options.limit ?? MAX_ELIGIBLE_ORDERS,
      options.currentListingItemRef,
    ],
  });

  const orders: EligibleCustomerOrder[] = [];
  for (const row of rows as EligibleOrderRow[]) {
    const orderNumber = blankToNull(row.order_number);
    if (orderNumber === null || row.storefront_id == null) continue;
    orders.push({
      // Already selected by the query as `o.id::text`; now carried through, so
      // a validated selection can be keyed on the row id rather than the
      // non-unique order number. See `EligibleCustomerOrder.orderRowId`.
      orderRowId: row.order_row_id,
      orderNumber,
      orderDate: blankToNull(row.order_date),
      orderStatus: blankToNull(row.order_status),
      storefrontId: Number(row.storefront_id),
      storefrontName: blankToNull(row.storefront_name),
      orderLineCount: Number(row.order_line_count ?? 0),
      // Already NULL from the database on a multi-line order — see the query.
      orderItemRef: blankToNull(row.order_item_ref),
      orderSku: blankToNull(row.order_sku),
      orderProductTitle: blankToNull(row.order_product_title),
      trackingNumber: blankToNull(row.tracking_number),
      shipmentStatus: blankToNull(row.shipment_status),
      shipmentCreatedAt: blankToNull(row.shipment_created_at),
      shipmentCancelledAt: blankToNull(row.shipment_cancelled_at),
      carrier: blankToNull(row.carrier),
      carrierService: blankToNull(row.carrier_service),
      shippedAt: blankToNull(row.shipped_time),
      deliveryAddress: formatAddress(row),
      listingMatch: row.listing_match === true,
    });
  }
  return orders;
}
