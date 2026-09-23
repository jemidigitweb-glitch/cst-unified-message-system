import type { MediaRecord } from "@/lib/domain/conversation-message-media";
import type { Queryable } from "@/lib/sync/message-sync";

/**
 * Writes eBay message-image metadata into cst_app. Idempotent, and batched.
 *
 * WRITES cst_app.conversation_message_media AND NOTHING ELSE. In particular it
 * does not touch `conversation_messages.attachments`, which is 0007's column
 * and carries Shopify (561 in / 224 out) and B&Q (63) attachments today. eBay
 * media lands alongside those, never through them.
 *
 * NO IMAGE IS STORED, ONLY A URL. There is no bytea column, no download and no
 * proxy. These point at storage eBay and the business already run; if a photo
 * is removed at source the link stops resolving, which is the behaviour 0007
 * settled on and 0016 inherits.
 *
 * ------------------------------------------------------------------------
 * RE-RUNNABLE BY CONSTRUCTION
 * ------------------------------------------------------------------------
 * `ON CONFLICT (source_database, source_table, source_pk)` targets the unique
 * index 0016 created, keyed on `files.id`. A second run updates rather than
 * duplicating, and idempotency rests on that index rather than on the caller
 * checking first.
 *
 * `ingested_at` is absent from the DO UPDATE list — it records when CST first
 * saw this image. `last_seen_at` is set on BOTH paths, which is what makes
 * "still present at source" a fact rather than an assumption: a row whose
 * `last_seen_at` stops advancing has disappeared upstream, and a later
 * reconciliation can say so without anything having deleted on a guess.
 *
 * `conversation_message_id` IS in the update list. A media row imported before
 * its message was re-ingested would otherwise keep pointing at a stale parent;
 * in practice the FK makes that impossible, but the correct value is cheap to
 * carry and the alternative is a field that silently ages.
 */

export type MediaUpsertOutcome = {
  readonly inserted: number;
  readonly updated: number;
};

/** `xmax = 0` is true only for a tuple this statement inserted. */
const UPSERT = `
INSERT INTO cst_app.conversation_message_media
  (conversation_message_id, source_database, source_table, source_pk,
   source_ref_id, media_url, view_order, last_seen_at)
SELECT * FROM unnest(
  $1::bigint[], $2::text[], $3::text[], $4::text[],
  $5::bigint[], $6::text[], $7::integer[]), now()
ON CONFLICT (source_database, source_table, source_pk) DO UPDATE
  SET conversation_message_id = EXCLUDED.conversation_message_id,
      source_ref_id           = EXCLUDED.source_ref_id,
      media_url               = EXCLUDED.media_url,
      view_order              = EXCLUDED.view_order,
      last_seen_at            = now()
RETURNING (xmax = 0) AS inserted`;

/** Exposed so a test can assert the statement's shape without a database. */
export const UPSERT_MESSAGE_MEDIA_SQL = UPSERT;

/** Builds the seven parallel arrays. Separate so a test can read them. */
export function toColumnArrays(records: readonly MediaRecord[]): unknown[][] {
  return [
    records.map((r) => r.conversationMessageId),
    records.map((r) => r.sourceDatabase),
    records.map((r) => r.sourceTable),
    records.map((r) => r.sourcePk),
    records.map((r) => r.sourceRefId),
    records.map((r) => r.mediaUrl),
    records.map((r) => r.viewOrder),
  ];
}

/**
 * Upserts one batch. The caller owns the transaction, so a whole run commits or
 * rolls back as one rather than leaving a message with half its photographs.
 */
export async function upsertMessageMedia(
  tx: Queryable,
  records: readonly MediaRecord[],
): Promise<MediaUpsertOutcome> {
  if (records.length === 0) return { inserted: 0, updated: 0 };

  const { rows } = await tx.query({ text: UPSERT, values: toColumnArrays(records) });

  let inserted = 0;
  for (const row of rows as Array<{ inserted: boolean }>) {
    if (row.inserted) inserted += 1;
  }
  return { inserted, updated: rows.length - inserted };
}
