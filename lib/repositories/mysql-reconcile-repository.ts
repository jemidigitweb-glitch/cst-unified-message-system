import "server-only";

import type { Queryable } from "@/lib/repositories/ebay-message-link-repository";

/**
 * The CST-side reads that drive reconciliation.
 *
 * Both of these exist to answer one question without re-reading MariaDB:
 * "what became importable since last time?"
 *
 * ------------------------------------------------------------------------
 * UNMATCHED ACTIVITY COSTS NOTHING TO RETRY
 * ------------------------------------------------------------------------
 * An activity row that did not resolve is STORED — `match_status = 'unmatched'`
 * with its `external_message_id` intact, because migration 0017 keeps the
 * reference the attempt was made on. So a retry needs no MariaDB query at all:
 * the references are already in cst_app, and only the two PostgreSQL hops have
 * to run again.
 *
 * 7,097 rows are currently unmatched, almost all because the activity log
 * starts 2026-03-06 and CST's eBay history starts 2026-06-19. They resolve as
 * that window widens, and each retry is free of MariaDB budget.
 *
 * ------------------------------------------------------------------------
 * UNMATCHED IMAGES ARE NOT STORED, SO THE QUESTION IS REVERSED
 * ------------------------------------------------------------------------
 * An image whose parent message CST lacks cannot be stored — the foreign key
 * forbids an orphan — so there is no row to retry. Re-scanning all 12,965
 * `files` rows would work and costs 7 of 100 hourly queries every run.
 *
 * Instead this asks cst_app which eBay messages are NEW, and the caller maps
 * those back to `ext_message_id` and requests only their media. A run that
 * ingested no eBay messages does no MariaDB work at all.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT.
 */

const FIND_UNMATCHED_ACTIVITY = `
SELECT id, external_message_id
FROM cst_app.agent_activity
WHERE match_status = 'unmatched'
  AND external_message_id IS NOT NULL
ORDER BY id
LIMIT $1`;

/**
 * eBay messages ingested since the reconciliation cursor.
 *
 * Ordered by `id`, which is the cursor: `conversation_messages.id` is a
 * generated identity, so a higher id is a later insert. `ingested_at` would be
 * the more obvious cursor and is the wrong one — two rows can share a timestamp
 * and a cursor on it would skip or repeat them.
 *
 * `source_table` pins this to eBay. The media mapping is defined against eBay
 * headers, and a Shopify message id here would send a meaningless reference to
 * MariaDB.
 */
const FIND_NEW_EBAY_MESSAGES = `
SELECT id, external_message_id
FROM cst_app.conversation_messages
WHERE source_table = 'ebay_message_headers'
  AND external_message_id IS NOT NULL
  AND id > $1
ORDER BY id
LIMIT $2`;

/**
 * eBay messages CST holds that carry no imported media yet.
 *
 * The safety net for the cursor: a message ingested BEFORE the reconciler first
 * ran sits below the watermark forever. This finds those, newest first, so a
 * bounded sweep can pick them up without re-reading everything.
 *
 * `NOT EXISTS` rather than a LEFT JOIN with an IS NULL filter, so the planner
 * can stop at the first media row instead of building the join.
 */
const FIND_EBAY_MESSAGES_WITHOUT_MEDIA = `
SELECT m.id, m.external_message_id
FROM cst_app.conversation_messages m
WHERE m.source_table = 'ebay_message_headers'
  AND m.external_message_id IS NOT NULL
  AND m.id <= $1
  AND NOT EXISTS (
    SELECT 1 FROM cst_app.conversation_message_media med
    WHERE med.conversation_message_id = m.id
  )
ORDER BY m.id DESC
LIMIT $2`;

export const FIND_UNMATCHED_ACTIVITY_SQL = FIND_UNMATCHED_ACTIVITY;
export const FIND_NEW_EBAY_MESSAGES_SQL = FIND_NEW_EBAY_MESSAGES;
export const FIND_EBAY_MESSAGES_WITHOUT_MEDIA_SQL = FIND_EBAY_MESSAGES_WITHOUT_MEDIA;

export type UnmatchedActivity = {
  readonly id: number;
  readonly externalMessageId: string;
};

export type CstEbayMessage = {
  readonly id: number;
  readonly externalMessageId: string;
};

export async function findUnmatchedActivity(
  app: Queryable,
  limit: number,
): Promise<readonly UnmatchedActivity[]> {
  const { rows } = await app.query({ text: FIND_UNMATCHED_ACTIVITY, values: [limit] });
  return (rows as Array<{ id: string | number; external_message_id: string }>).map((r) => ({
    id: Number(r.id),
    externalMessageId: r.external_message_id,
  }));
}

export async function findNewEbayMessages(
  app: Queryable,
  options: { readonly afterId: number; readonly limit: number },
): Promise<readonly CstEbayMessage[]> {
  const { rows } = await app.query({
    text: FIND_NEW_EBAY_MESSAGES,
    values: [options.afterId, options.limit],
  });
  return (rows as Array<{ id: string | number; external_message_id: string }>).map((r) => ({
    id: Number(r.id),
    externalMessageId: r.external_message_id,
  }));
}

export async function findEbayMessagesWithoutMedia(
  app: Queryable,
  options: { readonly upToId: number; readonly limit: number },
): Promise<readonly CstEbayMessage[]> {
  const { rows } = await app.query({
    text: FIND_EBAY_MESSAGES_WITHOUT_MEDIA,
    values: [options.upToId, options.limit],
  });
  return (rows as Array<{ id: string | number; external_message_id: string }>).map((r) => ({
    id: Number(r.id),
    externalMessageId: r.external_message_id,
  }));
}

/**
 * Applies newly resolved conversations to activity rows that were unmatched.
 *
 * Batched with `unnest`, one statement, every value bound. It can only move a
 * row from `unmatched` to `matched` — the WHERE clause refuses to touch
 * anything else — so a re-resolution cannot silently rewrite a row that was
 * already correct, and cannot reach a `no_reference` row at all.
 */
const PROMOTE_MATCHED = `
UPDATE cst_app.agent_activity a
SET conversation_id = v.conversation_id,
    match_status    = 'matched'
FROM (SELECT * FROM unnest($1::bigint[], $2::bigint[]) AS t(id, conversation_id)) v
WHERE a.id = v.id
  AND a.match_status = 'unmatched'`;

export const PROMOTE_MATCHED_SQL = PROMOTE_MATCHED;

export async function promoteMatchedActivity(
  app: Queryable,
  resolved: readonly { readonly id: number; readonly conversationId: number }[],
): Promise<number> {
  if (resolved.length === 0) return 0;
  const result = (await app.query({
    text: PROMOTE_MATCHED,
    values: [resolved.map((r) => r.id), resolved.map((r) => r.conversationId)],
  })) as { rows: unknown[]; rowCount?: number };
  return result.rowCount ?? 0;
}
