import { readFileSync, writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { closeAllPools, getAppPool } from "@/lib/db/pools";
import type { ShopifySourceRow } from "@/lib/marketplaces/shopify/adapter";
import { classifyRows } from "@/lib/marketplaces/shopify/message-repository";
import {
  type Writable,
  persistUnresolvedMessages,
} from "@/lib/sync/unresolved-message-writer";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * TEMPORARY DEVELOPMENT INGESTION BRIDGE — the ambiguous remainder.
 *
 * Companion to the marketplace bridge. That one persists the messages whose
 * direction the source decided; this one persists the messages it did NOT.
 *
 * For Shopify those are the 14.8% where both addresses are ours, neither is, or
 * one is missing — internal forwards and third-party traffic. They keep the
 * neutral no-direction storage rather than being guessed onto a side, which is
 * the whole reason that storage exists.
 *
 * Opt-in only; it never runs in the normal suite.
 *   CST_UNRESOLVED_BOOTSTRAP=shopify
 *   CST_UNRESOLVED_BOOTSTRAP_INPUT=path    exported source rows (JSON array)
 *   CST_UNRESOLVED_BOOTSTRAP_REPORT=path   aggregate report destination
 */

const MARKETPLACE = process.env.CST_UNRESOLVED_BOOTSTRAP;
const INPUT = process.env.CST_UNRESOLVED_BOOTSTRAP_INPUT;
const REPORT_OUT = process.env.CST_UNRESOLVED_BOOTSTRAP_REPORT;
const FEED_KEY = "shopify-ambiguous";

const collected: Record<string, unknown> = {};
function report(name: string, value: unknown): void {
  collected[name] = value;
  if (REPORT_OUT) writeFileSync(REPORT_OUT, JSON.stringify(collected, null, 2), "utf8");
}

describe.runIf(MARKETPLACE && INPUT)("unresolved bootstrap bridge", () => {
  loadEnvFile();

  afterAll(async () => {
    await closeAllPools();
  });

  it("persists the ambiguous remainder inside one transaction", async () => {
    expect(MARKETPLACE, "only shopify has an ambiguous remainder").toBe("shopify");

    const rows = JSON.parse(readFileSync(INPUT as string, "utf8")) as ShopifySourceRow[];
    const classified = classifyRows(rows);
    const ambiguous = classified.ambiguous;
    const timestamps = ambiguous.map((m) => m.sourceTimestamp).sort();

    report("marketplace", MARKETPLACE);
    report("source", {
      rawSourceRowsExamined: classified.rowsExamined,
      directionDecided: classified.messages.length,
      ambiguousDirection: ambiguous.length,
      withSourceReference: ambiguous.filter((m) => m.sourceReference !== null).length,
      oldestSourceTimestamp: timestamps[0] ?? null,
      newestSourceTimestamp: timestamps.at(-1) ?? null,
    });

    // Every row is accounted for on one side of the split or the other.
    expect(classified.messages.length + ambiguous.length + classified.unusableCount).toBe(
      classified.rowsExamined,
    );
    // Nothing on this side may carry a direction.
    expect(ambiguous.every((m) => !Object.hasOwn(m, "direction"))).toBe(true);

    if (ambiguous.length === 0) {
      report("persisted", { skipped: "no ambiguous rows in this window" });
      return;
    }

    const pool = getAppPool();
    const client = await pool.connect();
    try {
      const identity = await client.query("SELECT current_database() AS db, current_user AS usr");
      const id = identity.rows[0] as { db: string; usr: string };
      report("target", { current_database: id.db, current_user: id.usr });
      expect(id.db).toBe("varmen_db");
      expect(id.usr).toBe("varmen_user");

      await client.query("BEGIN");
      const stats = await persistUnresolvedMessages(client as unknown as Writable, {
        marketplace: "shopify",
        feedKey: FEED_KEY,
        messages: ambiguous,
      });
      await client.query("COMMIT");
      report("persisted", {
        feedKey: FEED_KEY,
        messagesInserted: stats.messagesInserted,
        messagesUpdated: stats.messagesUpdated,
        watermarkAdvancedTo: stats.watermark,
      });
      expect(stats.messagesInserted + stats.messagesUpdated).toBe(ambiguous.length);
    } catch (error) {
      await client.query("ROLLBACK");
      report("failure", { rolledBack: true, message: (error as Error).message });
      throw error;
    } finally {
      client.release();
    }
  });
});
