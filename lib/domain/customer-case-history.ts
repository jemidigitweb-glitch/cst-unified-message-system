/**
 * Turns the message application's per-event case logs into one record per
 * customer case.
 *
 * PURE. No network, no database, no clock — the caller supplies the verified
 * eBay storefront set, and nothing here reads the time. That is what makes
 * every rule below testable without a database, and it is why the double-count
 * and supersession decisions live here rather than inside a SQL statement
 * nobody can unit-test.
 *
 * ------------------------------------------------------------------------
 * ONE ROW PER CASE, NOT PER EVENT
 * ------------------------------------------------------------------------
 * `inquiries` and `cases` are status-event logs. Measured 2026-10-01:
 * 8,052 rows for 1,062 cases, and 1,038 rows for 127. `res_his_order` is the
 * event sequence within a case — verified unique in combination with the case
 * id, 8,052 distinct pairs for 8,052 rows, sequences 0..18.
 *
 * Importing one row per event would report a customer who filed ONE
 * item-not-received claim as having filed four. `sourceRowCount` records how
 * many events folded in, so a report can still separate "how many cases" from
 * "how many recorded events".
 *
 * ------------------------------------------------------------------------
 * THE STATUS TRAP
 * ------------------------------------------------------------------------
 * `status` is NULL on the NEWEST row of all 1,062 inquiry cases, while existing
 * somewhere in 1,061 of them. So "latest row wins" imports NULL for every
 * single case and looks like it worked.
 *
 * The rule is therefore split: the newest row by (eventSeq, rowId) decides
 * IDENTITY, and the newest NON-NULL value decides STATUS. One case has no
 * status on any row and is reported as unknown rather than given one.
 *
 * ------------------------------------------------------------------------
 * 69 CASES EXIST IN BOTH TABLES, AND THEY ARE THE SAME CASES
 * ------------------------------------------------------------------------
 * `cases` stopped being written on 2025-05-31, the day `inquiries` was created,
 * and 69 of its 127 case ids also appear as `inquiries.inquiry_id`. Measured:
 * all 69 agree on buyer, storefront, type AND `req_date` to the exact second,
 * with identical min/max spans (2025-03-12 11:12:20 .. 2025-05-26 20:17:58).
 * They are one real case recorded in both the old and the new store.
 *
 * Importing both tables naively yields 1,225 rows for 1,156 real cases. The
 * `cases` copy is therefore DROPPED and counted as `superseded_by_inquiries` —
 * `inquiries` is the live store and the one that still receives events. The 58
 * ids unique to `cases` (2025-01-21 .. 2025-03-10, 57 buyers) are the history
 * that predates `inquiries` and are the reason the table is imported at all.
 *
 * This is not enforceable in the schema: 0021's unique key includes
 * `source_table` precisely BECAUSE the two id spaces overlap, so the database
 * would happily store both rows. The deduplication is a rule, so it lives here.
 *
 * ------------------------------------------------------------------------
 * NOTHING IS GUESSED. A ROW THAT CANNOT BE MAPPED IS REJECTED AND COUNTED
 * ------------------------------------------------------------------------
 * Measured populations this exists for: 58 of 1,062 inquiry cases carry no
 * `type` on any row, and 1 of the 37 payment-dispute rows has `case_id`,
 * `buyer` and `order_id` all NULL. Neither is patched with a placeholder.
 */

/** The three source tables, and the only values `sourceTable` may take. */
export const SOURCE_TABLES = ["inquiries", "cases", "payment_disputes"] as const;
export type SourceTable = (typeof SOURCE_TABLES)[number];

/** The case kinds 0021's CHECK admits. */
export const EVENT_TYPES = ["ITEM_NOT_RECEIVED", "RETURN", "PAYMENT_DISPUTE"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Escalation = "escalated" | "not_escalated" | "not_recorded";

/**
 * One source event row, normalised across the three tables by the reader.
 *
 * The columns the three tables do NOT share are nullable here and are only
 * consulted for the table that has them — `orderId` for payment_disputes,
 * `isCase`/`escDate` for inquiries. A reader must never populate a field its
 * table does not actually carry.
 */
export type SourceCaseEventRow = {
  readonly sourceTable: SourceTable;
  /** inquiry_id / case_id. Text: bigint(20) at source. */
  readonly caseId: string | null;
  /** res_his_order for the logs, revision for disputes. Null is permitted. */
  readonly eventSeq: number | null;
  /** The source row primary key, as the tiebreak within one sequence value. */
  readonly rowId: string;
  readonly buyer: string | null;
  readonly subSource: number | null;
  /** inquiries.type / cases.case_type. Null for payment_disputes, which has none. */
  readonly caseType: string | null;
  readonly status: string | null;
  /** inquiries only. */
  readonly isCase: number | null;
  /** inquiries only. */
  readonly escDate: string | null;
  /** payment_disputes only. */
  readonly orderId: string | null;
  /** req_date, a naive datetime string. */
  readonly reqDate: string | null;
};

/** One collapsed case, shaped to 0021's columns exactly. */
export type CaseHistoryRecord = {
  readonly sourceDatabase: "message_app";
  readonly sourceTable: SourceTable;
  readonly sourceCaseId: string;
  readonly marketplace: "ebay";
  readonly subSourceId: number;
  readonly counterpartyRef: string;
  readonly orderRef: string | null;
  readonly eventType: EventType;
  readonly eventStatus: string | null;
  readonly escalation: Escalation;
  readonly eventAt: string;
  readonly sourceRowCount: number;
};

/**
 * Why a case was not imported. Every one is counted and reported; none is
 * repaired with a default.
 */
export type RejectionReason =
  | "no_case_id"
  | "no_buyer"
  | "no_storefront"
  | "unverified_storefront"
  | "no_event_date"
  | "unmapped_case_type"
  | "superseded_by_inquiries";

export type Rejection = {
  readonly sourceTable: SourceTable;
  /** Null only when the case id itself was missing. */
  readonly sourceCaseId: string | null;
  readonly reason: RejectionReason;
  readonly sourceRowCount: number;
};

export type CollapseOutcome = {
  readonly records: readonly CaseHistoryRecord[];
  readonly rejections: readonly Rejection[];
};

/** The two values `inquiries.type` and `cases.case_type` actually take. */
const MAPPED_CASE_TYPES = new Set<string>(["ITEM_NOT_RECEIVED", "RETURN"]);

function trimmed(value: string | null): string | null {
  if (value === null) return null;
  const out = value.trim();
  return out === "" ? null : out;
}

/**
 * Newest first: by event sequence, then by row id.
 *
 * The row-id tiebreak is load-bearing, the same way `recorded_at DESC, id DESC`
 * is for this schema's append-only tables — a sequence value is not a total
 * order on its own, and `payment_disputes.revision` is nullable. A null
 * sequence sorts oldest so a row that never got one cannot displace a row that
 * did.
 */
function newestFirst(rows: readonly SourceCaseEventRow[]): SourceCaseEventRow[] {
  return [...rows].sort((a, b) => {
    const seqA = a.eventSeq ?? Number.NEGATIVE_INFINITY;
    const seqB = b.eventSeq ?? Number.NEGATIVE_INFINITY;
    if (seqA !== seqB) return seqB - seqA;
    // Row ids are bigint-as-text: compare by length then lexically, so a
    // 7-digit id does not sort above a 10-digit one.
    if (a.rowId.length !== b.rowId.length) return b.rowId.length - a.rowId.length;
    return b.rowId < a.rowId ? -1 : b.rowId > a.rowId ? 1 : 0;
  });
}

/** The newest non-null value of one field across a case's events. */
function latestNonNull(
  ordered: readonly SourceCaseEventRow[],
  pick: (row: SourceCaseEventRow) => string | null,
): string | null {
  for (const row of ordered) {
    const value = trimmed(pick(row));
    if (value !== null) return value;
  }
  return null;
}

/**
 * The case kind, or null when the source never recorded one.
 *
 * `payment_disputes` has no type column at all, so its kind comes from the
 * table's own identity — a constant, not a source value, and the module doc
 * says so. For the two logs an unrecognised value returns null and the case is
 * rejected: a vocabulary this import has not reviewed must not reach a column
 * a reader treats as verified.
 */
function resolveEventType(
  sourceTable: SourceTable,
  ordered: readonly SourceCaseEventRow[],
): EventType | null {
  if (sourceTable === "payment_disputes") return "PAYMENT_DISPUTE";
  const raw = latestNonNull(ordered, (row) => row.caseType);
  if (raw === null) return null;
  return MAPPED_CASE_TYPES.has(raw) ? (raw as EventType) : null;
}

/**
 * Escalation, which only `inquiries` records.
 *
 * `cases.esc_reason` is NULL on all 1,038 of its rows and `payment_disputes`
 * has no escalation concept, so both are `not_recorded` — the state that says
 * the source carries no signal, as distinct from a signal meaning "no". 0021's
 * `ck_customer_case_history_escalation_source` makes anything else
 * unrepresentable for those two tables.
 */
function resolveEscalation(
  sourceTable: SourceTable,
  rows: readonly SourceCaseEventRow[],
): Escalation {
  if (sourceTable !== "inquiries") return "not_recorded";
  const escalated = rows.some(
    (row) => row.isCase === 1 || trimmed(row.escDate) !== null,
  );
  return escalated ? "escalated" : "not_escalated";
}

/**
 * The date the case was raised: the EARLIEST req_date across its events.
 *
 * Earliest, not latest, and the distinction matters for a history signal. A
 * case's events accumulate over weeks; the newest event's date is when it was
 * last touched, which would make an old case look recent and defeat the point
 * of knowing a customer has contacted before. All 69 cross-table duplicates
 * agreed on req_date to the second, so the value is stable at source.
 */
function earliestReqDate(rows: readonly SourceCaseEventRow[]): string | null {
  let earliest: string | null = null;
  for (const row of rows) {
    const value = trimmed(row.reqDate);
    if (value === null) continue;
    if (earliest === null || value < earliest) earliest = value;
  }
  return earliest;
}

/**
 * Groups one table's event rows by case and collapses each group.
 *
 * `supersededCaseIds` is the set of case ids already covered by `inquiries`;
 * pass it when collapsing `cases` so the 69 duplicates are dropped and counted
 * rather than stored a second time. Pass an empty set for `inquiries` itself.
 *
 * `verifiedEbaySubSources` is the storefront allowlist, resolved by the caller
 * from `order_management.sub_source.source_id = 2`. A row whose storefront is
 * not in it is rejected rather than labelled `ebay` on the strength of which
 * table it came from — `marketplace` is NOT NULL in 0021 for exactly this
 * reason.
 */
export function collapseCaseEvents(
  rows: readonly SourceCaseEventRow[],
  options: {
    readonly verifiedEbaySubSources: ReadonlySet<number>;
    readonly supersededCaseIds?: ReadonlySet<string>;
  },
): CollapseOutcome {
  const superseded = options.supersededCaseIds ?? new Set<string>();

  const records: CaseHistoryRecord[] = [];
  const rejections: Rejection[] = [];

  /** Grouped by case id. Rows with no case id cannot be grouped at all. */
  const groups = new Map<string, SourceCaseEventRow[]>();
  let orphanRows = 0;
  let orphanTable: SourceTable | null = null;

  for (const row of rows) {
    const caseId = trimmed(row.caseId);
    if (caseId === null) {
      orphanRows += 1;
      orphanTable = row.sourceTable;
      continue;
    }
    const group = groups.get(caseId);
    if (group === undefined) groups.set(caseId, [row]);
    else group.push(row);
  }

  // Reported as one rejection carrying the row count, not one per row: these
  // rows have no identity to name, so counting them individually would imply
  // we know they were distinct cases. Measured: 1 such row, in payment_disputes.
  if (orphanRows > 0 && orphanTable !== null) {
    rejections.push({
      sourceTable: orphanTable,
      sourceCaseId: null,
      reason: "no_case_id",
      sourceRowCount: orphanRows,
    });
  }

  for (const [caseId, group] of groups) {
    const sourceTable = group[0]!.sourceTable;
    const sourceRowCount = group.length;
    const reject = (reason: RejectionReason) => {
      rejections.push({ sourceTable, sourceCaseId: caseId, reason, sourceRowCount });
    };

    if (superseded.has(caseId)) {
      reject("superseded_by_inquiries");
      continue;
    }

    const ordered = newestFirst(group);

    const counterpartyRef = latestNonNull(ordered, (row) => row.buyer);
    if (counterpartyRef === null) {
      reject("no_buyer");
      continue;
    }

    const subSourceId = ordered.find((row) => row.subSource !== null)?.subSource ?? null;
    if (subSourceId === null) {
      reject("no_storefront");
      continue;
    }
    if (!options.verifiedEbaySubSources.has(subSourceId)) {
      reject("unverified_storefront");
      continue;
    }

    const eventAt = earliestReqDate(group);
    if (eventAt === null) {
      reject("no_event_date");
      continue;
    }

    const eventType = resolveEventType(sourceTable, ordered);
    if (eventType === null) {
      reject("unmapped_case_type");
      continue;
    }

    records.push({
      sourceDatabase: "message_app",
      sourceTable,
      sourceCaseId: caseId,
      marketplace: "ebay",
      subSourceId,
      counterpartyRef,
      // Only payment_disputes records an order, and 0021's
      // ck_customer_case_history_order_ref_dispute_only enforces it. For the
      // other two the source has no order id to carry, and deriving one from
      // item + buyer is what resolve-order-context.ts does — with an ambiguous
      // outcome on real data, which is not a value to put in a verified column.
      orderRef: sourceTable === "payment_disputes"
        ? latestNonNull(ordered, (row) => row.orderId)
        : null,
      eventType,
      eventStatus: latestNonNull(ordered, (row) => row.status),
      escalation: resolveEscalation(sourceTable, group),
      eventAt,
      sourceRowCount,
    });
  }

  return { records, rejections };
}

/** Tallies rejections by reason, for a report that names what was dropped. */
export function rejectionSummary(
  rejections: readonly Rejection[],
): ReadonlyMap<RejectionReason, { cases: number; rows: number }> {
  const out = new Map<RejectionReason, { cases: number; rows: number }>();
  for (const rejection of rejections) {
    const entry = out.get(rejection.reason) ?? { cases: 0, rows: 0 };
    entry.cases += 1;
    entry.rows += rejection.sourceRowCount;
    out.set(rejection.reason, entry);
  }
  return out;
}
