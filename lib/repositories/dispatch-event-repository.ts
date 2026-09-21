import "server-only";

import {
  type DispatchEvent,
  channelForSourceId,
} from "@/lib/domain/automation/automation-types";

/**
 * Dispatched shipments, read from the live source database.
 *
 * STRICTLY READ-ONLY. SELECT and nothing else. The pool this runs on pins
 * `default_transaction_read_only=on`, so the server itself refuses a write
 * rather than relying on this file's discipline — the source is shared with
 * unrelated production systems.
 *
 * THE MAPPING, VERIFIED LIVE against the source rather than assumed:
 *
 *   order_management.shipment        sh   the dispatch event. PK `id`.
 *     -> order_management.orders     o    sh.order_id = o.id
 *     -> order_management.order_info oi   oi.order_id = o.id  (exactly one row
 *                                         per order — confirmed across all
 *                                         1,111,189 orders)
 *     -> order_management.sub_source ss   ss.id = o.sub_source_id (storefront)
 *          ss.source_id                   the PLATFORM: 1 AMAZON, 2 EBAY,
 *                                         3 SHOPIFY, 16 B&Q, 17 TEMU, read from
 *                                         order_management.source
 *     -> customers.customer_info     ci   ci.order_id = o.id (recipient)
 *     -> customers.shipping_address  sa   sa.order_id = o.id (recipient, fallback)
 *     -> order_management.order_item_info oii  oii.order_id = o.id (what shipped)
 *     -> order_management.carrier_service cs   cs.id = sh.carrier_service_id
 *
 *   RETURNS AND CANCELLATIONS, joined on the MARKETPLACE order number and the
 *   storefront — the only keys these tables carry:
 *     customer_service.ebay_returns            (order_id, sub_source)
 *     customer_service.amazon_returns          (order_id, sub_source)
 *     customer_service.ebay_order_cancellations(order_id, sub_source)
 *   Verified live: eBay returns matched 42,185 of 42,185 rows to an order,
 *   cancellations 4,551 of 4,551, Amazon returns 13,085 of 15,636.
 *
 * The join `ci.order_id = o.id` and `sa.order_id = o.id` is the same one
 * `order-context-repository.ts` and `order-display-repository.ts` already use
 * and had verified; nothing here invents a relationship.
 *
 * THE DISPATCH TIME IS `order_info.shipped_time`. It is the only recorded
 * dispatch moment in the source: `shipment.shipment_created_at` is when the
 * label was made, which runs ~1.8 hours ahead of it on average and covers fewer
 * rows (593,905 against 600,914 on completed shipments). It is ORDER-level, so
 * an order dispatched in several parcels gives each parcel the same time —
 * recorded honestly as such rather than fabricating a per-parcel one.
 *
 * IT IS NAIVE. The source stores `timestamp without time zone`, and this
 * repository never casts it. Interpreting it is the scheduler's job, with the
 * configured zone, once.
 *
 * `DISTINCT ON (sh.id)` because `customer_info`, `shipping_address` and
 * `order_item_info` can each carry several rows per order and would otherwise
 * multiply one shipment into several dispatch events.
 */

/** Source reads only. The source pool enforces `default_transaction_read_only=on`. */
export type SourceQueryable = {
  query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows: unknown[] }>;
};

type Row = {
  shipment_id: string;
  order_id: string;
  order_number: string | null;
  source_id: number;
  sub_source_id: number;
  sub_source_name: string | null;
  dispatched_at: string;
  cancellation_raised: boolean;
  returned: boolean;
  order_status: string | null;
  shipment_status: string | null;
  shipment_cancelled: boolean;
  tracking_number: string | null;
  carrier: string | null;
  first_name: string | null;
  last_name: string | null;
  address_name: string | null;
  item_sku: string | null;
  real_sku: string | null;
  item_title: string | null;
};

const SELECT_COLUMNS = `
  DISTINCT ON (sh.id)
  sh.id::text                 AS shipment_id,
  o.id::text                  AS order_id,
  o.order_id                  AS order_number,
  ss.source_id                AS source_id,
  o.sub_source_id             AS sub_source_id,
  ss.name                     AS sub_source_name,
  oi.shipped_time::text       AS dispatched_at,
  o.status                    AS order_status,
  sh.status                   AS shipment_status,
  (sh.cancelled_at IS NOT NULL) AS shipment_cancelled,
  EXISTS (
    SELECT 1 FROM customer_service.ebay_order_cancellations c
     WHERE c.order_id = o.order_id AND c.sub_source = o.sub_source_id
  )                           AS cancellation_raised,
  (
    EXISTS (
      SELECT 1 FROM customer_service.ebay_returns r
       WHERE r.order_id = o.order_id AND r.sub_source = o.sub_source_id
    )
    OR EXISTS (
      SELECT 1 FROM customer_service.amazon_returns ar
       WHERE ar.order_id = o.order_id AND ar.sub_source = o.sub_source_id
    )
  )                           AS returned,
  sh.tracking_number          AS tracking_number,
  cs.carrier                  AS carrier,
  ci.first_name               AS first_name,
  ci.last_name                AS last_name,
  sa.address_name             AS address_name,
  oii.item_sku                AS item_sku,
  oii.real_sku                AS real_sku,
  oii.item_title              AS item_title`;

const FROM_CLAUSE = `
FROM order_management.shipment sh
JOIN order_management.orders o ON o.id = sh.order_id
JOIN order_management.order_info oi ON oi.order_id = o.id
JOIN order_management.sub_source ss ON ss.id = o.sub_source_id
LEFT JOIN order_management.carrier_service cs ON cs.id = sh.carrier_service_id
LEFT JOIN customers.customer_info ci ON ci.order_id = o.id
LEFT JOIN customers.shipping_address sa ON sa.order_id = o.id
LEFT JOIN order_management.order_item_info oii ON oii.order_id = o.id`;

/**
 * Discovery, bounded and floored.
 *
 * The WHERE clause carries the eligibility rules that can be expressed in SQL,
 * so an ineligible shipment is never transferred at all. It is not the only
 * check: `eligibilityForPostDispatch` re-applies all of them to every row, and
 * again to a fresh read before the record is processed.
 */
const FIND_DISPATCHED = `
SELECT * FROM (
  SELECT ${SELECT_COLUMNS}
  ${FROM_CLAUSE}
  WHERE sh.status = 'Completed'
    AND sh.cancelled_at IS NULL
    AND oi.shipped_time IS NOT NULL
    AND oi.shipped_time >= $1::timestamp
    AND o.sub_source_id = ANY($2::int[])
    AND lower(COALESCE(o.status, '')) NOT IN ('cancelled', 'refunded', 'deleted')
  ORDER BY sh.id, ci.id, sa.id, oii.id
) candidates
ORDER BY dispatched_at ASC, shipment_id ASC
LIMIT $3::int`;

/** The same row, re-read for exactly one shipment, with no eligibility filter. */
const FIND_ONE = `
SELECT ${SELECT_COLUMNS}
${FROM_CLAUSE}
WHERE sh.id = $1::bigint
ORDER BY sh.id, ci.id, sa.id, oii.id`;

/**
 * The recipient's name, from the two columns that record it.
 *
 * `customer_info.first_name`/`last_name` first, then
 * `shipping_address.address_name` — the same person, recorded twice. Never a
 * marketplace username: a handle is not a name.
 */
function customerName(row: Row): string | null {
  const parts = [row.first_name, row.last_name]
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part !== "");
  if (parts.length > 0) return parts.join(" ");
  const fallback = row.address_name?.trim();
  return fallback === undefined || fallback === "" ? null : fallback;
}

function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}

/**
 * One source row as a dispatch event, or nothing.
 *
 * A platform this application has no channel for is DROPPED rather than
 * guessed: the source lists seventeen platforms (Etsy, OnBuy, Wayfair,
 * ManoMano and others among them) and this application has five. Inventing a
 * channel for the rest would prepare a message for a marketplace this
 * application has never been configured for.
 */
function toDispatchEvent(row: Row): DispatchEvent | undefined {
  const channel = channelForSourceId(Number(row.source_id));
  if (channel === undefined) return undefined;
  return {
    shipmentId: row.shipment_id,
    orderId: row.order_id,
    orderNumber: blankToNull(row.order_number),
    channel,
    subSourceId: Number(row.sub_source_id),
    subSourceName: blankToNull(row.sub_source_name),
    dispatchedAt: row.dispatched_at,
    orderStatus: blankToNull(row.order_status),
    shipmentStatus: blankToNull(row.shipment_status),
    shipmentCancelled: row.shipment_cancelled === true,
    cancellationRaised: row.cancellation_raised === true,
    returned: row.returned === true,
    trackingNumber: blankToNull(row.tracking_number),
    carrier: blankToNull(row.carrier),
    customerName: customerName(row),
    // `real_sku` is the corrected SKU when one was recorded; `item_sku` is what
    // the listing carried at order time. Prefer the corrected one.
    sku: blankToNull(row.real_sku) ?? blankToNull(row.item_sku),
    productTitle: blankToNull(row.item_title),
  };
}

export async function findDispatchedShipments(
  source: SourceQueryable,
  options: {
    readonly notBefore: string;
    readonly subSourceIds: readonly number[];
    readonly limit: number;
  },
): Promise<readonly DispatchEvent[]> {
  if (options.subSourceIds.length === 0) return [];
  const { rows } = await source.query({
    text: FIND_DISPATCHED,
    values: [options.notBefore, [...options.subSourceIds], options.limit],
  });
  return (rows as Row[]).flatMap((row) => {
    const event = toDispatchEvent(row);
    return event === undefined ? [] : [event];
  });
}

/**
 * Re-reads one shipment immediately before it is processed.
 *
 * DELIBERATELY UNFILTERED. It must be able to return a cancelled order, a
 * cancelled shipment and a returned order, because telling those apart from
 * "this shipment no longer exists" is the whole point of the recheck — a
 * filtered query would make every ineligible record look deleted.
 */
export async function dispatchEventForShipment(
  source: SourceQueryable,
  shipmentId: string,
): Promise<DispatchEvent | undefined> {
  const { rows } = await source.query({ text: FIND_ONE, values: [shipmentId] });
  const row = (rows as Row[])[0];
  return row === undefined ? undefined : toDispatchEvent(row);
}
