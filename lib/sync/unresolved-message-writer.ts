import type {
  SourceWatermark,
  UnresolvedSourceMessage,
} from "@/lib/domain/source-message";

/**
 * Idempotent persistence of unverified-direction source messages into cst_app.
 *
 * Writes ONLY to cst_app.unresolved_marketplace_messages and cst_app.sync_state.
 * Nothing here can reach issue_tracking, poc_listing or public, and no
 * context/order/SKU/product table is touched.
 *
 * REQUIRES migration 0002, which is written but NOT executed. Until it is
 * reviewed and applied, calling this fails loudly with `undefined_table` rather
 * than silently writing a guessed direction into the conversation tables.
 *
 * Idempotency rests on the unique constraint the migration declares:
 *   unresolved_marketplace_messages (source_database, source_schema,
 *                                    source_table, source_pk)
 *
 * Every statement is a parameterised upsert. Nothing is truncated or deleted,
 * and unrelated rows are never touched.
 */

/** The slice of node-postgres this writer needs. */
export type Writable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export type UnresolvedPersistStats = {
  readonly messagesInserted: number;
  readonly messagesUpdated: number;
  readonly watermark: SourceWatermark | null;
};

/**
 * Message upsert.
 *
 * `source_ts` is written once and never updated — the source timestamp is
 * immutable, and rewriting it is how a silent timezone shift would creep in.
 * `source_ts_utc` and `source_ts_zone` are hard-coded NULL: the authoritative
 * source zone is still unconfirmed, so no normalised value may be invented.
 *
 * Note there is no direction, counterparty or conversation column to write. The
 * table has none, so this writer has no way to invent one even by mistake.
 */
const UPSERT_MESSAGES = `
INSERT INTO cst_app.unresolved_marketplace_messages (
  marketplace, source_database, source_schema, source_table, source_pk,
  external_message_id, sub_source_id, source_ts, source_ts_utc, source_ts_zone,
  body_text, body_decode_status, source_reference
)
SELECT c.marketplace, c.source_database, c.source_schema, c.source_table, c.source_pk,
       c.external_message_id, c.sub_source_id, c.source_ts, NULL, NULL,
       c.body_text, c.body_decode_status, c.source_reference
FROM unnest(
  $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
  $6::text[], $7::int[], $8::timestamp[], $9::text[], $10::text[], $11::text[]
) AS c(marketplace, source_database, source_schema, source_table, source_pk,
       external_message_id, sub_source_id, source_ts, body_text,
       body_decode_status, source_reference)
ON CONFLICT (source_database, source_schema, source_table, source_pk) DO UPDATE SET
  body_text          = EXCLUDED.body_text,
  body_decode_status = EXCLUDED.body_decode_status,
  source_reference   = EXCLUDED.source_reference
RETURNING (xmax = 0) AS inserted`;

/**
 * Sync cursor upsert.
 *
 * Shares cst_app.sync_state with the conversation feeds, keyed on
 * (marketplace, feed_key), so each marketplace's cursor stays independent and
 * this can never disturb another's. The watermark only ever moves forward: a
 * re-run over an older or identical window cannot drag the cursor backwards and
 * cause rows to be re-read or, worse, skipped on the next resume.
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
  updated_at      = now()`;

/** Highest (timestamp, pk) pair across the messages actually being persisted. */
export function highestWatermark(
  messages: readonly UnresolvedSourceMessage[],
): SourceWatermark | null {
  let best: UnresolvedSourceMessage | null = null;
  for (const message of messages) {
    if (
      best === null ||
      message.sourceTimestamp > best.sourceTimestamp ||
      (message.sourceTimestamp === best.sourceTimestamp &&
        Number(message.sourcePk) > Number(best.sourcePk))
    ) {
      best = message;
    }
  }
  return best ? { sourceTimestamp: best.sourceTimestamp, sourcePk: best.sourcePk } : null;
}

/**
 * Persists unresolved messages, then advances the sync cursor.
 *
 * The caller owns the transaction. The cursor is written last, inside that same
 * transaction, so a failure anywhere leaves the cursor no further ahead than the
 * data that actually landed.
 */
export async function persistUnresolvedMessages(
  client: Writable,
  params: {
    readonly marketplace: string;
    readonly feedKey: string;
    readonly messages: readonly UnresolvedSourceMessage[];
  },
): Promise<UnresolvedPersistStats> {
  const { messages } = params;
  if (messages.length === 0) {
    return { messagesInserted: 0, messagesUpdated: 0, watermark: null };
  }

  const result = await client.query({
    text: UPSERT_MESSAGES,
    values: [
      messages.map((m) => m.marketplace),
      messages.map((m) => m.sourceDatabase),
      messages.map((m) => m.sourceSchema),
      messages.map((m) => m.sourceTable),
      messages.map((m) => m.sourcePk),
      messages.map((m) => m.externalMessageId),
      messages.map((m) => m.subSourceId),
      messages.map((m) => m.sourceTimestamp),
      messages.map((m) => m.bodyText),
      messages.map((m) => m.bodyDecodeStatus),
      messages.map((m) => m.sourceReference),
    ],
  });

  let messagesInserted = 0;
  for (const raw of result.rows) {
    if ((raw as { inserted: boolean }).inserted) messagesInserted += 1;
  }

  const watermark = highestWatermark(messages);
  if (watermark !== null) {
    await client.query({
      text: UPSERT_SYNC_STATE,
      values: [params.marketplace, params.feedKey, watermark.sourceTimestamp, watermark.sourcePk],
    });
  }

  return {
    messagesInserted,
    messagesUpdated: messages.length - messagesInserted,
    watermark,
  };
}
