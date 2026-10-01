import "server-only";

/**
 * Read-only history lookups behind the Repeat-Customer Warning.
 *
 * POSTGRESQL ONLY. There is no MySQL client, driver, connection or query in
 * this module and no code path that could reach one. The historical case data
 * was imported into `cst_app.customer_case_history` precisely so this read
 * never touches MySQL: that account is capped at 100 queries per hour, which a
 * per-conversation page load would exhaust in minutes.
 *
 * NO WRITES. Every statement here is a SELECT. Nothing in this module inserts,
 * updates, deletes or upserts, and the warning needs no write to function.
 *
 * ------------------------------------------------------------------------
 * THREE STATEMENTS, ONE PER SIGNAL, EACH AGGREGATED IN THE DATABASE
 * ------------------------------------------------------------------------
 * Each returns a single row of counts. No history row crosses the wire, which
 * is both a performance property and a privacy one — the browser is told "3
 * previous conversations", never which conversations, and no buyer handle,
 * message body, address or order line is read by any statement below.
 *
 * ------------------------------------------------------------------------
 * COUNTS ARE DISTINCT ON THE ESTABLISHED IDENTIFIERS
 * ------------------------------------------------------------------------
 *   conversations    count(DISTINCT id) — the primary key
 *   case history     count(DISTINCT source_case_id) — the CASE identity the
 *                    import deduplicated on, never a row count. The source is
 *                    an event log: 9,127 event rows collapsed to 1,098 cases,
 *                    so counting rows would report one customer's single claim
 *                    as four.
 *   refunded orders  count(DISTINCT o.id) — the order row. `customer_info` has
 *                    one row per order but the join is still made distinct, so
 *                    a second customer row for one order cannot double a
 *                    refund.
 *
 * ------------------------------------------------------------------------
 * CASE SENSITIVITY IS NOT COSMETIC HERE, AND IT IS WHY ONE INDEX IS UNUSED
 * ------------------------------------------------------------------------
 * Measured 2026-10-01: all 1,098 `customer_case_history.counterparty_ref`
 * values are lowercase, while 358 `conversations.counterparty_ref` values are
 * NOT — eBay handles carry mixed case and the import's source stored them
 * folded. An exact-match predicate would therefore silently miss the history
 * of every mixed-case buyer. It happens to miss none today (93 matching pairs,
 * identical under both predicates) only because no mixed-case buyer currently
 * has history — which is luck, not a property worth depending on.
 *
 * So `lower()` is applied to BOTH sides, and the consequence is accepted
 * deliberately: `ix_customer_case_history_counterparty` cannot serve this
 * predicate, so the case-history read is a sequential scan. Over 1,098 rows
 * that is sub-millisecond and measured below. A functional index on
 * `lower(counterparty_ref)` would restore it and would need a migration — if
 * this table ever grows by orders of magnitude, that is the change to propose,
 * and it must be approved rather than added quietly.
 *
 * The `conversations` read keeps its index: `marketplace` and `sub_source_id`
 * lead the predicate and are served by `ix_conversations_marketplace_sub_source`
 * before `lower()` filters the storefront's own slice.
 *
 * The source-database read uses EXACT match on `ebay_buyer_id`, deliberately
 * unlike the two above — it reuses the predicate
 * `findCandidateEbayOrders` has resolved real orders with since the order
 * resolver was built. Both sides of that comparison come from the same eBay
 * feed and preserve its casing; changing a proven join to be safe against a
 * problem it does not have would be the riskier edit.
 */

import type { Marketplace } from "@/lib/domain/marketplace";

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * The scope every lookup is confined to.
 *
 * ONE STOREFRONT. `subSourceId` is part of every predicate, not an
 * afterthought: the business runs several eBay storefronts and the same buyer
 * handle on two of them has not been approved as one customer's history. The
 * type carries it so a future cross-storefront aggregation has to change this
 * shape deliberately rather than by forgetting a filter.
 *
 * `before` is the current conversation's own first source timestamp — never
 * `now()`. See `resolve-customer-history.ts` for why the server clock is the
 * wrong boundary.
 */
export type HistoryScope = {
  readonly marketplace: Marketplace;
  readonly subSourceId: number;
  readonly counterpartyRef: string;
  /** Naive source timestamp. Events strictly earlier than this count. */
  readonly before: string;
  /** Excluded from the conversation count: it is the conversation being read. */
  readonly excludeConversationId: string;
};

/**
 * OTHER conversations with this buyer on this storefront that started earlier.
 *
 * THREE EXCLUSIONS, each required by the previous-history rule:
 *   `id <> $5`                   the current conversation is not its own history
 *   `first_source_ts < $4`       a conversation started later is not previous
 *   `sub_source_id = $2`         a different storefront is out of scope
 *
 * STRICTLY `<`, NOT `<=`. A conversation whose first message shares the exact
 * timestamp of this one is not evidence of an earlier contact; at best it is
 * the same arrival split in two. Ties resolve to "not previous", which is the
 * direction that cannot invent history.
 *
 * Both timestamps are naive `timestamp` columns holding preserved source
 * values, so they are compared directly with no timezone conversion and none
 * is possible — see the migration 0001 comment on why source timestamps are
 * stored naive.
 */
const COUNT_PREVIOUS_CONVERSATIONS = `
SELECT count(DISTINCT id)::int AS previous_conversations
FROM cst_app.conversations
WHERE marketplace = $1
  AND sub_source_id = $2::int
  AND lower(counterparty_ref) = lower($3)
  AND first_source_ts < $4::timestamp
  AND id <> $5::bigint`;

export const COUNT_PREVIOUS_CONVERSATIONS_SQL = COUNT_PREVIOUS_CONVERSATIONS;

export async function countPreviousConversations(
  client: Queryable,
  scope: HistoryScope,
): Promise<number> {
  const { rows } = await client.query({
    text: COUNT_PREVIOUS_CONVERSATIONS,
    values: [
      scope.marketplace,
      scope.subSourceId,
      scope.counterpartyRef,
      scope.before,
      scope.excludeConversationId,
    ],
  });
  return Number((rows as Array<{ previous_conversations: number }>)[0]?.previous_conversations ?? 0);
}

export type CaseHistoryCounts = {
  readonly formalCases: number;
  readonly paymentDisputes: number;
  readonly escalations: number;
  /**
   * The verified issue types of the escalated cases counted above — the stored
   * `event_type` values, nothing derived. Empty when there are no escalated
   * cases in range, which is the same thing as "nothing to describe".
   *
   * READ SO THE WARNING CAN SAY WHAT THE EARLIER CASE WAS ABOUT, instead of
   * only that one existed. It changes no count: it is aggregated from exactly
   * the rows the `escalations` filter already matched, so a wording change can
   * never move who qualifies.
   */
  readonly escalatedEventTypes: readonly string[];
  /** When this history was last confirmed against the source, for staleness. */
  readonly historyAsOf: string | null;
};

/**
 * The case-history counts, in one statement.
 *
 * ------------------------------------------------------------------------
 * FORMAL CASES AND INQUIRIES ARE DIFFERENT THINGS, AND ARE COUNTED APART
 * ------------------------------------------------------------------------
 * `source_table` carries that distinction straight from the source store:
 *
 *   'cases'             eBay's formal case record. Counted as a formal case.
 *   'payment_disputes'  a payment dispute. Counted as a dispute.
 *   'inquiries'         an inquiry. NOT counted as a formal case, ever —
 *                       an ordinary item-not-received question is not a
 *                       dispute, and 1,004 of the 1,098 imported cases are
 *                       inquiries, so treating them as formal would flag
 *                       nearly every customer with any history at all.
 *
 * ------------------------------------------------------------------------
 * `not_recorded` IS NOT `not_escalated`, AND THE FILTER SAYS SO
 * ------------------------------------------------------------------------
 * `escalation = 'escalated'` is the ONLY predicate that feeds the escalation
 * count. The three stored states mean three different things:
 *
 *   'escalated'      the source recorded an escalation. Counted.
 *   'not_escalated'  the source recorded that there was none. Not counted.
 *   'not_recorded'   the source table has NO escalation signal at all — every
 *                    `cases` and `payment_disputes` row, by construction.
 *                    Not counted, and NOT evidence of absence.
 *
 * Collapsing the second and third would claim 94 rows were checked and found
 * clean when they were never checked. `escalation = 'escalated'` is true for
 * neither, so the count is right without needing to know the difference — but
 * the difference is the reason the predicate is written positively rather than
 * as `escalation <> 'not_escalated'`.
 *
 * THE COUNTS ARE NOT SUMMED, here or anywhere. They are three different kinds
 * of record and a total would be a quantity the data does not contain.
 */
const COUNT_PREVIOUS_CASES = `
SELECT
  count(DISTINCT source_case_id) FILTER (WHERE source_table = 'cases')::int
    AS formal_cases,
  count(DISTINCT source_case_id) FILTER (WHERE source_table = 'payment_disputes')::int
    AS payment_disputes,
  count(DISTINCT source_case_id) FILTER (WHERE escalation = 'escalated')::int
    AS escalations,
  -- The stored issue types of exactly those escalated cases. Aggregated from
  -- the same filtered rows as the count above, so the two can never disagree
  -- about which cases are being described. event_type is NOT NULL and
  -- CHECK-constrained to three values by 0021, so nothing here can be a
  -- free-text string or a vocabulary nobody has checked.
  -- (No backticks in this comment: it lives inside a template literal, and a
  -- backtick here ends the string. That exact mistake broke the parse once.)
  array_agg(DISTINCT event_type) FILTER (WHERE escalation = 'escalated')
    AS escalated_event_types,
  max(imported_at)::text AS history_as_of
FROM cst_app.customer_case_history
WHERE marketplace = $1
  AND sub_source_id = $2::int
  AND lower(counterparty_ref) = lower($3)
  AND event_at < $4::timestamp`;

export const COUNT_PREVIOUS_CASES_SQL = COUNT_PREVIOUS_CASES;

export async function countPreviousCases(
  client: Queryable,
  scope: HistoryScope,
): Promise<CaseHistoryCounts> {
  const { rows } = await client.query({
    text: COUNT_PREVIOUS_CASES,
    values: [scope.marketplace, scope.subSourceId, scope.counterpartyRef, scope.before],
  });
  const row = (rows as Array<{
    formal_cases: number;
    payment_disputes: number;
    escalations: number;
    escalated_event_types: string[] | null;
    history_as_of: string | null;
  }>)[0];
  return {
    formalCases: Number(row?.formal_cases ?? 0),
    paymentDisputes: Number(row?.payment_disputes ?? 0),
    escalations: Number(row?.escalations ?? 0),
    // `array_agg ... FILTER` yields SQL NULL rather than an empty array when
    // no row matched, so the null is mapped to empty here rather than left for
    // every caller to remember.
    escalatedEventTypes: row?.escalated_event_types ?? [],
    historyAsOf: row?.history_as_of ?? null,
  };
}

/**
 * Earlier orders by this buyer on this storefront whose status is Refunded.
 *
 * READ-ONLY AGAINST THE MARKETPLACE SOURCE, whose pool pins
 * `default_transaction_read_only=on` at the session level — see
 * `getSourcePool()`. Same contract as `order-context-repository.ts`.
 *
 * ------------------------------------------------------------------------
 * WHY `orders.status = 'Refunded'` IS THE REFUND FACT
 * ------------------------------------------------------------------------
 * It is a single authoritative column on the order itself, with a closed
 * vocabulary measured live: Completed 1,087,095 · Refunded 19,079 ·
 * Cancelled 10,861 · Deleted 879 · Inprogress 520 · New 70 · Hold 31. One row
 * per order, so a refunded order is one record and cannot be counted twice —
 * which is what satisfies "repeated order-status records are not separate
 * refunds" without needing a history table of status transitions.
 *
 * `customer_service.ebay_returns` was considered and NOT used for this count.
 * It is a status-event log — 42,879 rows for 4,074 returns — and a return is
 * not a refund: a return can be open, rejected or closed without money moving.
 * Counting refunds from it would mean picking a refund-implying subset of a
 * vocabulary nobody has reviewed, which is the guess this codebase rejects.
 *
 * ------------------------------------------------------------------------
 * THE JOIN AND THE PLATFORM CHECK ARE THE PROVEN ONES
 * ------------------------------------------------------------------------
 * `orders -> customer_info ON order_id`, buyer matched on
 * `ci.ebay_buyer_id`, platform established by `sub_source.source_id = 2` —
 * every one of these is the predicate `findCandidateEbayOrders` already uses,
 * for the reasons its module header documents at length (in particular that
 * `orders.market_place` is a COUNTRY table and not a platform code, and
 * filtering on it drops every non-UK order).
 *
 * `order_date < $3` applies the previous-history rule on the order's own date,
 * not the server clock. `sub_source_id = $2` keeps the storefront scope.
 *
 * Index-supported: `customers_customer_info_ebay_buyer_id_idx` on the buyer,
 * plus `order_management_orders_sub_source_id_idx` and
 * `..._status_idx` on the order side.
 */
const EBAY_SOURCE_ID = 2;

const COUNT_PREVIOUS_REFUNDED_ORDERS = `
SELECT count(DISTINCT o.id)::int AS previous_refunded_orders
FROM order_management.orders o
JOIN order_management.sub_source ss ON ss.id = o.sub_source_id
JOIN customers.customer_info ci ON ci.order_id = o.id
WHERE ss.source_id = $1::int
  AND o.sub_source_id = $2::int
  AND ci.ebay_buyer_id = $3
  AND o.status = 'Refunded'
  AND o.order_date < $4::timestamp`;

export const COUNT_PREVIOUS_REFUNDED_ORDERS_SQL = COUNT_PREVIOUS_REFUNDED_ORDERS;

export async function countPreviousRefundedOrders(
  client: Queryable,
  scope: Pick<HistoryScope, "subSourceId" | "counterpartyRef" | "before">,
): Promise<number> {
  const { rows } = await client.query({
    text: COUNT_PREVIOUS_REFUNDED_ORDERS,
    values: [EBAY_SOURCE_ID, scope.subSourceId, scope.counterpartyRef, scope.before],
  });
  return Number(
    (rows as Array<{ previous_refunded_orders: number }>)[0]?.previous_refunded_orders ?? 0,
  );
}
