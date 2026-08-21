import { describe, expect, it } from "vitest";

import { UNRESOLVED_REFERENCE_PREFIX } from "@/lib/domain/conversation-reference";
import type { SourceMessage } from "@/lib/domain/source-message";
import {
  BANDQ_SOURCE_ORDER_THREAD_RULE,
  BANDQ_UNRESOLVED_SINGLETON_RULE,
  buildConversations,
} from "@/lib/marketplaces/bandq/thread-builder";

/** Synthetic values only. No real customer data appears in any test. */
function msg(overrides: Partial<SourceMessage> = {}): SourceMessage {
  const reference =
    "sourceOrderRef" in (overrides.sourceMetadata ?? {})
      ? (overrides.sourceMetadata!.sourceOrderRef ?? null)
      : "0000000001-A";
  return {
    marketplace: "bandq",
    sourceDatabase: "ledsone",
    sourceSchema: "customer_service",
    sourceTable: "bandq_messages",
    sourcePk: "1",
    externalMessageId: "src-1",
    subSourceId: 4,
    listingItemRef: null,
    counterpartyRef: reference ?? `${UNRESOLVED_REFERENCE_PREFIX}1`,
    direction: "inbound",
    sourceTimestamp: "2026-08-10 09:15:00",
    bodyText: "synthetic body",
    bodyDecodeStatus: "decoded",
    sourceMetadata: { messageType: "Question", sourceOrderRef: reference },
    ...overrides,
  };
}

function ungrouped(pk: string, overrides: Partial<SourceMessage> = {}): SourceMessage {
  return msg({
    sourcePk: pk,
    counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}${pk}`,
    sourceMetadata: { messageType: "Question", sourceOrderRef: null },
    ...overrides,
  });
}

describe("rule identifiers", () => {
  it("uses durable capability-based names", () => {
    expect(BANDQ_SOURCE_ORDER_THREAD_RULE).toBe("bandq-source-order-thread-v1");
    expect(BANDQ_UNRESOLVED_SINGLETON_RULE).toBe("bandq-unresolved-singleton-v1");
    for (const rule of [BANDQ_SOURCE_ORDER_THREAD_RULE, BANDQ_UNRESOLVED_SINGLETON_RULE]) {
      expect(rule).not.toMatch(/day\d|phase\d|task\d/i);
    }
  });
});

describe("deterministic grouping where the source supplies a reference", () => {
  it("groups messages sharing sub_source and source reference", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-10 11:00:00" }),
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      marketplace: "bandq",
      threadingRuleVersion: BANDQ_SOURCE_ORDER_THREAD_RULE,
      messageCount: 2,
      inboundCount: 2,
      outboundCount: 0,
      inboxPlacement: "reply_inbox",
    });
  });

  it("separates different references and different accounts", () => {
    const other = { messageType: "Question", sourceOrderRef: "0000000002-B" };
    const { conversations } = buildConversations([
      msg({ sourcePk: "1" }),
      msg({ sourcePk: "2", counterpartyRef: "0000000002-B", sourceMetadata: other }),
      msg({ sourcePk: "3", subSourceId: 5 }),
    ]);
    expect(conversations).toHaveLength(3);
  });

  it("still needs context, because the reference is not a resolved order", () => {
    // Grouping proves two messages belong together. It does not establish which
    // purchase — if any — they concern, and the two are separate claims.
    const { conversations } = buildConversations([msg({ sourcePk: "1" }), msg({ sourcePk: "2" })]);
    expect(conversations[0]!.needsContext).toBe(true);
  });

  it("applies no time-gap segmentation", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", sourceTimestamp: "2026-01-01 10:00:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-06-01 10:00:00" }),
    ]);
    expect(conversations).toHaveLength(1);
  });

  it("orders messages oldest first with the source PK as tiebreaker", () => {
    const same = "2026-08-10 09:15:00";
    const { conversations } = buildConversations([
      msg({ sourcePk: "10", sourceTimestamp: same }),
      msg({ sourcePk: "9", sourceTimestamp: same }),
      msg({ sourcePk: "100", sourceTimestamp: same }),
    ]);
    expect(conversations[0]!.messages.map((m) => m.sourcePk)).toEqual(["9", "10", "100"]);
  });
});

describe("singleton fallback", () => {
  it("gives each message with no source reference its own conversation", () => {
    const { conversations } = buildConversations([ungrouped("1"), ungrouped("2")]);
    expect(conversations).toHaveLength(2);
    expect(conversations.every((c) => c.messageCount === 1)).toBe(true);
    expect(conversations.every((c) => c.needsContext)).toBe(true);
    expect(
      conversations.every((c) => c.threadingRuleVersion === BANDQ_UNRESOLVED_SINGLETON_RULE),
    ).toBe(true);
  });

  it("does not merge ungrouped messages that share a relay sender", () => {
    const { conversations } = buildConversations([
      ungrouped("1", { externalMessageId: "src-a" }),
      ungrouped("2", { externalMessageId: "src-b" }),
    ]);
    expect(conversations).toHaveLength(2);
    expect(conversations[0]!.threadKey).not.toBe(conversations[1]!.threadKey);
  });

  it("keys singletons on the immutable source PK so a re-run is stable", () => {
    expect(buildConversations([ungrouped("42")]).conversations[0]!.threadKey).toBe(
      buildConversations([ungrouped("42")]).conversations[0]!.threadKey,
    );
  });
});

describe("nothing is lost or invented", () => {
  it("drops no message", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1" }),
      ungrouped("2"),
      ungrouped("3"),
    ]);
    expect(conversations.reduce((sum, c) => sum + c.messageCount, 0)).toBe(3);
  });

  it("fabricates no CST reply", () => {
    const { conversations } = buildConversations([msg({ sourcePk: "1" }), ungrouped("2")]);
    for (const conversation of conversations) {
      expect(conversation.outboundCount).toBe(0);
      expect(conversation.messages.every((m) => m.direction === "inbound")).toBe(true);
    }
  });

  it("claims no item reference", () => {
    const { conversations } = buildConversations([msg({ sourcePk: "1" })]);
    expect(conversations[0]!.listingItemRef).toBeNull();
  });

  it("is deterministic regardless of arrival order", () => {
    const messages = [
      msg({ sourcePk: "1", sourceTimestamp: "2026-08-01 10:00:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-03 10:00:00" }),
      ungrouped("3", { sourceTimestamp: "2026-08-02 10:00:00" }),
    ];
    expect(JSON.stringify(buildConversations([...messages].reverse()))).toBe(
      JSON.stringify(buildConversations(messages)),
    );
  });

  it("refuses a message from another marketplace", () => {
    const result = buildConversations([
      msg({ sourcePk: "1" }),
      msg({ sourcePk: "2", marketplace: "temu" }),
    ]);
    expect(result.excludedUnusableCount).toBe(1);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.marketplace).toBe("bandq");
  });

  it("preserves source timestamps verbatim on the conversation span", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", sourceTimestamp: "2026-08-10 09:15:00" }),
      msg({ sourcePk: "2", sourceTimestamp: "2026-08-12 23:59:59" }),
    ]);
    expect(conversations[0]!.firstSourceTimestamp).toBe("2026-08-10 09:15:00");
    expect(conversations[0]!.lastSourceTimestamp).toBe("2026-08-12 23:59:59");
  });
});
