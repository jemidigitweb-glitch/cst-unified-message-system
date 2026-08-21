import * as amazonRepository from "@/lib/marketplaces/amazon/message-repository";
import * as amazonThreads from "@/lib/marketplaces/amazon/thread-builder";
import * as bandqRepository from "@/lib/marketplaces/bandq/message-repository";
import * as bandqThreads from "@/lib/marketplaces/bandq/thread-builder";
import * as ebayRepository from "@/lib/marketplaces/ebay/message-repository";
import * as ebayThreads from "@/lib/marketplaces/ebay/thread-builder";
import * as shopifyRepository from "@/lib/marketplaces/shopify/message-repository";
import * as shopifyThreads from "@/lib/marketplaces/shopify/thread-builder";
import * as temuRepository from "@/lib/marketplaces/temu/message-repository";
import * as temuThreads from "@/lib/marketplaces/temu/thread-builder";
import type { ThreadBuildResult } from "@/lib/domain/conversation";
import type { Marketplace } from "@/lib/domain/marketplace";
import type { SourceMessage, SourceWatermark } from "@/lib/domain/source-message";

import { highestWatermark, persistConversations } from "./conversation-writer";

/**
 * Incremental message sync: live marketplace source -> cst_app.
 *
 * WHAT WAS MISSING. Every piece below this already existed and was already
 * reviewed — the adapters, the direction rules, the thread builders, the
 * idempotent writers. What did not exist was anything that RAN them against the
 * live source. Ingestion happened by exporting rows to JSON and replaying them
 * through an opt-in test ("TEMPORARY DEVELOPMENT INGESTION BRIDGE"), which is
 * why the newest customer messages never appeared in the workspace.
 *
 * This module is only the orchestration. It reimplements no normalisation, no
 * direction logic and no threading: a marketplace's own reviewed code decides
 * all of that, exactly as the bridge did. Only the transport changes.
 *
 * READS THE SOURCE, WRITES cst_app. The source client is expected to be the
 * read-only pool (`default_transaction_read_only=on` at the session level), so
 * a mistake here cannot write to a marketplace database. Nothing in this file
 * issues an INSERT or UPDATE against anything but cst_app, via the existing
 * writer.
 *
 * INCREMENTAL, AND SAFE TO RE-RUN. Each feed resumes from the (timestamp, pk)
 * watermark in `cst_app.sync_state`, and the fetch uses a row-value comparison
 * so a page boundary neither skips nor replays a row. Idempotency does not rest
 * on the watermark being right: the unique constraints do
 * (`conversations(threading_rule_version, thread_key)` and
 * `conversation_messages(source_database, source_schema, source_table,
 * source_pk)`), so a repeated run upserts rather than duplicates.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * One marketplace's sync wiring.
 *
 * `fetch` and `build` are the marketplace's OWN functions. Keeping them behind
 * this shape means the loop below is written once while each source keeps its
 * own reviewed rules, rather than a shared approximation of them.
 */
export type SyncFeed = {
  readonly marketplace: Marketplace;
  readonly feedKey: string;
  readonly fetch: (
    client: Queryable,
    options: { window: FetchWindow; limit?: number },
  ) => Promise<{
    readonly messages: readonly SourceMessage[];
    readonly unusableCount: number;
    readonly rowsExamined: number;
  }>;
  readonly build: (messages: readonly SourceMessage[]) => ThreadBuildResult;
};

export type FetchWindow =
  | { readonly mode: "after"; readonly watermark: SourceWatermark }
  | { readonly mode: "bootstrap"; readonly startAt: string };

/* eslint-disable @typescript-eslint/no-explicit-any -- each marketplace types
   its own row shape; the loop only ever passes them straight back to the same
   marketplace's builder, so the row type never needs to be named here. */
export const SYNC_FEEDS: Readonly<Record<Marketplace, SyncFeed>> = {
  ebay: {
    marketplace: "ebay",
    // `ebay-message-headers`, not `ebay-messages`. This has to match the key
    // the existing cursor was written under — the eBay bootstrap used the
    // source table's name — or the feed reads as never-run and re-processes
    // three weeks of history. Harmless thanks to the upserts, but it would
    // leave two cursor rows for one feed and the wrong one would win next time.
    feedKey: "ebay-message-headers",
    fetch: (client, options) => ebayRepository.fetchMessages(client as any, options as any),
    build: ebayThreads.buildConversations,
  },
  amazon: {
    marketplace: "amazon",
    feedKey: "amazon-messages",
    fetch: (client, options) => amazonRepository.fetchMessages(client as any, options as any),
    build: amazonThreads.buildConversations,
  },
  shopify: {
    marketplace: "shopify",
    feedKey: "shopify-messages",
    fetch: (client, options) => shopifyRepository.fetchMessages(client as any, options as any),
    build: shopifyThreads.buildConversations,
  },
  bandq: {
    marketplace: "bandq",
    feedKey: "bandq-messages",
    fetch: (client, options) => bandqRepository.fetchMessages(client as any, options as any),
    build: bandqThreads.buildConversations,
  },
  temu: {
    marketplace: "temu",
    feedKey: "temu-messages",
    fetch: (client, options) => temuRepository.fetchMessages(client as any, options as any),
    build: temuThreads.buildConversations,
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const READ_WATERMARK = `
SELECT watermark_source_ts::text AS ts, watermark_source_pk AS pk
FROM cst_app.sync_state
WHERE marketplace = $1 AND feed_key = $2`;

/**
 * Where this feed left off, or null if it has never run.
 *
 * `::text` on the timestamp for the same reason it appears everywhere else in
 * this project: the driver would otherwise build a JS Date through the process
 * timezone and shift a naive source timestamp by the local offset.
 */
export async function readWatermark(
  app: Queryable,
  marketplace: string,
  feedKey: string,
): Promise<SourceWatermark | null> {
  const { rows } = await app.query({ text: READ_WATERMARK, values: [marketplace, feedKey] });
  const row = (rows as { ts: string | null; pk: string | null }[])[0];
  if (row?.ts == null || row.pk == null) return null;
  return { sourceTimestamp: row.ts, sourcePk: row.pk };
}

/**
 * Resume point, or a bounded first run.
 *
 * A feed with no watermark does NOT read all history. `bootstrap` requires an
 * explicit start timestamp, so a first run is a decision someone made rather
 * than an accident that pulls in years of messages.
 */
export function windowFor(
  watermark: SourceWatermark | null,
  bootstrapStartAt: string,
): FetchWindow {
  return watermark === null
    ? { mode: "bootstrap", startAt: bootstrapStartAt }
    : { mode: "after", watermark };
}

export type SyncOutcome = {
  readonly marketplace: Marketplace;
  readonly pages: number;
  readonly rowsExamined: number;
  readonly unusableRows: number;
  readonly messages: number;
  readonly conversationsInserted: number;
  readonly conversationsUpdated: number;
  readonly messagesInserted: number;
  readonly messagesUpdated: number;
  readonly excludedSystemNotices: number;
  readonly conversationsRecounted: number;
  readonly watermarkBefore: SourceWatermark | null;
  readonly watermarkAfter: SourceWatermark | null;
  /** True when the page limit stopped the run before the source was exhausted. */
  readonly moreAvailable: boolean;
};

export type SyncOptions = {
  /** Rows per page. The source is read in bounded pages, never all at once. */
  readonly pageSize?: number;
  /** Safety stop, so one run cannot loop indefinitely against a busy source. */
  readonly maxPages?: number;
  /** Required for a feed that has never run. */
  readonly bootstrapStartAt: string;
  /** Report what would happen; open no transaction and write nothing. */
  readonly dryRun?: boolean;
  readonly onPage?: (page: number, messages: number) => void;
};

/**
 * Syncs one marketplace, page by page, until the source is exhausted.
 *
 * EACH PAGE IS ITS OWN TRANSACTION, committed before the next is fetched. A
 * failure on page nine therefore keeps the first eight — and the watermark
 * moves with them, so a re-run resumes rather than starting over. The
 * alternative, one transaction around everything, turns a transient error at
 * the end into a total loss of the run.
 *
 * The watermark is written inside the same transaction as the data it describes
 * (see `persistConversations`), so it can never point past rows that failed to
 * land.
 */
export async function syncFeed(
  app: Queryable,
  source: Queryable,
  feed: SyncFeed,
  options: SyncOptions,
  begin?: (run: (tx: Queryable) => Promise<void>) => Promise<void>,
): Promise<SyncOutcome> {
  const pageSize = options.pageSize ?? 500;
  const maxPages = options.maxPages ?? 50;

  const watermarkBefore = await readWatermark(app, feed.marketplace, feed.feedKey);
  let watermark = watermarkBefore;

  const totals = {
    pages: 0,
    rowsExamined: 0,
    unusableRows: 0,
    messages: 0,
    conversationsInserted: 0,
    conversationsUpdated: 0,
    messagesInserted: 0,
    messagesUpdated: 0,
    excludedSystemNotices: 0,
    conversationsRecounted: 0,
  };
  let moreAvailable = false;

  for (let page = 0; page < maxPages; page++) {
    const fetched = await feed.fetch(source, {
      window: windowFor(watermark, options.bootstrapStartAt),
      limit: pageSize,
    });

    totals.pages += 1;
    totals.rowsExamined += fetched.rowsExamined;
    totals.unusableRows += fetched.unusableCount;
    totals.messages += fetched.messages.length;
    options.onPage?.(page + 1, fetched.messages.length);

    // A page that yielded no usable message still consumed source rows, so the
    // watermark must advance past them or the next run re-reads the same rows
    // forever. `highestWatermark` reads the messages actually persisted, so
    // that only happens when something was built; when nothing was, the run
    // stops rather than spinning.
    if (fetched.messages.length === 0) break;

    const built = feed.build(fetched.messages);
    totals.excludedSystemNotices += built.excludedSystemNoticeCount;

    if (options.dryRun) {
      const next = highestWatermark(built.conversations);
      if (next === null) break;
      watermark = next;
    } else {
      if (begin === undefined) throw new Error("a transaction runner is required unless dryRun");
      await begin(async (tx) => {
        const stats = await persistConversations(tx, {
          marketplace: feed.marketplace,
          feedKey: feed.feedKey,
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

    // A short page means the source had nothing more to give.
    if (fetched.rowsExamined < pageSize) break;
    if (page === maxPages - 1) moreAvailable = true;
  }

  return {
    marketplace: feed.marketplace,
    ...totals,
    watermarkBefore,
    watermarkAfter: watermark,
    moreAvailable,
  };
}
