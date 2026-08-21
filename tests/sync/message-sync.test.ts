import { describe, expect, it } from "vitest";

import { MARKETPLACES } from "@/lib/domain/marketplace";
import type { SourceMessage } from "@/lib/domain/source-message";
import { SYNC_FEEDS, readWatermark, syncFeed, windowFor } from "@/lib/sync/message-sync";

/**
 * The incremental sync loop.
 *
 * No database and no network: the client is a stub and the feed is a stub, so
 * these test the ORCHESTRATION — resume point, paging, stopping, and the
 * refusal to write outside a transaction. Normalisation, direction and
 * threading are each marketplace's own reviewed code and are tested with it.
 */

function message(pk: string, ts: string): SourceMessage {
  return {
    marketplace: "ebay",
    sourceDatabase: "ledsone",
    sourceSchema: "customer_service",
    sourceTable: "ebay_message_headers",
    sourcePk: pk,
    externalMessageId: null,
    subSourceId: 1,
    direction: "inbound",
    sourceTimestamp: ts,
    bodyText: "synthetic",
    bodyDecodeStatus: "decoded",
    counterpartyRef: "buyer-1",
    listingItemRef: null,
  } as SourceMessage;
}

/** A client that answers the watermark read and records every statement. */
function stubApp(watermark: { ts: string; pk: string } | null) {
  const statements: string[] = [];
  return {
    statements,
    client: {
      query: async (config: { text: string; values?: unknown[] }) => {
        statements.push(config.text);
        if (config.text.includes("FROM cst_app.sync_state")) {
          return { rows: watermark === null ? [] : [{ ts: watermark.ts, pk: watermark.pk }] };
        }
        return { rows: [] };
      },
    },
  };
}

describe("the feed table", () => {
  it("covers every marketplace exactly once", () => {
    for (const marketplace of MARKETPLACES) {
      expect(SYNC_FEEDS[marketplace]?.marketplace, marketplace).toBe(marketplace);
    }
    const keys = Object.values(SYNC_FEEDS).map((feed) => feed.feedKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * eBay's cursor was written by the bootstrap under the SOURCE TABLE's name.
   * Using "ebay-messages" here would read as never-run and re-process weeks of
   * history — safe, because of the upserts, but it would leave two cursor rows
   * for one feed.
   */
  it("keeps eBay on the cursor key its history was written under", () => {
    expect(SYNC_FEEDS.ebay.feedKey).toBe("ebay-message-headers");
  });
});

describe("choosing the resume point", () => {
  it("bootstraps from an explicit start when the feed has never run", () => {
    expect(windowFor(null, "2026-08-01 00:00:00")).toEqual({
      mode: "bootstrap",
      startAt: "2026-08-01 00:00:00",
    });
  });

  it("resumes after the stored watermark once there is one", () => {
    const watermark = { sourceTimestamp: "2026-08-20 06:21:55", sourcePk: "102087" };
    expect(windowFor(watermark, "2026-08-01 00:00:00")).toEqual({ mode: "after", watermark });
  });

  it("reads a stored watermark as text, never as a Date", async () => {
    const { client } = stubApp({ ts: "2026-08-20 06:21:55", pk: "102087" });
    const watermark = await readWatermark(client, "ebay", "ebay-message-headers");
    // A Date here would mean the driver reinterpreted a naive timestamp through
    // the process timezone and shifted every message by the local offset.
    expect(watermark).toEqual({ sourceTimestamp: "2026-08-20 06:21:55", sourcePk: "102087" });
    expect(typeof watermark!.sourceTimestamp).toBe("string");
  });

  it("treats a row with no watermark as never-run", async () => {
    const { client } = stubApp(null);
    expect(await readWatermark(client, "ebay", "ebay-message-headers")).toBeNull();
  });
});

describe("the sync loop", () => {
  const feed = (pages: SourceMessage[][]) => {
    let call = 0;
    return {
      marketplace: "ebay" as const,
      feedKey: "ebay-message-headers",
      fetch: async () => {
        const messages = pages[call] ?? [];
        call += 1;
        return { messages, unusableCount: 0, rowsExamined: messages.length };
      },
      build: (messages: readonly SourceMessage[]) => ({
        conversations: messages.length
          ? [
              {
                marketplace: "ebay",
                subSourceId: 1,
                threadKey: `k${messages[0]!.sourcePk}`,
                threadingRuleVersion: "v1",
                threadingStrategy: "no_item",
                listingItemRef: null,
                counterpartyRef: "buyer-1",
                messages,
              },
            ]
          : [],
        excludedSystemNoticeCount: 0,
        excludedUnusableCount: 0,
      }),
    } as unknown as (typeof SYNC_FEEDS)["ebay"];
  };

  it("stops as soon as a page returns nothing", async () => {
    const { client } = stubApp(null);
    const outcome = await syncFeed(client, client, feed([[]]), {
      bootstrapStartAt: "2026-08-01 00:00:00",
      dryRun: true,
    });
    expect(outcome.pages).toBe(1);
    expect(outcome.messages).toBe(0);
  });

  it("stops on a short page rather than asking again", async () => {
    const { client } = stubApp(null);
    const outcome = await syncFeed(
      client,
      client,
      feed([[message("1", "2026-08-20 10:00:00")]]),
      { pageSize: 500, bootstrapStartAt: "2026-08-01 00:00:00", dryRun: true },
    );
    expect(outcome.pages).toBe(1);
    expect(outcome.messages).toBe(1);
  });

  it("advances the watermark across pages", async () => {
    const { client } = stubApp(null);
    const outcome = await syncFeed(
      client,
      client,
      feed([
        [message("1", "2026-08-20 10:00:00"), message("2", "2026-08-20 11:00:00")],
        [message("3", "2026-08-20 12:00:00")],
      ]),
      { pageSize: 2, bootstrapStartAt: "2026-08-01 00:00:00", dryRun: true },
    );
    expect(outcome.pages).toBe(2);
    expect(outcome.watermarkAfter).toEqual({
      sourceTimestamp: "2026-08-20 12:00:00",
      sourcePk: "3",
    });
  });

  it("reports when the page cap stopped it short of the source", async () => {
    const { client } = stubApp(null);
    const pages = Array.from({ length: 5 }, (_, i) => [
      message(String(i + 1), `2026-08-20 1${i}:00:00`),
    ]);
    const outcome = await syncFeed(client, client, feed(pages), {
      pageSize: 1,
      maxPages: 2,
      bootstrapStartAt: "2026-08-01 00:00:00",
      dryRun: true,
    });
    expect(outcome.pages).toBe(2);
    expect(outcome.moreAvailable).toBe(true);
  });

  /**
   * A write without a transaction would leave the cursor and the data able to
   * disagree. Refusing loudly is better than a partial write nobody notices.
   */
  it("refuses to write when no transaction runner was supplied", async () => {
    const { client } = stubApp(null);
    await expect(
      syncFeed(client, client, feed([[message("1", "2026-08-20 10:00:00")]]), {
        bootstrapStartAt: "2026-08-01 00:00:00",
      }),
    ).rejects.toThrow(/transaction runner is required/i);
  });

  it("writes nothing at all on a dry run", async () => {
    const { client, statements } = stubApp(null);
    await syncFeed(client, client, feed([[message("1", "2026-08-20 10:00:00")]]), {
      bootstrapStartAt: "2026-08-01 00:00:00",
      dryRun: true,
    });
    for (const statement of statements) {
      expect(statement).not.toMatch(/INSERT|UPDATE|DELETE/i);
    }
  });
});
