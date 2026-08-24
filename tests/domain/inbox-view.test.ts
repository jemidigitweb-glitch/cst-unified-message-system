import { describe, expect, it } from "vitest";

import {
  CONTEXT_NOT_LOADED_TEXT,
  type ConversationMessageView,
  NEEDS_CONTEXT_LABEL,
  UNAVAILABLE_BODY_TEXT,
  displayBody,
  formatSourceTimestamp,
  messageSide,
  previewOf,
  readStateLabel,
  readStateOf,
} from "@/lib/domain/inbox";

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
