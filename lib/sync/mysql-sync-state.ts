import type { Queryable } from "@/lib/sync/message-sync";

/**
 * Checkpoints for the three MariaDB-sourced feeds, in the table that already
 * exists.
 *
 * ------------------------------------------------------------------------
 * `cst_app.sync_state` FITS TWO OF THE THREE, AND THE THIRD IS NOT FORCED
 * ------------------------------------------------------------------------
 * `watermark_source_pk` is `text`, so a MariaDB auto-increment id stores
 * without conversion, and `watermark_source_ts` is nullable, so a feed ordered
 * by id alone leaves it NULL rather than inventing a timestamp. Both eBay
 * feeds fit exactly and reuse the row that `uq_sync_state_feed` already keys.
 *
 * THE STAFF DIRECTORY DELIBERATELY HAS NO ROW HERE.
 * `ck_sync_state_marketplace` admits only ebay, amazon, shopify, bandq and
 * temu. A staff directory is none of those, and writing `'ebay'` to satisfy a
 * CHECK would put a false fact in a table other code reads to decide what to
 * sync next.
 *
 * It also needs no checkpoint. 234 rows are refreshed by one full idempotent
 * upsert — there is no cursor to resume from, nothing to skip, and re-running
 * costs a single MariaDB query. A watermark would be a column to maintain that
 * nothing reads. So the directory reports its outcome to the operator and
 * stores no state, and no new table was created to give it one.
 *
 * ------------------------------------------------------------------------
 * THE LOOKBACK IS NOT PARANOIA
 * ------------------------------------------------------------------------
 * `id > watermark` assumes auto-increment ids become visible in order. They do
 * not: MariaDB allocates the id when the row is inserted and publishes it at
 * COMMIT, so a long transaction can commit id 100 after id 105 is already
 * readable. A cursor that saw 105 would never look at 100 again.
 *
 * Every incremental read therefore restarts a fixed distance BELOW the
 * watermark. Re-reading those rows is free of consequence — every writer here
 * is an upsert keyed on the source id — so the only cost is a slightly wider
 * page, and the gain is that a late commit cannot be lost permanently.
 */

/** eBay is the real marketplace for both feeds; neither identity is invented. */
export const MYSQL_FEEDS = {
  agentActivity: {
    marketplace: "ebay",
    feedKey: "message-app-agent-activity",
    /** Watermark is `message_app.message_app_logs.id`. */
    watermarkMeaning: "message_app_logs.id",
  },
  messageMedia: {
    marketplace: "ebay",
    feedKey: "message-app-message-media",
    /** Watermark is `message_app.files.id`. */
    watermarkMeaning: "files.id",
  },
  /**
   * The reconciliation cursor, and the one whose watermark is NOT a MariaDB id.
   *
   * It walks `cst_app.conversation_messages.id` — newly ingested eBay messages —
   * because that is what unlocks a previously-skipped image. The feed key says
   * so out loud rather than leaving a reader to assume it is a source id.
   */
  messageMediaReconcile: {
    marketplace: "ebay",
    feedKey: "ebay-media-reconcile-by-cst-message-id",
    watermarkMeaning: "cst_app.conversation_messages.id",
  },
} as const;

export type MysqlFeed = (typeof MYSQL_FEEDS)[keyof typeof MYSQL_FEEDS];

const READ = `
SELECT watermark_source_pk AS pk
FROM cst_app.sync_state
WHERE marketplace = $1 AND feed_key = $2`;

/**
 * Upserts the checkpoint. `watermark_source_ts` is left untouched — these feeds
 * order by id, and writing a timestamp would claim an ordering they do not use.
 *
 * `last_error` is cleared on success so a recovered feed does not keep
 * displaying the failure it recovered from, and set on failure because
 * `ck_sync_state_error_detail` requires a reason whenever the status is error.
 */
const WRITE = `
INSERT INTO cst_app.sync_state
  (marketplace, feed_key, watermark_source_pk, last_run_at, last_success_at, last_status, last_error)
VALUES ($1, $2, $3, now(),
        CASE WHEN $4::text = 'ok' THEN now() ELSE NULL END,
        $4, $5)
ON CONFLICT (marketplace, feed_key) DO UPDATE
  SET watermark_source_pk = COALESCE(EXCLUDED.watermark_source_pk, cst_app.sync_state.watermark_source_pk),
      last_run_at         = now(),
      last_success_at     = CASE WHEN EXCLUDED.last_status = 'ok'
                                 THEN now() ELSE cst_app.sync_state.last_success_at END,
      last_status         = EXCLUDED.last_status,
      last_error          = EXCLUDED.last_error,
      updated_at          = now()`;

export const READ_WATERMARK_SQL = READ;
export const WRITE_WATERMARK_SQL = WRITE;

/** The stored watermark, or 0 when this feed has never run. */
export async function readWatermark(app: Queryable, feed: MysqlFeed): Promise<number> {
  const { rows } = await app.query({ text: READ, values: [feed.marketplace, feed.feedKey] });
  const pk = (rows[0] as { pk: string | null } | undefined)?.pk ?? null;
  if (pk === null) return 0;
  const parsed = Number(pk);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${feed.feedKey}: stored watermark is not a positive integer: ${pk}`);
  }
  return parsed;
}

export async function writeWatermark(
  app: Queryable,
  feed: MysqlFeed,
  options: {
    readonly watermark: number | null;
    readonly status: "ok" | "error";
    readonly error?: string;
  },
): Promise<void> {
  if (options.status === "error" && !options.error) {
    throw new Error(`${feed.feedKey}: an error status requires a reason`);
  }
  await app.query({
    text: WRITE,
    values: [
      feed.marketplace,
      feed.feedKey,
      options.watermark === null ? null : String(options.watermark),
      options.status,
      options.status === "error" ? (options.error ?? null) : null,
    ],
  });
}

/** Default distance below the watermark that every incremental read restarts from. */
export const DEFAULT_LOOKBACK = 500;

/**
 * Where an incremental read should actually start.
 *
 * Never below zero, and never above the watermark — a lookback larger than the
 * watermark means "start at the beginning", not "start at a negative id".
 */
export function startFrom(watermark: number, lookback: number = DEFAULT_LOOKBACK): number {
  if (!Number.isInteger(watermark) || watermark < 0) {
    throw new Error(`watermark must be a non-negative integer, received: ${String(watermark)}`);
  }
  if (!Number.isInteger(lookback) || lookback < 0) {
    throw new Error(`lookback must be a non-negative integer, received: ${String(lookback)}`);
  }
  return Math.max(0, watermark - lookback);
}
