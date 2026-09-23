import type { DirectoryEntry } from "@/lib/domain/agent-directory";
import type { Queryable } from "@/lib/sync/message-sync";

/**
 * Writes agent directory entries into cst_app. Idempotent.
 *
 * WRITES cst_app.agent_directory AND NOTHING ELSE. In particular it does not
 * touch `cst_app.app_users`, which holds the ids of a different directory
 * (`issue_tracking.management_users`) whose numbering collides with this one —
 * id 43 is "Bietrick" there and "mathusha" here. Keeping them apart is the
 * whole reason 0018 exists.
 *
 * ------------------------------------------------------------------------
 * RE-RUNNABLE BY CONSTRUCTION
 * ------------------------------------------------------------------------
 * `ON CONFLICT (source_system, source_user_id)` targets the unique index 0018
 * created, so running the import twice updates 234 rows rather than inserting
 * 468. Idempotency rests on that index, not on the caller checking first —
 * the same reasoning as `uq_conversation_messages_source_identity` in the
 * message sync.
 *
 * `created_at` is deliberately absent from the DO UPDATE list: it records when
 * CST first saw this person, and a refresh must not rewrite that. `synced_at`
 * is set on both paths, so "when was this last confirmed against the source"
 * is always current.
 *
 * ------------------------------------------------------------------------
 * INACTIVE PEOPLE ARE UPDATED, NEVER DELETED
 * ------------------------------------------------------------------------
 * There is no DELETE in this file and no "prune" pass. A person who has left
 * keeps their row with `active = false`, because `agent_activity` refers to
 * them by `source_user_id` and a dashboard has to be able to name whoever did
 * the work — including 174 (gnanatheepan, status `Remove`, 14,734 recorded
 * actions) and 22 (Torin). Removing them would turn historical work anonymous.
 *
 * A row that disappears from the source is therefore LEFT ALONE rather than
 * removed. It stops being refreshed, which `synced_at` makes visible.
 */

export type UpsertOutcome = {
  readonly inserted: number;
  readonly updated: number;
};

/**
 * `xmax = 0` is true only for a tuple this statement inserted; a row that
 * existed and was updated carries the locking transaction id. It is the
 * standard way to tell the two apart in one round trip, and it is why the
 * caller can report real insert/update counts rather than "234 affected".
 */
const UPSERT = `
INSERT INTO cst_app.agent_directory
  (source_system, source_user_id, display_name, active, source_status, synced_at)
VALUES ($1, $2, $3, $4, $5, now())
ON CONFLICT (source_system, source_user_id) DO UPDATE
  SET display_name  = EXCLUDED.display_name,
      active        = EXCLUDED.active,
      source_status = EXCLUDED.source_status,
      synced_at     = now()
RETURNING (xmax = 0) AS inserted`;

/** The statement, exposed so a test can assert its shape without a database. */
export const UPSERT_AGENT_DIRECTORY_SQL = UPSERT;

/**
 * Upserts one batch. Every value is a bound parameter; nothing is interpolated.
 *
 * The caller owns the transaction, exactly as `persistConversations` expects,
 * so a whole run commits or rolls back as one rather than leaving the directory
 * half refreshed.
 */
export async function upsertAgentDirectory(
  tx: Queryable,
  entries: readonly DirectoryEntry[],
): Promise<UpsertOutcome> {
  let inserted = 0;
  let updated = 0;

  for (const entry of entries) {
    const { rows } = await tx.query({
      text: UPSERT,
      values: [
        entry.sourceSystem,
        entry.sourceUserId,
        entry.displayName,
        entry.active,
        entry.sourceStatus,
      ],
    });
    const row = rows[0] as { inserted: boolean } | undefined;
    if (row?.inserted) inserted += 1;
    else updated += 1;
  }

  return { inserted, updated };
}
