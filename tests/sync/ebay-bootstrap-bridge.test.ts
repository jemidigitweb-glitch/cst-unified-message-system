import { readFileSync, writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { closeAllPools, getAppPool } from "@/lib/db/pools";
import type { EbaySourceRow } from "@/lib/marketplaces/ebay/adapter";
import { classifyRows } from "@/lib/marketplaces/ebay/message-repository";
import { buildConversations } from "@/lib/marketplaces/ebay/thread-builder";
import { type Writable, persistConversations } from "@/lib/sync/conversation-writer";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * TEMPORARY DEVELOPMENT INGESTION BRIDGE.
 *
 * The application has no approved read-only LEDsone runtime credential yet, so
 * source rows are exported once through the read-only Claude MCP connection and
 * replayed here through the REAL normalization, threading and persistence code.
 *
 * This is a development/MVP bridge, NOT the production runtime architecture.
 * A direct server-side read-only LEDsone connection remains a deployment and
 * handover requirement.
 *
 * Opt-in only; it never runs in the normal suite.
 *   CST_BOOTSTRAP_INPUT=path   exported source rows (JSON array)
 *   CST_BOOTSTRAP_REPORT=path  aggregate report destination
 */

const INPUT = process.env.CST_BOOTSTRAP_INPUT;
const REPORT_OUT = process.env.CST_BOOTSTRAP_REPORT;
const FEED_KEY = process.env.CST_BOOTSTRAP_FEED ?? "ebay-message-headers";

const collected: Record<string, unknown> = {};
function report(name: string, value: unknown): void {
  collected[name] = value;
  if (REPORT_OUT) writeFileSync(REPORT_OUT, JSON.stringify(collected, null, 2), "utf8");
}

describe.runIf(INPUT)("eBay bootstrap bridge", () => {
  loadEnvFile();

  afterAll(async () => {
    await closeAllPools();
  });

  it("persists the bootstrap window inside one transaction", async () => {
    const rows = JSON.parse(readFileSync(INPUT as string, "utf8")) as EbaySourceRow[];
    const classified = classifyRows(rows);
    const built = buildConversations(classified.messages);

    const noItem = built.conversations.filter((c) => c.threadingStrategy === "no_item");
    report("source", {
      rawSourceRowsExamined: classified.rowsExamined,
      systemNoticesExcluded: classified.systemNoticeCount,
      unusableRows: classified.unusableCount,
      normalizedMessages: classified.messages.length,
      inbound: classified.messages.filter((m) => m.direction === "inbound").length,
      outbound: classified.messages.filter((m) => m.direction === "outbound").length,
      itemLinkedMessages: classified.messages.filter((m) => m.listingItemRef !== null).length,
      noItemMessages: classified.messages.filter((m) => m.listingItemRef === null).length,
      bodyDecoded: classified.messages.filter((m) => m.bodyDecodeStatus === "decoded").length,
      bodyEmpty: classified.messages.filter((m) => m.bodyDecodeStatus === "empty").length,
      bodyFailed: classified.messages.filter((m) => m.bodyDecodeStatus === "failed").length,
      oldestSourceTimestamp:
        [...classified.messages.map((m) => m.sourceTimestamp)].sort()[0] ?? null,
      newestSourceTimestamp:
        [...classified.messages.map((m) => m.sourceTimestamp)].sort().at(-1) ?? null,
    });
    report("derived", {
      conversations: built.conversations.length,
      itemLinked: built.conversations.filter((c) => c.threadingStrategy === "item_linked").length,
      noItem: noItem.length,
      needsContext: built.conversations.filter((c) => c.needsContext).length,
      replyInbox: built.conversations.filter((c) => c.inboxPlacement === "reply_inbox").length,
      outboundOnly: built.conversations.filter((c) => c.inboxPlacement === "outbound_only").length,
      maxConversationSize: Math.max(0, ...built.conversations.map((c) => c.messageCount)),
    });

    const pool = getAppPool();
    const client = await pool.connect();
    try {
      const identity = await client.query(
        "SELECT current_database() AS db, current_user AS usr",
      );
      const id = identity.rows[0] as { db: string; usr: string };
      report("target", { current_database: id.db, current_user: id.usr });
      expect(id.db).toBe("varmen_db");
      expect(id.usr).toBe("varmen_user");

      await client.query("BEGIN");
      const stats = await persistConversations(client as unknown as Writable, {
        marketplace: "ebay",
        feedKey: FEED_KEY,
        conversations: built.conversations,
      });
      await client.query("COMMIT");
      report("persisted", {
        conversationsInserted: stats.conversationsInserted,
        conversationsUpdated: stats.conversationsUpdated,
        messagesInserted: stats.messagesInserted,
        messagesUpdated: stats.messagesUpdated,
        watermarkAdvancedTo: stats.watermark,
      });
      expect(stats.conversationsInserted + stats.conversationsUpdated).toBe(
        built.conversations.length,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      report("failure", { rolledBack: true, message: (error as Error).message });
      throw error;
    } finally {
      client.release();
    }
  });
});
