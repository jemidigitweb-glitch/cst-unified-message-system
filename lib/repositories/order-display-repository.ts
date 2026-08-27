import "server-only";

/**
 * Read-only eBay order lookup for DISPLAY, beside the grounding lookup rather
 * than instead of it.
 *
 * WHY THIS IS A SECOND FILE. `order-context-repository.ts` feeds the AI: what
 * it selects is what a draft may state, so every column on it is a liability
 * and it is deliberately narrow. The sidebar has the opposite problem — a
 * reviewer opening a conversation wants the order in front of them, and a
 * blank "Customer name" beside a real order number is a worse answer than the
 * name the source has recorded all along. Widening the grounding query to fill
 * the sidebar would have put a customer name, a seller identity and an order
 * total one refactor away from the prompt. Two queries, two purposes, and the
 * grounding one is untouched.
 *
 * SAME JOIN, VERIFIED THE SAME WAY. The FROM/WHERE below is character-for-
 * character the grounding query's: item_id + buyer username, scoped to one
 * eBay sub-account by `sub_source_id`, with eBay identified by
 * `sub_source.source_id = 2` rather than by the region code in
 * `orders.market_place` (which is a country FK, not a platform — see the note
 * in `order-context-repository.ts`). Only the SELECT list differs. That is
 * what makes "the rows the sidebar shows" and "the rows the resolver counted"
 * the same rows, so the sidebar can never show an order the resolver did not
 * match.
 *
 * STRICTLY READ-ONLY, and it writes no snapshot. Unlike the resolver this
 * caches nothing: it is a live read of what the source says right now, which
 * is the point — a conversation resolved weeks ago still shows today's
 * tracking number.
 *
 * EVERY COLUMN CONFIRMED LIVE before it was added, against a 2,000-order
 * sample of eBay orders: first_name/last_name populated on 487 of 495,
 * shipping_address.address_name on the same 487, sub_source.name on 495/495,
 * orders.total on 495/495, shipment.status on 495/495. Nothing here selects a
 * column that is decorative or empty in practice.
 */

import type { SourceOrderDetail } from "@/lib/domain/order";

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

const EBAY_SOURCE_ID = 2;

type SourceOrderRow = {
  order_number: string;
  order_date: string | null;
  order_status: string | null;
  order_total: string | null;
  first_name: string | null;
  last_name: string | null;
  address_name: string | null;
  seller_name: string | null;
  seller_company: string | null;
  tracking_number: string | null;
  shipment_status: string | null;
  carrier_name: string | null;
  carrier: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  address_line_3: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  listing_item_ref: string | null;
  item_sku: string | null;
  real_sku: string | null;
  item_title: string | null;
};

/**
 * `DISTINCT ON (o.id)` gives exactly one row per order even when an order has
 * several shipments (picks the most recent), matching the grounding query so
 * the two agree on how many orders matched.
 *
 * `o.total` is cast to text rather than returned as a number: it is `numeric`,
 * and rendering it through a float would change the value the source recorded.
 * No currency is selected because the source stores none — not on `orders`,
 * not on `market_place` (confirmed live: it has name/abbreviation/urls and no
 * currency column). A symbol would therefore be invented, and these accounts
 * sell in more than one currency.
 */
const FIND_ORDER_DETAILS = `
SELECT DISTINCT ON (o.id)
  o.order_id              AS order_number,
  o.order_date::text      AS order_date,
  o.status                AS order_status,
  o.total::text           AS order_total,
  ci.first_name           AS first_name,
  ci.last_name            AS last_name,
  sa.address_name         AS address_name,
  ss.name                 AS seller_name,
  ss.company              AS seller_company,
  sh.tracking_number      AS tracking_number,
  sh.status               AS shipment_status,
  cs.name                 AS carrier_name,
  cs.carrier              AS carrier,
  sa.address_line_1       AS address_line_1,
  sa.address_line_2       AS address_line_2,
  sa.address_line_3       AS address_line_3,
  sa.city                 AS city,
  sa.region               AS region,
  sa.postcode             AS postcode,
  oii.item_id             AS listing_item_ref,
  oii.item_sku            AS item_sku,
  oii.real_sku            AS real_sku,
  oii.item_title          AS item_title
FROM order_management.orders o
JOIN order_management.sub_source ss ON ss.id = o.sub_source_id
JOIN order_management.order_item_info oii ON oii.order_id = o.id
JOIN customers.customer_info ci ON ci.order_id = o.id
LEFT JOIN customers.shipping_address sa ON sa.order_id = o.id
LEFT JOIN order_management.shipment sh ON sh.order_id = o.id
LEFT JOIN order_management.carrier_service cs ON cs.id = sh.carrier_service_id
WHERE ss.source_id = $1::int
  AND o.sub_source_id = $2::int
  AND oii.item_id = $3
  AND ci.ebay_buyer_id = $4
ORDER BY o.id, sh.shipment_created_at DESC NULLS LAST`;

function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}

/** The address lines the source actually recorded, joined into one line. */
function formatAddress(row: SourceOrderRow): string | null {
  const parts = [
    row.address_line_1,
    row.address_line_2,
    row.address_line_3,
    row.city,
    row.region,
    row.postcode,
  ]
    .map(blankToNull)
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * The customer's name from the two columns that hold it.
 *
 * `customer_info.first_name`/`last_name` first, then `shipping_address.address_name`
 * as the fallback — the same person, recorded twice, and on the sampled orders
 * populated together. Never the eBay username: that is the Buyer field, and a
 * handle is not a name.
 */
function formatCustomerName(row: SourceOrderRow): string | null {
  const parts = [blankToNull(row.first_name), blankToNull(row.last_name)].filter(
    (part): part is string => part !== null,
  );
  if (parts.length > 0) return parts.join(" ");
  return blankToNull(row.address_name);
}

function toSourceOrderDetail(row: SourceOrderRow): SourceOrderDetail {
  return {
    orderNumber: row.order_number,
    orderDate: blankToNull(row.order_date),
    orderStatus: blankToNull(row.order_status),
    orderTotal: blankToNull(row.order_total),
    customerName: formatCustomerName(row),
    // `sub_source.name` is the storefront handle the customer bought from
    // ("led_sone"); `company` is the trading name behind it ("LEDSone"). The
    // handle is what appears on the listing, so it is preferred.
    sellerName: blankToNull(row.seller_name) ?? blankToNull(row.seller_company),
    trackingNumber: blankToNull(row.tracking_number),
    // The shipment record's own state, not a courier's delivery scan. Shown
    // under "Shipment status" for exactly that reason -- its values are
    // Completed/New/Cancelled, which describe this business's dispatch record
    // and would be read as a delivery claim under any other label.
    shipmentStatus: blankToNull(row.shipment_status),
    carrierName: blankToNull(row.carrier) ?? blankToNull(row.carrier_name),
    deliveryAddress: formatAddress(row),
    listingItemRef: blankToNull(row.listing_item_ref),
    // real_sku is the corrected/verified SKU when one was recorded; item_sku is
    // what the listing carried at order time. Prefer the corrected one.
    sku: blankToNull(row.real_sku) ?? blankToNull(row.item_sku),
    productTitle: blankToNull(row.item_title),
  };
}

/**
 * Every order matching this item and buyer, in full, for display.
 *
 * Returns as many rows as matched — one for a normal conversation, several
 * where the buyer bought the same listing more than once. The caller renders
 * one block per row and merges nothing; this function deliberately offers no
 * "best" row, because it has no basis to pick one.
 */
export async function findOrderDetailsForDisplay(
  client: Queryable,
  options: {
    readonly subSourceId: number;
    readonly itemId: string;
    readonly buyerUsername: string;
  },
): Promise<SourceOrderDetail[]> {
  const { rows } = await client.query({
    text: FIND_ORDER_DETAILS,
    values: [EBAY_SOURCE_ID, options.subSourceId, options.itemId, options.buyerUsername],
  });
  return (rows as SourceOrderRow[]).map(toSourceOrderDetail);
}
