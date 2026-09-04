import { describe, expect, it } from "vitest";

import {
  CONTEXT_NOT_LOADED_TEXT,
  type ConversationMessageView,
  type InboxItem,
  NEEDS_CONTEXT_LABEL,
  UNAVAILABLE_BODY_TEXT,
  displayBody,
  formatSourceTimestamp,
  inboxItemSchema,
  messageSide,
  previewOf,
  readStateLabel,
  readStateOf,
} from "@/lib/domain/inbox";
import { MESSAGE_PRIORITIES } from "@/lib/knowledge/message-priority";

function view(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-08-01 10:00:00",
    bodyText: "synthetic body",
    bodyDecodeStatus: "decoded",
    attachments: [],
    ...overrides,
  };
}

describe("message side", () => {
  it("places the customer on the left", () => {
    expect(messageSide(view({ direction: "inbound" }))).toBe("left");
  });

  it("places a previous CST reply on the right", () => {
    expect(messageSide(view({ direction: "outbound" }))).toBe("right");
  });
});

describe("body rendering", () => {
  it("shows a decoded body", () => {
    expect(displayBody(view())).toEqual({ text: "synthetic body", available: true });
  });

  it("shows neutral copy for an empty body", () => {
    expect(displayBody(view({ bodyText: null, bodyDecodeStatus: "empty" }))).toEqual({
      text: UNAVAILABLE_BODY_TEXT,
      available: false,
    });
  });

  it("shows neutral copy for a failed decode rather than raw content", () => {
    const failed = displayBody(view({ bodyText: '{"raw":1}', bodyDecodeStatus: "failed" }));
    expect(failed.text).toBe(UNAVAILABLE_BODY_TEXT);
    expect(failed.text).not.toContain("{");
  });

  it("treats a whitespace-only body as unavailable", () => {
    expect(displayBody(view({ bodyText: "   " })).available).toBe(false);
  });
});

describe("timestamp display", () => {
  it("splits the stored value without converting it", () => {
    expect(formatSourceTimestamp("2026-08-19 11:06:44")).toEqual({
      date: "2026-08-19",
      time: "11:06",
    });
  });

  it("applies no timezone arithmetic and adds no zone label", () => {
    const formatted = formatSourceTimestamp("2026-08-19 23:59:59");
    expect(formatted.date).toBe("2026-08-19");
    expect(formatted.time).toBe("23:59");
    expect(JSON.stringify(formatted)).not.toMatch(/UTC|GMT|BST|Berlin|Z\b/);
  });

  it("handles a fractional-second value", () => {
    expect(formatSourceTimestamp("2026-08-19 11:06:44.123456").time).toBe("11:06");
  });
});

describe("inbox preview", () => {
  it("flattens whitespace", () => {
    expect(previewOf(view({ bodyText: "line one\n\nline  two" }))).toBe("line one line two");
  });

  it("truncates a long body", () => {
    const preview = previewOf(view({ bodyText: "x".repeat(500) }), 20);
    expect(preview).toHaveLength(20);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("never leaks raw content for an undecodable body", () => {
    expect(previewOf(view({ bodyText: "[1,2]", bodyDecodeStatus: "failed" }))).toBe(
      UNAVAILABLE_BODY_TEXT,
    );
  });

  it("handles a conversation with no messages", () => {
    expect(previewOf(null)).toBe("No messages");
  });
});

describe("read state", () => {
  it("is read when the last message is a CST/marketplace outbound reply", () => {
    expect(readStateOf({ lastDirection: "outbound" })).toBe("read");
  });

  it("is unread when the last message is from the customer", () => {
    expect(readStateOf({ lastDirection: "inbound" })).toBe("unread");
  });

  it("is unread when no message has landed yet, rather than assuming read", () => {
    expect(readStateOf({ lastDirection: null })).toBe("unread");
  });

  it("labels each state in plain English", () => {
    expect(readStateLabel("read")).toBe("Read");
    expect(readStateLabel("unread")).toBe("Unread");
  });
});

describe("context copy", () => {
  it("states plainly that context is not resolved yet", () => {
    expect(CONTEXT_NOT_LOADED_TEXT).toBe("Order and product details not loaded yet.");
  });

  it("labels conversations needing context in plain English", () => {
    expect(NEEDS_CONTEXT_LABEL).toBe("No order linked");
    expect(NEEDS_CONTEXT_LABEL.toLowerCase()).not.toContain("context");
  });

  it("fabricates no business fact", () => {
    const copy = { CONTEXT_NOT_LOADED_TEXT, NEEDS_CONTEXT_LABEL, UNAVAILABLE_BODY_TEXT };
    const text = JSON.stringify(copy).toLowerCase();
    for (const invented of ["order number", "sku", "tracking", "refund", "replacement", "delivered"]) {
      expect(text).not.toContain(invented);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * THE PRIORITY FIELD ON THE READ CONTRACT
 * ------------------------------------------------------------------------- */

/**
 * `priority` is ADDITIVE. It joins the item beside `category` and changes
 * nothing else on it: no existing field is renamed, removed, re-typed or made
 * to depend on it.
 */
function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
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
    lastDirection: "inbound",
    category: null,
    priority: null,
    ...overrides,
  };
}

describe("the inbox item's priority field", () => {
  it("accepts every level the engine can return", () => {
    for (const priority of [...MESSAGE_PRIORITIES, null] as const) {
      const parsed = inboxItemSchema.safeParse(item({ priority }));
      expect(parsed.success, String(priority)).toBe(true);
      expect(parsed.success && parsed.data.priority).toBe(priority);
    }
  });

  it("accepts exactly HIGH, MEDIUM, LOW and null — nothing else", () => {
    for (const invalid of ["HIGHEST", "URGENT", "high", "Medium", "", "none", 1, true, {}]) {
      expect(
        inboxItemSchema.safeParse(item({ priority: invalid as never })).success,
        String(invalid),
      ).toBe(false);
    }
  });

  it("requires the field rather than letting it be forgotten", () => {
    // A projection that simply omits it must fail loudly. `undefined` in a JSON
    // response is a dropped field, and a dropped priority is indistinguishable
    // from an established absence — which is the one thing null has to mean.
    const withoutPriority: Record<string, unknown> = { ...item() };
    delete withoutPriority.priority;
    expect(inboxItemSchema.safeParse(withoutPriority).success).toBe(false);
  });

  it("takes the levels from the engine, not from a second copy of them", () => {
    // One definition, so a level cannot exist in the classifier and be
    // unrepresentable on the wire, or the reverse.
    expect([...MESSAGE_PRIORITIES]).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });

  /**
   * ADDITIVE, PINNED FIELD BY FIELD. The response gained exactly one key and
   * lost, renamed and re-typed none — which is what "backward compatible"
   * has to mean for a contract an existing client already reads.
   */
  it("adds one field to the item and changes no other", () => {
    expect(Object.keys(inboxItemSchema.shape).sort()).toEqual(
      [
        "id",
        "marketplace",
        "subSourceId",
        "counterpartyRef",
        "listingItemRef",
        "workflowState",
        "needsContext",
        "inboxPlacement",
        "firstSourceTimestamp",
        "lastSourceTimestamp",
        "messageCount",
        "inboundCount",
        "lastDirection",
        "category",
        "priority",
      ].sort(),
    );
  });

  it("parses an item back exactly as it was given", () => {
    const before = item({ priority: "HIGH", category: "Delivery queries" });
    expect(inboxItemSchema.parse(before)).toEqual(before);
  });
});
