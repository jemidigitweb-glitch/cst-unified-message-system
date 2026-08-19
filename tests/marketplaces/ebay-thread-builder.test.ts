import { describe, expect, it } from "vitest";

import type { SourceMessage } from "@/lib/domain/source-message";
import {
  EBAY_ITEM_LINKED_RULE,
  EBAY_NO_ITEM_RULE,
  buildConversations,
} from "@/lib/marketplaces/ebay/thread-builder";

function msg(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return {
    marketplace: "ebay",
    sourceDatabase: "ledsone",
    sourceSchema: "customer_service",
    sourceTable: "ebay_message_headers",
    sourcePk: "1",
    externalMessageId: "123456789012",
    subSourceId: 1,
    listingItemRef: "555",
    counterpartyRef: "buyer",
    direction: "inbound",
    sourceTimestamp: "2026-08-01 10:00:00",
    bodyText: "text",
    bodyDecodeStatus: "decoded",
    sourceMetadata: {},
    ...overrides,
  };
}

describe("rule identifiers", () => {
  it("uses durable capability-based rule names", () => {
    expect(EBAY_ITEM_LINKED_RULE).toBe("ebay-item-counterparty-gap-v1");
    expect(EBAY_NO_ITEM_RULE).toBe("ebay-counterparty-gap-v1");
    for (const rule of [EBAY_ITEM_LINKED_RULE, EBAY_NO_ITEM_RULE]) {
      expect(rule).not.toMatch(/day\d|phase\d|task\d/i);
    }
  });
});

describe("item-linked grouping", () => {
  it("groups by sub_source + listing item + counterparty", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-01 11:00:00", direction: "outbound" }),
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      threadingStrategy: "item_linked",
      threadingRuleVersion: EBAY_ITEM_LINKED_RULE,
      messageCount: 2,
      inboundCount: 1,
      outboundCount: 1,
      needsContext: false,
      inboxPlacement: "reply_inbox",
    });
  });

  it("separates different listings, buyers, and sub_sources", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1" }),
      msg({ sourcePk: "2", listingItemRef: "666" }),
      msg({ sourcePk: "3", counterpartyRef: "other" }),
      msg({ sourcePk: "4", subSourceId: 2 }),
    ]);
    expect(conversations).toHaveLength(4);
  });

  it("carries the exact source timestamps through unconverted", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", sourceTimestamp: "2026-08-01 10:00:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-05 23:59:59.123456" }),
    ]);
    expect(conversations[0]!.firstSourceTimestamp).toBe("2026-08-01 10:00:00");
    expect(conversations[0]!.lastSourceTimestamp).toBe("2026-08-05 23:59:59.123456");
  });
});

describe("30-day gap segmentation", () => {
  it("splits when the gap exceeds 30 days", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", sourceTimestamp: "2026-01-01 00:00:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-02-05 00:00:00" }),
    ]);
    expect(conversations).toHaveLength(2);
    expect(conversations[0]!.threadKey).not.toBe(conversations[1]!.threadKey);
    // Segment is the last element of the canonical key tuple.
    expect(JSON.parse(conversations[0]!.threadKey).at(-1)).toBe(0);
    expect(JSON.parse(conversations[1]!.threadKey).at(-1)).toBe(1);
  });

  it("keeps a gap of exactly 30 days in one conversation", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", sourceTimestamp: "2026-01-01 00:00:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-01-31 00:00:00" }),
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.messageCount).toBe(2);
  });

  it("splits one second past the threshold", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", sourceTimestamp: "2026-01-01 00:00:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-01-31 00:00:01" }),
    ]);
    expect(conversations).toHaveLength(2);
  });
});

describe("message ordering inside a conversation", () => {
  it("orders by source timestamp ascending", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "3", sourceTimestamp: "2026-08-03 10:00:00" }),
      msg({ sourcePk: "1", sourceTimestamp: "2026-08-01 10:00:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-02 10:00:00" }),
    ]);
    expect(conversations[0]!.messages.map((m) => m.sourcePk)).toEqual(["1", "2", "3"]);
  });

  it("breaks a timestamp tie by source PK, numerically", () => {
    const same = "2026-08-01 10:00:00";
    const { conversations } = buildConversations([
      msg({ sourcePk: "10", sourceTimestamp: same }),
      msg({ sourcePk: "9", sourceTimestamp: same }),
      msg({ sourcePk: "100", sourceTimestamp: same }),
    ]);
    expect(conversations[0]!.messages.map((m) => m.sourcePk)).toEqual(["9", "10", "100"]);
  });
});

describe("no-item conversations", () => {
  it("groups by sub_source + counterparty and flags needsContext", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", listingItemRef: null }),
      msg({ sourcePk: "2", listingItemRef: null, sourceTimestamp: "2026-08-01 11:00:00", direction: "outbound" }),
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      threadingStrategy: "no_item",
      threadingRuleVersion: EBAY_NO_ITEM_RULE,
      needsContext: true,
      inboxPlacement: "reply_inbox",
      listingItemRef: null,
    });
  });

  it("keeps no-item messages out of item-linked conversations", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", listingItemRef: "555" }),
      msg({ sourcePk: "2", listingItemRef: null }),
    ]);
    expect(conversations).toHaveLength(2);
    expect(new Set(conversations.map((c) => c.threadingStrategy))).toEqual(
      new Set(["item_linked", "no_item"]),
    );
  });

  it("classifies an outbound-only group away from the reply inbox", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", listingItemRef: null, direction: "outbound" }),
      msg({ sourcePk: "2", listingItemRef: null, direction: "outbound", sourceTimestamp: "2026-08-01 11:00:00" }),
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      inboxPlacement: "outbound_only",
      inboundCount: 0,
      outboundCount: 2,
    });
  });

  it("attaches no order and reads no message text to infer one", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", listingItemRef: null, bodyText: "my order 00-00000-00000 is late" }),
    ]);
    const conversation = conversations[0]!;
    for (const forbidden of ["orderNumber", "orderId", "candidateOrders", "subSourceOrderId"]) {
      expect(conversation).not.toHaveProperty(forbidden);
    }
    expect(conversation.needsContext).toBe(true);
    // Body text is carried through untouched, never parsed.
    expect(conversation.messages[0]!.bodyText).toBe("my order 00-00000-00000 is late");
  });
});

describe("determinism", () => {
  it("produces identical output for identical input regardless of arrival order", () => {
    const messages = [
      msg({ sourcePk: "1", sourceTimestamp: "2026-08-01 10:00:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-02 10:00:00", direction: "outbound" }),
      msg({ sourcePk: "3", sourceTimestamp: "2026-08-01 10:00:00", listingItemRef: null }),
      msg({ sourcePk: "4", sourceTimestamp: "2026-09-30 10:00:00" }),
    ];
    const forward = buildConversations(messages);
    const reversed = buildConversations([...messages].reverse());
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("orders conversations deterministically by first timestamp then key", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", sourceTimestamp: "2026-08-05 10:00:00", listingItemRef: "b" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-01 10:00:00", listingItemRef: "a" }),
    ]);
    expect(conversations.map((c) => c.firstSourceTimestamp)).toEqual([
      "2026-08-01 10:00:00",
      "2026-08-05 10:00:00",
    ]);
  });

  it("does not mutate the input array or its messages", () => {
    const input = [
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-02 10:00:00" }),
      msg({ sourcePk: "1", sourceTimestamp: "2026-08-01 10:00:00" }),
    ];
    const snapshot = JSON.stringify(input);
    buildConversations(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("unusable messages", () => {
  it("counts a message with no counterparty instead of grouping it", () => {
    const result = buildConversations([msg({ counterpartyRef: null }), msg({ sourcePk: "2" })]);
    expect(result.excludedUnusableCount).toBe(1);
    expect(result.conversations).toHaveLength(1);
  });
});
