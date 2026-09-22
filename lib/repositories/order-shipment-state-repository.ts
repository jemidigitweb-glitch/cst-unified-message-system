import "server-only";

/**
 * Has this order left the building yet?
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ------------------------------------------------------------------------
 * The before-shipment urgent rule turns on a fact about an ORDER, not on
 * anything a customer wrote. `lib/knowledge/message-priority.ts` says so in as
 * many words and refuses to guess it — see `ADDRESS_CHANGE_IS_NOT_ESCALATED`,
 * which exists precisely because "before dispatch" cannot be established from a
 * sentence. This module is the integration layer that comment defers to: it
 * reads the dispatch state from the source and hands back a yes or a no.
 *
 * STRICTLY READ-ONLY. One SELECT, against the source pool, which the caller
 * pins `default_transaction_read_only=on` for. Nothing here writes anywhere,
 * and the source is shared with unrelated production systems.
 *
 * ------------------------------------------------------------------------
 * THE KEY IS THE MARKETPLACE ORDER NUMBER, VERIFIED LIVE
 * ------------------------------------------------------------------------
 * `orders.order_id` IS the marketplace order number and `orders.id` is the
 * physical row -- the same pairing `dispatch-event-repository.ts` already joins
 * returns and cancellations on.
 *
 * Checked against live data before this was written: of 200 real `single_order`
 * snapshot keys, 199 matched an order in the source; and Shopify conversation
 * 46268, keyed `LED65289`, matches order 1149159 on the same column.
 *
 * BATCHED, NOT PER ROW. An inbox page can carry a hundred conversations, and a
 * query each would be a hundred round trips to a shared production database.
 * One array answers them all.
 *
 * ------------------------------------------------------------------------
 * WHAT COUNTS AS DISPATCHED, AND WHY IT LEANS THAT WAY
 * ------------------------------------------------------------------------
 * `order_info.shipped_time` is the dispatch moment — the same column the
 * post-dispatch automation treats as authoritative, chosen there over
 * `shipment.shipment_created_at` because the latter is when the LABEL was made
 * and runs ahead of the parcel leaving. A completed, uncancelled shipment row
 * counts too.
 *
 * EITHER is enough, and that asymmetry is deliberate. This gate decides whether
 * to tell a CST agent "you can still stop this". Reading a dispatched order as
 * undispatched makes the interface promise a window that has already closed;
 * reading an undispatched one as dispatched merely fails to flag it. The first
 * is a false promise about a parcel, the second is a missed highlight, so any
 * evidence of dispatch settles it.
 *
 * AN ORDER THAT DOES NOT MATCH IS NOT "NOT SHIPPED". It comes back absent, and
 * the caller must treat an absence as "no verified order" rather than as an
 * undispatched one — see `beforeShipmentEligibility`, which does.
 */

/** Source reads only. The source pool enforces `default_transaction_read_only=on`. */
export type SourceQueryable = {
  query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows: unknown[] }>;
};

/** The logical marketplace-order identity, as `context_snapshots` records it. */
export type OrderKey = { readonly orderNumber: string };

export type OrderShipmentState = {
  readonly subSourceId: number;
  readonly orderNumber: string;
  /** Whether the source shows any evidence this order has been dispatched. */
  readonly dispatched: boolean;
  /**
   * The recorded dispatch moment, verbatim and NAIVE — the source stores
   * `timestamp without time zone` and nothing here casts it. Null for an order
   * with no recorded dispatch.
   */
  readonly dispatchedAt: string | null;
  /** `orders.status`, as the source spells it. */
  readonly orderStatus: string | null;
};

type Row = {
  sub_source_id: number | string;
  order_number: string;
  order_status: string | null;
  shipped_time: string | null;
  has_completed_shipment: boolean | null;
};

/**
 * `LEFT JOIN` onto `shipment`, because an order that has NOT been dispatched has
 * no shipment row at all — an inner join would drop exactly the rows this
 * feature is about and make every unshipped order look like an unknown one.
 *
 * Grouped because one order can carry several shipment rows (a split
 * consignment), and one row of evidence is enough.
 */
const SHIPMENT_STATE_FOR_ORDERS = `
SELECT o.sub_source_id                          AS sub_source_id,
       o.order_id                               AS order_number,
       o.status                                 AS order_status,
       max(oi.shipped_time)::text               AS shipped_time,
       bool_or(sh.status = 'Completed' AND sh.cancelled_at IS NULL)
                                                AS has_completed_shipment
  FROM order_management.orders o
  JOIN order_management.order_info oi ON oi.order_id = o.id
  LEFT JOIN order_management.shipment sh ON sh.order_id = o.id
 WHERE o.order_id = ANY($1::text[])
 GROUP BY o.sub_source_id, o.order_id, o.status`;

/** The map key both sides agree on: the marketplace order number itself. */
export function orderKeyOf(key: OrderKey): string {
  return key.orderNumber;
}

/**
 * Dispatch state for a batch of orders, keyed by `orderKeyOf`.
 *
 * An order the source does not know is ABSENT FROM THE MAP rather than present
 * and false. "We have no record of this order" and "this order has not shipped"
 * are different facts, and only one of them is a reason to promise a window.
 */
export async function shipmentStateForOrders(
  source: SourceQueryable,
  keys: readonly OrderKey[],
): Promise<Map<string, OrderShipmentState>> {
  const state = new Map<string, OrderShipmentState>();
  if (keys.length === 0) return state;

  const { rows } = await source.query({
    text: SHIPMENT_STATE_FOR_ORDERS,
    values: [keys.map((key) => key.orderNumber)],
  });

  for (const row of rows as Row[]) {
    const subSourceId = Number(row.sub_source_id);
    const orderNumber = String(row.order_number);
    const dispatchedAt = row.shipped_time;
    state.set(orderKeyOf({ orderNumber }), {
      subSourceId,
      orderNumber,
      // Either signal settles it — see the header.
      dispatched: dispatchedAt !== null || row.has_completed_shipment === true,
      dispatchedAt,
      orderStatus: row.order_status,
    });
  }
  return state;
}
