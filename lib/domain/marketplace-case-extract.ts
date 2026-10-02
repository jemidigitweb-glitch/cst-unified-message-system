/**
 * Turns the message application's per-event case rows into one record per case.
 *
 * PURE. No network, no database, no clock — the caller supplies the verified
 * storefront allowlist and the order-resolution answers, and nothing here reads
 * the time. That is what makes every rule below testable without a database, and
 * it is why the collapse, the order-match precedence and the duplicate decisions
 * live here rather than inside SQL nobody can unit-test.
 *
 * ---------------------------------------------------------------------------
 * ONE ROW PER CASE, NOT PER EVENT
 * ---------------------------------------------------------------------------
 * Six of the nine stores are status-event logs. Measured: 42,931 eBay return
 * rows for 4,082 cases, 4,623 cancellation rows for 1,263, 8,054 inquiry rows
 * for 1,062, 1,038 formal-case rows for 127, 37 dispute rows for 36.
 *
 * Importing one row per event would report a customer who filed ONE
 * item-not-received claim as having filed four. `sourceRowCount` records how
 * many events folded in, so a report can still separate "how many cases" from
 * "how many recorded events".
 *
 * ---------------------------------------------------------------------------
 * THE STATUS TRAP, WHICH RECURS IN A SECOND SOURCE
 * ---------------------------------------------------------------------------
 * 0021 recorded that `status` is NULL on the NEWEST row of all 1,062 inquiry
 * cases while existing somewhere in 1,061 of them, so "latest row wins" imports
 * NULL for every case and looks like it worked. The eBay return store has the
 * same shape: a status exists on 4,427 rows of 42,931 and on none of the others.
 *
 * The rule is therefore split, exactly as 0021's is: the newest row by
 * (eventSeq, rowId) decides IDENTITY, and the newest NON-NULL value decides each
 * preserved source field.
 *
 * ---------------------------------------------------------------------------
 * 69 CASES EXIST IN BOTH INQUIRY LOGS, AND THEY ARE THE SAME CASES
 * ---------------------------------------------------------------------------
 * Measured in 0021's own discovery: 69 of the formal-case store's 127 ids also
 * appear as inquiry ids, agreeing on buyer, storefront, type and request date to
 * the second. The formal-case copy is DROPPED and counted as
 * `superseded_by_inquiries`. This is not enforceable in the schema — 0022's
 * unique key includes `source_table` precisely BECAUSE the id spaces overlap —
 * so the deduplication is a rule, and it lives here.
 */

import {
  type CaseEscalation,
  type CaseLifecycle,
  type CaseRejection,
  type CaseSourceTable,
  type CaseType,
  type MarketplaceCaseRecord,
  type OrderMatchMethod,
  ESCALATION_RECORDING_TABLES,
  caseTypeFor,
  damageReportedBy,
  escalationFor,
  isAmazonFulfilledByAmazon,
  lifecycleFor,
  marketplaceFor,
  replacementConfirmedBy,
} from "@/lib/domain/marketplace-case";

/**
 * One source event row, normalised across nine differently-shaped stores.
 *
 * THE FIELDS A STORE DOES NOT HAVE ARE NULL HERE, AND ARE ONLY EVER CONSULTED
 * FOR THE STORE THAT HAS THEM. A reader must never populate a field its table
 * does not actually carry — that is how a column that is always NULL gets read
 * as a meaningful absence. Which store carries which field is recorded in
 * `lib/db/message-app-case-source.ts`, beside the statement that selects it.
 */
export type SourceCaseEvent = {
  readonly sourceTable: CaseSourceTable;
  /** The CASE id as the source issues it. Null is rejected and counted. */
  readonly caseId: string | null;
  /** res_his_order / revision. Null permitted; it sorts oldest. */
  readonly eventSeq: number | null;
  /** The source row primary key, as the tiebreak within one sequence value. */
  readonly rowId: string;
  readonly subSource: number | null;

  readonly orderRef: string | null;
  readonly itemRef: string | null;
  readonly txnRef: string | null;
  readonly counterpartyRef: string | null;

  /** inquiries.type / cases.case_type. Null for the other seven stores. */
  readonly caseTypeRaw: string | null;
  readonly status: string | null;
  readonly state: string | null;
  readonly resolution: string | null;
  readonly reason: string | null;
  readonly reasonFamily: string | null;
  /** amazon_returns only. Decides whether `status` is a case status at all. */
  readonly fulfilment: string | null;
  /** amazon_returns only, and only for Amazon-fulfilled rows. */
  readonly disposition: string | null;

  /** inquiries only. */
  readonly isCase: number | null;
  /** inquiries only. */
  readonly escDate: string | null;
  /** ebay_returns only. */
  readonly buyerEsc: number | null;
  /** ebay_returns only. */
  readonly sellerEsc: number | null;
  /** amazon_returns only. */
  readonly azClaim: number | null;

  readonly sellerActionOwed: string | null;
  readonly sellerActionDueAt: string | null;

  readonly quantity: number | null;
  readonly refundAmount: string | null;
  readonly refundCurrency: string | null;

  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly sourceUpdatedAt: string | null;
};

/**
 * How one case's order reference was resolved, supplied by the caller.
 *
 * The lookups are impure — one verifies a source-recorded order number against
 * the order source, the other derives an order from the marketplace item and
 * transaction identifiers — so they happen outside this module and their
 * ANSWERS come in. That keeps the precedence rule unit-testable.
 */
export type OrderResolution =
  | { readonly method: "source_order_id_verified"; readonly orderRef: string }
  | { readonly method: "source_order_id_unverified"; readonly orderRef: string }
  | { readonly method: "item_transaction"; readonly orderRef: string }
  | { readonly method: "unmatched" };

export const UNMATCHED: OrderResolution = { method: "unmatched" };

/**
 * The grouping and lookup key for one case: THE STORE AND THE ID, NEVER THE ID
 * ALONE.
 *
 * The id spaces genuinely overlap — the formal-case and dispute stores use
 * separate marketplace spaces, and 69 identifiers appear in both inquiry logs —
 * which is why 0022's unique key includes `source_table`. Grouping on the id
 * alone silently MERGED two different cases into one, and a test caught it:
 * `tests/domain/marketplace-case-extract.test.ts` passes a dispute and a formal
 * case that share the id 123 and expects two records.
 *
 * The same key shape is used for `orderResolutions`, so the two cannot drift.
 */
export function caseKeyOf(sourceTable: CaseSourceTable, sourceCaseId: string): string {
  return `${sourceTable}|${sourceCaseId}`;
}

export type CollapseOptions = {
  /** Storefronts verified to belong to this store's marketplace. */
  readonly verifiedSubSources: ReadonlySet<number>;
  /** Case ids already covered by `inquiries`; pass when collapsing `cases`. */
  readonly supersededCaseIds?: ReadonlySet<string>;
  /**
   * The resolved order for each case, keyed by `caseKeyOf(store, id)`. A case
   * absent from the map is `unmatched` — never silently given the source's own
   * value, because an unverified reference and a verified one are different
   * claims.
   */
  readonly orderResolutions: ReadonlyMap<string, OrderResolution>;
};

export type CollapseOutcome = {
  readonly records: readonly MarketplaceCaseRecord[];
  readonly rejections: readonly CaseRejection[];
  /**
   * Cases whose refund amount was REFUSED because the source recorded no
   * currency for it. The CASE is kept; only the uninterpretable number is
   * dropped, and it is counted here so the loss is reported rather than silent.
   *
   * WHY THIS COUNTER EXISTS AT ALL: the first apply run failed on
   * `ck_marketplace_cases_refund_pair`, and the measurement behind it is 1,367
   * Amazon return rows of 9,760 that carry an amount with a blank currency.
   * Storing 12.50 with no currency cannot distinguish pounds from dollars, so
   * the number is not a fact — it is the shape of one. Rejecting the whole case
   * over it would discard 1,367 real returns for a field that is not what the
   * case is about, and relaxing the constraint would store a number nobody can
   * act on. Refusing the value and counting it is the same discipline applied to
   * every other unmappable value here.
   */
  readonly refundAmountsWithoutCurrency: number;
  /**
   * Lifecycle values outside the reviewed vocabulary. NOT a rejection count a
   * reader may skim past: the importer refuses the whole run when this is
   * non-empty, because an unreviewed status means the source changed shape.
   */
  readonly unmappedLifecycleValues: readonly string[];
};

function trimmed(value: string | null): string | null {
  if (value === null) return null;
  const out = value.trim();
  return out === "" ? null : out;
}

/**
 * Newest first: by event sequence, then by row id.
 *
 * The row-id tiebreak is load-bearing, the same way `recorded_at DESC, id DESC`
 * is for this schema's append-only tables. A sequence value is not a total order
 * on its own — `revision` is nullable and a store may re-snapshot a header — and
 * a null sequence sorts OLDEST so a row that never got one cannot displace a row
 * that did.
 *
 * Row ids are bigint-as-text: compared by length then lexically, so a 7-digit id
 * does not sort above a 10-digit one.
 */
function newestFirst(rows: readonly SourceCaseEvent[]): SourceCaseEvent[] {
  return [...rows].sort((a, b) => {
    const seqA = a.eventSeq ?? Number.NEGATIVE_INFINITY;
    const seqB = b.eventSeq ?? Number.NEGATIVE_INFINITY;
    if (seqA !== seqB) return seqB - seqA;
    if (a.rowId.length !== b.rowId.length) return b.rowId.length - a.rowId.length;
    return b.rowId < a.rowId ? -1 : b.rowId > a.rowId ? 1 : 0;
  });
}

/** The newest non-null value of one field across a case's events. */
function latestNonNull(
  ordered: readonly SourceCaseEvent[],
  pick: (row: SourceCaseEvent) => string | null,
): string | null {
  for (const row of ordered) {
    const value = trimmed(pick(row));
    if (value !== null) return value;
  }
  return null;
}

/** The newest non-null numeric value across a case's events. */
function latestNonNullNumber(
  ordered: readonly SourceCaseEvent[],
  pick: (row: SourceCaseEvent) => number | null,
): number | null {
  for (const row of ordered) {
    const value = pick(row);
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The date the case was raised: the EARLIEST recorded date across its events.
 *
 * Earliest, not latest, and the distinction matters. A case's events accumulate
 * over weeks; the newest event's date is when it was last touched, which would
 * make an old case look recent and defeat the point of knowing a case already
 * exists. Naive source datetimes sort correctly as strings in
 * 'YYYY-MM-DD HH:MM:SS' form, which is exactly why the reader must not let the
 * driver parse them into dates.
 */
function earliestOpenedAt(rows: readonly SourceCaseEvent[]): string | null {
  let earliest: string | null = null;
  for (const row of rows) {
    const value = trimmed(row.openedAt);
    if (value === null) continue;
    if (earliest === null || value < earliest) earliest = value;
  }
  return earliest;
}

/**
 * Groups one store's event rows by case and collapses each group.
 *
 * `supersededCaseIds` is the set of ids already covered by `inquiries`; pass it
 * when collapsing `cases` so the 69 duplicates are dropped and counted rather
 * than stored a second time. Pass nothing for every other store.
 *
 * `verifiedSubSources` is the storefront allowlist the caller resolved from the
 * order source. A row whose storefront is not in it is REJECTED rather than
 * labelled by the strength of which table it came from — `marketplace` is NOT
 * NULL in 0022 for exactly that reason.
 */
export function collapseCaseEvents(
  rows: readonly SourceCaseEvent[],
  options: CollapseOptions,
): CollapseOutcome {
  const superseded = options.supersededCaseIds ?? new Set<string>();
  const records: MarketplaceCaseRecord[] = [];
  const rejections: CaseRejection[] = [];
  const unmappedLifecycleValues = new Set<string>();
  let refundAmountsWithoutCurrency = 0;

  /**
   * The refund pair, or the amount refused.
   *
   * AN AMOUNT WITH NO CURRENCY IS NOT A FACT. It cannot distinguish 12.50 in
   * pounds from 12.50 in dollars, so it is the SHAPE of a fact rather than one.
   * 0022's `ck_marketplace_cases_refund_pair` refuses the pair, and the first
   * apply run discovered that the source produces it: 1,367 Amazon return rows
   * of the 9,760 carrying an amount have a blank currency.
   *
   * The CASE is kept and only the number is dropped, because the amount is not
   * what the case is about — the alternative was discarding 1,367 real returns.
   * A currency with no amount is harmless and is left alone.
   */
  function refundFor(ordered: readonly SourceCaseEvent[]): {
    refundAmount: string | null;
    refundCurrency: string | null;
  } {
    const amount = latestNonNull(ordered, (row) => row.refundAmount);
    const currency = latestNonNull(ordered, (row) => row.refundCurrency);
    if (amount !== null && currency === null) {
      refundAmountsWithoutCurrency += 1;
      return { refundAmount: null, refundCurrency: null };
    }
    return { refundAmount: amount, refundCurrency: currency };
  }

  /**
   * Grouped by (store, case id) — see `caseKeyOf`. A row with no case id cannot
   * be grouped at all.
   */
  const groups = new Map<string, SourceCaseEvent[]>();
  let orphanRows = 0;
  let orphanTable: CaseSourceTable | null = null;

  for (const row of rows) {
    const caseId = trimmed(row.caseId);
    if (caseId === null) {
      orphanRows += 1;
      orphanTable = row.sourceTable;
      continue;
    }
    const key = caseKeyOf(row.sourceTable, caseId);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }

  /*
   * Reported as ONE rejection carrying the row count, not one per row: these
   * rows have no identity to name, so counting them individually would imply we
   * know they were distinct cases. Measured: 1 such row, in payment_disputes.
   */
  if (orphanRows > 0 && orphanTable !== null) {
    rejections.push({
      sourceTable: orphanTable,
      sourceCaseId: null,
      reason: "no_case_id",
      sourceRowCount: orphanRows,
    });
  }

  for (const [caseKey, group] of groups) {
    const sourceTable = group[0]!.sourceTable;
    const caseId = trimmed(group[0]!.caseId)!;
    const sourceRowCount = group.length;
    const reject = (reason: CaseRejection["reason"]) => {
      rejections.push({ sourceTable, sourceCaseId: caseId, reason, sourceRowCount });
    };

    if (superseded.has(caseId)) {
      reject("superseded_by_inquiries");
      continue;
    }

    const ordered = newestFirst(group);

    const subSourceId = ordered.find((row) => row.subSource !== null)?.subSource ?? null;
    if (subSourceId === null) {
      reject("no_storefront");
      continue;
    }
    if (!options.verifiedSubSources.has(subSourceId)) {
      reject("unverified_storefront");
      continue;
    }

    const openedAt = earliestOpenedAt(group);
    if (openedAt === null) {
      reject("no_opened_at");
      continue;
    }

    const caseType = caseTypeFor(sourceTable, latestNonNull(ordered, (row) => row.caseTypeRaw));
    if (caseType === null) {
      reject("unmapped_case_type");
      continue;
    }

    // Identity from the newest row; every preserved value from the newest
    // NON-NULL one. See the status trap in the module header.
    const status = latestNonNull(ordered, (row) => row.status);
    const state = latestNonNull(ordered, (row) => row.state);
    const fulfilment = latestNonNull(ordered, (row) => row.fulfilment);
    const closedAt = latestNonNull(ordered, (row) => row.closedAt);

    const verdict = lifecycleFor({ sourceTable, status, state, closedAt, fulfilment });
    if (verdict === "unmapped") {
      // The value that is not in the reviewed vocabulary. Recorded so the
      // importer can name it and refuse, rather than drop the case quietly.
      unmappedLifecycleValues.add(
        `${sourceTable}: ${JSON.stringify(sourceTable === "ebay_returns" || sourceTable === "cancellation" ? state : status)}`,
      );
      reject("unmapped_lifecycle");
      continue;
    }
    const lifecycle: CaseLifecycle = verdict;

    /*
     * AN AMAZON-FULFILLED ROW'S `status` IS A WAREHOUSE DISPOSITION, NOT A CASE
     * STATUS, so it is moved to its own field and `sourceStatus` is left null.
     * That is what stops a stockroom outcome being rendered to an agent as the
     * customer's case status, and 0022's CHECK keeps the field out of every
     * other store.
     */
    const amazonFulfilled = sourceTable === "amazon_returns" && isAmazonFulfilledByAmazon(fulfilment);
    const sourceStatus = amazonFulfilled ? null : status;
    const sourceDisposition = amazonFulfilled
      ? (status ?? latestNonNull(ordered, (row) => row.disposition))
      : null;

    const resolution = latestNonNull(ordered, (row) => row.resolution);
    const reason = latestNonNull(ordered, (row) => row.reason);

    /*
     * The order this case belongs to, as RESOLVED BY THE CALLER. A case absent
     * from the map is `unmatched`, never silently given the source's own value:
     * an unverified reference and a verified one are different claims, and the
     * difference is the whole reason `order_match_method` exists.
     */
    const resolved = options.orderResolutions.get(caseKey) ?? UNMATCHED;
    const orderMatchMethod: OrderMatchMethod = resolved.method;
    const orderRef = resolved.method === "unmatched" ? null : resolved.orderRef;

    const escalation: CaseEscalation = escalationFor({
      sourceTable,
      status,
      isCase: latestNonNullNumber(ordered, (row) => row.isCase),
      escDate: latestNonNull(ordered, (row) => row.escDate),
      buyerEsc: latestNonNullNumber(ordered, (row) => row.buyerEsc),
      sellerEsc: latestNonNullNumber(ordered, (row) => row.sellerEsc),
      azClaim: latestNonNullNumber(ordered, (row) => row.azClaim),
    });

    records.push({
      sourceDatabase: "message_app",
      sourceTable,
      sourceCaseId: caseId,
      marketplace: marketplaceFor(sourceTable),
      subSourceId,
      caseType: caseType as CaseType,
      orderRef,
      orderMatchMethod,
      orderLineItemRef: latestNonNull(ordered, (row) => row.itemRef),
      orderTxnRef: latestNonNull(ordered, (row) => row.txnRef),
      counterpartyRef: latestNonNull(ordered, (row) => row.counterpartyRef),
      lifecycle,
      sourceStatus,
      sourceState: state,
      sourceDisposition,
      sourceResolution: resolution,
      sourceReason: reason,
      sourceReasonFamily: latestNonNull(ordered, (row) => row.reasonFamily),
      damageReported: damageReportedBy(sourceTable, reason),
      replacementConfirmed: replacementConfirmedBy(sourceTable, resolution),
      escalation,
      sellerActionOwed: latestNonNull(ordered, (row) => row.sellerActionOwed),
      sellerActionDueAt: latestNonNull(ordered, (row) => row.sellerActionDueAt),
      quantity: latestNonNullNumber(ordered, (row) => row.quantity),
      ...refundFor(ordered),
      openedAt,
      closedAt,
      sourceUpdatedAt: latestNonNull(ordered, (row) => row.sourceUpdatedAt),
      sourceRowCount,
    });
  }

  return {
    records,
    rejections,
    refundAmountsWithoutCurrency,
    unmappedLifecycleValues: [...unmappedLifecycleValues],
  };
}

/**
 * ===========================================================================
 * DESTINATION INVARIANTS, CHECKED BEFORE THE DATABASE IS ASKED
 * ===========================================================================
 * A MIRROR OF 0022'S CHECK CONSTRAINTS, AND THE REASON IT EXISTS IS A REAL
 * FAILURE. The dry run reads, collapses and reports — and writes nothing, so it
 * never exercises a CHECK. The first apply run therefore got all the way to
 * transaction 2 before `ck_marketplace_cases_refund_pair` rejected a row, which
 * made a data problem look like an import failure and cost a MySQL read.
 *
 * So the invariants are checked HERE, on the collapsed records, where a dry run
 * can refuse for the same reason the database would. The database remains the
 * authority — this does not replace a constraint, it moves the discovery earlier.
 *
 * Returns one sentence per violating record, capped by the caller, so a run can
 * name what is wrong rather than only that something is.
 */
export function destinationInvariantViolations(
  records: readonly MarketplaceCaseRecord[],
): readonly string[] {
  const out: string[] = [];
  const say = (record: MarketplaceCaseRecord, problem: string) => {
    out.push(`${record.sourceTable}/${record.sourceCaseId}: ${problem}`);
  };
  const blank = (value: string | null) => value !== null && value.trim() === "";

  for (const record of records) {
    // ck_marketplace_cases_refund_pair
    if (record.refundAmount !== null && blankOrNull(record.refundCurrency)) {
      say(record, "refund_amount with no currency");
    }
    // ck_marketplace_cases_order_ref_method — a biconditional, both directions
    if ((record.orderMatchMethod === "unmatched") !== (record.orderRef === null)) {
      say(record, `order_match_method ${record.orderMatchMethod} disagrees with order_ref`);
    }
    // ck_marketplace_cases_escalation_source
    if (
      record.escalation !== "not_recorded" &&
      !ESCALATION_RECORDING_TABLES.includes(record.sourceTable)
    ) {
      say(record, `escalation ${record.escalation} from a store that records none`);
    }
    // ck_marketplace_cases_replacement_source
    if (record.replacementConfirmed && record.sourceTable !== "amazon_returns") {
      say(record, "replacement_confirmed outside the one store that confirms one");
    }
    // ck_marketplace_cases_disposition_source
    if (record.sourceDisposition !== null && record.sourceTable !== "amazon_returns") {
      say(record, "source_disposition outside the Amazon return store");
    }
    // ck_marketplace_cases_source_row_count_positive
    if (record.sourceRowCount < 1) say(record, "source_row_count below 1");
    // ck_marketplace_cases_quantity_positive
    if (record.quantity !== null && record.quantity < 0) say(record, "negative quantity");
    // ck_marketplace_cases_source_case_id_present
    if (record.sourceCaseId.trim() === "") say(record, "blank source_case_id");
    // The blank-but-not-null guards.
    if (blank(record.counterpartyRef)) say(record, "blank counterparty_ref");
    if (blank(record.orderRef)) say(record, "blank order_ref");
    for (const [name, value] of [
      ["source_status", record.sourceStatus],
      ["source_state", record.sourceState],
      ["source_disposition", record.sourceDisposition],
      ["source_resolution", record.sourceResolution],
      ["source_reason", record.sourceReason],
      ["source_reason_family", record.sourceReasonFamily],
    ] as const) {
      if (blank(value)) say(record, `blank ${name}`);
    }
    // opened_at is NOT NULL at the destination.
    if (record.openedAt.trim() === "") say(record, "blank opened_at");
  }
  return out;
}

function blankOrNull(value: string | null): boolean {
  return value === null || value.trim() === "";
}

/**
 * The keys one store's cases need an order resolved for, with the method each
 * is eligible for.
 *
 * TWO ROUTES, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   A store that records an order id gets its reference VERIFIED against the
 *   order source. Measured match rates: eBay returns 3,934 of 3,934,
 *   cancellations 1,263 of 1,263, Amazon returns 12,093 of 14,398 (84.0%). The
 *   16% that resolve to no order row are `source_order_id_unverified` — the
 *   source did record a reference, and saying so is different from saying it was
 *   confirmed.
 *
 *   The two inquiry logs record NO order id at all — 0 of 8,054 and 0 of 1,038 —
 *   so their reference is DERIVED from the marketplace item and transaction
 *   identifiers, which both carry on 100% of rows. Measured: 1,189 cases, 1,182
 *   resolving to exactly one order, 7 to none, 0 to several.
 */
export type OrderLookupRequest = {
  readonly sourceTable: CaseSourceTable;
  readonly sourceCaseId: string;
  /** `caseKeyOf(sourceTable, sourceCaseId)`, so the resolution map keys match. */
  readonly caseKey: string;
  readonly subSourceId: number;
  /** Present for the seven stores that record one. */
  readonly sourceOrderRef: string | null;
  /** Present for the two inquiry logs. */
  readonly itemRef: string | null;
  readonly txnRef: string | null;
};

/**
 * Builds the lookup requests for one store's collapsed groups, without
 * resolving anything. Pure, so the request set is testable on its own.
 */
export function orderLookupRequests(
  rows: readonly SourceCaseEvent[],
): readonly OrderLookupRequest[] {
  // Grouped by (store, case id) for the same reason the collapse is — see
  // `caseKeyOf`. Keying on the id alone would merge two different cases.
  const byCase = new Map<string, SourceCaseEvent[]>();
  for (const row of rows) {
    const caseId = trimmed(row.caseId);
    if (caseId === null) continue;
    const key = caseKeyOf(row.sourceTable, caseId);
    const group = byCase.get(key);
    if (group === undefined) byCase.set(key, [row]);
    else group.push(row);
  }

  const out: OrderLookupRequest[] = [];
  for (const [caseKey, group] of byCase) {
    const ordered = newestFirst(group);
    const subSourceId = ordered.find((row) => row.subSource !== null)?.subSource ?? null;
    if (subSourceId === null) continue;
    out.push({
      sourceTable: group[0]!.sourceTable,
      sourceCaseId: trimmed(group[0]!.caseId)!,
      caseKey,
      subSourceId,
      sourceOrderRef: latestNonNull(ordered, (row) => row.orderRef),
      itemRef: latestNonNull(ordered, (row) => row.itemRef),
      txnRef: latestNonNull(ordered, (row) => row.txnRef),
    });
  }
  return out;
}

/**
 * Turns one lookup's answers into a resolution. PURE, so the precedence rule is
 * unit-testable without either database.
 *
 * PRECEDENCE, AND IT IS NOT A MERGE:
 *   1. A source-recorded reference wins outright. It is what the marketplace
 *      itself put on the case, and `verified` or `unverified` only describes
 *      whether an order row was found for it.
 *   2. Otherwise the derived line key, and ONLY when it names exactly one order.
 *   3. Otherwise unmatched.
 *
 * SEVERAL MATCHES ARE NEVER RESOLVED AUTOMATICALLY. `matchedOrderRefs` carrying
 * more than one distinct value returns `unmatched`, because choosing between
 * real alternatives is the guess this codebase rejects — and because 2 of the
 * 364,467 measured line keys genuinely collide.
 */
export function resolveOrderFor(input: {
  readonly sourceOrderRef: string | null;
  /** Whether the source-recorded reference names a real order on this storefront. */
  readonly sourceOrderVerified: boolean;
  /** Distinct order numbers the derived line key matched. */
  readonly matchedOrderRefs: readonly string[];
}): { readonly resolution: OrderResolution; readonly ambiguous: boolean } {
  const sourceRef = trimmed(input.sourceOrderRef);
  if (sourceRef !== null) {
    return {
      resolution: input.sourceOrderVerified
        ? { method: "source_order_id_verified", orderRef: sourceRef }
        : { method: "source_order_id_unverified", orderRef: sourceRef },
      ambiguous: false,
    };
  }
  const distinct = [...new Set(input.matchedOrderRefs.map((r) => r.trim()).filter((r) => r !== ""))];
  if (distinct.length === 1) {
    return { resolution: { method: "item_transaction", orderRef: distinct[0]! }, ambiguous: false };
  }
  /*
   * `ambiguous` is reported alongside the refusal so a run can say "7 unmatched,
   * of which 2 were ambiguous" rather than burying a real conflict inside a
   * total that also covers "no order exists". Both end as `unmatched` in the
   * row, because neither is a reference this import may assert.
   */
  return { resolution: UNMATCHED, ambiguous: distinct.length > 1 };
}

/**
 * Whether a run's declared coverage is consistent with what it actually wrote.
 *
 * ONE-DIRECTIONAL, AND THE DIRECTION IS THE POINT. Every store that produced a
 * record must appear in the declared coverage, or the run is claiming less than
 * it did and freshness would understate itself. The CONVERSE must not be
 * checked: a store that was read successfully and legitimately contained no
 * importable case still counts as covered, and demanding a record from it would
 * make an empty store look like an unread one.
 */
export function coverageInconsistencies(
  records: readonly MarketplaceCaseRecord[],
  declaredSourceTables: readonly string[],
): readonly string[] {
  const declared = new Set(declaredSourceTables);
  const produced = new Set(records.map((record) => record.sourceTable));
  return [...produced].filter((table) => !declared.has(table)).sort();
}
