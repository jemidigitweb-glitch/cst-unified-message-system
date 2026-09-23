import "server-only";

/**
 * Resolving eBay's `ext_message_id` to a CST conversation, in batches.
 *
 * TWO HOPS, TWO DATABASES, AND THEY ARE NOT THE SAME NUMBER.
 *
 *   message_app_logs.data->>'ext_message_id'   13 digits, eBay's message key
 *     -> ledsone.customer_service.ebay_message_headers.ext_message_id
 *     -> .message_id                            12 digits, the header key
 *     -> varmen_db.cst_app.conversation_messages.external_message_id
 *     -> .conversation_id
 *
 * The middle step is the one that cannot be skipped and the one that is easy to
 * get wrong: `cst_app` stores `message_id`, not `ext_message_id` — see
 * `normalizeRow` in `lib/marketplaces/ebay/adapter.ts`, which sets
 * `externalMessageId: row.message_id`. Joining the log straight against
 * `external_message_id` matches nothing, silently, and every row reads as
 * unmatched.
 *
 * Measured on live data: 2,885 of 2,885 log references resolved in
 * `ebay_message_headers` (100.0%), of which 2,817 were present in `cst_app`
 * (97.6%).
 *
 * BATCHED, NOT PER ROW. Each hop is one `= ANY($1)` per page, so a 2,000-row
 * page costs two queries rather than four thousand. Nothing here opens a
 * connection; both clients are supplied by the caller.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT. The `ledsone` client is the
 * source pool, which pins `default_transaction_read_only=on` at the session
 * level, so the server refuses a write regardless of this file's discipline.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * `ext_message_id::text` because the column is a bigint and values run past
 * 6.4e12 — comfortably inside a double, but the map key must be a string on
 * both sides or lookups miss on type alone.
 */
const FIND_HEADER_MESSAGE_IDS = `
SELECT ext_message_id::text AS ext_message_id,
       message_id           AS message_id
FROM customer_service.ebay_message_headers
WHERE ext_message_id = ANY($1::bigint[])
  AND message_id IS NOT NULL`;

/**
 * The message row itself, not just its conversation.
 *
 * `id` is what `conversation_message_media.conversation_message_id` references;
 * `direction` is the ONLY honest source of who attached an image, because
 * `files.submitter` is NULL on every one of the 12,965 message-media rows.
 *
 * `source_table` is pinned. eBay's `external_message_id` is a bare numeric
 * string, and so are some other feeds' — without this, a numeric id from
 * another marketplace could satisfy the lookup and attach an eBay photograph
 * to somebody else's message. The two-hop mapping is defined against eBay
 * headers, so the query says so.
 */
const FIND_CONVERSATIONS = `
SELECT external_message_id,
       id AS conversation_message_id,
       conversation_id,
       direction
FROM cst_app.conversation_messages
WHERE external_message_id = ANY($1::text[])
  AND source_table = 'ebay_message_headers'`;

export const FIND_HEADER_MESSAGE_IDS_SQL = FIND_HEADER_MESSAGE_IDS;
export const FIND_CONVERSATIONS_SQL = FIND_CONVERSATIONS;

/**
 * ext_message_id -> message_id, for the ids given. Absent keys did not resolve.
 *
 * A header with a NULL `message_id` is excluded rather than mapped to null:
 * there is nothing to look up in `cst_app` with, so it is indistinguishable
 * from "no header" for this purpose, and one absent-key rule is simpler to
 * reason about than two.
 */
export async function findHeaderMessageIds(
  source: Queryable,
  extMessageIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (extMessageIds.length === 0) return new Map();
  const { rows } = await source.query({
    text: FIND_HEADER_MESSAGE_IDS,
    values: [[...new Set(extMessageIds)]],
  });
  return new Map(
    (rows as Array<{ ext_message_id: string; message_id: string }>).map((r) => [
      r.ext_message_id,
      String(r.message_id),
    ]),
  );
}

/** What CST knows about one eBay message, once it has been resolved. */
export type EbayMessageLink = {
  /** The row `conversation_message_media.conversation_message_id` references. */
  readonly conversationMessageId: number;
  readonly conversationId: number;
  /** Who wrote it. The only honest source of image authorship. */
  readonly direction: "inbound" | "outbound";
};

/**
 * message_id -> the CST message, for the ids given.
 *
 * One message belongs to exactly one conversation
 * (`conversation_messages.conversation_id` is NOT NULL and the row is unique on
 * its source identity), so the last write into the map cannot disagree with an
 * earlier one for the same key.
 */
export async function findConversationMessages(
  app: Queryable,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, EbayMessageLink>> {
  if (messageIds.length === 0) return new Map();
  const { rows } = await app.query({
    text: FIND_CONVERSATIONS,
    values: [[...new Set(messageIds)]],
  });
  return new Map(
    (
      rows as Array<{
        external_message_id: string;
        conversation_message_id: string | number;
        conversation_id: string | number;
        direction: "inbound" | "outbound";
      }>
    ).map((r) => [
      r.external_message_id,
      {
        conversationMessageId: Number(r.conversation_message_id),
        conversationId: Number(r.conversation_id),
        direction: r.direction,
      },
    ]),
  );
}

/**
 * Both hops for one page: ext_message_id -> the CST message.
 *
 * An id missing from the result did not resolve, and the caller keeps it as
 * unmatched. There is deliberately no fallback, no fuzzy match and no
 * nearest-timestamp guess — a wrong message id would hang one customer's
 * photograph on another customer's thread.
 */
export async function resolveMessagesByExtMessageId(
  source: Queryable,
  app: Queryable,
  extMessageIds: readonly string[],
): Promise<ReadonlyMap<string, EbayMessageLink>> {
  const headers = await findHeaderMessageIds(source, extMessageIds);
  if (headers.size === 0) return new Map();

  const messages = await findConversationMessages(app, [...headers.values()]);

  const resolved = new Map<string, EbayMessageLink>();
  for (const [extMessageId, messageId] of headers) {
    const link = messages.get(messageId);
    if (link !== undefined) resolved.set(extMessageId, link);
  }
  return resolved;
}

/**
 * The conversation only, for callers that do not need the message row.
 *
 * Delegates rather than issuing its own pair of queries, so the two-hop rule —
 * and the `source_table` pin that keeps it honest — has exactly one definition
 * in this codebase.
 */
export async function resolveConversationsByExtMessageId(
  source: Queryable,
  app: Queryable,
  extMessageIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const links = await resolveMessagesByExtMessageId(source, app, extMessageIds);
  return new Map([...links].map(([extMessageId, link]) => [extMessageId, link.conversationId]));
}
