import { readFileSync, writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import type { ThreadBuildResult } from "@/lib/domain/conversation";
import type { FetchResult } from "@/lib/marketplaces/source-fetch";
import { closeAllPools, getAppPool } from "@/lib/db/pools";
import * as amazonRepository from "@/lib/marketplaces/amazon/message-repository";
import * as amazonThreads from "@/lib/marketplaces/amazon/thread-builder";
import * as bandqRepository from "@/lib/marketplaces/bandq/message-repository";
import * as bandqThreads from "@/lib/marketplaces/bandq/thread-builder";
import * as shopifyRepository from "@/lib/marketplaces/shopify/message-repository";
import * as shopifyThreads from "@/lib/marketplaces/shopify/thread-builder";
import * as temuRepository from "@/lib/marketplaces/temu/message-repository";
import * as temuThreads from "@/lib/marketplaces/temu/thread-builder";
import { type Writable, persistConversations } from "@/lib/sync/conversation-writer";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * TEMPORARY DEVELOPMENT INGESTION BRIDGE — conversation-backed marketplaces.
 *
 * The application has no approved read-only LEDsone runtime credential yet, so
 * source rows are exported once through the read-only MCP connection and
 * replayed here through the REAL per-marketplace normalization and threading
 * code and the REAL shared persistence code. Nothing is reimplemented for the
 * bridge; only the transport differs.
 *
 * This is a development/MVP bridge, NOT the production runtime architecture.
 * A direct server-side read-only LEDsone connection remains a deployment and
 * handover requirement.
 *
 * Shopify is deliberately absent: its direction is unproven, so it has no
 * conversations to build and goes through the unresolved bridge instead.
 *
 * Opt-in only; it never runs in the normal suite.
 *   CST_MARKETPLACE_BOOTSTRAP=<amazon|bandq|temu>
 *   CST_MARKETPLACE_BOOTSTRAP_INPUT=path    exported source rows (JSON array)
 *   CST_MARKETPLACE_BOOTSTRAP_REPORT=path   aggregate report destination
 */

const MARKETPLACE = process.env.CST_MARKETPLACE_BOOTSTRAP;
const INPUT = process.env.CST_MARKETPLACE_BOOTSTRAP_INPUT;
const REPORT_OUT = process.env.CST_MARKETPLACE_BOOTSTRAP_REPORT;

/**
 * The adapter set per marketplace. Keyed by name so the bridge stays one file,
 * and every marketplace goes through its own reviewed rules rather than a
 * shared approximation of them.
 */
const BRIDGES = {
  amazon: {
    feedKey: "amazon-messages",
    classify: (rows: unknown[]) =>
      amazonRepository.classifyRows(rows as Parameters<typeof amazonRepository.classifyRows>[0]),
    build: amazonThreads.buildConversations,
  },
  shopify: {
    feedKey: "shopify-messages",
    classify: (rows: unknown[]) =>
      shopifyRepository.classifyRows(
        rows as Parameters<typeof shopifyRepository.classifyRows>[0],
      ),
    build: shopifyThreads.buildConversations,
  },
  bandq: {
    feedKey: "bandq-messages",
    classify: (rows: unknown[]) =>
      bandqRepository.classifyRows(rows as Parameters<typeof bandqRepository.classifyRows>[0]),
    build: bandqThreads.buildConversations,
  },
  temu: {
    feedKey: "temu-messages",
    classify: (rows: unknown[]) =>
      temuRepository.classifyRows(rows as Parameters<typeof temuRepository.classifyRows>[0]),
    build: temuThreads.buildConversations,
  },
} as const;

type BridgeName = keyof typeof BRIDGES;

const collected: Record<string, unknown> = {};
function report(name: string, value: unknown): void {
  collected[name] = value;
  if (REPORT_OUT) writeFileSync(REPORT_OUT, JSON.stringify(collected, null, 2), "utf8");
}

function summarizeSource(
  classified: FetchResult & {
    readonly platformNoticeCount?: number;
    readonly ambiguous?: readonly unknown[];
  },
): Record<string, unknown> {
  const timestamps = classified.messages.map((m) => m.sourceTimestamp).sort();
  return {
    rawSourceRowsExamined: classified.rowsExamined,
    unusableRows: classified.unusableCount,
    platformNoticesExcluded: classified.platformNoticeCount ?? 0,
    // Direction undecidable from the addresses; kept neutral, never guessed.
    ambiguousDirection: classified.ambiguous?.length ?? 0,
    normalizedMessages: classified.messages.length,
    inbound: classified.messages.filter((m) => m.direction === "inbound").length,
    outbound: classified.messages.filter((m) => m.direction === "outbound").length,
    withItemReference: classified.messages.filter((m) => m.listingItemRef !== null).length,
    bodyDecoded: classified.messages.filter((m) => m.bodyDecodeStatus === "decoded").length,
    bodyEmpty: classified.messages.filter((m) => m.bodyDecodeStatus === "empty").length,
    bodyFailed: classified.messages.filter((m) => m.bodyDecodeStatus === "failed").length,
    oldestSourceTimestamp: timestamps[0] ?? null,
    newestSourceTimestamp: timestamps.at(-1) ?? null,
  };
}

function summarizeDerived(built: ThreadBuildResult): Record<string, unknown> {
  const byRule: Record<string, number> = {};
  for (const conversation of built.conversations) {
    byRule[conversation.threadingRuleVersion] =
      (byRule[conversation.threadingRuleVersion] ?? 0) + 1;
  }
  return {
    conversations: built.conversations.length,
    conversationsByRule: byRule,
    needsContext: built.conversations.filter((c) => c.needsContext).length,
    replyInbox: built.conversations.filter((c) => c.inboxPlacement === "reply_inbox").length,
    excludedUnusable: built.excludedUnusableCount,
    maxConversationSize: Math.max(0, ...built.conversations.map((c) => c.messageCount)),
  };
}

describe.runIf(MARKETPLACE && INPUT)("marketplace bootstrap bridge", () => {
  loadEnvFile();

  afterAll(async () => {
    await closeAllPools();
  });

  it("persists the bootstrap window inside one transaction", async () => {
    const bridge = BRIDGES[MARKETPLACE as BridgeName];
    expect(bridge, `no bridge for marketplace: ${String(MARKETPLACE)}`).toBeDefined();

    const rows = JSON.parse(readFileSync(INPUT as string, "utf8")) as unknown[];
    const classified = bridge.classify(rows);
    const built = bridge.build(classified.messages);

    report("marketplace", MARKETPLACE);
    report("source", summarizeSource(classified));
    report("derived", summarizeDerived(built));

    // B&Q and Temu are verified inbound-only: 100% of their rows are addressed
    // to a company domain and 0% are sent from one. A single outbound message
    // would mean the mapping changed, and would fabricate a CST reply.
    // Amazon and Shopify are two-sided and are excluded from this check.
    if (MARKETPLACE === "bandq" || MARKETPLACE === "temu") {
      expect(classified.messages.every((m) => m.direction === "inbound")).toBe(true);
    }
    // Threading must never silently discard a message.
    expect(built.conversations.reduce((sum, c) => sum + c.messageCount, 0)).toBe(
      classified.messages.length,
    );

    const pool = getAppPool();
    const client = await pool.connect();
    try {
      const identity = await client.query("SELECT current_database() AS db, current_user AS usr");
      const id = identity.rows[0] as { db: string; usr: string };
      report("target", { current_database: id.db, current_user: id.usr });
      expect(id.db).toBe("varmen_db");
      expect(id.usr).toBe("varmen_user");

      await client.query("BEGIN");
      const stats = await persistConversations(client as unknown as Writable, {
        marketplace: MARKETPLACE as string,
        feedKey: bridge.feedKey,
        conversations: built.conversations,
      });
      await client.query("COMMIT");
      report("persisted", {
        feedKey: bridge.feedKey,
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
