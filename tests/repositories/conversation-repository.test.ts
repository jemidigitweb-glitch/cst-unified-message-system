import { describe, expect, it } from "vitest";

import {
  DEFAULT_INBOX_LIMIT,
  MAX_INBOX_LIMIT,
  type Queryable,
  getConversation,
  listConversations,
  parseConversationId,
} from "@/lib/repositories/conversation-repository";

/** Synthetic rows only. No real customer data appears in any test. */
function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    marketplace: "ebay",
    counterparty_ref: "counterparty-a",
    listing_item_ref: "listing-1",
    workflow_state: "received",
    needs_context: false,
    inbox_visibility: "reply_inbox",
    first_source_ts: "2026-08-01 10:00:00",
    last_source_ts: "2026-08-02 10:00:00",
    message_count: 2,
    inbound_count: 1,
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "10",
    direction: "inbound",
    source_ts: "2026-08-01 10:00:00",
    body_text: "synthetic body",
    body_decode_status: "decoded",
    ...overrides,
  };
}

function fake(responses: unknown[][]) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let index = 0;
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows: responses[index++] ?? [] };
    },
  };
  return { calls, client };
}

describe("inbox listing", () => {
  it("requests only reply_inbox conversations", async () => {
    const { calls, client } = fake([[conversationRow()]]);
    await listConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.values![0]).toBe("reply_inbox");
    expect(calls[0]!.text).toContain("WHERE inbox_visibility = $1");
  });

  it("cannot be asked for outbound_only conversations", async () => {
    const { calls, client } = fake([[]]);
    // The placement is fixed by the repository; there is no parameter for it.
    await listConversations(client, { marketplace: "ebay", limit: 5 });
    expect(calls[0]!.values).toEqual(["reply_inbox", "ebay", 5]);
    expect(calls[0]!.text).not.toContain("outbound_only");
  });

  it("orders the inbox by latest activity first", async () => {
    const { calls, client } = fake([[]]);
    await listConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.text).toContain("ORDER BY last_source_ts DESC");
  });

  it("bounds the result size", async () => {
    const a = fake([[]]);
    await listConversations(a.client, { marketplace: "ebay" });
    expect(a.calls[0]!.values![2]).toBe(DEFAULT_INBOX_LIMIT);

    const b = fake([[]]);
    await listConversations(b.client, { marketplace: "ebay", limit: 99_999 });
    expect(b.calls[0]!.values![2]).toBe(MAX_INBOX_LIMIT);

    const c = fake([[]]);
    await listConversations(c.client, { marketplace: "ebay", limit: 0 });
    expect(c.calls[0]!.values![2]).toBe(DEFAULT_INBOX_LIMIT);
  });

  it("maps rows to the neutral inbox shape", async () => {
    const { client } = fake([[conversationRow({ needs_context: true })]]);
    const [item] = await listConversations(client, { marketplace: "ebay" });
    expect(item).toEqual({
      id: "1",
      marketplace: "ebay",
      counterpartyRef: "counterparty-a",
      listingItemRef: "listing-1",
      workflowState: "received",
      needsContext: true,
      inboxPlacement: "reply_inbox",
      firstSourceTimestamp: "2026-08-01 10:00:00",
      lastSourceTimestamp: "2026-08-02 10:00:00",
      messageCount: 2,
      inboundCount: 1,
    });
  });

  it("exposes no source table or connection metadata to callers", async () => {
    const { client } = fake([[conversationRow()]]);
    const [item] = await listConversations(client, { marketplace: "ebay" });
    for (const leaked of ["source_database", "source_schema", "source_table", "source_pk", "password", "host"]) {
      expect(item).not.toHaveProperty(leaked);
    }
  });
});

describe("marketplace filtering", () => {
  it("filters the inbox to the requested marketplace", async () => {
    const { calls, client } = fake([[]]);
    await listConversations(client, { marketplace: "amazon" });
    expect(calls[0]!.text).toContain("AND marketplace = $2");
    expect(calls[0]!.values![1]).toBe("amazon");
  });

  it("keeps eBay and Amazon queries separate", async () => {
    const a = fake([[]]);
    await listConversations(a.client, { marketplace: "ebay" });
    const b = fake([[]]);
    await listConversations(b.client, { marketplace: "amazon" });
    expect(a.calls[0]!.values![1]).toBe("ebay");
    expect(b.calls[0]!.values![1]).toBe("amazon");
  });

  it("parameterises the marketplace rather than interpolating it", async () => {
    const { calls, client } = fake([[]]);
    await listConversations(client, { marketplace: "amazon" });
    expect(calls[0]!.text).not.toContain("amazon");
  });

  it("hides a conversation belonging to another marketplace", async () => {
    const { client } = fake([[conversationRow({ marketplace: "ebay" })], [messageRow()]]);
    const detail = await getConversation(client, "1", { expectedMarketplace: "amazon" });
    expect(detail).toBeNull();
  });

  it("returns a conversation that matches the expected marketplace", async () => {
    const { client } = fake([[conversationRow({ marketplace: "amazon" })], [messageRow()]]);
    const detail = await getConversation(client, "1", { expectedMarketplace: "amazon" });
    expect(detail?.conversation.marketplace).toBe("amazon");
  });

  it("does not fetch messages for a cross-marketplace mismatch", async () => {
    const { calls, client } = fake([[conversationRow({ marketplace: "ebay" })], [messageRow()]]);
    await getConversation(client, "1", { expectedMarketplace: "amazon" });
    expect(calls).toHaveLength(1);
  });
});

describe("conversation detail", () => {
  it("returns the conversation with its messages", async () => {
    const { client } = fake([
      [conversationRow()],
      [messageRow(), messageRow({ id: "11", direction: "outbound", source_ts: "2026-08-02 10:00:00" })],
    ]);
    const detail = await getConversation(client, "1");
    expect(detail?.conversation.id).toBe("1");
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages[1]?.direction).toBe("outbound");
  });

  it("orders messages oldest first with the source PK as tiebreaker", async () => {
    const { calls, client } = fake([[conversationRow()], []]);
    await getConversation(client, "1");
    expect(calls[1]!.text).toContain("ORDER BY source_ts ASC, source_pk::bigint ASC");
  });

  it("keeps the stored source timestamp as text, applying no timezone", async () => {
    const { calls, client } = fake([[conversationRow()], [messageRow()]]);
    const detail = await getConversation(client, "1");
    expect(calls[1]!.text).toContain("source_ts::text");
    expect(calls[1]!.text).not.toMatch(/AT TIME ZONE/i);
    expect(calls[1]!.text).not.toMatch(/::\s*timestamptz/i);
    expect(detail?.messages[0]?.sourceTimestamp).toBe("2026-08-01 10:00:00");
  });

  it("returns null for a conversation that does not exist", async () => {
    const { client } = fake([[]]);
    expect(await getConversation(client, "999")).toBeNull();
  });

  it("does not query messages when the conversation is missing", async () => {
    const { calls, client } = fake([[]]);
    await getConversation(client, "999");
    expect(calls).toHaveLength(1);
  });

  it("parameterises the conversation id", async () => {
    const { calls, client } = fake([[conversationRow()], []]);
    await getConversation(client, "42");
    expect(calls[0]!.values).toEqual(["42"]);
    expect(calls[0]!.text).not.toContain("42");
  });

  it("exposes only the fields the view needs", async () => {
    const { client } = fake([[conversationRow()], [messageRow()]]);
    const detail = await getConversation(client, "1");
    expect(Object.keys(detail!.messages[0]!).sort()).toEqual(
      ["bodyDecodeStatus", "bodyText", "direction", "id", "sourceTimestamp"].sort(),
    );
  });
});

describe("conversation id validation", () => {
  it("accepts a plain positive integer id", () => {
    expect(parseConversationId("1")).toBe("1");
    expect(parseConversationId("257")).toBe("257");
  });

  it("rejects anything else", () => {
    for (const bad of ["", "0", "-1", "1.5", "abc", "1;DROP TABLE x", "1 OR 1=1", " 1", "1e3", "٩"]) {
      expect(parseConversationId(bad)).toBeNull();
    }
  });
});

describe("read-only guarantee", () => {
  it("issues no write statement", async () => {
    const { calls, client } = fake([[conversationRow()], [messageRow()], [conversationRow()]]);
    await listConversations(client, { marketplace: "ebay" });
    await getConversation(client, "1");
    for (const call of calls) {
      for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "DROP", "ALTER", "CREATE"]) {
        expect(call.text.toUpperCase()).not.toContain(verb);
      }
    }
  });

  it("reads only from cst_app", async () => {
    const { calls, client } = fake([[conversationRow()], [messageRow()], [conversationRow()]]);
    await listConversations(client, { marketplace: "ebay" });
    await getConversation(client, "1");
    for (const call of calls) {
      const tables = [...call.text.matchAll(/FROM\s+([\w.]+)/g)].map((m) => m[1]!);
      for (const table of tables) expect(table.startsWith("cst_app.")).toBe(true);
      for (const foreign of ["customer_service", "order_management", "issue_tracking", "poc_listing"]) {
        expect(call.text).not.toContain(foreign);
      }
    }
  });
});
