import "server-only";

/**
 * The shipment facts a detail view shows and nothing else reads.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NOT A CHANGE TO `dispatch-event-repository.ts`
 * ------------------------------------------------------------------------
 * That module's `FIND_ONE` already returns most of what a detail view needs —
 * order, shipment, status, tracking number and the resolved carrier — and it is
 * keyed on one shipment id, which is exactly the right key. It is also the query
 * the SCHEDULER runs, on the recheck immediately before a record is processed.
 * Adding display-only columns to it would widen the hot path of the automation
 * for the benefit of a screen, and the brief for this work forbids touching the
 * dispatch trigger, the scheduling and the eligibility rules. So the shared
 * fields are READ FROM THAT MODULE, unchanged, and this one adds only the
 * columns it does not carry.
 *
 * STRICTLY READ-ONLY. One parameterised SELECT against the source pool, which
 * the caller pins `default_transaction_read_only=on` for. Nothing here writes
 * anywhere, and nothing here is copied into an application table: the detail
 * view reads the source every time it is opened, so it cannot go stale and there
 * is no second copy of a shipment to keep in step.
 *
 * ------------------------------------------------------------------------
 * ONE SHIPMENT, NAMED. NEVER "THE ORDER'S SHIPMENT"
 * ------------------------------------------------------------------------
 * `WHERE sh.id = $1::bigint`, and the order is reached THROUGH that row rather
 * than queried beside it. An order can carry several shipments — a split
 * consignment — and each one is its own automation record with its own tracking
 * number and its own carrier. A query that started from the order and took the
 * first shipment would show a reviewer the wrong parcel while naming the right
 * order, which is worse than showing nothing.
 *
 * `shipments_on_order` is returned for that reason: so the view can SAY that
 * this is one of several, rather than leaving a reviewer to assume it is the
 * only one.
 *
 * ------------------------------------------------------------------------
 * ABSENT IS ABSENT
 * ------------------------------------------------------------------------
 * Every nullable column comes back null when the source has no value, and blank
 * strings are normalised to null with it. `order_info.shipping_method` is
 * declared NOT NULL and is EMPTY on real rows — a dispatched eBay order checked
 * while writing this stores `''` for it, with a real carrier and tracking number
 * beside it — so a caller that trusted the constraint would print an empty
 * label rather than saying it has nothing. Null is
 * what the interface turns into "Not available"; nothing here invents a value,
 * and no carrier, method or tracking number is ever defaulted or guessed.
 */

/** Source reads only. The source pool enforces `default_transaction_read_only=on`. */
export type SourceQueryable = {
  query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * The columns `DispatchEvent` does not already carry.
 *
 * Timestamps are `::text` for the reason they are everywhere else in this
 * project: they are `timestamp without time zone`, and handing one to the driver
 * would build a `Date` through the process timezone and shift a naive source
 * value by the local offset.
 */
export type ShipmentDispatchDetail = {
  readonly shipmentId: string;
  /** `order_info.shipping_method`, blank normalised to null. */
  readonly shippingMethod: string | null;
  /**
   * `order_info.shipped` verbatim — an integer flag, not a boolean column.
   * Returned as recorded so the view can report it without asserting a meaning
   * the source does not document.
   */
  readonly shippedFlag: number | null;
  /** `order_info.shipped_error`, blank normalised to null. */
  readonly shippedError: string | null;
  /** `order_info.shipped_time`, for drift detection only — never displayed as the dispatch time. */
  readonly sourceShippedTime: string | null;
  /** `shipment.shipment_created_at` — the label, NOT the departure. */
  readonly shipmentCreatedAt: string | null;
  /** `shipment.cancelled_at`, the timestamp rather than the boolean. */
  readonly cancelledAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** `shipment.carrier_service_id`, kept so the view can fall back to it when no name resolves. */
  readonly carrierServiceId: string | null;
  /** `carrier_service.name` — the SERVICE, e.g. "ROYAL MAIL TRACKED 48 NEX(2kg)". */
  readonly carrierServiceName: string | null;
  /** `carrier_service.code`. */
  readonly carrierServiceCode: string | null;
  /** How many shipments the owning order carries, this one included. */
  readonly shipmentsOnOrder: number;
};

type Row = {
  shipment_id: string;
  shipping_method: string | null;
  shipped: number | string | null;
  shipped_error: string | null;
  source_shipped_time: string | null;
  shipment_created_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  carrier_service_id: string | null;
  carrier_service_name: string | null;
  carrier_service_code: string | null;
  shipments_on_order: number | string;
};

/**
 * `LEFT JOIN` onto `carrier_service`, because a shipment can carry a
 * `carrier_service_id` that resolves to nothing, and 320,593 shipments carry no
 * usable carrier at all. An inner join would drop exactly those rows and make a
 * shipment with an unresolvable carrier indistinguishable from one that does not
 * exist.
 */
const SHIPMENT_DETAIL = `
SELECT sh.id::text                    AS shipment_id,
       oi.shipping_method             AS shipping_method,
       oi.shipped                     AS shipped,
       oi.shipped_error              AS shipped_error,
       oi.shipped_time::text          AS source_shipped_time,
       sh.shipment_created_at::text   AS shipment_created_at,
       sh.cancelled_at::text          AS cancelled_at,
       sh.created_at::text            AS created_at,
       sh.updated_at::text            AS updated_at,
       sh.carrier_service_id::text    AS carrier_service_id,
       cs.name                        AS carrier_service_name,
       cs.code                        AS carrier_service_code,
       (SELECT count(*) FROM order_management.shipment s2
         WHERE s2.order_id = sh.order_id)::int AS shipments_on_order
  FROM order_management.shipment sh
  JOIN order_management.orders o     ON o.id = sh.order_id
  JOIN order_management.order_info oi ON oi.order_id = o.id
  LEFT JOIN order_management.carrier_service cs ON cs.id = sh.carrier_service_id
 WHERE sh.id = $1::bigint`;

function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The supplementary detail for exactly one shipment, or nothing.
 *
 * A shipment id the source does not know comes back `undefined` rather than as a
 * row of nulls: "we have no record of this shipment" and "this shipment records
 * no carrier" are different facts, and the view says different things about them.
 *
 * The id is CHECKED BEFORE IT IS CAST. `$1::bigint` on a non-numeric string is a
 * database error, and a 500 from a malformed id in a URL would read as a broken
 * detail view rather than as a bad request.
 */
export async function shipmentDispatchDetail(
  source: SourceQueryable,
  shipmentId: string,
): Promise<ShipmentDispatchDetail | undefined> {
  if (!/^\d+$/.test(shipmentId)) return undefined;

  const { rows } = await source.query({ text: SHIPMENT_DETAIL, values: [shipmentId] });
  const row = (rows as Row[])[0];
  if (row === undefined) return undefined;

  return {
    shipmentId: String(row.shipment_id),
    shippingMethod: blankToNull(row.shipping_method),
    shippedFlag: numberOrNull(row.shipped),
    shippedError: blankToNull(row.shipped_error),
    sourceShippedTime: row.source_shipped_time,
    shipmentCreatedAt: row.shipment_created_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    carrierServiceId: blankToNull(row.carrier_service_id),
    carrierServiceName: blankToNull(row.carrier_service_name),
    carrierServiceCode: blankToNull(row.carrier_service_code),
    shipmentsOnOrder: numberOrNull(row.shipments_on_order) ?? 1,
  };
}
