import type { ActivityRecord } from "@/lib/domain/agent-activity";
import type { Queryable } from "@/lib/sync/message-sync";

/**
 * Writes agent activity into cst_app. Idempotent, and batched.
 *
 * WRITES cst_app.agent_activity AND NOTHING ELSE. Not `conversations`, not
 * `conversation_messages`, not `agent_directory`, not `app_users`.
 *
 * ------------------------------------------------------------------------
 * ONE STATEMENT PER BATCH, NOT PER ROW
 * ------------------------------------------------------------------------
 * The staff importer writes 234 rows and a round trip each is fine. This writes
 * 17,815 and it is not: the same shape would be 17,815 round trips for a job
 * that can be nine.
 *
 * `unnest` of eleven parallel arrays is how one statement carries a whole page
 * while every value stays a bound parameter — no VALUES list built by string
 * concatenation, no placeholder arithmetic, no escaping by hand.
 *
 * The casts on each array are required rather than decorative: without them
 * PostgreSQL cannot infer the element type of an empty or all-null array, and
 * `conversation_id`, `source_user_id` and `sub_source_id` are legitimately
 * all-null for whole pages of unmatched work.
 *
 * ------------------------------------------------------------------------
 * RE-RUNNABLE BY CONSTRUCTION
 * ------------------------------------------------------------------------
 * `ON CONFLICT (source_database, source_table, source_pk)` targets the unique
 * index 0017 created, so a second run updates rather than duplicating.
 * Idempotency rests on that index, not on the caller checking first.
 *
 * `ingested_at` is absent from the DO UPDATE list: it records when CST first
 * saw this action, and a re-run must not rewrite history. A row whose match
 * later succeeds is updated in place — which is the point, since the log is
 * imported before the conversations it refers to have always arrived.
 *
 * ------------------------------------------------------------------------
 * ORDER WITHIN A BATCH
 * ------------------------------------------------------------------------
 * A page cannot contain the same `source_pk` twice — it comes from a keyset
 * scan of a primary key — so `ON CONFLICT DO UPDATE` cannot hit the
 * "cannot affect row a second time" error that a batch with internal duplicates
 * would raise. If that ever changes, this is where it surfaces, loudly.
 */

export type ActivityUpsertOutcome = {
  readonly inserted: number;
  readonly updated: number;
};

/**
 * `xmax = 0` is true only for a tuple this statement inserted; an updated row
 * carries the locking transaction id. One round trip, real counts.
 */
const UPSERT = `
INSERT INTO cst_app.agent_activity
  (source_database, source_table, source_pk, source_user_id, action, action_date,
   marketplace, sub_source_id, conversation_id, external_message_id, match_status)
SELECT * FROM unnest(
  $1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::date[],
  $7::text[], $8::integer[], $9::bigint[], $10::text[], $11::text[])
ON CONFLICT (source_database, source_table, source_pk) DO UPDATE
  SET source_user_id      = EXCLUDED.source_user_id,
      action              = EXCLUDED.action,
      action_date         = EXCLUDED.action_date,
      marketplace         = EXCLUDED.marketplace,
      sub_source_id       = EXCLUDED.sub_source_id,
      conversation_id     = EXCLUDED.conversation_id,
      external_message_id = EXCLUDED.external_message_id,
      match_status        = EXCLUDED.match_status
RETURNING (xmax = 0) AS inserted`;

/** Exposed so a test can assert the statement's shape without a database. */
export const UPSERT_AGENT_ACTIVITY_SQL = UPSERT;

/** Builds the eleven parallel arrays. Separate so a test can read them. */
export function toColumnArrays(records: readonly ActivityRecord[]): unknown[][] {
  return [
    records.map((r) => r.sourceDatabase),
    records.map((r) => r.sourceTable),
    records.map((r) => r.sourcePk),
    records.map((r) => r.sourceUserId),
    records.map((r) => r.action),
    records.map((r) => r.actionDate),
    records.map((r) => r.marketplace),
    records.map((r) => r.subSourceId),
    records.map((r) => r.conversationId),
    records.map((r) => r.externalMessageId),
    records.map((r) => r.matchStatus),
  ];
}

/**
 * Upserts one batch. The caller owns the transaction, so a whole run commits or
 * rolls back as one rather than leaving activity half imported.
 */
export async function upsertAgentActivity(
  tx: Queryable,
  records: readonly ActivityRecord[],
): Promise<ActivityUpsertOutcome> {
  if (records.length === 0) return { inserted: 0, updated: 0 };

  const { rows } = await tx.query({ text: UPSERT, values: toColumnArrays(records) });

  let inserted = 0;
  for (const row of rows as Array<{ inserted: boolean }>) {
    if (row.inserted) inserted += 1;
  }
  return { inserted, updated: rows.length - inserted };
}
