import { describe, expect, it } from "vitest";

import type { DerivedConversation, ThreadBuildResult } from "@/lib/domain/conversation";
import { MARKETPLACES } from "@/lib/domain/marketplace";
import type { SourceMessage } from "@/lib/domain/source-message";
import type { PkReader } from "@/lib/sync/body-repair";
import {
  DEFAULT_RECONCILE_LIMIT,
  MAX_RECONCILE_LIMIT,
  RECONCILE_RELATIONS,
  type ReconcileOptions,
  assertWindow,
  buildSourcePkQuery,
  reconcileFeed,
  reconcileFeedKey,
} from "@/lib/sync/message-reconcile";
import { type Queryable, SYNC_FEEDS } from "@/lib/sync/message-sync";

/**
 * The reconcile pass: the thing that finds messages the cursor cannot reach.
 *
 * No database and no network. The source and app clients are stubs, so these
 * test the DECISION — what it enumerates, what it treats as missing, what it
 * refuses to touch, and above all that it cannot disturb the live cursor.
 *
 * The case behind every test here is Shopify conversation 46268 (order
 * LED65289): message 31065501, the customer reporting she had received someone
 * else's parcel, sat in the source while 31190827 — later on BOTH ordering
 * columns — had already been ingested. The cursor was past it permanently, so
 * the inbox showed a wrong-item case as "Order change, before shipping queries".
 */

const WINDOW = { from: "2026-09-01 00:00:00", to: "2026-09-23 00:00:00" };

const THREAD_KEY = '["shopify-order-thread-v1","no_item",104,null,"LED65289",0]';

function message(pk: string, ts: string, text: string): SourceMessage {
  return {
    marketplace: "shopify",
    sourceDatabase: "ledsone",
    sourceSchema: "customer_service",
    sourceTable: "shopify_messages",
    sourcePk: pk,
    externalMessageId: `<${pk}@mail.gmail.com>`,
    subSourceId: 104,
    direction: "inbound",
    sourceTimestamp: ts,
    bodyText: text,
    bodyDecodeStatus: "decoded",
    counterpartyRef: "LED65289",
    listingItemRef: null,
  } as SourceMessage;
}

/**
 * A stub source/app pair.
 *
 * `sourcePks` is what the source holds in the window; `appPks` is what cst_app
 * already has, across BOTH destinations. `readable` maps a pk to the row the
 * source returns for it — a pk absent from it models a row deleted between the
 * enumeration and the read. `unrepresentable` models a row that comes back but
 * that the adapter refuses to normalise.
 */
function stubs(opts: {
  sourcePks: string[];
  appPks: string[];
  readable?: Record<string, SourceMessage>;
  unrepresentable?: string[];
}) {
  const readable = opts.readable ?? {};
  const unrepresentable = new Set(opts.unrepresentable ?? []);

  const source: Queryable = {
    query: async () => ({ rows: opts.sourcePks.map((pk) => ({ source_pk: pk })) }),
  };

  const app: Queryable = {
    query: async (config) => {
      if (config.text.includes("FROM cst_app.sync_state")) return { rows: [] };
      return { rows: opts.appPks.map((pk) => ({ source_pk: pk })) };
    },
  };

  const read: PkReader = async (_client, pks) => {
    const messages = pks.map((pk) => readable[pk]).filter((m): m is SourceMessage => m != null);
    const rowsExamined = pks.filter(
      (pk) => readable[pk] != null || unrepresentable.has(pk),
    ).length;
    return { messages, rowsExamined };
  };

  return { source, app, read };
}

/** One conversation carrying whatever messages the batch produced. */
function oneThread(messages: readonly SourceMessage[]): ThreadBuildResult {
  return {
    conversations: [
      {
        marketplace: "shopify",
        subSourceId: 104,
        threadKey: THREAD_KEY,
        threadingRuleVersion: "shopify-order-thread-v1",
        threadingStrategy: "no_item",
        listingItemRef: null,
        counterpartyRef: "LED65289",
        firstSourceTimestamp: messages[0]!.sourceTimestamp,
        lastSourceTimestamp: messages[messages.length - 1]!.sourceTimestamp,
        needsContext: false,
        inboxPlacement: "reply_inbox",
        inboxFilterReason: null,
        messageCount: messages.length,
        inboundCount: messages.length,
        messages,
      } as unknown as DerivedConversation,
    ],
    excludedSystemNoticeCount: 0,
    excludedUnusableCount: 0,
  };
}

const SHOPIFY_FEED = { ...SYNC_FEEDS.shopify, build: oneThread };

/** Records every statement a persist would issue, and answers the upserts. */
function txRecorder() {
  const statements: string[] = [];
  const runner = async (run: (tx: Queryable) => Promise<void>) => {
    await run({
      query: async (config) => {
        statements.push(config.text);
        if (config.text.includes("INSERT INTO cst_app.conversations")) {
          return {
            rows: [
              {
                id: "46268",
                threading_rule_version: "shopify-order-thread-v1",
                thread_key: THREAD_KEY,
                inserted: false,
              },
            ],
          };
        }
        if (config.text.includes("INSERT INTO cst_app.conversation_messages")) {
          return { rows: [{ inserted: true }] };
        }
        return { rows: [] };
      },
    });
  };
  return { statements, runner };
}

function options(extra: Partial<ReconcileOptions> & { read: PkReader }): ReconcileOptions {
  return { window: WINDOW, ...extra };
}

describe("the relation table", () => {
  it("covers every marketplace", () => {
    for (const marketplace of MARKETPLACES) {
      expect(RECONCILE_RELATIONS[marketplace]?.table, marketplace).toBeTruthy();
    }
  });

  /**
   * eBay is keyed by its HEADER row, which is what `source_table` records for
   * it. Enumerating `ebay_messages` would diff body rows against header pks and
   * report every eBay message in the window as missing.
   */
  it("enumerates eBay by its header table", () => {
    expect(RECONCILE_RELATIONS.ebay.table).toBe("ebay_message_headers");
    expect(RECONCILE_RELATIONS.ebay.timestampColumn).toBe("receive_date");
  });

  it("keeps its cursor row separate from every live feed's", () => {
    for (const marketplace of MARKETPLACES) {
      expect(reconcileFeedKey(marketplace)).not.toBe(SYNC_FEEDS[marketplace].feedKey);
    }
  });
});

describe("the window", () => {
  it("refuses an open, inverted or empty span", () => {
    expect(() => assertWindow({ from: "", to: WINDOW.to })).toThrow(/both/);
    expect(() => assertWindow({ from: WINDOW.to, to: WINDOW.from })).toThrow(/inverted/);
    expect(() => assertWindow({ from: WINDOW.from, to: WINDOW.from })).toThrow(/inverted/);
  });

  it("enumerates only the pk, half-open, oldest first", () => {
    const query = buildSourcePkQuery(RECONCILE_RELATIONS.shopify, WINDOW);
    expect(query.text).toContain("m.id::text AS source_pk");
    expect(query.text).toContain(">= $1::timestamp");
    expect(query.text).toContain("<  $2::timestamp");
    expect(query.text).toMatch(/ORDER BY m\.date ASC, m\.id ASC/);
    // A key enumeration, not a message read: no body may be selected.
    expect(query.text).not.toMatch(/message_content|body/i);
    expect(query.values).toEqual([WINDOW.from, WINDOW.to]);
  });
});

describe("finding the gap", () => {
  it("ingests a message the cursor has already passed", async () => {
    const missed = message("31065501", "2026-09-21 11:52:36", "it's not what I ordered");
    const { source, app, read } = stubs({
      sourcePks: ["30825462", "31065501", "31190827"],
      appPks: ["30825462", "31190827"],
      readable: { "31065501": missed },
    });
    const { statements, runner } = txRecorder();

    const outcome = await reconcileFeed(
      app,
      source,
      SHOPIFY_FEED,
      options({ read }),
      runner,
    );

    expect(outcome.missing).toBe(1);
    expect(outcome.attempted).toBe(1);
    expect(outcome.messagesRead).toBe(1);
    expect(outcome.messagesInserted).toBe(1);
    expect(statements.some((s) => s.includes("INSERT INTO cst_app.conversation_messages"))).toBe(
      true,
    );
  });

  /**
   * THE WHOLE POINT OF THE SEPARATE FEED KEY. The backfilled message is three
   * weeks behind the live cursor. Writing it under `shopify-messages` would hand
   * `UPSERT_SYNC_STATE` an older watermark for the feed the incremental sync
   * resumes from — harmless today only because that statement refuses to
   * retreat. This asserts the stronger property: the live feed's row is never
   * even addressed.
   */
  it("never writes the live feed's cursor row", async () => {
    const missed = message("31065501", "2026-09-21 11:52:36", "x");
    const { source, app, read } = stubs({
      sourcePks: ["31065501"],
      appPks: [],
      readable: { "31065501": missed },
    });
    const statements: { text: string; values?: unknown[] }[] = [];
    const runner = async (run: (tx: Queryable) => Promise<void>) => {
      await run({
        query: async (config) => {
          statements.push(config);
          if (config.text.includes("INSERT INTO cst_app.conversations")) {
            return {
              rows: [
                {
                  id: "46268",
                  threading_rule_version: "shopify-order-thread-v1",
                  thread_key: THREAD_KEY,
                  inserted: false,
                },
              ],
            };
          }
          if (config.text.includes("INSERT INTO cst_app.conversation_messages")) {
            return { rows: [{ inserted: true }] };
          }
          return { rows: [] };
        },
      });
    };

    const outcome = await reconcileFeed(app, source, SHOPIFY_FEED, options({ read }), runner);

    expect(outcome.feedKey).toBe("shopify-reconcile");
    const cursorWrites = statements.filter((s) => s.text.includes("cst_app.sync_state"));
    expect(cursorWrites.length).toBeGreaterThan(0);
    for (const write of cursorWrites) {
      expect(write.values?.[1]).toBe("shopify-reconcile");
      expect(write.values?.[1]).not.toBe(SYNC_FEEDS.shopify.feedKey);
    }
  });

  it("counts a row the source no longer answers for instead of dropping it", async () => {
    const { source, app, read } = stubs({ sourcePks: ["1", "2"], appPks: [] });
    const outcome = await reconcileFeed(
      app,
      source,
      SHOPIFY_FEED,
      options({ read, dryRun: true }),
    );
    expect(outcome.missing).toBe(2);
    expect(outcome.sourceRowsGone).toBe(2);
    expect(outcome.messagesRead).toBe(0);
  });

  it("reports a row it will not represent rather than guessing a direction", async () => {
    const { source, app, read } = stubs({
      sourcePks: ["1"],
      appPks: [],
      unrepresentable: ["1"],
    });
    const outcome = await reconcileFeed(
      app,
      source,
      SHOPIFY_FEED,
      options({ read, dryRun: true }),
    );
    expect(outcome.notRepresentable).toBe(1);
    expect(outcome.sourceRowsGone).toBe(0);
    expect(outcome.messagesRead).toBe(0);
  });

  /**
   * Without the UNION over `unresolved_marketplace_messages` this pk would be
   * retried on every run, forever, against the very rule that routed it there.
   */
  it("treats a message held on the ambiguous feed as present, not missing", async () => {
    const { source, app, read } = stubs({ sourcePks: ["1", "2"], appPks: ["1", "2"] });
    const outcome = await reconcileFeed(
      app,
      source,
      SHOPIFY_FEED,
      options({ read, dryRun: true }),
    );
    expect(outcome.missing).toBe(0);
    expect(outcome.attempted).toBe(0);
  });

  it("caps the run and says there is more", async () => {
    const { source, app, read } = stubs({ sourcePks: ["1", "2", "3"], appPks: [] });
    const outcome = await reconcileFeed(
      app,
      source,
      SHOPIFY_FEED,
      options({ read, limit: 2, dryRun: true }),
    );
    expect(outcome.missing).toBe(3);
    expect(outcome.attempted).toBe(2);
    expect(outcome.moreAvailable).toBe(true);
  });

  it("refuses to write without a transaction runner", async () => {
    const missed = message("31065501", "2026-09-21 11:52:36", "x");
    const { source, app, read } = stubs({
      sourcePks: ["31065501"],
      appPks: [],
      readable: { "31065501": missed },
    });
    await expect(
      reconcileFeed(app, source, SHOPIFY_FEED, options({ read })),
    ).rejects.toThrow(/transaction runner/);
  });

  it("does nothing at all when the window is already whole", async () => {
    const { source, app, read } = stubs({ sourcePks: ["1"], appPks: ["1"] });
    let reads = 0;
    const counting: PkReader = async (client, pks) => {
      reads += 1;
      return read(client, pks);
    };
    const outcome = await reconcileFeed(
      app,
      source,
      SHOPIFY_FEED,
      options({ read: counting, dryRun: true }),
    );
    expect(outcome.missing).toBe(0);
    // No gap means no body read at all — the cost of a clean window is two
    // key enumerations and nothing else.
    expect(reads).toBe(0);
  });

  it("keeps its default limit within the cap", () => {
    expect(DEFAULT_RECONCILE_LIMIT).toBeLessThanOrEqual(MAX_RECONCILE_LIMIT);
  });
});
