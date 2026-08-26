import "server-only";

/**
 * Read-only eBay order/shipping lookup, for grounding an AI draft in a real
 * order rather than nothing.
 *
 * STRICTLY READ-ONLY. Every statement here is a SELECT against the source
 * pool, which the caller pins `default_transaction_read_only=on` for — see
 * `getSourcePool()`. Nothing here writes anywhere, and nothing here is part
 * of the sync pipeline: this runs on demand, from a draft request, not on a
 * schedule.
 *
 * THE JOIN, verified live against real data before this was written:
 *
 *   ebay_message_headers.item_id + buyer username
 *     -> order_management.order_item_info.item_id
 *     -> order_management.orders.id      (order number, status, date)
 *     -> customers.customer_info         (ebay_buyer_id, disambiguates the account)
 *     -> customers.shipping_address      (delivery address)
 *     -> order_management.shipment       (tracking number)
 *     -> order_management.carrier_service (courier name)
 *
 * SCOPED TO ONE EBAY SUB-ACCOUNT. `sub_source_id` is included in the WHERE
 * clause, not just item_id + buyer: the business can run more than one eBay
 * storefront, and item_id is only unique within one of them. Confirmed live
 * that `orders.sub_source_id` and `ebay_message_headers.sub_source` carry the
 * same value for the same order.
 *
 * WHAT "EBAY" MEANS HERE, AND WHAT IT DOES NOT.
 *
 *   `order_management.orders.market_place` looks like a platform code but
 *   is not one — it is a foreign key into `order_management.market_place`,
 *   a COUNTRY/REGION table (id 23 = "UK", id 10 = "Germany", id 24 = "US", ...)
 *   whose rows carry both an `ebay_url` and an `amazon_url`. A prior version
 *   of this query filtered on `market_place = '23'`, reasoning that it was
 *   eBay's code because it was the largest bucket for eBay sub-accounts —
 *   but it is *also* the largest bucket for the Amazon sub-account (id 8:
 *   125,597 of its rows carry market_place = '23' too), because most order
 *   volume across every platform happens to be UK-addressed. That filter
 *   silently dropped every non-UK order — confirmed live: sub-account 28
 *   ("huettenlampen", a German-language eBay storefront) files 26,796 of its
 *   orders under market_place = '10' (Germany) against only 82 under '23',
 *   so a conversation naming a real, unambiguous, completed order for that
 *   account resolved to zero candidates every time.
 *
 *   The actual platform identity lives in `order_management.sub_source`:
 *   each row there has an `id` (the same value as `orders.sub_source_id`)
 *   and a `source_id`, confirmed live to be `1` for every Amazon sub-account,
 *   `2` for every eBay sub-account (including 28, "huettenlampen"), and `3`
 *   for every Shopify sub-account. `EBAY_SOURCE_ID` below joins on that
 *   column instead — it is a platform check, not a region guess, and it
 *   needs no per-account list to keep it correct as new eBay sub-accounts
 *   are added.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

const EBAY_SOURCE_ID = 2;

/** One order that matches the item and buyer. More than one means ambiguous. */
export type CandidateOrder = {
  readonly orderRowId: string;
  readonly orderItemInfoId: string | null;
  readonly orderNumber: string;
  readonly orderDate: string | null;
  readonly orderStatus: string | null;
  readonly sku: string | null;
  readonly productTitle: string | null;
  readonly productImageUrl: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly addressLine3: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postcode: string | null;
  readonly trackingNumber: string | null;
  readonly carrierName: string | null;
};

type CandidateOrderRow = {
  order_row_id: string;
  order_item_info_id: string | null;
  order_number: string;
  order_date: string | null;
  order_status: string | null;
  item_sku: string | null;
  real_sku: string | null;
  item_title: string | null;
  item_img: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  address_line_3: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  tracking_number: string | null;
  carrier_name: string | null;
  carrier: string | null;
};

/**
 * `DISTINCT ON (o.id)` gives exactly one row per order even when an order has
 * several shipments (picks the most recent) or, rarely, the same item_id
 * twice on one order (picks either — a real duplicate line is not this
 * query's problem to resolve).
 */
const FIND_CANDIDATE_ORDERS = `
SELECT DISTINCT ON (o.id)
  o.id::text             AS order_row_id,
  oii.id::text            AS order_item_info_id,
  o.order_id              AS order_number,
  o.order_date::text      AS order_date,
  o.status                AS order_status,
  oii.item_sku             AS item_sku,
  oii.real_sku             AS real_sku,
  oii.item_title           AS item_title,
  oii.item_img             AS item_img,
  sa.address_line_1        AS address_line_1,
  sa.address_line_2        AS address_line_2,
  sa.address_line_3        AS address_line_3,
  sa.city                  AS city,
  sa.region                AS region,
  sa.postcode              AS postcode,
  sh.tracking_number       AS tracking_number,
  cs.name                  AS carrier_name,
  cs.carrier               AS carrier
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

function toCandidateOrder(row: CandidateOrderRow): CandidateOrder {
  return {
    orderRowId: row.order_row_id,
    orderItemInfoId: row.order_item_info_id,
    orderNumber: row.order_number,
    orderDate: row.order_date,
    orderStatus: row.order_status,
    // real_sku is the corrected/verified SKU when one was recorded; item_sku
    // is what the listing carried at order time. Prefer the corrected one.
    sku: row.real_sku ?? row.item_sku,
    productTitle: row.item_title,
    productImageUrl: row.item_img,
    addressLine1: row.address_line_1,
    addressLine2: row.address_line_2,
    addressLine3: row.address_line_3,
    city: row.city,
    region: row.region,
    postcode: row.postcode,
    trackingNumber: row.tracking_number,
    // carrier_service.name is the specific service ("ROYAL MAIL TRACKED 48"),
    // .carrier is the carrier brand ("Royal Mail"). The brand is what a
    // customer recognises, so it is preferred; the service name is the
    // fallback when a carrier brand was never recorded.
    carrierName: row.carrier ?? row.carrier_name,
  };
}

/**
 * Every order matching this item and buyer, for one eBay sub-account.
 *
 * Zero rows means no order to ground a reply in. More than one means the
 * buyer ordered this same listing more than once — a real, observed case —
 * and the caller must not guess which order the conversation is about.
 */
export async function findCandidateEbayOrders(
  client: Queryable,
  options: {
    readonly subSourceId: number;
    readonly itemId: string;
    readonly buyerUsername: string;
  },
): Promise<CandidateOrder[]> {
  const { rows } = await client.query({
    text: FIND_CANDIDATE_ORDERS,
    values: [EBAY_SOURCE_ID, options.subSourceId, options.itemId, options.buyerUsername],
  });
  return (rows as CandidateOrderRow[]).map(toCandidateOrder);
}
