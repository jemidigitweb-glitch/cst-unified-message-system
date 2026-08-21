import { describe, expect, it } from "vitest";

import {
  THREAD_GAP_DAYS,
  THREAD_GAP_MS,
  belongsInReplyInbox,
  gapMillis,
  threadKeyOf,
} from "@/lib/domain/threading";
import { MARKETPLACES, marketplaceSchema } from "@/lib/domain/marketplace";

const RULE = "test-rule-v1";

describe("threading contract", () => {
  it("segments on a 30-day gap", () => {
    expect(THREAD_GAP_DAYS).toBe(30);
    expect(THREAD_GAP_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("stamps every key with the rule that produced it", () => {
    const key = threadKeyOf({
      ruleVersion: RULE,
      strategy: "item_linked",
      subSourceId: 1,
      counterpartyRef: "buyer",
      listingItemRef: "123",
      segment: 0,
    });
    // Canonical key tuple; the rule version is its first element.
    expect(JSON.parse(key)[0]).toBe(RULE);
  });

  it("separates segments of the same buyer and listing", () => {
    const base = {
      ruleVersion: RULE,
      strategy: "item_linked",
      subSourceId: 1,
      counterpartyRef: "buyer",
      listingItemRef: "123",
    } as const;
    expect(threadKeyOf({ ...base, segment: 0 })).not.toBe(threadKeyOf({ ...base, segment: 1 }));
  });

  it("ignores the listing reference for the no-item strategy", () => {
    const a = threadKeyOf({
      ruleVersion: RULE,
      strategy: "no_item",
      subSourceId: 1,
      counterpartyRef: "buyer",
      listingItemRef: "123",
      segment: 0,
    });
    const b = threadKeyOf({
      ruleVersion: RULE,
      strategy: "no_item",
      subSourceId: 1,
      counterpartyRef: "buyer",
      segment: 0,
    });
    expect(a).toBe(b);
  });

  it("separates different buyers on the same listing", () => {
    const base = {
      ruleVersion: RULE,
      strategy: "item_linked",
      subSourceId: 1,
      listingItemRef: "123",
      segment: 0,
    } as const;
    expect(threadKeyOf({ ...base, counterpartyRef: "a" })).not.toBe(
      threadKeyOf({ ...base, counterpartyRef: "b" }),
    );
  });
});

describe("gap arithmetic", () => {
  it("measures the gap between two naive source timestamps", () => {
    expect(gapMillis("2026-01-01 00:00:00", "2026-01-02 00:00:00")).toBe(86_400_000);
  });

  it("uses a fixed offset so a daylight-saving boundary cannot shift a gap", () => {
    // Europe/London springs forward on 2026-03-29. At a fixed offset this stays
    // exactly 24h; parsed as local time it would come out as 23h and could split
    // or merge a conversation depending on where the process runs.
    expect(gapMillis("2026-03-29 00:00:00", "2026-03-30 00:00:00")).toBe(86_400_000);
  });

  it("rejects an unparseable timestamp rather than guessing", () => {
    expect(() => gapMillis("not-a-timestamp", "2026-01-01 00:00:00")).toThrow(/Unparseable/);
  });
});

describe("reply inbox placement", () => {
  it("requires at least one inbound customer message", () => {
    expect(belongsInReplyInbox({ inboundCount: 1 })).toBe(true);
    expect(belongsInReplyInbox({ inboundCount: 0 })).toBe(false);
  });
});

describe("marketplace scope", () => {
  it("covers all five marketplaces, with no enable/disable switch", () => {
    expect(MARKETPLACES).toEqual(["ebay", "amazon", "shopify", "bandq", "temu"]);
  });

  it("accepts every marketplace name and nothing else", () => {
    for (const marketplace of MARKETPLACES) {
      expect(marketplaceSchema.parse(marketplace)).toBe(marketplace);
    }
    expect(marketplaceSchema.safeParse("etsy").success).toBe(false);
  });
});
