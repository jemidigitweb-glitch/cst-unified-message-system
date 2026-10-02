import "server-only";

/**
 * The CST read path over `cst_app.marketplace_cases` — the Case Detection
 * Indicator's only source of data.
 *
 * POSTGRESQL ONLY. There is no MySQL client, driver, connection or query in this
 * module and no code path that could reach one. The case data was imported into
 * `cst_app` precisely so this read never touches the message application's
 * MySQL account, which allows 100 queries and 50 connections per HOUR shared
 * across every consumer — one CST agent working a shift would exhaust that in
 * minutes if a page load could reach it. `tests/guards/case-import-isolation.test.ts`
 * is what makes that promise checkable rather than a claim in a comment.
 *
 * NO WRITES. Every statement here is a SELECT. Nothing inserts, updates,
 * deletes or upserts, and the indicator needs no write to function.
 *
 * ---------------------------------------------------------------------------
 * THE READ-PATH GATE, WHICH NO SCHEMA CAN ENFORCE AND WHICH THIS MODULE OWNS
 * ---------------------------------------------------------------------------
 * A case row is visible to CST **only when its `import_run_id` names a run whose
 * status is 'published'**. Migration 0022 says at length why the schema cannot
 * do this itself: the publication protocol makes committed-and-failed
 * unrepresentable, but nothing stops a reader ignoring the ledger, and an
 * abandoned 'in_progress' run would then be read as current data.
 *
 * So EVERY statement below joins `case_import_runs` and filters on
 * `status = 'published'`. `ix_marketplace_cases_run` exists to make that join
 * cheap. A statement here without that join is the bug this gate exists to
 * prevent, and `tests/guards/case-detection-read-path.test.ts` fails the build
 * if one appears.
 *
 * ---------------------------------------------------------------------------
 * TWO MATCHES, KEPT APART, AND NEITHER IS INFERRED
 * ---------------------------------------------------------------------------
 *   THIS ORDER      `order_ref` equals the order this conversation already
 *                   resolved to, on the same marketplace and storefront. The
 *                   order came from the existing context resolver; nothing here
 *                   resolves one.
 *   SAME CUSTOMER   `lower(counterparty_ref)` equals the conversation's buyer
 *                   handle, on the same storefront, EXCLUDING this order's own
 *                   cases so the two lists are disjoint by construction.
 *
 * Nothing is matched on a product name, a SKU, a customer name, a date
 * proximity or any model output. The only two keys are an order reference the
 * importer verified against a real order and a marketplace buyer handle.
 *
 * ---------------------------------------------------------------------------
 * CASE SENSITIVITY, AND WHY ONLY ONE SIDE IS FOLDED
 * ---------------------------------------------------------------------------
 * The buyer handles differ in case between the two systems — every imported
 * source value is lowercase while 358 `conversations.counterparty_ref` values
 * are not — so `lower()` is applied to BOTH sides, exactly as
 * `customer-history-repository.ts` does and for the same measured reason.
 * `ix_marketplace_cases_counterparty` is FUNCTIONAL on
 * `lower(counterparty_ref)` precisely so that predicate stays indexed at 21,022
 * rows; 0021 accepted a sequential scan over 1,098 and recorded that this
 * migration is the one that would have to fix it.
 *
 * The ORDER reference is matched EXACTLY, deliberately unlike the handle. It is
 * not a human-entered value: the importer resolved it against
 * `order_management.orders` and stored what that source holds, so folding case
 * here would widen a verified join to catch nothing.
 */

import type { Marketplace } from "@/lib/domain/marketplace";
import type {
  CaseEscalation,
  CaseLifecycle,
  CaseSourceTable,
  CaseType,
  OrderMatchMethod,
} from "@/lib/domain/marketplace-case";

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * One case as CST reads it.
 *
 * WHAT IS DELIBERATELY NOT HERE. No counterparty reference, no customer name,
 * no address, no email, no message or case correspondence, no raw marketplace
 * payload — `marketplace_cases` stores none of those, and this shape could not
 * carry one if it did. The buyer handle is matched ON and never returned: the
 * conversation header already shows it, and republishing it beside a case list
 * would add an identity to a payload that needs none.
 *
 * `warehouseDisposition` is NOT a status and is named so it cannot be read as
 * one. The Amazon return store puts two vocabularies in one source column, split
 * by fulfilment channel, and 0022 keeps the stockroom outcome in its own column
 * for exactly this reason. It is carried separately here and labelled
 * separately on screen.
 */
export type MarketplaceCaseView = {
  readonly sourceTable: CaseSourceTable;
  readonly caseRef: string;
  readonly marketplace: Marketplace;
  readonly caseType: CaseType;

  readonly lifecycle: CaseLifecycle;
  /** The marketplace's own word for where the case stands. Never a disposition. */
  readonly sourceStatus: string | null;
  readonly sourceState: string | null;
  /** The Amazon warehouse outcome. A stockroom fact, never a case status. */
  readonly warehouseDisposition: string | null;
  readonly sourceResolution: string | null;
  readonly sourceReason: string | null;
  readonly sourceReasonFamily: string | null;

  readonly damageReported: boolean;
  readonly replacementConfirmed: boolean;
  readonly escalation: CaseEscalation;

  readonly sellerActionOwed: string | null;
  /** Naive source datetime, preserved byte-for-byte. No zone is known for it. */
  readonly sellerActionDueAt: string | null;

  readonly quantity: number | null;
  readonly refundAmount: string | null;
  readonly refundCurrency: string | null;

  readonly openedAt: string;
  readonly closedAt: string | null;

  readonly orderRef: string | null;
  readonly orderMatchMethod: OrderMatchMethod;

  /** How many source event rows collapsed into this case. Never a case count. */
  readonly sourceRowCount: number;
};

type CaseRow = {
  source_table: CaseSourceTable;
  source_case_id: string;
  marketplace: Marketplace;
  case_type: CaseType;
  lifecycle: CaseLifecycle;
  source_status: string | null;
  source_state: string | null;
  source_disposition: string | null;
  source_resolution: string | null;
  source_reason: string | null;
  source_reason_family: string | null;
  damage_reported: boolean;
  replacement_confirmed: boolean;
  escalation: CaseEscalation;
  seller_action_owed: string | null;
  seller_action_due_at: string | null;
  quantity: number | null;
  refund_amount: string | null;
  refund_currency: string | null;
  opened_at: string;
  closed_at: string | null;
  order_ref: string | null;
  order_match_method: OrderMatchMethod;
  source_row_count: number;
};

/**
 * The selected columns, written once and shared by both reads so the two lists
 * can never describe a case differently.
 *
 * `refund_amount::text` because a `numeric(12,2)` through a JavaScript number is
 * how an amount loses a penny — the same reason the writer casts it once in SQL
 * on the way in. The three naive timestamps are cast to text for the same reason
 * the importer kept them raw: a Date would give a value of unknown zone an
 * offset it never had.
 */
const CASE_COLUMNS = `
  c.source_table,
  c.source_case_id,
  c.marketplace,
  c.case_type,
  c.lifecycle,
  c.source_status,
  c.source_state,
  c.source_disposition,
  c.source_resolution,
  c.source_reason,
  c.source_reason_family,
  c.damage_reported,
  c.replacement_confirmed,
  c.escalation,
  c.seller_action_owed,
  c.seller_action_due_at::text AS seller_action_due_at,
  c.quantity,
  c.refund_amount::text AS refund_amount,
  c.refund_currency,
  c.opened_at::text AS opened_at,
  c.closed_at::text AS closed_at,
  c.order_ref,
  c.order_match_method,
  c.source_row_count`;

/**
 * ACTIVE FIRST, THEN UNKNOWN, THEN CLOSED — and `unknown` sitting above `closed`
 * is a deliberate reading of measured data rather than a tidy alphabetical one.
 *
 * 14,436 of 21,022 cases are `unknown`, and the largest population behind that
 * is 12,397 Amazon returns whose source status is `Approved`: the request was
 * approved and the store records no closure event and no closure date. Sorting
 * those below closed cases would bury the live ones under six thousand finished
 * ones. An unknown case is the one an agent most needs to look at, because
 * nothing in the source says it is over.
 *
 * `id DESC` breaks the tie after `opened_at`, so a list is stable across loads —
 * the same reasoning as the append-only tables' `recorded_at DESC, id DESC`.
 */
const LIFECYCLE_RANK = `CASE c.lifecycle WHEN 'active' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END`;

/**
 * THE PUBLICATION GATE, as a join rather than as a convention.
 *
 * Written once and spliced into both statements below. It is a compile-time
 * constant — no caller value reaches it — so interpolating it is string
 * assembly, not injection. Every value in both statements is bound.
 */
const PUBLISHED_RUN_JOIN = `
  JOIN cst_app.case_import_runs r
    ON r.id = c.import_run_id
   AND r.status = 'published'`;

/**
 * The cases recorded against the order this conversation already resolved to.
 *
 * `marketplace` and `sub_source_id` lead the predicate and are served by
 * `ix_marketplace_cases_order`, which is PARTIAL on `order_ref IS NOT NULL` —
 * a row with no order reference can never satisfy this and is not scanned.
 *
 * ONE STOREFRONT. `sub_source_id` is part of the predicate, not an afterthought:
 * the business runs several eBay storefronts, and the same order reference
 * space on two of them has not been approved as one customer's history. Same
 * discipline as `HistoryScope`.
 */
const FIND_CASES_FOR_ORDER = `
SELECT ${CASE_COLUMNS}
FROM cst_app.marketplace_cases c
${PUBLISHED_RUN_JOIN}
WHERE c.marketplace = $1
  AND c.sub_source_id = $2::int
  AND c.order_ref = $3
ORDER BY ${LIFECYCLE_RANK}, c.opened_at DESC, c.id DESC
LIMIT $4::int`;

export const FIND_CASES_FOR_ORDER_SQL = FIND_CASES_FOR_ORDER;

/**
 * This customer's OTHER cases on this storefront.
 *
 * `c.order_ref IS DISTINCT FROM $4` rather than `<> $4`, because `$4` is NULL
 * when the conversation resolved to no order and `<>` against NULL excludes
 * every row — which would silently empty this list in exactly the case where it
 * is the only list there is.
 *
 * It also makes the two result sets DISJOINT, which is what lets the panel say
 * "this order" and "another order" without a case appearing under both.
 */
const FIND_CASES_FOR_CUSTOMER = `
SELECT ${CASE_COLUMNS}
FROM cst_app.marketplace_cases c
${PUBLISHED_RUN_JOIN}
WHERE c.marketplace = $1
  AND c.sub_source_id = $2::int
  AND c.counterparty_ref IS NOT NULL
  AND lower(c.counterparty_ref) = lower($3)
  AND c.order_ref IS DISTINCT FROM $4
ORDER BY ${LIFECYCLE_RANK}, c.opened_at DESC, c.id DESC
LIMIT $5::int`;

export const FIND_CASES_FOR_CUSTOMER_SQL = FIND_CASES_FOR_CUSTOMER;

/**
 * FRESHNESS, PER SOURCE STORE, FROM PUBLISHED RUNS ONLY.
 *
 * A run may be asked for a subset of the nine stores, so one global timestamp
 * would let a refresh of the inquiry log make every return store look current.
 * A store ABSENT from this result has never been published, and the caller must
 * report that as "never imported" rather than as "no cases found" — the two lead
 * a reviewer to opposite conclusions, which is the distinction `case_import_runs`
 * exists to make possible.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IMPORTED FROM `lib/sync/marketplace-case-writer.ts`
 * ---------------------------------------------------------------------------
 * That module holds the same statement, and importing it would be the obvious
 * de-duplication. It is not done, for a reason that is structural rather than
 * stylistic: the writer's module graph belongs to the standalone importer, and
 * `tests/guards/case-import-isolation.test.ts` walks every module reachable from
 * `app/` looking for a MySQL dependency. Pulling the importer's writer into a
 * route's graph to save eight lines of SQL would put the whole import path one
 * edit away from the CST runtime.
 *
 * The two copies are held together by a guard instead:
 * `tests/guards/case-detection-read-path.test.ts` asserts both filter on
 * `status = 'published'` and both group per store, so they cannot drift into
 * disagreeing about what "current" means.
 */
const LAST_PUBLISHED_BY_STORE = `
SELECT t AS source_table, max(r.published_at)::text AS published_at
FROM cst_app.case_import_runs r, unnest(r.source_tables) AS t
WHERE r.status = 'published'
GROUP BY 1
ORDER BY 1`;

export const LAST_PUBLISHED_BY_STORE_SQL = LAST_PUBLISHED_BY_STORE;

/**
 * How many cases one list may carry.
 *
 * A BOUND IS REQUIRED, and it must be visible. The busiest buyer handle in the
 * imported snapshot carries far fewer than this, but a bound chosen from today's
 * data is a bound that fails on tomorrow's. The reads below ask for `LIMIT n+1`
 * and report `hasMore` from the extra row, so a caller can always tell "that is
 * everything" from "I stopped looking" — the house rule, and the reason a list
 * here never silently truncates.
 */
export const CASE_LIST_LIMIT = 50;

export type CaseList = {
  readonly cases: readonly MarketplaceCaseView[];
  /** True when the store held more cases than the limit returned. */
  readonly hasMore: boolean;
};

/** The scope every lookup is confined to: one marketplace, one storefront. */
export type CaseScope = {
  readonly marketplace: Marketplace;
  readonly subSourceId: number;
  /** The order this conversation resolved to, or null when it resolved to none. */
  readonly orderRef: string | null;
  /** The verified buyer handle, or null where the marketplace supplies none. */
  readonly counterpartyRef: string | null;
};

function toView(row: CaseRow): MarketplaceCaseView {
  return {
    sourceTable: row.source_table,
    caseRef: row.source_case_id,
    marketplace: row.marketplace,
    caseType: row.case_type,
    lifecycle: row.lifecycle,
    sourceStatus: row.source_status,
    sourceState: row.source_state,
    warehouseDisposition: row.source_disposition,
    sourceResolution: row.source_resolution,
    sourceReason: row.source_reason,
    sourceReasonFamily: row.source_reason_family,
    damageReported: row.damage_reported,
    replacementConfirmed: row.replacement_confirmed,
    escalation: row.escalation,
    sellerActionOwed: row.seller_action_owed,
    sellerActionDueAt: row.seller_action_due_at,
    quantity: row.quantity === null ? null : Number(row.quantity),
    refundAmount: row.refund_amount,
    refundCurrency: row.refund_currency,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    orderRef: row.order_ref,
    orderMatchMethod: row.order_match_method,
    sourceRowCount: Number(row.source_row_count),
  };
}

/** Takes `limit + 1` rows and reports the overflow rather than hiding it. */
function toList(rows: readonly CaseRow[], limit: number): CaseList {
  return {
    cases: rows.slice(0, limit).map(toView),
    hasMore: rows.length > limit,
  };
}

/** The published cases on this conversation's own resolved order. */
export async function findCasesForOrder(
  client: Queryable,
  scope: Pick<CaseScope, "marketplace" | "subSourceId"> & { readonly orderRef: string },
  limit: number = CASE_LIST_LIMIT,
): Promise<CaseList> {
  const { rows } = await client.query({
    text: FIND_CASES_FOR_ORDER,
    values: [scope.marketplace, scope.subSourceId, scope.orderRef, limit + 1],
  });
  return toList(rows as CaseRow[], limit);
}

/** The published cases for this customer on any OTHER order of this storefront. */
export async function findCasesForCustomer(
  client: Queryable,
  scope: Pick<CaseScope, "marketplace" | "subSourceId" | "orderRef"> & {
    readonly counterpartyRef: string;
  },
  limit: number = CASE_LIST_LIMIT,
): Promise<CaseList> {
  const { rows } = await client.query({
    text: FIND_CASES_FOR_CUSTOMER,
    values: [
      scope.marketplace,
      scope.subSourceId,
      scope.counterpartyRef,
      scope.orderRef,
      limit + 1,
    ],
  });
  return toList(rows as CaseRow[], limit);
}

/**
 * When each source store was last published, from published runs only.
 *
 * A store missing from this map has NEVER been imported. That is not the same
 * fact as "it holds no case for this customer", and no caller may treat it as
 * one.
 */
export async function lastPublishedByStore(
  client: Queryable,
): Promise<ReadonlyMap<string, string>> {
  const { rows } = await client.query({ text: LAST_PUBLISHED_BY_STORE });
  return new Map(
    (rows as Array<{ source_table: string; published_at: string }>).map((row) => [
      row.source_table,
      row.published_at,
    ]),
  );
}
