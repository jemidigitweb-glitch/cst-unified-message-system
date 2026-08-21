import { describe, expect, it } from "vitest";

import { UNRESOLVED_REFERENCE_PREFIX } from "@/lib/domain/conversation-reference";
import type { SourceMessage } from "@/lib/domain/source-message";
import {
  TEMU_SOURCE,
  type TemuSourceRow,
  normalizeRow,
  readBody,
  sourceReferenceOf,
} from "@/lib/marketplaces/temu/adapter";
import { buildQuery, classifyRows } from "@/lib/marketplaces/temu/message-repository";
import {
  TEMU_UNRESOLVED_SINGLETON_RULE,
  buildConversations,
} from "@/lib/marketplaces/temu/thread-builder";

/** Synthetic values only. No real customer data appears in any test. */
function row(overrides: Partial<TemuSourceRow> = {}): TemuSourceRow {
  return {
    id: "1",
    message_id: "src-1",
    sub_source: 7,
    message_type: "Question",
    order_id: "PO-000-00000000000000001",
    message_date: "2026-08-11 14:02:00",
    message_content: "synthetic body",
    ...overrides,
  };
}

function msg(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return { ...normalizeRow(row())!, ...overrides };
}

describe("body handling", () => {
  it("treats the body as plain text, never as JSON", () => {
    expect(readBody("5")).toEqual({ text: "5", status: "decoded" });
  });

  it("reports an absent or blank body as empty rather than failed", () => {
    expect(readBody(null)).toEqual({ text: null, status: "empty" });
    expect(readBody("  ")).toEqual({ text: null, status: "empty" });
  });
});

describe("direction", () => {
  it("marks every message inbound, matching the verified source", () => {
    expect(normalizeRow(row())!.direction).toBe("inbound");
    expect(normalizeRow(row({ message_type: "Cancellation" }))!.direction).toBe("inbound");
  });
});

describe("no conversation key is claimed", () => {
  it("gives every message the ungrouped sentinel, reference or not", () => {
    expect(normalizeRow(row({ id: "5" }))!.counterpartyRef).toBe(
      `${UNRESOLVED_REFERENCE_PREFIX}5`,
    );
    expect(normalizeRow(row({ id: "6", order_id: null }))!.counterpartyRef).toBe(
      `${UNRESOLVED_REFERENCE_PREFIX}6`,
    );
  });

  it("records the source reference for traceability without threading on it", () => {
    // Present on under half the rows and very nearly unique where present, so
    // it groups almost nothing while implying that grouping was performed.
    const normalized = normalizeRow(row())!;
    expect(normalized.sourceMetadata.sourceReference).toBe("PO-000-00000000000000001");
    expect(normalized.counterpartyRef).not.toBe(normalized.sourceMetadata.sourceReference);
  });

  it("treats a blank reference as absent", () => {
    expect(sourceReferenceOf("")).toBeNull();
    expect(sourceReferenceOf("   ")).toBeNull();
    expect(sourceReferenceOf(null)).toBeNull();
  });

  it("never derives identity or grouping from an address", () => {
    const normalized = normalizeRow(row())!;
    expect(Object.keys(normalized.sourceMetadata).sort()).toEqual([
      "messageType",
      "sourceReference",
    ]);
    expect(JSON.stringify(normalized)).not.toMatch(/from_msg|to_msg|sender|recipient/i);
  });
});

describe("no fabricated context", () => {
  it("claims no listing or item reference, because the source has none", () => {
    expect(normalizeRow(row())!.listingItemRef).toBeNull();
  });

  it("invents no order, SKU, product, tracking or delivery fact", () => {
    const serialised = JSON.stringify(normalizeRow(row())).toLowerCase();
    for (const invented of ["sku", "product", "tracking", "delivered", "refund", "listing_url"]) {
      expect(serialised).not.toContain(invented);
    }
  });
});

describe("timestamps", () => {
  it("carries the source timestamp through unchanged and unlabelled", () => {
    const stamp = "2026-08-11 23:59:59";
    const normalized = normalizeRow(row({ message_date: stamp }))!;
    expect(normalized.sourceTimestamp).toBe(stamp);
    expect(JSON.stringify(normalized)).not.toMatch(/UTC|GMT|BST|Berlin/);
  });
});

describe("source identity", () => {
  it("records the full source coordinates that make sync idempotent", () => {
    const normalized = normalizeRow(row({ id: "999" }))!;
    expect(normalized.sourceDatabase).toBe(TEMU_SOURCE.database);
    expect(normalized.sourceSchema).toBe(TEMU_SOURCE.schema);
    expect(normalized.sourceTable).toBe(TEMU_SOURCE.messageTable);
    expect(normalized.sourcePk).toBe("999");
    expect(normalized.marketplace).toBe("temu");
  });
});

describe("unusable rows", () => {
  it("rejects rather than coerces a row with no account attribution", () => {
    expect(normalizeRow(row({ sub_source: null }))).toBeNull();
  });

  it("counts what it rejected instead of silently dropping it", () => {
    const result = classifyRows([row({ id: "1" }), row({ id: "2", sub_source: null })]);
    expect(result.rowsExamined).toBe(2);
    expect(result.messages).toHaveLength(1);
    expect(result.unusableCount).toBe(1);
  });
});

describe("singleton threading", () => {
  it("uses a durable capability-based rule name", () => {
    expect(TEMU_UNRESOLVED_SINGLETON_RULE).toBe("temu-unresolved-singleton-v1");
    expect(TEMU_UNRESOLVED_SINGLETON_RULE).not.toMatch(/day\d|phase\d|task\d/i);
  });

  it("gives every message its own conversation, flagged as needing context", () => {
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}1` }),
      msg({ sourcePk: "2", counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}2` }),
      msg({ sourcePk: "3", counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}3` }),
    ]);
    expect(conversations).toHaveLength(3);
    for (const conversation of conversations) {
      expect(conversation.messageCount).toBe(1);
      expect(conversation.needsContext).toBe(true);
      expect(conversation.threadingRuleVersion).toBe(TEMU_UNRESOLVED_SINGLETON_RULE);
      expect(conversation.outboundCount).toBe(0);
    }
  });

  it("never merges messages that share a relay sender or a source reference", () => {
    // Both messages carry the same source reference; the builder must still not
    // group on it, because that reference is not a reliable conversation key.
    const { conversations } = buildConversations([
      msg({ sourcePk: "1", counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}1` }),
      msg({ sourcePk: "2", counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}2` }),
    ]);
    expect(conversations).toHaveLength(2);
    expect(conversations[0]!.threadKey).not.toBe(conversations[1]!.threadKey);
  });

  it("drops no message and is stable across runs", () => {
    const messages = [
      msg({ sourcePk: "1", counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}1` }),
      msg({ sourcePk: "2", counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}2` }),
    ];
    expect(JSON.stringify(buildConversations([...messages].reverse()))).toBe(
      JSON.stringify(buildConversations(messages)),
    );
  });

  it("refuses a message from another marketplace", () => {
    const result = buildConversations([
      msg({ sourcePk: "1", counterpartyRef: `${UNRESOLVED_REFERENCE_PREFIX}1` }),
      msg({ sourcePk: "2", marketplace: "bandq" }),
    ]);
    expect(result.excludedUnusableCount).toBe(1);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.marketplace).toBe("temu");
  });
});

describe("fetch query", () => {
  it("is bounded, parameterised and ordered by the shared intent", () => {
    const { text, values } = buildQuery({
      window: { mode: "bootstrap", startAt: "2026-08-05 00:00:00" },
      limit: 100,
    });
    expect(text).toContain("customer_service.temu_messages");
    expect(text).toMatch(/WHERE m\.date >= \$1::timestamp/);
    expect(text).toMatch(/ORDER BY m\.date ASC, m\.id ASC/);
    expect(values).toEqual(["2026-08-05 00:00:00", 100]);
  });

  it("selects no sender or recipient column", () => {
    const { text } = buildQuery({ window: { mode: "bootstrap", startAt: "2026-08-05" } });
    expect(text).not.toMatch(/from_msg|to_msg/);
  });
});
