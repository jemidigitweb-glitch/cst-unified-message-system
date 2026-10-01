import type { CaseHistoryRecord } from "@/lib/domain/customer-case-history";
import type { Queryable } from "@/lib/sync/message-sync";

/**
 * Writes collapsed customer case history into cst_app. Idempotent.
 *
 * WRITES cst_app.customer_case_history AND NOTHING ELSE. In particular it does
 * not touch `conversations` — a case is matched to a conversation logically, at
 * read time, on `counterparty_ref`, with no foreign key and no write back. See
 * migration 0021 on why an FK here would defeat the feature.
 *
 * ------------------------------------------------------------------------
 * IT STORES HISTORY. IT DISPLAYS NOTHING AND WARNS NOBODY
 * ------------------------------------------------------------------------
 * No reader, no panel and no draft input is added by this file. A row landing
 * here changes nothing an agent sees; the Repeat-Customer Warning is a separate
 * piece of work that has not been built.
 *
 * ------------------------------------------------------------------------
 * RE-RUNNABLE BY CONSTRUCTION
 * ------------------------------------------------------------------------
 * `ON CONFLICT (source_database, source_table, source_case_id)` targets
 * `uq_customer_case_history_source_identity`, so a second run updates rows
 * rather than appending a second copy of the history.
 *
 * THE CONFLICT TARGET IS A PLAIN COLUMN LIST, and that is correct here only
 * because all three columns are NOT NULL in 0021. `sla-policy-writer.ts` needs
 * a `coalesce` in its target because one of its key columns is nullable and
 * PostgreSQL treats NULLs as distinct — which would let the same row insert
 * twice, forever. No column of this key can be NULL, so no coalesce is needed;
 * if one ever became nullable this statement would have to change with it.
 *
 * `imported_at` is set on both paths, so "when was this case last confirmed
 * against the source" is always current and a stale copy is visible rather than
 * silent.
 *
 * `source_row_count` IS updated, because it describes the evidence behind the
 * current row: a case that gained three more events between runs must report
 * the new count or the number would explain a row that no longer exists.
 *
 * ------------------------------------------------------------------------
 * NOTHING IS EVER DELETED
 * ------------------------------------------------------------------------
 * There is no DELETE in this file and no prune pass — the same decision as
 * `agent-directory-writer.ts` and `sla-policy-writer.ts`, and the honest
 * consequence is the same: a case WITHDRAWN at source keeps its row and stops
 * being refreshed. `imported_at` is what makes that detectable. The alternative
 * is worse, because a pruning importer that hit a partial read would silently
 * delete real history.
 */

export type UpsertOutcome = {
  readonly inserted: number;
  readonly updated: number;
};

/**
 * `xmax = 0` is true only for a tuple this statement inserted; a row that
 * existed and was updated carries the locking transaction id. It is how the
 * caller reports real insert/update counts rather than "1,156 affected", and
 * it is what makes the duplicate check after a second run meaningful.
 *
 * `$12::timestamp` is an explicit cast because `event_at` is a naive timestamp
 * holding a source value byte-for-byte. Without it the driver's inference and
 * the session timezone decide, which is how a preserved source datetime
 * quietly acquires an offset.
 */
const UPSERT = `
INSERT INTO cst_app.customer_case_history
  (source_database, source_table, source_case_id, marketplace, sub_source_id,
   counterparty_ref, order_ref, event_type, event_status, escalation,
   event_at, source_row_count, imported_at)
VALUES ($1, $2, $3, $4, $5::int, $6, $7, $8, $9, $10, $11::timestamp, $12::int, now())
ON CONFLICT (source_database, source_table, source_case_id) DO UPDATE
  SET marketplace      = EXCLUDED.marketplace,
      sub_source_id    = EXCLUDED.sub_source_id,
      counterparty_ref = EXCLUDED.counterparty_ref,
      order_ref        = EXCLUDED.order_ref,
      event_type       = EXCLUDED.event_type,
      event_status     = EXCLUDED.event_status,
      escalation       = EXCLUDED.escalation,
      event_at         = EXCLUDED.event_at,
      source_row_count = EXCLUDED.source_row_count,
      imported_at      = now()
RETURNING (xmax = 0) AS inserted`;

/** The statement, exposed so a test can assert its shape without a database. */
export const UPSERT_CUSTOMER_CASE_HISTORY_SQL = UPSERT;

/**
 * Upserts one batch. Every value is a bound parameter; nothing is interpolated.
 *
 * The caller owns the transaction, exactly as `upsertAgentDirectory` and
 * `upsertResponseSlaPolicy` expect, so a bounded batch commits or rolls back as
 * one and a failed run can be re-run from the start without leaving a partial
 * history behind.
 */
export async function upsertCustomerCaseHistory(
  tx: Queryable,
  records: readonly CaseHistoryRecord[],
): Promise<UpsertOutcome> {
  let inserted = 0;
  let updated = 0;

  for (const record of records) {
    const { rows } = await tx.query({
      text: UPSERT,
      values: [
        record.sourceDatabase,
        record.sourceTable,
        record.sourceCaseId,
        record.marketplace,
        record.subSourceId,
        record.counterpartyRef,
        record.orderRef,
        record.eventType,
        record.eventStatus,
        record.escalation,
        record.eventAt,
        record.sourceRowCount,
      ],
    });
    const row = rows[0] as { inserted: boolean } | undefined;
    if (row?.inserted) inserted += 1;
    else updated += 1;
  }

  return { inserted, updated };
}
