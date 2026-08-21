import { writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import type { ThreadBuildResult } from "@/lib/domain/conversation";
import type { SourceMessage, SourceWatermark } from "@/lib/domain/source-message";
import { closeAllPools, getAppPool, getSourcePool } from "@/lib/db/pools";
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
import { type Writable, persistConversations } from "@/lib/sync/conversation-writer";
import {
  persistUnresolvedMessages,
  type Writable as UnresolvedWritable,
} from "@/lib/sync/unresolved-message-writer";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * DIRECT-FROM-SOURCE BOOTSTRAP.
 *
 * Reads the live source over a read-only connection and replays it through the
 * REAL adapters, threading rules and persistence code. It supersedes the
 * JSON-file bridges, which existed only because no server-side source
 * credential was available; message bodies no longer leave the two databases.
 *
 * READ-ONLY AT THE SOURCE. `getSourcePool()` pins
 * `default_transaction_read_only=on` at session level, so the server itself
 * rejects a write rather than trusting this code.
 *
 * WHY IT LOADS A WHOLE WINDOW BEFORE THREADING. Conversations are derived, and
 * `message_count` / `inbound_count` are written as absolute values. Threading
 * page-by-page would let a thread that spans two pages have its counts
 * overwritten by the second page's partial totals. So every message in the
 * window is fetched first, threaded once, and persisted in one transaction.
 * The largest marketplace window here is ~13k messages, which is nothing for
 * the process and worth far more than the alternative's wrong counts.
 *
 * Opt-in only; it never runs in the normal suite.
 *   CST_SOURCE_BOOTSTRAP=<ebay|amazon|shopify|bandq|temu|all>
 *   CST_SOURCE_BOOTSTRAP_SINCE=YYYY-MM-DD   window start (required)
 *   CST_SOURCE_BOOTSTRAP_REPORT=path        aggregate report destination
 */

const MARKETPLACE = process.env.CST_SOURCE_BOOTSTRAP;
const SINCE = process.env.CST_SOURCE_BOOTSTRAP_SINCE;
const REPORT_OUT = process.env.CST_SOURCE_BOOTSTRAP_REPORT;

/** Rows per source round trip. Bounded so no single query is unbounded. */
const PAGE_SIZE = 1000;

type Classified = {
  readonly messages: readonly SourceMessage[];
  readonly unusableCount: number;
  readonly rowsExamined: number;
  readonly systemNoticeCount?: number;
  readonly platformNoticeCount?: number;
  readonly ambiguous?: readonly {
    readonly sourceTimestamp: string;
    readonly sourcePk: string;
  }[];
};

type Bridge = {
  readonly feedKey: string;
  readonly fetch: (client: never, options: never) => Promise<Classified>;
  readonly build: (messages: readonly SourceMessage[]) => ThreadBuildResult;
};

const BRIDGES: Readonly<Record<string, Bridge>> = {
  ebay: {
    feedKey: "ebay-message-headers",
    fetch: ebayRepository.fetchMessages as never,
    build: ebayThreads.buildConversations,
  },
  amazon: {
    feedKey: "amazon-messages",
    fetch: amazonRepository.fetchMessages as never,
    build: amazonThreads.buildConversations,
  },
  shopify: {
    feedKey: "shopify-messages",
    fetch: shopifyRepository.fetchMessages as never,
    build: shopifyThreads.buildConversations,
  },
  bandq: {
    feedKey: "bandq-messages",
    fetch: bandqRepository.fetchMessages as never,
    build: bandqThreads.buildConversations,
  },
  temu: {
    feedKey: "temu-messages",
    fetch: temuRepository.fetchMessages as never,
    build: temuThreads.buildConversations,
  },
};

const collected: Record<string, unknown> = {};
function report(name: string, value: unknown): void {
  collected[name] = value;
  if (REPORT_OUT) writeFileSync(REPORT_OUT, JSON.stringify(collected, null, 2), "utf8");
}

/** Pages the whole window into memory, resuming on the (timestamp, pk) watermark. */
async function loadWindow(bridge: Bridge, since: string) {
  const sourcePool = getSourcePool();
  const messages: SourceMessage[] = [];
  const ambiguous: { sourceTimestamp: string; sourcePk: string }[] = [];
  let rowsExamined = 0;
  let unusable = 0;
  let notices = 0;
  let pages = 0;
  let watermark: SourceWatermark | null = null;

  for (;;) {
    const window = watermark === null
      ? ({ mode: "bootstrap", startAt: since } as const)
      : ({ mode: "after", watermark } as const);

    const page: Classified = await bridge.fetch(sourcePool as never, {
      window,
      limit: PAGE_SIZE,
    } as never);

    pages += 1;
    rowsExamined += page.rowsExamined;
    unusable += page.unusableCount;
    notices += (page.systemNoticeCount ?? 0) + (page.platformNoticeCount ?? 0);
    messages.push(...page.messages);
    if (page.ambiguous) ambiguous.push(...page.ambiguous);

    if (page.rowsExamined < PAGE_SIZE) break;

    /*
     * Advance to the highest (timestamp, pk) the page yielded.
     *
     * The repositories return classified output, not the raw tail, so a page
     * whose last rows were all notices or unusable leaves the watermark short
     * of where the page actually ended and the next page re-reads them. That
     * overlap is why the accumulated batches are de-duplicated below — an
     * upsert cannot touch the same source row twice in one statement.
     *
     * Compared as a tuple: timestamp first, PK only as the tiebreaker. Taking
     * the maximum PK alone would jump backwards whenever a later second
     * carries a lower id.
     */
    const next = [...page.messages, ...(page.ambiguous ?? [])].reduce<
      { sourceTimestamp: string; sourcePk: string } | null
    >((best, row) => {
      if (best === null) return row;
      if (row.sourceTimestamp !== best.sourceTimestamp) {
        return row.sourceTimestamp > best.sourceTimestamp ? row : best;
      }
      return Number(row.sourcePk) > Number(best.sourcePk) ? row : best;
    }, null);

    if (next === null) break;
    // A watermark that did not move would page forever.
    if (
      watermark !== null &&
      next.sourceTimestamp === watermark.sourceTimestamp &&
      next.sourcePk === watermark.sourcePk
    ) {
      break;
    }
    watermark = { sourceTimestamp: next.sourceTimestamp, sourcePk: next.sourcePk };
  }

  return {
    messages: dedupeBySourcePk(messages),
    ambiguous: dedupeBySourcePk(ambiguous),
    rowsExamined,
    unusable,
    notices,
    pages,
  };
}

/** Keeps the first occurrence of each source row. See the watermark note above. */
function dedupeBySourcePk<T extends { sourcePk: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.sourcePk)) continue;
    seen.add(row.sourcePk);
    out.push(row);
  }
  return out;
}

describe.runIf(MARKETPLACE && SINCE)("direct-from-source bootstrap", () => {
  loadEnvFile();

  afterAll(async () => {
    await closeAllPools();
  });

  it("loads the requested window into cst_app", async () => {
    const names = MARKETPLACE === "all" ? Object.keys(BRIDGES) : [MARKETPLACE as string];
    for (const name of names) {
      expect(BRIDGES[name], `no bridge for marketplace: ${name}`).toBeDefined();
    }

    const appPool = getAppPool();
    const summary: Record<string, unknown> = {};

    for (const name of names) {
      const bridge = BRIDGES[name]!;
      const started = Date.now();
      const loaded = await loadWindow(bridge, SINCE as string);
      const fetchedMs = Date.now() - started;

      const built = bridge.build(loaded.messages);
      // Threading must never silently discard a message.
      expect(built.conversations.reduce((sum, c) => sum + c.messageCount, 0)).toBe(
        loaded.messages.length,
      );

      const client = await appPool.connect();
      try {
        const identity = await client.query(
          "SELECT current_database() AS db, current_user AS usr",
        );
        const id = identity.rows[0] as { db: string; usr: string };
        expect(id.db).toBe("varmen_db");
        expect(id.usr).toBe("varmen_user");

        await client.query("BEGIN");
        const stats = await persistConversations(client as unknown as Writable, {
          marketplace: name,
          feedKey: bridge.feedKey,
          conversations: built.conversations,
        });
        let ambiguousStats = { messagesInserted: 0, messagesUpdated: 0 };
        if (loaded.ambiguous.length > 0) {
          ambiguousStats = await persistUnresolvedMessages(
            client as unknown as UnresolvedWritable,
            {
              marketplace: name,
              feedKey: `${name}-ambiguous`,
              messages: loaded.ambiguous as never,
            },
          );
        }
        await client.query("COMMIT");

        summary[name] = {
          sourceRowsExamined: loaded.rowsExamined,
          pages: loaded.pages,
          noticesExcluded: loaded.notices,
          unusableRows: loaded.unusable,
          ambiguousDirection: loaded.ambiguous.length,
          normalizedMessages: loaded.messages.length,
          inbound: loaded.messages.filter((m) => m.direction === "inbound").length,
          outbound: loaded.messages.filter((m) => m.direction === "outbound").length,
          conversations: built.conversations.length,
          replyInbox: built.conversations.filter((c) => c.inboxPlacement === "reply_inbox").length,
          conversationsInserted: stats.conversationsInserted,
          conversationsUpdated: stats.conversationsUpdated,
          messagesInserted: stats.messagesInserted,
          messagesUpdated: stats.messagesUpdated,
          ambiguousInserted: ambiguousStats.messagesInserted,
          fetchSeconds: Math.round(fetchedMs / 100) / 10,
          totalSeconds: Math.round((Date.now() - started) / 100) / 10,
        };
        report("marketplaces", summary);
      } catch (error) {
        await client.query("ROLLBACK");
        summary[name] = { failed: (error as Error).message };
        report("marketplaces", summary);
        throw error;
      } finally {
        client.release();
      }
    }
  }, 900_000);
});
