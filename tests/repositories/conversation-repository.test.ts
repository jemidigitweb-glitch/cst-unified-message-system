import { describe, expect, it } from "vitest";

import {
  DEFAULT_INBOX_LIMIT,
  MAX_INBOX_LIMIT,
  type Queryable,
  getConversation,
  listConversations,
  listNoRuleConversations,
  parseConversationId,
} from "@/lib/repositories/conversation-repository";

/** Synthetic rows only. No real customer data appears in any test. */
function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    marketplace: "ebay",
    sub_source_id: 7,
    counterparty_ref: "counterparty-a",
    listing_item_ref: "listing-1",
    workflow_state: "received",
    needs_context: false,
    inbox_visibility: "reply_inbox",
    first_source_ts: "2026-08-01 10:00:00",
    last_source_ts: "2026-08-02 10:00:00",
    message_count: 2,
    inbound_count: 1,
    last_direction: "outbound",
    ...overrides,
  };
}

/** A no-rule row: every conversationRow() field plus the finding itself. */
function noRuleRow(overrides: Record<string, unknown> = {}) {
  return {
    ...conversationRow(),
    case_type: "Return request",
    analysed_at: "2026-08-20 09:00:00",
    reason: "no_corpus",
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
  /**
   * EVERY placement is listed by default.
   *
   * This used to assert the opposite -- only 'reply_inbox' -- and that filter
   * hid 3,046 stored conversations from every view in the application. The
   * placement is still returned on each item so the interface can label it;
   * what it no longer does is decide what exists.
   */
  it("lists every conversation, whatever its inbox placement", async () => {
    const { calls, client } = fake([[conversationRow()]]);
    await listConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.values![1]).toBeNull();
    expect(calls[0]!.text).not.toContain("WHERE inbox_visibility = 'reply_inbox'");
  });

  it("can still narrow to one placement when a caller asks", async () => {
    const { calls, client } = fake([[]]);
    await listConversations(client, { marketplace: "ebay", limit: 5, placement: "reply_inbox" });
    // limit+1: one extra row is requested, never returned, purely to learn
    // whether a next page exists. offset defaults to 0.
    expect(calls[0]!.values).toEqual(["ebay", "reply_inbox", 6, 0]);
  });

  it("orders the inbox by latest activity first", async () => {
    const { calls, client } = fake([[]]);
    await listConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.text).toContain("ORDER BY c.last_source_ts DESC");
  });

  it("bounds the result size", async () => {
    // The query asks for one row more than the bound, purely to detect a
    // next page; the bound itself is what these assert.
    const a = fake([[]]);
    await listConversations(a.client, { marketplace: "ebay" });
    expect(a.calls[0]!.values![2]).toBe(DEFAULT_INBOX_LIMIT + 1);

    const b = fake([[]]);
    await listConversations(b.client, { marketplace: "ebay", limit: 99_999 });
    expect(b.calls[0]!.values![2]).toBe(MAX_INBOX_LIMIT + 1);

    const c = fake([[]]);
    await listConversations(c.client, { marketplace: "ebay", limit: 0 });
    expect(c.calls[0]!.values![2]).toBe(DEFAULT_INBOX_LIMIT + 1);
  });

  it("skips by offset for the second and later pages", async () => {
    const { calls, client } = fake([[]]);
    await listConversations(client, { marketplace: "ebay", offset: 100 });
    expect(calls[0]!.values![3]).toBe(100);

    const { calls: defaultCalls, client: defaultClient } = fake([[]]);
    await listConversations(defaultClient, { marketplace: "ebay" });
    expect(defaultCalls[0]!.values![3]).toBe(0);
  });

  it("reports hasMore from the one-extra-row overfetch, not a count", async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      conversationRow({ id: String(index + 1) }),
    );

    const exact = fake([rows.slice(0, 2)]);
    const exactPage = await listConversations(exact.client, { marketplace: "ebay", limit: 2 });
    expect(exactPage.items).toHaveLength(2);
    expect(exactPage.hasMore).toBe(false);

    const overflow = fake([rows]);
    const overflowPage = await listConversations(overflow.client, {
      marketplace: "ebay",
      limit: 2,
    });
    // The third row proved a next page exists; it is not itself returned.
    expect(overflowPage.items).toHaveLength(2);
    expect(overflowPage.hasMore).toBe(true);
  });

  it("maps rows to the neutral inbox shape", async () => {
    const { client } = fake([[conversationRow({ needs_context: true })]]);
    const [item] = (await listConversations(client, { marketplace: "ebay" })).items;
    expect(item).toEqual({
      id: "1",
      marketplace: "ebay",
      subSourceId: 7,
      counterpartyRef: "counterparty-a",
      listingItemRef: "listing-1",
      workflowState: "received",
      needsContext: true,
      inboxPlacement: "reply_inbox",
      firstSourceTimestamp: "2026-08-01 10:00:00",
      lastSourceTimestamp: "2026-08-02 10:00:00",
      messageCount: 2,
      inboundCount: 1,
      lastDirection: "outbound",
      category: null,
    });
  });

  it("computes category from the row's aggregated inbound text", async () => {
    const { calls, client } = fake([[conversationRow({ inbound_text: "My item arrived damaged." })]]);
    const [item] = (await listConversations(client, { marketplace: "ebay" })).items;
    expect(item?.category).toBe("Damage queries");
    expect(calls[0]!.text).toContain("AS inbound_text");
    expect(calls[0]!.text).toContain("cm.direction = 'inbound'");
  });

  it("reports category null when no inbound text was aggregated", async () => {
    const { client } = fake([[conversationRow({ inbound_text: null })]]);
    const [item] = (await listConversations(client, { marketplace: "ebay" })).items;
    expect(item?.category).toBeNull();
  });

  it("still classifies eBay and Amazon conversations", async () => {
    const ebay = fake([[conversationRow({ marketplace: "ebay", inbound_text: "Der Artikel ist defekt." })]]);
    const [ebayItem] = (await listConversations(ebay.client, { marketplace: "ebay" })).items;
    expect(ebayItem?.category).toBe("Defective items");

    const amazon = fake([
      [conversationRow({ marketplace: "amazon", inbound_text: "This item is faulty and stopped working." })],
    ]);
    const [amazonItem] = (await listConversations(amazon.client, { marketplace: "amazon" })).items;
    expect(amazonItem?.category).toBe("Defective items");
  });

  it("suppresses category for B&Q and Temu, even when the text would otherwise classify", async () => {
    const bandq = fake([
      [conversationRow({ marketplace: "bandq", inbound_text: "The item arrived damaged and broken." })],
    ]);
    const [bandqItem] = (await listConversations(bandq.client, { marketplace: "bandq" })).items;
    expect(bandqItem?.category).toBeNull();

    const temu = fake([
      [conversationRow({ marketplace: "temu", inbound_text: "I would like a refund for this order." })],
    ]);
    const [temuItem] = (await listConversations(temu.client, { marketplace: "temu" })).items;
    expect(temuItem?.category).toBeNull();
  });

  it("leaves inbox_visibility filtering untouched by the category suppression", async () => {
    const { calls, client } = fake([[]]);
    await listConversations(client, { marketplace: "bandq", placement: "reply_inbox" });
    expect(calls[0]!.text).toContain("c.inbox_visibility = $2::text");
    expect(calls[0]!.values![1]).toBe("reply_inbox");
  });

  it("exposes no source table or connection metadata to callers", async () => {
    const { client } = fake([[conversationRow()]]);
    const [item] = (await listConversations(client, { marketplace: "ebay" })).items;
    for (const leaked of ["source_database", "source_schema", "source_table", "source_pk", "password", "host"]) {
      expect(item).not.toHaveProperty(leaked);
    }
  });
});

describe("last message direction", () => {
  it("derives it from conversation_messages, ordered like the thread view", async () => {
    const { calls, client } = fake([[conversationRow()]]);
    await listConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.text).toContain(
      "ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC",
    );
    expect(calls[0]!.text).toContain("cm.conversation_id = c.id");
  });

  it("does not read it from a stored/carried column", async () => {
    const { client } = fake([[conversationRow({ last_direction: "inbound" })]]);
    const [item] = (await listConversations(client, { marketplace: "ebay" })).items;
    expect(item?.lastDirection).toBe("inbound");
  });

  it("is null for a conversation with no messages landed yet", async () => {
    const { client } = fake([[conversationRow({ last_direction: null })]]);
    const [item] = (await listConversations(client, { marketplace: "ebay" })).items;
    expect(item?.lastDirection).toBeNull();
  });

  it("is included on a single conversation lookup too", async () => {
    const { calls, client } = fake([[conversationRow({ last_direction: "inbound" })], []]);
    const detail = await getConversation(client, "1");
    expect(calls[0]!.text).toContain("AS last_direction");
    expect(detail?.conversation.lastDirection).toBe("inbound");
  });
});

describe("No Rule listing", () => {
  it("joins the rule-analysis finding to the conversation it describes", async () => {
    const { calls, client } = fake([[noRuleRow()]]);
    await listNoRuleConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.text).toContain(
      "FROM cst_app.conversation_rule_analysis ra",
    );
    expect(calls[0]!.text).toContain("JOIN cst_app.conversations c ON c.id = ra.conversation_id");
  });

  it("narrows to the requested marketplace, parameterised", async () => {
    const { calls, client } = fake([[]]);
    await listNoRuleConversations(client, { marketplace: "amazon" });
    expect(calls[0]!.text).toContain("WHERE c.marketplace = $1");
    expect(calls[0]!.text).not.toContain("amazon");
    expect(calls[0]!.values![0]).toBe("amazon");
  });

  it("only returns the no_applicable_rule outcome", async () => {
    const { calls, client } = fake([[]]);
    await listNoRuleConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.text).toContain("ra.outcome = 'no_applicable_rule'");
  });

  it("orders newest finding first", async () => {
    const { calls, client } = fake([[]]);
    await listNoRuleConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.text).toContain("ORDER BY ra.analysed_at DESC");
  });

  it("carries the finding's case type and timestamp alongside every inbox field", async () => {
    const { client } = fake([[noRuleRow({ case_type: "Damaged item" })]]);
    const [item] = await listNoRuleConversations(client, { marketplace: "ebay" });
    expect(item).toEqual({
      id: "1",
      marketplace: "ebay",
      subSourceId: 7,
      counterpartyRef: "counterparty-a",
      listingItemRef: "listing-1",
      workflowState: "received",
      needsContext: false,
      inboxPlacement: "reply_inbox",
      firstSourceTimestamp: "2026-08-01 10:00:00",
      lastSourceTimestamp: "2026-08-02 10:00:00",
      messageCount: 2,
      inboundCount: 1,
      lastDirection: "outbound",
      category: null,
      caseType: "Damaged item",
      analysedAt: "2026-08-20 09:00:00",
      reason: "no_corpus",
    });
  });

  it("represents an unclassified case as null, not a placeholder string", async () => {
    const { client } = fake([[noRuleRow({ case_type: null })]]);
    const [item] = await listNoRuleConversations(client, { marketplace: "ebay" });
    expect(item?.caseType).toBeNull();
  });

  it("bounds the result size like every other list", async () => {
    const { calls, client } = fake([[]]);
    await listNoRuleConversations(client, { marketplace: "ebay" });
    expect(calls[0]!.values![1]).toBe(DEFAULT_INBOX_LIMIT);
  });

  it("reads nothing outside cst_app", async () => {
    const { calls, client } = fake([[noRuleRow()]]);
    await listNoRuleConversations(client, { marketplace: "ebay" });
    for (const call of calls) {
      // Schema-qualified references only -- a WITH-clause name like
      // `latest_generated` is not a table and is never `schema.table`.
      const tables = [...call.text.matchAll(/FROM\s+([\w.]+)/g)]
        .map((m) => m[1]!)
        .filter((name) => name.includes("."));
      for (const table of tables) expect(table.startsWith("cst_app.")).toBe(true);
      // Statement phrases, not bare verbs -- a bare "CREATE" also matches the
      // legitimate column name `created_at`.
      for (const statement of [
        "INSERT INTO",
        "UPDATE CST_APP",
        "DELETE FROM",
        "TRUNCATE",
        "DROP TABLE",
        "ALTER TABLE",
        "CREATE TABLE",
      ]) {
        expect(call.text.toUpperCase()).not.toContain(statement);
      }
    }
  });

  it("tags a stored finding as no_corpus", async () => {
    const { client } = fake([[noRuleRow()]]);
    const [item] = await listNoRuleConversations(client, { marketplace: "ebay" });
    expect(item?.reason).toBe("no_corpus");
  });
});

describe("No Rule listing: ungrounded generated drafts", () => {
  /** A row from the second query: a conversation, no case type of its own yet. */
  function ungroundedRow(overrides: Record<string, unknown> = {}) {
    return {
      ...conversationRow(),
      revision_id: "50",
      analysed_at: "2026-08-22 14:00:00",
      reason: "no_citation",
      ...overrides,
    };
  }

  function messageRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "10",
      direction: "inbound",
      source_ts: "2026-08-22 13:00:00",
      body_text: "I would like a refund please.",
      body_decode_status: "decoded",
      attachments: null,
      ...overrides,
    };
  }

  /** A stored citation row, as the third query (LIST_CITED_REFS) returns it. */
  function citedRefRow(overrides: Record<string, unknown> = {}) {
    return { revision_id: "50", source_ref: "RETREF-1-1", ...overrides };
  }

  /** A corpus with one real rule, resolvable by its ref. */
  const RESOLVABLE_RULE = { ref: "RETREF-1-1", title: "Refund rule", text: "Refund text", category: null };
  const loadRulesWith = (rules: typeof RESOLVABLE_RULE[]) => () => ({
    knowledge:
      rules.length > 0
        ? ({ state: "available" as const, rules, sheetRef: "test" })
        : ({ state: "not_configured" as const, reason: "test: empty corpus" }),
    corpus: undefined,
  });

  it("finds a conversation whose newest generated reply cited nothing", async () => {
    const { calls, client } = fake([[], [ungroundedRow()], [], [messageRow()]]);
    await listNoRuleConversations(client, {
      marketplace: "ebay",
      loadRules: loadRulesWith([]),
    });
    const candidateQuery = calls[1]!.text;
    expect(candidateQuery).toContain("origin = 'generated'");
    expect(candidateQuery).toContain("DISTINCT ON (dr.conversation_id)");
    // The presence check moved to its own query, run only for candidates that exist.
    expect(calls[2]!.text).toContain("source_kind = 'cst_document'");
  });

  it("excludes a conversation already covered by the stored no_corpus finding", async () => {
    const { calls, client } = fake([[], []]);
    await listNoRuleConversations(client, { marketplace: "ebay" });
    expect(calls[1]!.text).toContain("NOT EXISTS");
    expect(calls[1]!.text).toContain(
      "SELECT 1 FROM cst_app.conversation_rule_analysis ra WHERE ra.conversation_id = c.id",
    );
    // No candidates, so the corpus is never loaded and no third query runs.
    expect(calls).toHaveLength(2);
  });

  it("classifies the case from the conversation's own messages, not a stored value", async () => {
    const { calls, client } = fake([[], [ungroundedRow()], [], [messageRow()]]);
    const [item] = await listNoRuleConversations(client, {
      marketplace: "ebay",
      loadRules: loadRulesWith([]),
    });
    // The message-fetch query for the classification, keyed to this conversation.
    expect(calls[3]!.text).toContain("FROM cst_app.conversation_messages");
    expect(calls[3]!.values).toEqual(["1"]);
    expect(item?.caseType).toBe("Customer requesting a return or refund");
  });

  it("tags it as no_citation, using the revision's own timestamp", async () => {
    const { client } = fake([
      [],
      [ungroundedRow({ analysed_at: "2026-08-23 08:15:00" })],
      [],
      [messageRow()],
    ]);
    const [item] = await listNoRuleConversations(client, {
      marketplace: "ebay",
      loadRules: loadRulesWith([]),
    });
    expect(item?.reason).toBe("no_citation");
    expect(item?.analysedAt).toBe("2026-08-23 08:15:00");
  });

  it("merges both sources into one newest-first list", async () => {
    const { client } = fake([
      [noRuleRow({ id: "1", analysed_at: "2026-08-20 09:00:00" })],
      [ungroundedRow({ id: "2", analysed_at: "2026-08-23 08:15:00" })],
      [],
      [messageRow()],
    ]);
    const items = await listNoRuleConversations(client, {
      marketplace: "ebay",
      loadRules: loadRulesWith([]),
    });
    expect(items.map((item) => item.id)).toEqual(["2", "1"]);
    expect(items.map((item) => item.reason)).toEqual(["no_citation", "no_corpus"]);
  });

  /**
   * THE FIX ITSELF. A stored `cst_document` row used to be enough on its own
   * to exclude a conversation from this list, whatever the ref inside it
   * said. These two tests are the guard against that regressing.
   */
  describe("citation resolution, not just presence", () => {
    it("excludes a conversation whose citation resolves to a real rule", async () => {
      const { client } = fake([
        [],
        [ungroundedRow({ id: "3" })],
        [citedRefRow({ source_ref: "RETREF-1-1" })],
      ]);
      const items = await listNoRuleConversations(client, {
        marketplace: "ebay",
        loadRules: loadRulesWith([RESOLVABLE_RULE]),
      });
      expect(items.map((item) => item.id)).not.toContain("3");
    });

    it("includes a conversation whose citation does not resolve against the current corpus", async () => {
      const { calls, client } = fake([
        [],
        [ungroundedRow({ id: "4" })],
        // The corpus has rules, but none matches this stored ref -- the
        // documents moved on since this draft was generated.
        [citedRefRow({ source_ref: "RETREF-DELETED-9" })],
        [messageRow()],
      ]);
      const items = await listNoRuleConversations(client, {
        marketplace: "ebay",
        loadRules: loadRulesWith([RESOLVABLE_RULE]),
      });
      expect(items.map((item) => item.id)).toContain("4");
      expect(calls[2]!.values).toEqual([["50"]]);
    });

    it("includes a conversation when the corpus itself is not configured", async () => {
      const { client } = fake([
        [],
        [ungroundedRow({ id: "5" })],
        [citedRefRow({ source_ref: "RETREF-1-1" })],
        [messageRow()],
      ]);
      const items = await listNoRuleConversations(client, {
        marketplace: "ebay",
        loadRules: () => ({
          knowledge: { state: "not_configured", reason: "test: unreadable corpus" },
          corpus: undefined,
        }),
      });
      expect(items.map((item) => item.id)).toContain("5");
    });

    it("works the same way for every marketplace, not only eBay", async () => {
      const { calls, client } = fake([
        [],
        [ungroundedRow({ id: "6", marketplace: "amazon" })],
        [citedRefRow({ source_ref: "RETREF-DELETED-9" })],
        [messageRow()],
      ]);
      const items = await listNoRuleConversations(client, {
        marketplace: "amazon",
        loadRules: loadRulesWith([RESOLVABLE_RULE]),
      });
      expect(calls[0]!.values![0]).toBe("amazon");
      expect(calls[1]!.values).toEqual(["amazon"]);
      expect(items.map((item) => item.id)).toContain("6");
    });
  });
});

describe("marketplace filtering", () => {
  it("filters the inbox to the requested marketplace", async () => {
    const { calls, client } = fake([[]]);
    await listConversations(client, { marketplace: "amazon" });
    expect(calls[0]!.text).toContain("WHERE c.marketplace = $1");
    expect(calls[0]!.values![0]).toBe("amazon");
  });

  it("keeps eBay and Amazon queries separate", async () => {
    const a = fake([[]]);
    await listConversations(a.client, { marketplace: "ebay" });
    const b = fake([[]]);
    await listConversations(b.client, { marketplace: "amazon" });
    expect(a.calls[0]!.values![0]).toBe("ebay");
    expect(b.calls[0]!.values![0]).toBe("amazon");
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
      ["attachments", "bodyDecodeStatus", "bodyText", "direction", "id", "sourceTimestamp"].sort(),
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
