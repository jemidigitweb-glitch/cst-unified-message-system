import { describe, expect, it } from "vitest";

import {
  THREADING_RULE_VERSION,
  THREAD_GAP_DAYS,
  belongsInReplyInbox,
  threadKeyOf,
} from "@/lib/domain/threading";
import { ENABLED_MARKETPLACES, isEnabled } from "@/lib/domain/marketplace";

describe("threading rule", () => {
  it("stamps a rule version so grouping can be recalculated later", () => {
    expect(THREADING_RULE_VERSION).toBe("v1");
    expect(threadKeyOf({ strategy: "item_linked", subSource: 1, counterparty: "buyer", itemId: "123", segment: 0 }))
      .toMatch(/^v1\|/);
  });

  it("segments on a 30-day gap", () => {
    expect(THREAD_GAP_DAYS).toBe(30);
  });

  it("separates item-linked segments of the same buyer and listing", () => {
    const base = { strategy: "item_linked", subSource: 1, counterparty: "buyer", itemId: "123" } as const;
    expect(threadKeyOf({ ...base, segment: 0 })).not.toBe(threadKeyOf({ ...base, segment: 1 }));
  });

  it("ignores item_id for the no-item strategy", () => {
    const a = threadKeyOf({ strategy: "no_item", subSource: 1, counterparty: "buyer", itemId: "123", segment: 0 });
    const b = threadKeyOf({ strategy: "no_item", subSource: 1, counterparty: "buyer", segment: 0 });
    expect(a).toBe(b);
  });
});

describe("marketplace neutrality of the threading contract", () => {
  it("keeps marketplace-specific detection out of the shared domain layer", async () => {
    const threading = await import("@/lib/domain/threading");
    expect(Object.keys(threading)).not.toContain("isSystemNotice");
  });
});

describe("reply inbox placement", () => {
  it("requires at least one inbound customer message", () => {
    expect(belongsInReplyInbox({ inboundCount: 1 })).toBe(true);
    expect(belongsInReplyInbox({ inboundCount: 0 })).toBe(false);
  });
});

describe("marketplace scope", () => {
  it("enables eBay only in Phase 1", () => {
    expect(ENABLED_MARKETPLACES).toEqual(["ebay"]);
    expect(isEnabled("ebay")).toBe(true);
    expect(isEnabled("amazon")).toBe(false);
    expect(isEnabled("shopify")).toBe(false);
  });
});
