import type { MarketplaceCaseRecord } from "@/lib/domain/marketplace-case";
import type { Queryable } from "@/lib/sync/message-sync";

/**
 * Writes the marketplace case snapshot into cst_app, and publishes it atomically.
 *
 * WRITES `cst_app.marketplace_cases` AND `cst_app.case_import_runs` AND NOTHING
 * ELSE. In particular it does not touch `customer_case_history`, whose 1,098 rows
 * and three statements continue to serve the Repeat-Customer Warning unchanged —
 * about 1,225 cases will exist in both tables and the provenance key is
 * deliberately identical so a report can deduplicate across them.
 *
 * ---------------------------------------------------------------------------
 * THE PUBLICATION PROTOCOL, AND WHY IT IS THREE TRANSACTIONS AND NOT ONE
 * ---------------------------------------------------------------------------
 *   TRANSACTION 1  `openImportRun` — records the attempt as 'in_progress' and
 *                  COMMITS at once, so a run that later dies is still on record.
 *                  Only an --apply run calls it; a rehearsal calls nothing here.
 *
 *   TRANSACTION 2  `upsertMarketplaceCases` for every record, THEN
 *                  `publishImportRun`, all inside ONE caller-owned transaction.
 *                  Either every case lands and the run is published with them,
 *                  or neither happens. There is no interleaving in which
 *                  published data is incomplete.
 *
 *   TRANSACTION 3  `failImportRun` — only after transaction 2 has rolled back,
 *                  so no case row from this run exists to be read.
 *
 * The caller owns the transactions, exactly as `upsertCustomerCaseHistory`,
 * `upsertAgentDirectory` and `upsertResponseSlaPolicy` expect. What is different
 * here is that the batch may NOT be split: a bounded-batch design was tried and
 * rejected because a failure part-way left committed rows the indicator would
 * read while the run was recorded as failed.
 *
 * ---------------------------------------------------------------------------
 * A DRY RUN REACHES NONE OF THIS
 * ---------------------------------------------------------------------------
 * There is no mode flag and no dry-run path. A rehearsal does not call
 * `openImportRun`, so it writes no row anywhere — the property is structural
 * rather than a branch somebody could get wrong.
 *
 * ---------------------------------------------------------------------------
 * RE-RUNNABLE BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * `ON CONFLICT (source_database, source_table, source_case_id)` targets
 * `uq_marketplace_cases_source_identity`, so a second run updates rows rather
 * than appending a second copy. The conflict target is a plain column list, and
 * that is correct ONLY because all three columns are NOT NULL in 0022:
 * `sla-policy-writer.ts` needs a coalesce in its target because one of its key
 * columns is nullable and PostgreSQL treats NULLs as distinct, which would let
 * the same row insert twice forever. If one of these ever became nullable this
 * statement must change with it.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS EVER DELETED
 * ---------------------------------------------------------------------------
 * There is no DELETE in this file and no prune pass — the same decision as
 * `customer-case-history-writer.ts`, and the honest consequence is the same: a
 * case withdrawn at source keeps its row and stops being refreshed.
 * `imported_at` and `import_run_id` are what make that detectable. A pruning
 * importer that hit a partial read would silently delete real history.
 */

export type ImportRunCounts = {
  readonly casesRead: number;
  readonly casesInserted: number;
  readonly casesUpdated: number;
  readonly casesRejected: number;
  readonly rejectionSummary: Record<string, { cases: number; rows: number }>;
};

export type UpsertOutcome = {
  readonly inserted: number;
  readonly updated: number;
};

/**
 * TRANSACTION 1. Records the attempt and returns its id.
 *
 * `source_tables` is what this run INTENDS to cover, and 0022 constrains it to
 * the nine known stores so a run cannot claim coverage of something that does not
 * exist. The connection and query counts are stored so the source budget is
 * auditable from the database rather than from a terminal somebody has closed.
 *
 * It will FAIL if another run is already in progress —
 * `uq_case_import_runs_single_in_progress` permits one at a time — and that
 * failure is the point: a second concurrent import stops here rather than
 * part-way through the data.
 */
const OPEN_RUN = `
INSERT INTO cst_app.case_import_runs
  (status, source_tables, mysql_connections, mysql_queries)
VALUES ('in_progress', $1::text[], $2::int, $3::int)
RETURNING id::text AS id`;

export const OPEN_IMPORT_RUN_SQL = OPEN_RUN;

export async function openImportRun(
  client: Queryable,
  options: {
    readonly sourceTables: readonly string[];
    readonly mysqlConnections: number;
    readonly mysqlQueries: number;
  },
): Promise<string> {
  const { rows } = await client.query({
    text: OPEN_RUN,
    values: [[...options.sourceTables], options.mysqlConnections, options.mysqlQueries],
  });
  const row = (rows as Array<{ id: string }>)[0];
  if (row === undefined) throw new Error("case import run was not created");
  return row.id;
}

/**
 * `xmax = 0` is true only for a tuple this statement inserted; a row that existed
 * and was updated carries the locking transaction id. It is how the caller
 * reports real insert/update counts rather than "20,990 affected", and it is what
 * makes the duplicate check after a second run meaningful.
 *
 * `$29::timestamp` and the other naive casts are explicit because these columns
 * hold source values byte-for-byte. Without them the driver's inference and the
 * session timezone decide, which is how a preserved source datetime quietly
 * acquires an offset — the mistake 0021's first dry run actually made.
 *
 * `refund_amount` arrives as TEXT and is cast once, here. A float round trip in
 * JavaScript is how a refund amount loses a penny.
 */
/**
 * The columns, in order, and the cast each bound value needs.
 *
 * Defined ONCE and rendered into both the single-row and the batched statement,
 * so the two cannot drift. `imported_at` is `now()` rather than a parameter and
 * therefore is not in this list.
 *
 * THE CASTS ARE LOAD-BEARING, NOT DECORATION. The four `::timestamp` columns hold
 * naive source values byte-for-byte; without an explicit cast the driver's
 * inference and the session timezone decide, which is how a preserved source
 * datetime quietly acquires an offset — the mistake 0021's first dry run actually
 * made. `::numeric` casts the refund once, in SQL, because a float round trip in
 * JavaScript is how an amount loses a penny.
 */
const VALUE_CASTS: readonly string[] = [
  "", "", "", "", "::int", // source_database .. sub_source_id
  "", "", "", "", "", // case_type .. order_txn_ref
  "", "", "", "", "", // counterparty_ref .. source_disposition
  "", "", "", // source_resolution .. source_reason_family
  "::boolean", "::boolean", "", // damage, replacement, escalation
  "", "::timestamp", "::int", // seller_action_owed, due_at, quantity
  "::numeric", "", // refund_amount, refund_currency
  "::timestamp", "::timestamp", "::timestamp", // opened/closed/source_updated
  "::int", // source_row_count
  "::bigint", // import_run_id
];

/** Bound values per row. `imported_at` is `now()` and is not one of them. */
export const UPSERT_VALUES_PER_ROW = VALUE_CASTS.length;

const INSERT_HEAD = `
INSERT INTO cst_app.marketplace_cases
  (source_database, source_table, source_case_id, marketplace, sub_source_id,
   case_type, order_ref, order_match_method, order_line_item_ref, order_txn_ref,
   counterparty_ref, lifecycle, source_status, source_state, source_disposition,
   source_resolution, source_reason, source_reason_family,
   damage_reported, replacement_confirmed, escalation,
   seller_action_owed, seller_action_due_at, quantity,
   refund_amount, refund_currency,
   opened_at, closed_at, source_updated_at,
   source_row_count, imported_at, import_run_id)
VALUES`;

/** One row's placeholder tuple, with `now()` inserted at the imported_at slot. */
function valuesTuple(rowIndex: number): string {
  const base = rowIndex * UPSERT_VALUES_PER_ROW;
  const slots = VALUE_CASTS.map((cast, i) => `$${base + i + 1}${cast}`);
  // imported_at sits between source_row_count and import_run_id in the column
  // list, so `now()` goes in at that position rather than being appended.
  const importRunId = slots.pop()!;
  return `  (${slots.join(", ")}, now(), ${importRunId})`;
}

const CONFLICT_CLAUSE = `
ON CONFLICT (source_database, source_table, source_case_id) DO UPDATE
  SET marketplace           = EXCLUDED.marketplace,
      sub_source_id         = EXCLUDED.sub_source_id,
      case_type             = EXCLUDED.case_type,
      order_ref             = EXCLUDED.order_ref,
      order_match_method    = EXCLUDED.order_match_method,
      order_line_item_ref   = EXCLUDED.order_line_item_ref,
      order_txn_ref         = EXCLUDED.order_txn_ref,
      counterparty_ref      = EXCLUDED.counterparty_ref,
      lifecycle             = EXCLUDED.lifecycle,
      source_status         = EXCLUDED.source_status,
      source_state          = EXCLUDED.source_state,
      source_disposition    = EXCLUDED.source_disposition,
      source_resolution     = EXCLUDED.source_resolution,
      source_reason         = EXCLUDED.source_reason,
      source_reason_family  = EXCLUDED.source_reason_family,
      damage_reported       = EXCLUDED.damage_reported,
      replacement_confirmed = EXCLUDED.replacement_confirmed,
      escalation            = EXCLUDED.escalation,
      seller_action_owed    = EXCLUDED.seller_action_owed,
      seller_action_due_at  = EXCLUDED.seller_action_due_at,
      quantity              = EXCLUDED.quantity,
      refund_amount         = EXCLUDED.refund_amount,
      refund_currency       = EXCLUDED.refund_currency,
      opened_at             = EXCLUDED.opened_at,
      closed_at             = EXCLUDED.closed_at,
      source_updated_at     = EXCLUDED.source_updated_at,
      source_row_count      = EXCLUDED.source_row_count,
      imported_at           = now(),
      import_run_id         = EXCLUDED.import_run_id
RETURNING (xmax = 0) AS inserted`;

/** The statement for `rowCount` rows. One row is the canonical exported form. */
export function upsertStatementFor(rowCount: number): string {
  if (!Number.isInteger(rowCount) || rowCount < 1) {
    throw new Error(`rowCount must be a positive integer, received: ${String(rowCount)}`);
  }
  const tuples = Array.from({ length: rowCount }, (_, i) => valuesTuple(i)).join(",\n");
  return `${INSERT_HEAD}\n${tuples}${CONFLICT_CLAUSE}`;
}

export const UPSERT_MARKETPLACE_CASE_SQL = upsertStatementFor(1);

/**
 * How many rows go in one statement.
 *
 * WHY BATCHING EXISTS, recorded because the first apply run is what forced it.
 * The writer issued one statement per case, and 21,022 sequential round trips to
 * a remote PostgreSQL over TLS took longer than ten minutes — the run was killed
 * mid-transaction. It behaved correctly under that kill: the connection dropped,
 * PostgreSQL rolled the transaction back, `marketplace_cases` held zero rows, and
 * the attempt survived as an `in_progress` ledger row that no freshness query
 * would read. But a write path that cannot finish is a write path that will be
 * interrupted again.
 *
 * ATOMICITY IS UNCHANGED. The batches are statements inside the SAME single
 * transaction, not separate transactions — that distinction is the whole
 * publication design and batching does not touch it. 21,022 rows become ~53
 * statements instead of 21,022, and still commit or roll back as one.
 *
 * 400 ROWS, AND THE CEILING IS A REAL ONE. PostgreSQL binds at most 65,535
 * parameters per statement; at 31 values per row that is 2,113 rows. 400 keeps a
 * wide margin and well inside what one TLS round trip carries comfortably.
 */
export const UPSERT_BATCH_SIZE = 400;

/**
 * Upserts every record. Every value is a bound parameter; nothing is interpolated.
 *
 * MUST run inside the SAME transaction as `publishImportRun`. Splitting it into
 * committed batches is what the publication design exists to prevent.
 */
export async function upsertMarketplaceCases(
  tx: Queryable,
  records: readonly MarketplaceCaseRecord[],
  importRunId: string,
  options: { readonly batchSize?: number } = {},
): Promise<UpsertOutcome> {
  const batchSize = options.batchSize ?? UPSERT_BATCH_SIZE;
  let inserted = 0;
  let updated = 0;

  /*
   * A KEY MAY NOT APPEAR TWICE IN ONE STATEMENT. PostgreSQL refuses with
   * "ON CONFLICT DO UPDATE command cannot affect row a second time", and the
   * importer already proves the whole batch is distinct before calling — this
   * re-checks it here so a future caller cannot reach that error by accident, and
   * so the failure names the duplicate rather than the SQL.
   */
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.sourceDatabase}|${record.sourceTable}|${record.sourceCaseId}`;
    if (seen.has(key)) {
      throw new Error(`duplicate source identity in one batch: ${key}`);
    }
    seen.add(key);
  }

  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    for (const record of batch) {
      values.push(
        record.sourceDatabase,
        record.sourceTable,
        record.sourceCaseId,
        record.marketplace,
        record.subSourceId,
        record.caseType,
        record.orderRef,
        record.orderMatchMethod,
        record.orderLineItemRef,
        record.orderTxnRef,
        record.counterpartyRef,
        record.lifecycle,
        record.sourceStatus,
        record.sourceState,
        record.sourceDisposition,
        record.sourceResolution,
        record.sourceReason,
        record.sourceReasonFamily,
        record.damageReported,
        record.replacementConfirmed,
        record.escalation,
        record.sellerActionOwed,
        record.sellerActionDueAt,
        record.quantity,
        record.refundAmount,
        record.refundCurrency,
        record.openedAt,
        record.closedAt,
        record.sourceUpdatedAt,
        record.sourceRowCount,
        importRunId,
      );
    }

    const { rows } = await tx.query({ text: upsertStatementFor(batch.length), values });
    for (const row of rows as Array<{ inserted: boolean }>) {
      if (row.inserted) inserted += 1;
      else updated += 1;
    }
  }

  return { inserted, updated };
}

/**
 * The single statement that makes a run's data readable.
 *
 * MUST be the last statement of the SAME transaction as the upserts. 0022's
 * `ck_case_import_runs_published_has_counts` refuses a publication with no
 * numbers, and `ck_case_import_runs_published_has_time` refuses one with no
 * timestamp, so a half-filled publication is unrepresentable rather than merely
 * discouraged.
 */
const PUBLISH_RUN = `
UPDATE cst_app.case_import_runs
   SET status            = 'published',
       published_at      = now(),
       finished_at       = now(),
       cases_read        = $2::int,
       cases_inserted    = $3::int,
       cases_updated     = $4::int,
       cases_rejected    = $5::int,
       rejection_summary = $6::jsonb
 WHERE id = $1::bigint
   AND status = 'in_progress'
RETURNING published_at::text AS published_at`;

export const PUBLISH_IMPORT_RUN_SQL = PUBLISH_RUN;

/**
 * Publishes the run, or throws.
 *
 * `AND status = 'in_progress'` is not decoration: it means publishing a run
 * twice, or publishing one that has already failed, affects no row and throws
 * here rather than silently re-stamping a snapshot.
 */
export async function publishImportRun(
  tx: Queryable,
  importRunId: string,
  counts: ImportRunCounts,
): Promise<string> {
  const { rows } = await tx.query({
    text: PUBLISH_RUN,
    values: [
      importRunId,
      counts.casesRead,
      counts.casesInserted,
      counts.casesUpdated,
      counts.casesRejected,
      JSON.stringify(counts.rejectionSummary),
    ],
  });
  const row = (rows as Array<{ published_at: string }>)[0];
  if (row === undefined) {
    throw new Error(
      `import run ${importRunId} was not in progress — refusing to publish, and nothing was published`,
    );
  }
  return row.published_at;
}

/**
 * TRANSACTION 3. Records the failure, after transaction 2 has already rolled
 * back. It never touches a case row — there are none from this run to touch.
 */
const FAIL_RUN = `
UPDATE cst_app.case_import_runs
   SET status      = 'failed',
       finished_at = now(),
       error       = $2
 WHERE id = $1::bigint
   AND status = 'in_progress'`;

export const FAIL_IMPORT_RUN_SQL = FAIL_RUN;

export async function failImportRun(
  client: Queryable,
  importRunId: string,
  error: string,
): Promise<void> {
  await client.query({
    text: FAIL_RUN,
    // Truncated: an error message may quote a statement, and a statement here
    // may quote a source value. The ledger records what failed, not a payload.
    values: [importRunId, error.slice(0, 2000)],
  });
}

/**
 * FRESHNESS, PER SOURCE STORE, FROM PUBLISHED RUNS ONLY.
 *
 * A run may cover a subset, so one global timestamp would let a refresh of one
 * store make every other look current. A store absent from this result HAS NEVER
 * BEEN PUBLISHED, and a caller must report that as "never imported" rather than
 * as "no cases found" — the two lead a reviewer to opposite conclusions.
 *
 * `status = 'published'` is the whole gate, and it is why a retracted run — moved
 * back to 'failed' while keeping its `published_at` as history — stops counting
 * the moment it is retracted.
 */
const LAST_PUBLISHED_BY_STORE = `
SELECT t AS source_table, max(r.published_at)::text AS published_at
FROM cst_app.case_import_runs r, unnest(r.source_tables) AS t
WHERE r.status = 'published'
GROUP BY 1
ORDER BY 1`;

export const LAST_PUBLISHED_BY_STORE_SQL = LAST_PUBLISHED_BY_STORE;

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
