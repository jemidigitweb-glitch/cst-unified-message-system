import type { CollapsedPolicy } from "@/lib/domain/sla-policy";
import type { Queryable } from "@/lib/sync/message-sync";

/**
 * Writes response-SLA policy rows into cst_app. Idempotent.
 *
 * WRITES cst_app.response_sla_policy AND NOTHING ELSE. In particular it does
 * not touch `conversations` or `conversation_messages` — the policy is matched
 * to a conversation logically, at read time, with no foreign key and no write
 * back.
 *
 * ------------------------------------------------------------------------
 * IT STORES A TARGET. IT NEVER APPLIES ONE.
 * ------------------------------------------------------------------------
 * There is no interval, no comparison and no percentage in this file. CST's own
 * 24-hour rule (`lib/domain/response-sla.ts`) is untouched, and which of the
 * two targets governs is an open business decision. A row landing here changes
 * no displayed number.
 *
 * ------------------------------------------------------------------------
 * RE-RUNNABLE BY CONSTRUCTION, AND THE CONFLICT TARGET IS AN EXPRESSION
 * ------------------------------------------------------------------------
 * `ON CONFLICT (marketplace, coalesce(sub_source_id, -1), week_scope)` targets
 * `uq_response_sla_policy_scope`, so a second run updates 42 rows rather than
 * inserting 84.
 *
 * THE `coalesce` IS NOT DECORATION and must match the index exactly. PostgreSQL
 * treats NULLs as distinct in a unique index, so Amazon's channel-wide row
 * (`sub_source_id` NULL) would be insertable twice and every run would append
 * another pair. A plain column list here would also fail to match the
 * expression index and raise 42P10 — loudly, which is the better of the two
 * failures, but the point is to have neither.
 *
 * `created_at` is deliberately absent from the DO UPDATE list: it records when
 * CST first saw this scope, and a refresh must not rewrite it. `imported_at` is
 * set on both paths, so "when was this target last confirmed against the
 * source" is always current and a stale copy is visible rather than silent.
 *
 * `source_pk`, `source_mail_id` and `source_rows` ARE updated, because they
 * describe where the current target came from. If the source's winning row
 * changes, the provenance must follow it or the table would point at a row that
 * no longer sets the value it claims to explain.
 *
 * ------------------------------------------------------------------------
 * NOTHING IS EVER DELETED
 * ------------------------------------------------------------------------
 * There is no DELETE in this file and no prune pass. A scope that disappears
 * from the source keeps its row and stops being refreshed, which `imported_at`
 * makes visible — the same reasoning as `agent-directory-writer.ts`.
 *
 * The honest consequence, recorded rather than left to be found: a target
 * WITHDRAWN at source stays in CST until somebody removes it. That is the right
 * default here because the alternative is worse — a pruning importer that hit a
 * partial read would silently delete live policy — but it means "no row" and
 * "row nobody has confirmed for months" are different states, and only the
 * second is detectable. `imported_at` is what detects it.
 */

export type UpsertOutcome = {
  readonly inserted: number;
  readonly updated: number;
};

/**
 * `xmax = 0` is true only for a tuple this statement inserted; a row that
 * existed and was updated carries the locking transaction id. It is the
 * standard way to tell the two apart in one round trip, and it is why the
 * caller can report real insert/update counts rather than "42 affected".
 */
const UPSERT = `
INSERT INTO cst_app.response_sla_policy
  (marketplace, sub_source_id, week_scope, target_hours,
   source_database, source_table, source_pk, source_mail_id, source_rows, imported_at)
VALUES ($1, $2, $3, $4, 'message_app', 'sla_configs', $5, $6, $7, now())
ON CONFLICT (marketplace, coalesce(sub_source_id, -1), week_scope) DO UPDATE
  SET target_hours   = EXCLUDED.target_hours,
      source_pk      = EXCLUDED.source_pk,
      source_mail_id = EXCLUDED.source_mail_id,
      source_rows    = EXCLUDED.source_rows,
      imported_at    = now()
RETURNING (xmax = 0) AS inserted`;

/** The statement, exposed so a test can assert its shape without a database. */
export const UPSERT_RESPONSE_SLA_POLICY_SQL = UPSERT;

/**
 * Upserts one batch. Every value is a bound parameter; nothing is interpolated.
 *
 * The caller owns the transaction, exactly as `upsertAgentDirectory` expects,
 * so a whole run commits or rolls back as one. That matters more here than
 * usual: a half-written policy would give some seller accounts a target and
 * leave their neighbours without one, which reads as a coverage gap rather than
 * as a failed import.
 */
export async function upsertResponseSlaPolicy(
  tx: Queryable,
  policies: readonly CollapsedPolicy[],
): Promise<UpsertOutcome> {
  let inserted = 0;
  let updated = 0;

  for (const policy of policies) {
    const { rows } = await tx.query({
      text: UPSERT,
      values: [
        policy.marketplace,
        policy.subSourceId,
        policy.weekScope,
        policy.targetHours,
        policy.sourcePk,
        policy.sourceMailId,
        policy.sourceRows,
      ],
    });
    const row = rows[0] as { inserted: boolean } | undefined;
    if (row?.inserted) inserted += 1;
    else updated += 1;
  }

  return { inserted, updated };
}

/**
 * The seller accounts CST actually holds, for the coverage report.
 *
 * READ-ONLY, and the only statement in this file that touches `conversations`.
 * It counts nothing about messages, reads no body, and is here rather than in a
 * repository because it exists solely to let the importer say which accounts it
 * did NOT cover.
 *
 * `sub_source_id IS NOT NULL` because an account with no id cannot be matched
 * to a policy either way, and reporting it as uncovered would be noise.
 */
const CST_ACCOUNTS = `
SELECT marketplace, sub_source_id::int AS sub_source_id, count(*)::int AS conversations
FROM cst_app.conversations
WHERE sub_source_id IS NOT NULL
GROUP BY marketplace, sub_source_id
ORDER BY marketplace, sub_source_id`;

export const CST_ACCOUNTS_SQL = CST_ACCOUNTS;

export type CstAccount = {
  readonly marketplace: string;
  readonly subSourceId: number;
  readonly conversations: number;
};

export async function cstSellerAccounts(app: Queryable): Promise<readonly CstAccount[]> {
  const { rows } = await app.query({ text: CST_ACCOUNTS });
  return (rows as Array<{ marketplace: string; sub_source_id: number; conversations: number }>).map(
    (row) => ({
      marketplace: row.marketplace,
      subSourceId: Number(row.sub_source_id),
      conversations: Number(row.conversations),
    }),
  );
}
