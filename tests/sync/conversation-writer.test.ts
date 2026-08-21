import { describe, expect, it } from "vitest";

import type { DerivedConversation } from "@/lib/domain/conversation";
import type { SourceMessage } from "@/lib/domain/source-message";
import {
  type Writable,
  highestWatermark,
  persistConversations,
} from "@/lib/sync/conversation-writer";

function msg(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return {
    marketplace: "ebay",
    sourceDatabase: "ledsone",
    sourceSchema: "customer_service",
    sourceTable: "ebay_message_headers",
    sourcePk: "1",
    externalMessageId: "m1",
    subSourceId: 1,
    listingItemRef: "555",
    counterpartyRef: "cp",
    direction: "inbound",
    sourceTimestamp: "2026-08-01 10:00:00",
    bodyText: "text",
    bodyDecodeStatus: "decoded",
    sourceMetadata: {},
    ...overrides,
  };
}

function conversation(overrides: Partial<DerivedConversation> = {}): DerivedConversation {
  const messages = overrides.messages ?? [msg()];
  return {
    marketplace: "ebay",
    threadKey: '["ebay-item-counterparty-gap-v1","item_linked",1,"555","cp",0]',
    threadingRuleVersion: "ebay-item-counterparty-gap-v1",
    threadingStrategy: "item_linked",
    subSourceId: 1,
    listingItemRef: "555",
    counterpartyRef: "cp",
    firstSourceTimestamp: messages[0]!.sourceTimestamp,
    lastSourceTimestamp: messages.at(-1)!.sourceTimestamp,
    messageCount: messages.length,
    inboundCount: messages.filter((m) => m.direction === "inbound").length,
    outboundCount: messages.filter((m) => m.direction === "outbound").length,
    needsContext: false,
    inboxPlacement: "reply_inbox",
    inboxFilterReason: null,
    ...overrides,
    messages,
  };
}

/** Records every statement and returns plausible RETURNING rows. */
function recorder() {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: Writable = {
    query: async (config) => {
      calls.push(config);
      if (/INSERT INTO cst_app\.conversations/.test(config.text)) {
        const keys = (config.values![2] as string[]).map((k, i) => ({
          id: String(100 + i),
          threading_rule_version: (config.values![3] as string[])[i],
          thread_key: k,
          inserted: true,
        }));
        return { rows: keys };
      }
      if (/INSERT INTO cst_app\.conversation_messages/.test(config.text)) {
        return { rows: (config.values![0] as string[]).map(() => ({ inserted: true })) };
      }
      return { rows: [{ ts: "2026-08-01 10:00:00", pk: "1" }] };
    },
  };
  return { calls, client };
}

describe("write target", () => {
  it("writes only to the three permitted cst_app tables", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    const targets = calls
      .map((c) => /INSERT INTO ([\w.]+)/.exec(c.text)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(new Set(targets)).toEqual(
      new Set([
        "cst_app.conversations",
        "cst_app.conversation_messages",
        "cst_app.sync_state",
      ]),
    );
  });

  it("touches no other schema and issues no destructive statement", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    for (const call of calls) {
      for (const schema of ["issue_tracking", "poc_listing", "public."]) {
        expect(call.text).not.toContain(schema);
      }
      for (const verb of ["DELETE", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "REVOKE"]) {
        expect(call.text.toUpperCase()).not.toContain(verb);
      }
    }
  });

  it("parameterises every value", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    for (const call of calls) {
      expect(call.values).toBeDefined();
      expect(call.text).toMatch(/\$\d/);
      // No literal payload value may be interpolated into the statement text.
      expect(call.text).not.toContain("2026-08-01 10:00:00");
      expect(call.text).not.toContain("555");
    }
  });
});

describe("idempotency strategy", () => {
  it("upserts conversations on the rule/thread-key uniqueness", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    const sql = calls[0]!.text;
    expect(sql).toContain("ON CONFLICT (threading_rule_version, thread_key) DO UPDATE");
  });

  it("upserts messages on the full source identity", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    expect(calls[1]!.text).toContain(
      "ON CONFLICT (source_database, source_schema, source_table, source_pk) DO UPDATE",
    );
  });

  it("never resets workflow_state on a repeat run", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    const update = calls[0]!.text.split("DO UPDATE SET")[1]!;
    expect(update).not.toContain("workflow_state");
  });

  it("creates new conversations in the received state", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    expect(calls[0]!.values![9]).toEqual(["received"]);
  });

  it("never rewrites an already-stored source timestamp", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    const update = calls[1]!.text.split("DO UPDATE SET")[1]!;
    expect(update).not.toContain("source_ts");
  });

  it("reports inserted versus updated counts", async () => {
    const { client } = recorder();
    const stats = await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    expect(stats.conversationsInserted).toBe(1);
    expect(stats.conversationsUpdated).toBe(0);
    expect(stats.messagesInserted).toBe(1);
    expect(stats.messagesUpdated).toBe(0);
  });
});

describe("timezone preservation", () => {
  it("hard-codes NULL for the normalised timestamp columns", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    const sql = calls[1]!.text;
    expect(sql).toMatch(/c\.source_ts,\s*NULL,\s*NULL/);
    expect(sql).not.toMatch(/AT TIME ZONE/i);
    expect(sql).not.toMatch(/::\s*timestamptz/i);
  });

  it("passes the source timestamp through verbatim", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation({ messages: [msg({ sourceTimestamp: "2026-08-05 23:59:59.123456" })] })],
    });
    expect(calls[1]!.values![7]).toEqual(["2026-08-05 23:59:59.123456"]);
  });
});

describe("watermark", () => {
  it("selects the highest (timestamp, pk) pair across all persisted messages", () => {
    const wm = highestWatermark([
      conversation({
        messages: [
          msg({ sourcePk: "1", sourceTimestamp: "2026-08-01 10:00:00" }),
          msg({ sourcePk: "9", sourceTimestamp: "2026-08-02 10:00:00" }),
        ],
      }),
      conversation({
        threadKey: "other",
        messages: [msg({ sourcePk: "10", sourceTimestamp: "2026-08-02 10:00:00" })],
      }),
    ]);
    expect(wm).toEqual({ sourceTimestamp: "2026-08-02 10:00:00", sourcePk: "10" });
  });

  it("returns null when nothing is persisted", () => {
    expect(highestWatermark([])).toBeNull();
  });

  it("only ever moves the stored cursor forward", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    const sql = calls[2]!.text;
    expect(sql).toContain("ON CONFLICT (marketplace, feed_key) DO UPDATE");
    expect(sql).toMatch(/CASE\s+WHEN/);
    expect(sql).toContain("-infinity");
  });

  it("writes no cursor when there is nothing to persist", async () => {
    const { calls, client } = recorder();
    const stats = await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [],
    });
    expect(calls).toHaveLength(0);
    expect(stats.watermark).toBeNull();
  });
});

describe("no send capability", () => {
  it("persists no outbound or transmission concept", async () => {
    const { calls, client } = recorder();
    await persistConversations(client, {
      marketplace: "ebay",
      feedKey: "ebay-headers",
      conversations: [conversation()],
    });
    for (const call of calls) {
      for (const term of ["send", "sent", "outbound_queue", "dispatch", "transmit", "approved"]) {
        expect(call.text.toLowerCase()).not.toContain(term);
      }
    }
  });
});
