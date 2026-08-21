import { describe, expect, it } from "vitest";

import type { UnresolvedSourceMessage } from "@/lib/domain/source-message";
import {
  type Writable,
  highestWatermark,
  persistUnresolvedMessages,
} from "@/lib/sync/unresolved-message-writer";

/** Synthetic values only. No real customer data appears in any test. */
function message(overrides: Partial<UnresolvedSourceMessage> = {}): UnresolvedSourceMessage {
  return {
    marketplace: "shopify",
    sourceDatabase: "ledsone",
    sourceSchema: "customer_service",
    sourceTable: "shopify_messages",
    sourcePk: "1",
    externalMessageId: "src-1",
    subSourceId: 3,
    sourceTimestamp: "2026-08-12 08:30:00",
    bodyText: "synthetic body",
    bodyDecodeStatus: "decoded",
    sourceReference: "SYNTHETIC-REF-1",
    ...overrides,
  };
}

function fake(responses: unknown[][] = []) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let index = 0;
  const client: Writable = {
    query: async (config) => {
      calls.push(config);
      return { rows: responses[index++] ?? [] };
    },
  };
  return { calls, client };
}

describe("idempotency", () => {
  it("upserts on the full source identity", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    expect(calls[0]!.text).toContain(
      "ON CONFLICT (source_database, source_schema, source_table, source_pk) DO UPDATE",
    );
  });

  it("counts a re-run as updated rather than inserted", async () => {
    const { client } = fake([[{ inserted: false }, { inserted: false }]]);
    const stats = await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message({ sourcePk: "1" }), message({ sourcePk: "2" })],
    });
    expect(stats.messagesInserted).toBe(0);
    expect(stats.messagesUpdated).toBe(2);
  });

  it("never rewrites the stored source timestamp", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    const updateClause = calls[0]!.text.split("DO UPDATE SET")[1]!;
    expect(updateClause).not.toContain("source_ts");
  });

  it("writes nothing at all for an empty batch", async () => {
    const { calls, client } = fake();
    const stats = await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [],
    });
    expect(calls).toEqual([]);
    expect(stats).toEqual({ messagesInserted: 0, messagesUpdated: 0, watermark: null });
  });
});

describe("no guessed direction, identity or thread", () => {
  it("writes no direction, counterparty or conversation column", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    const sql = calls[0]!.text.toLowerCase();
    expect(sql).not.toContain("direction");
    expect(sql).not.toContain("counterparty");
    expect(sql).not.toContain("conversation");
    expect(sql).not.toContain("thread");
  });

  it("targets only the unresolved store, never the conversation tables", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    expect(calls[0]!.text).toContain("cst_app.unresolved_marketplace_messages");
    for (const call of calls) {
      expect(call.text).not.toContain("cst_app.conversations");
      expect(call.text).not.toContain("cst_app.conversation_messages");
    }
  });

  it("writes no normalised timestamp while the source zone is unconfirmed", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    expect(calls[0]!.text).toMatch(/c\.source_ts,\s*NULL,\s*NULL/);
  });
});

describe("sync cursor", () => {
  it("advances a cursor keyed on marketplace and feed, leaving others alone", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    const cursor = calls.at(-1)!;
    expect(cursor.text).toContain("cst_app.sync_state");
    expect(cursor.text).toContain("ON CONFLICT (marketplace, feed_key) DO UPDATE");
    expect(cursor.values!.slice(0, 2)).toEqual(["shopify", "shopify-messages"]);
  });

  it("only ever moves the watermark forward", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    expect(calls.at(-1)!.text).toMatch(/watermark_source_ts\s*=\s*CASE\s*\n?\s*WHEN/);
    expect(calls.at(-1)!.text).toContain("ELSE sync_state.watermark_source_ts END");
  });

  it("takes the highest (timestamp, pk) pair in the batch", () => {
    expect(
      highestWatermark([
        message({ sourcePk: "9", sourceTimestamp: "2026-08-12 08:30:00" }),
        message({ sourcePk: "10", sourceTimestamp: "2026-08-12 08:30:00" }),
        message({ sourcePk: "3", sourceTimestamp: "2026-08-11 08:30:00" }),
      ]),
    ).toEqual({ sourceTimestamp: "2026-08-12 08:30:00", sourcePk: "10" });
  });

  it("reports no watermark for an empty batch", () => {
    expect(highestWatermark([])).toBeNull();
  });
});

describe("write scope", () => {
  it("touches no schema outside cst_app", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    for (const call of calls) {
      for (const foreign of ["issue_tracking", "poc_listing", "public.", "customer_service"]) {
        expect(call.text).not.toContain(foreign);
      }
    }
  });

  it("deletes and truncates nothing", async () => {
    const { calls, client } = fake([[{ inserted: true }]]);
    await persistUnresolvedMessages(client, {
      marketplace: "shopify",
      feedKey: "shopify-messages",
      messages: [message()],
    });
    for (const call of calls) {
      const sql = call.text.toUpperCase();
      for (const verb of ["DELETE FROM", "TRUNCATE", "DROP ", "ALTER "]) {
        expect(sql).not.toContain(verb);
      }
    }
  });
});
