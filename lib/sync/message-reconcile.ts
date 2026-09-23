import { EBAY_SOURCE } from "@/lib/marketplaces/ebay/adapter";
import { AMAZON_SOURCE } from "@/lib/marketplaces/amazon/adapter";
import { SHOPIFY_SOURCE } from "@/lib/marketplaces/shopify/adapter";
import { BANDQ_SOURCE } from "@/lib/marketplaces/bandq/adapter";
import { TEMU_SOURCE } from "@/lib/marketplaces/temu/adapter";
import type { Marketplace } from "@/lib/domain/marketplace";
import type { SourceWatermark } from "@/lib/domain/source-message";
import { MAX_PK_BATCH } from "@/lib/marketplaces/source-fetch";

import { type PkReader, REPAIR_READERS } from "./body-repair";
import { persistConversations } from "./conversation-writer";
import { type Queryable, type SyncFeed, readWatermark } from "./message-sync";

/**
 * Finds and ingests source messages the incremental cursor can never reach.
 *
 * ------------------------------------------------------------------------
 * WHY A CURSOR IS NOT ENOUGH, AND WHY THIS IS NOT A BETTER CURSOR
 * ------------------------------------------------------------------------
 * `syncFeed` resumes from `(source_timestamp, source_pk) > (watermark)`, ordered
 * the same way. That is a correct cursor over a table whose rows arrive in the
 * order the cursor sorts by. The marketplace mirror is not such a table: it
 * re-ingests deleted-and-returning emails continuously, so a row can appear —
 * or have its timestamp change — at a position the cursor has already passed.
 * Once that happens the row is invisible to every future pass, permanently.
 *
 * MEASURED, NOT ASSUMED. Over 1–22 September 2026, `customer_service.shopify_messages`
 * held 7,790 rows up to the live watermark and `cst_app` held 5,769 of them:
 * 2,021 missing, 26%, 43–146 on every single day, 720 of them carrying an
 * extracted order number. None was explained by pk churn — all 2,021 were absent
 * under their Message-ID as well as under their pk.
 *
 * Shopify conversation 46268 (order LED65289) is the case that exposed it. Two
 * of its seven messages never arrived, including the customer reporting at 11:52
 * on the 21st that she had received someone else's parcel. The five the app did
 * hold are all order-change requests, so the inbox showed "Order change, before
 * shipping queries" for a wrong-item case. The classifier was right; its input
 * was missing a message.
 *
 * THE OBVIOUS FIX IS THE WRONG ONE. Re-ordering the cursor on some other column
 * — a mirror-side `synced_at`, an insert sequence — only moves the assumption:
 * every full mirror pass rewrites `synced_at` on every row, so that cursor would
 * re-read the whole table, and no column the mirror offers is documented as
 * monotonic with arrival. `shopify_messages.id` is explicitly marked "do NOT
 * join on this", and even `source_id` "is not stable".
 *
 * So this asks the one question that is answerable however the mirror behaves:
 * WHICH PRIMARY KEYS IN THIS WINDOW DOES cst_app NOT HAVE? A set difference has
 * no resume point to be wrong about, and it converges regardless of the order
 * rows appeared in.
 *
 * ------------------------------------------------------------------------
 * IT STRUCTURALLY CANNOT DISTURB THE LIVE CURSOR
 * ------------------------------------------------------------------------
 * Two independent reasons, and neither is discipline:
 *
 *   1. It persists under its OWN feed key (`<marketplace>-reconcile`), so the
 *      incremental feed's `sync_state` row is never the row being written. The
 *      reconcile keeps its own high-water mark, which is a record of what it has
 *      backfilled and nothing the live sync reads.
 *   2. `UPSERT_SYNC_STATE` advances a watermark and never retreats one — the
 *      CASE guards both columns. Backfilling three-week-old rows therefore
 *      cannot rewind anything even if the keys were shared.
 *
 * WRITES NOTHING THE SYNC DOES NOT WRITE. It calls `persistConversations`, the
 * same function and therefore the same upserts and the same recount. There is
 * one INSERT into `conversation_messages` in this codebase and this is not a
 * second one, so a backfilled message is indistinguishable from a synced one.
 *
 * READS the marketplace source, WRITES `cst_app` only.
 *
 * ------------------------------------------------------------------------
 * BOUNDED, LIKE BOOTSTRAP, AND FOR THE SAME REASON
 * ------------------------------------------------------------------------
 * The window is required and has no open end. An unbounded reconcile is a full
 * historical re-read wearing a repair's name, and the one thing it must not do
 * is become the thing somebody runs by accident against a shared production
 * source.
 *
 * NOTHING IS DROPPED SILENTLY. A pk the source no longer answers for, and a row
 * the marketplace's own rules cannot represent, are counted and reported
 * separately — see `ReconcileOutcome`. A pass that quietly did nothing 2,000
 * times and reported success would be worse than one that failed.
 */

/**
 * The relation to enumerate primary keys from, per marketplace.
 *
 * DERIVED FROM EACH ADAPTER'S OWN FROZEN DESCRIPTOR, never restated. The table,
 * pk and timestamp names come from the same constants the sync reads, so a
 * marketplace that moves its source cannot leave this file pointing at the old
 * one. eBay enumerates its HEADER table, because that is the row a message is
 * keyed by and what `conversation_messages.source_table` records for it.
 */
export type ReconcileRelation = {
  readonly database: string;
  readonly schema: string;
  readonly table: string;
  readonly pkColumn: string;
  readonly timestampColumn: string;
};

export const RECONCILE_RELATIONS: Readonly<Record<Marketplace, ReconcileRelation>> = {
  ebay: {
    database: EBAY_SOURCE.database,
    schema: EBAY_SOURCE.schema,
    table: EBAY_SOURCE.headerTable,
    pkColumn: EBAY_SOURCE.pkColumn,
    timestampColumn: EBAY_SOURCE.timestampColumn,
  },
  amazon: {
    database: AMAZON_SOURCE.database,
    schema: AMAZON_SOURCE.schema,
    table: AMAZON_SOURCE.messageTable,
    pkColumn: AMAZON_SOURCE.pkColumn,
    timestampColumn: AMAZON_SOURCE.timestampColumn,
  },
  shopify: {
    database: SHOPIFY_SOURCE.database,
    schema: SHOPIFY_SOURCE.schema,
    table: SHOPIFY_SOURCE.messageTable,
    pkColumn: SHOPIFY_SOURCE.pkColumn,
    timestampColumn: SHOPIFY_SOURCE.timestampColumn,
  },
  bandq: {
    database: BANDQ_SOURCE.database,
    schema: BANDQ_SOURCE.schema,
    table: BANDQ_SOURCE.messageTable,
    pkColumn: BANDQ_SOURCE.pkColumn,
    timestampColumn: BANDQ_SOURCE.timestampColumn,
  },
  temu: {
    database: TEMU_SOURCE.database,
    schema: TEMU_SOURCE.schema,
    table: TEMU_SOURCE.messageTable,
    pkColumn: TEMU_SOURCE.pkColumn,
    timestampColumn: TEMU_SOURCE.timestampColumn,
  },
};

/** The reconcile's own cursor row, never the live feed's. */
export function reconcileFeedKey(marketplace: Marketplace): string {
  return `${marketplace}-reconcile`;
}

/**
 * The span to reconcile. Half-open: `from` inclusive, `to` exclusive.
 *
 * Both ends required. See the header — there is deliberately no open-ended mode.
 */
export type ReconcileWindow = {
  readonly from: string;
  readonly to: string;
};

export const DEFAULT_RECONCILE_LIMIT = 2000;
export const MAX_RECONCILE_LIMIT = 20_000;

export function assertWindow(window: ReconcileWindow): void {
  if (!window.from || !window.to) {
    throw new Error("a reconcile window needs both `from` and `to`");
  }
  if (window.from >= window.to) {
    throw new Error(`reconcile window is empty or inverted: ${window.from} .. ${window.to}`);
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RECONCILE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, received: ${String(limit)}`);
  }
  return Math.min(limit, MAX_RECONCILE_LIMIT);
}

function clampBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return MAX_PK_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, received: ${String(batchSize)}`);
  }
  return Math.min(batchSize, MAX_PK_BATCH);
}

/**
 * Every primary key the source holds in the window.
 *
 * Only the pk and the timestamp are read. This is a key enumeration, not a
 * message read — the bodies are fetched later, and only for the keys that turn
 * out to be missing, so a window where nothing is missing costs no body reads at
 * all.
 *
 * Identifiers come from the frozen descriptor above; the window is
 * parameterised. Ordered so the capped run takes the OLDEST gaps first: a
 * missing message that has been missing longest is the one a reviewer has
 * already failed to see.
 */
export function buildSourcePkQuery(
  relation: ReconcileRelation,
  window: ReconcileWindow,
): { text: string; values: unknown[] } {
  assertWindow(window);
  return {
    text:
      `SELECT m.${relation.pkColumn}::text AS source_pk` +
      `\n  FROM ${relation.schema}.${relation.table} m` +
      `\n  WHERE m.${relation.timestampColumn} >= $1::timestamp` +
      `\n    AND m.${relation.timestampColumn} <  $2::timestamp` +
      `\n  ORDER BY m.${relation.timestampColumn} ASC, m.${relation.pkColumn} ASC`,
    values: [window.from, window.to],
  };
}

/**
 * Every primary key cst_app already holds in the window.
 *
 * BOTH DESTINATIONS, and this is what keeps the reconcile from fighting the
 * ambiguous feed. A message whose direction could not be decided was never a
 * conversation message — it was deliberately routed to
 * `unresolved_marketplace_messages`. Counting only `conversation_messages`
 * would read those as missing and try to ingest them on every run, forever,
 * against the very rule that put them there.
 *
 * Matched on the three source coordinates plus the table, which is the identity
 * the unique constraints use, so nothing is matched across marketplaces.
 */
export const SELECT_APP_PKS_IN_WINDOW = `
SELECT source_pk FROM cst_app.conversation_messages
 WHERE source_database = $1 AND source_schema = $2 AND source_table = $3
   AND source_ts >= $4::timestamp AND source_ts < $5::timestamp
UNION
SELECT source_pk FROM cst_app.unresolved_marketplace_messages
 WHERE source_database = $1 AND source_schema = $2 AND source_table = $3
   AND source_ts >= $4::timestamp AND source_ts < $5::timestamp`;

async function readPkSet(
  client: Queryable,
  query: { text: string; values?: unknown[] },
): Promise<Set<string>> {
  const { rows } = await client.query(query);
  return new Set((rows as { source_pk: string }[]).map((row) => String(row.source_pk)));
}

export type ReconcileOutcome = {
  readonly marketplace: Marketplace;
  readonly feedKey: string;
  readonly window: ReconcileWindow;
  /** Keys the source holds in the window. */
  readonly sourceRows: number;
  /** Keys cst_app already held, across both destinations. */
  readonly appRows: number;
  /** Keys present in the source and absent from cst_app. */
  readonly missing: number;
  /** How many of those this run acted on, after the limit. */
  readonly attempted: number;
  /** True when the limit stopped the run before every gap was closed. */
  readonly moreAvailable: boolean;
  /** Rows the source returned for the attempted keys. */
  readonly rowsExamined: number;
  /** Messages the marketplace's own rules could represent. */
  readonly messagesRead: number;
  /**
   * Attempted keys the source returned nothing for. The row was deleted between
   * the enumeration and the read, which is ordinary in a mirror that re-ingests.
   */
  readonly sourceRowsGone: number;
  /**
   * Rows read but not representable — overwhelmingly an undecidable direction.
   * These are NOT ingested here: deciding a side the adapter refused to decide
   * is exactly the guess the ambiguous feed exists to avoid.
   */
  readonly notRepresentable: number;
  readonly conversationsInserted: number;
  readonly conversationsUpdated: number;
  readonly messagesInserted: number;
  readonly messagesUpdated: number;
  readonly conversationsRecounted: number;
  readonly excludedSystemNotices: number;
  readonly watermarkBefore: SourceWatermark | null;
  readonly watermarkAfter: SourceWatermark | null;
};

export type ReconcileOptions = {
  readonly window: ReconcileWindow;
  /** Most gaps to close in one run. Oldest first. */
  readonly limit?: number;
  /** Keys per source read. Capped by `MAX_PK_BATCH`. */
  readonly batchSize?: number;
  /** Report what would happen; open no transaction and write nothing. */
  readonly dryRun?: boolean;
  readonly onBatch?: (batch: number, messages: number) => void;
  /**
   * The by-pk source read, injectable so the decision logic can be tested
   * against scripted rows without a database — the same seam
   * `createSourceDatabaseProvider` opens for the same reason.
   *
   * Left out, it resolves to the marketplace's OWN repository read from
   * `REPAIR_READERS`. There is no second normalisation path here: a reconciled
   * message is read by exactly the function body repair reads it with.
   */
  readonly read?: PkReader;
};

/**
 * Reconciles one feed's window: enumerate, diff, read the gaps, persist them.
 *
 * EACH BATCH IS ITS OWN TRANSACTION, committed before the next is read, exactly
 * as `syncFeed` pages. A failure on batch nine keeps the first eight, and
 * because the work is a set difference rather than a cursor, the next run simply
 * finds a smaller difference — there is no resume point to repair.
 */
export async function reconcileFeed(
  app: Queryable,
  source: Queryable,
  feed: SyncFeed,
  options: ReconcileOptions,
  begin?: (run: (tx: Queryable) => Promise<void>) => Promise<void>,
): Promise<ReconcileOutcome> {
  assertWindow(options.window);
  const limit = clampLimit(options.limit);
  const batchSize = clampBatchSize(options.batchSize);
  const relation = RECONCILE_RELATIONS[feed.marketplace];
  const feedKey = reconcileFeedKey(feed.marketplace);

  const watermarkBefore = await readWatermark(app, feed.marketplace, feedKey);
  let watermark = watermarkBefore;

  const sourcePks = await readPkSet(source, buildSourcePkQuery(relation, options.window));
  const appPks = await readPkSet(app, {
    text: SELECT_APP_PKS_IN_WINDOW,
    values: [
      relation.database,
      relation.schema,
      relation.table,
      options.window.from,
      options.window.to,
    ],
  });

  // Set difference, in the source's own order — `readPkSet` preserves insertion
  // order, and the enumeration was ordered oldest first.
  const missingAll: string[] = [];
  for (const pk of sourcePks) {
    if (!appPks.has(pk)) missingAll.push(pk);
  }

  const attempted = missingAll.slice(0, limit);
  const totals = {
    rowsExamined: 0,
    messagesRead: 0,
    sourceRowsGone: 0,
    notRepresentable: 0,
    conversationsInserted: 0,
    conversationsUpdated: 0,
    messagesInserted: 0,
    messagesUpdated: 0,
    conversationsRecounted: 0,
    excludedSystemNotices: 0,
  };

  const read = options.read ?? REPAIR_READERS[feed.marketplace];

  for (let offset = 0, batch = 0; offset < attempted.length; offset += batchSize, batch += 1) {
    const keys = attempted.slice(offset, offset + batchSize);
    const fetched = await read(source, keys);

    totals.rowsExamined += fetched.rowsExamined;
    totals.messagesRead += fetched.messages.length;
    totals.sourceRowsGone += Math.max(0, keys.length - fetched.rowsExamined);
    totals.notRepresentable += Math.max(0, fetched.rowsExamined - fetched.messages.length);
    options.onBatch?.(batch + 1, fetched.messages.length);

    if (fetched.messages.length === 0) continue;

    const built = feed.build(fetched.messages);
    totals.excludedSystemNotices += built.excludedSystemNoticeCount;
    if (built.conversations.length === 0) continue;

    if (options.dryRun) continue;
    if (begin === undefined) throw new Error("a transaction runner is required unless dryRun");

    await begin(async (tx) => {
      const stats = await persistConversations(tx, {
        marketplace: feed.marketplace,
        feedKey,
        conversations: built.conversations,
      });
      totals.conversationsInserted += stats.conversationsInserted;
      totals.conversationsUpdated += stats.conversationsUpdated;
      totals.messagesInserted += stats.messagesInserted;
      totals.messagesUpdated += stats.messagesUpdated;
      totals.conversationsRecounted += stats.conversationsRecounted;
      if (stats.watermark !== null) watermark = stats.watermark;
    });
  }

  return {
    marketplace: feed.marketplace,
    feedKey,
    window: options.window,
    sourceRows: sourcePks.size,
    appRows: appPks.size,
    missing: missingAll.length,
    attempted: attempted.length,
    moreAvailable: missingAll.length > attempted.length,
    ...totals,
    watermarkBefore,
    watermarkAfter: watermark,
  };
}
