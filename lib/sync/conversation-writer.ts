import type { DerivedConversation } from "@/lib/domain/conversation";
import type { SourceMessage, SourceWatermark } from "@/lib/domain/source-message";

/**
 * Idempotent persistence of derived conversations into cst_app.
 *
 * Writes ONLY to cst_app.conversations, cst_app.conversation_messages and
 * cst_app.sync_state. Nothing here can reach issue_tracking, poc_listing or
 * public, and no context/order/SKU/product table is touched.
 *
 * Idempotency rests on the two unique constraints already in the schema:
 *   conversations          (threading_rule_version, thread_key)
 *   conversation_messages  (source_database, source_schema, source_table, source_pk)
 *
 * Every statement is a parameterised upsert. Nothing is truncated or deleted,
 * and unrelated rows are never touched.
 */

/** The slice of node-postgres this writer needs. */
export type Writable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export type PersistStats = {
  readonly conversationsInserted: number;
  readonly conversationsUpdated: number;
  readonly messagesInserted: number;
  readonly messagesUpdated: number;
  /** Conversations whose counters this batch corrected. Zero on a repeat run. */
  readonly conversationsRecounted: number;
  readonly watermark: SourceWatermark | null;
};

/**
 * Conversations upsert.
 *
 * `workflow_state` is set on INSERT only and is deliberately absent from the
 * DO UPDATE list: re-running a bootstrap must never drag a conversation that has
 * progressed to drafting or pending_review back to `received`.
 *
 * `first_source_ts` / `last_source_ts` widen rather than overwrite, so a partial
 * re-read cannot narrow a conversation's known span.
 */
const UPSERT_CONVERSATIONS = `
INSERT INTO cst_app.conversations (
  marketplace, sub_source_id, thread_key, threading_rule_version, threading_strategy,
  listing_item_ref, counterparty_ref, first_source_ts, last_source_ts,
  workflow_state, needs_context, inbox_visibility, message_count, inbound_count,
  inbox_filter_reason
)
SELECT * FROM unnest(
  $1::text[], $2::int[], $3::text[], $4::text[], $5::text[],
  $6::text[], $7::text[], $8::timestamp[], $9::timestamp[],
  $10::text[], $11::boolean[], $12::text[], $13::int[], $14::int[],
  $15::text[]
)
ON CONFLICT (threading_rule_version, thread_key) DO UPDATE SET
  first_source_ts     = LEAST(conversations.first_source_ts, EXCLUDED.first_source_ts),
  last_source_ts      = GREATEST(conversations.last_source_ts, EXCLUDED.last_source_ts),
  needs_context       = EXCLUDED.needs_context,
  inbox_visibility    = EXCLUDED.inbox_visibility,
  -- Widened, not overwritten, same as the timestamps above. This row is
  -- transient: RECOUNT_CONVERSATIONS below replaces it with the true total
  -- moments later. But the row still has to satisfy
  -- ck_conversations_reply_inbox_needs_inbound the instant this statement
  -- runs — a page that flips a thread to reply_inbox would otherwise pair
  -- that with the stale pre-recount inbound_count, which can be 0.
  message_count       = GREATEST(conversations.message_count, EXCLUDED.message_count),
  inbound_count       = GREATEST(conversations.inbound_count, EXCLUDED.inbound_count),
  inbox_filter_reason = EXCLUDED.inbox_filter_reason,
  updated_at          = now()
RETURNING id, threading_rule_version, thread_key, (xmax = 0) AS inserted`;

/**
 * Recomputes the conversation counters from the messages themselves.
 *
 * THE BUG THIS FIXES. `message_count` and `inbound_count` used to be written
 * from EXCLUDED — the counts of the batch being persisted. That was right for a
 * one-shot bootstrap, where every message of a conversation arrived together,
 * and wrong the moment sync became incremental: each page carries only its own
 * messages, so the last page's partial count overwrote the true total. One
 * ten-message eBay thread was stored as three, with one inbound of five.
 *
 * ADDING THE PAGE'S COUNT INSTEAD WOULD BE WORSE. It reads as the obvious fix
 * and it breaks idempotency: re-running the same page — which the writer must
 * tolerate, since that is what its unique constraints are for — would count
 * those messages twice and keep climbing on every re-run.
 *
 * So the count is not tracked at all; it is DERIVED. `conversation_messages` is
 * the authority, this reads it, and the answer is the same however many times
 * it runs and in whatever order the pages arrived.
 *
 * Runs AFTER the messages are upserted, inside the same transaction, so the
 * counters can never describe a set of rows that failed to land. Scoped to the
 * conversations in this batch rather than the whole table.
 *
 * The final predicate skips rows that are already right, so a repeat sync
 * reports no work and does not churn `updated_at`.
 */
const RECOUNT_CONVERSATIONS = `
UPDATE cst_app.conversations c
SET message_count = t.total,
    inbound_count = t.inbound,
    updated_at    = now()
FROM (
  SELECT conversation_id,
         count(*)::int                                        AS total,
         count(*) FILTER (WHERE direction = 'inbound')::int    AS inbound
  FROM cst_app.conversation_messages
  WHERE conversation_id = ANY($1::bigint[])
  GROUP BY conversation_id
) AS t
WHERE c.id = t.conversation_id
  AND (c.message_count IS DISTINCT FROM t.total
    OR c.inbound_count IS DISTINCT FROM t.inbound)
RETURNING c.id`;

/**
 * Messages upsert.
 *
 * `source_ts` is written once and never updated — the source timestamp is
 * immutable, and rewriting it is how a silent timezone shift would creep in.
 * `source_ts_utc` and `source_ts_zone` are hard-coded NULL: the authoritative
 * source zone is still unconfirmed, so no normalised value may be invented.
 */
const UPSERT_MESSAGES = `
INSERT INTO cst_app.conversation_messages (
  conversation_id, source_database, source_schema, source_table, source_pk,
  external_message_id, direction, source_ts, source_ts_utc, source_ts_zone,
  body_text, body_decode_status
)
SELECT c.conversation_id, c.source_database, c.source_schema, c.source_table, c.source_pk,
       c.external_message_id, c.direction, c.source_ts, NULL, NULL,
       c.body_text, c.body_decode_status
FROM unnest(
  $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[],
  $6::text[], $7::text[], $8::timestamp[], $9::text[], $10::text[]
) AS c(conversation_id, source_database, source_schema, source_table, source_pk,
       external_message_id, direction, source_ts, body_text, body_decode_status)
ON CONFLICT (source_database, source_schema, source_table, source_pk) DO UPDATE SET
  conversation_id    = EXCLUDED.conversation_id,
  body_text          = EXCLUDED.body_text,
  body_decode_status = EXCLUDED.body_decode_status
RETURNING (xmax = 0) AS inserted`;

/**
 * Sync cursor upsert.
 *
 * The watermark only ever moves forward: a re-run over an older or identical
 * window cannot drag the cursor backwards and cause rows to be re-read or, worse,
 * skipped on the next resume.
 */
const UPSERT_SYNC_STATE = `
INSERT INTO cst_app.sync_state (
  marketplace, feed_key, watermark_source_ts, watermark_source_pk,
  last_run_at, last_success_at, last_status, last_error
)
VALUES ($1, $2, $3::timestamp, $4, now(), now(), 'ok', NULL)
ON CONFLICT (marketplace, feed_key) DO UPDATE SET
  watermark_source_ts = CASE
    WHEN (COALESCE(sync_state.watermark_source_ts, '-infinity'::timestamp),
          COALESCE(sync_state.watermark_source_pk, '0')::bigint)
       < (EXCLUDED.watermark_source_ts, EXCLUDED.watermark_source_pk::bigint)
    THEN EXCLUDED.watermark_source_ts ELSE sync_state.watermark_source_ts END,
  watermark_source_pk = CASE
    WHEN (COALESCE(sync_state.watermark_source_ts, '-infinity'::timestamp),
          COALESCE(sync_state.watermark_source_pk, '0')::bigint)
       < (EXCLUDED.watermark_source_ts, EXCLUDED.watermark_source_pk::bigint)
    THEN EXCLUDED.watermark_source_pk ELSE sync_state.watermark_source_pk END,
  last_run_at     = now(),
  last_success_at = now(),
  last_status     = 'ok',
  last_error      = NULL,
  updated_at      = now()
RETURNING watermark_source_ts::text AS ts, watermark_source_pk AS pk`;

/** Highest (timestamp, pk) pair across the messages actually being persisted. */
export function highestWatermark(
  conversations: readonly DerivedConversation[],
): SourceWatermark | null {
  let best: SourceMessage | null = null;
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (
        best === null ||
        message.sourceTimestamp > best.sourceTimestamp ||
        (message.sourceTimestamp === best.sourceTimestamp &&
          Number(message.sourcePk) > Number(best.sourcePk))
      ) {
        best = message;
      }
    }
  }
  return best ? { sourceTimestamp: best.sourceTimestamp, sourcePk: best.sourcePk } : null;
}

/**
 * Persists conversations and their messages, then advances the sync cursor.
 *
 * The caller owns the transaction. The cursor is written last, inside that same
 * transaction, so a failure anywhere leaves the cursor no further ahead than the
 * data that actually landed.
 */
export async function persistConversations(
  client: Writable,
  params: {
    readonly marketplace: string;
    readonly feedKey: string;
    readonly conversations: readonly DerivedConversation[];
  },
): Promise<PersistStats> {
  const { conversations } = params;
  if (conversations.length === 0) {
    return {
      conversationsInserted: 0,
      conversationsUpdated: 0,
      messagesInserted: 0,
      messagesUpdated: 0,
      conversationsRecounted: 0,
      watermark: null,
    };
  }

  const convResult = await client.query({
    text: UPSERT_CONVERSATIONS,
    values: [
      conversations.map((c) => c.marketplace),
      conversations.map((c) => c.subSourceId),
      conversations.map((c) => c.threadKey),
      conversations.map((c) => c.threadingRuleVersion),
      conversations.map((c) => c.threadingStrategy),
      conversations.map((c) => c.listingItemRef),
      conversations.map((c) => c.counterpartyRef),
      conversations.map((c) => c.firstSourceTimestamp),
      conversations.map((c) => c.lastSourceTimestamp),
      conversations.map(() => "received"),
      conversations.map((c) => c.needsContext),
      conversations.map((c) => c.inboxPlacement),
      conversations.map((c) => c.messageCount),
      conversations.map((c) => c.inboundCount),
      conversations.map((c) => c.inboxFilterReason),
    ],
  });

  const idByKey = new Map<string, string>();
  let conversationsInserted = 0;
  for (const raw of convResult.rows) {
    const row = raw as {
      id: string;
      threading_rule_version: string;
      thread_key: string;
      inserted: boolean;
    };
    idByKey.set(`${row.threading_rule_version} ${row.thread_key}`, String(row.id));
    if (row.inserted) conversationsInserted += 1;
  }

  const flat: { conversationId: string; message: SourceMessage }[] = [];
  for (const conversation of conversations) {
    const id = idByKey.get(
      `${conversation.threadingRuleVersion} ${conversation.threadKey}`,
    );
    if (id === undefined) {
      throw new Error("Conversation upsert did not return an id for a persisted thread key");
    }
    for (const message of conversation.messages) flat.push({ conversationId: id, message });
  }

  let messagesInserted = 0;
  if (flat.length > 0) {
    const msgResult = await client.query({
      text: UPSERT_MESSAGES,
      values: [
        flat.map((f) => f.conversationId),
        flat.map((f) => f.message.sourceDatabase),
        flat.map((f) => f.message.sourceSchema),
        flat.map((f) => f.message.sourceTable),
        flat.map((f) => f.message.sourcePk),
        flat.map((f) => f.message.externalMessageId),
        flat.map((f) => f.message.direction),
        flat.map((f) => f.message.sourceTimestamp),
        flat.map((f) => f.message.bodyText),
        flat.map((f) => f.message.bodyDecodeStatus),
      ],
    });
    for (const raw of msgResult.rows) {
      if ((raw as { inserted: boolean }).inserted) messagesInserted += 1;
    }
  }

  /**
   * Counters last, from the messages that just landed.
   *
   * Order matters: this reads `conversation_messages`, so it has to follow the
   * message upsert. Inside the same transaction, so a rollback takes the
   * counters with the rows they describe.
   */
  const recounted = await client.query({
    text: RECOUNT_CONVERSATIONS,
    values: [[...idByKey.values()]],
  });
  const conversationsRecounted = recounted.rows.length;

  const watermark = highestWatermark(conversations);
  if (watermark !== null) {
    await client.query({
      text: UPSERT_SYNC_STATE,
      values: [params.marketplace, params.feedKey, watermark.sourceTimestamp, watermark.sourcePk],
    });
  }

  return {
    conversationsInserted,
    conversationsUpdated: conversations.length - conversationsInserted,
    messagesInserted,
    messagesUpdated: flat.length - messagesInserted,
    conversationsRecounted,
    watermark,
  };
}
