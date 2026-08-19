import { describe, expect, it } from "vitest";

import { threadKeyOf, type ThreadKeyParts } from "@/lib/domain/threading";

/**
 * Adversarial coverage for thread-key encoding.
 *
 * `counterpartyRef` and `listingItemRef` are opaque source strings. Nothing
 * guarantees they exclude whatever separator the key format uses, so the
 * encoding must stay injective even when values contain separator-like
 * characters. A collision here would silently merge two different customers
 * into one conversation.
 */

const BASE: ThreadKeyParts = {
  ruleVersion: "ebay-item-counterparty-gap-v1",
  strategy: "item_linked",
  subSourceId: 1,
  listingItemRef: "555",
  counterpartyRef: "buyer",
  segment: 0,
};

const HOSTILE = [
  "|",
  "a|b",
  "||",
  '"',
  'a"b',
  "\\",
  "a\\b",
  ",",
  "a,b",
  "[",
  "]",
  ":",
  "a:b",
  " ",
  "a b",
  "\n",
  "\t",
  "null",
  "0",
  "",
  '","',
  '\\"',
  "],[",
];

describe("thread key determinism", () => {
  it("produces the same key for the same input", () => {
    expect(threadKeyOf(BASE)).toBe(threadKeyOf({ ...BASE }));
  });

  it("represents the rule version", () => {
    expect(threadKeyOf(BASE)).toContain("ebay-item-counterparty-gap-v1");
    const other = threadKeyOf({ ...BASE, ruleVersion: "ebay-counterparty-gap-v1" });
    expect(other).not.toBe(threadKeyOf(BASE));
  });

  it("uses no timeline or task terminology", () => {
    expect(threadKeyOf(BASE)).not.toMatch(/day\d|phase\d|task\d/i);
  });
});

describe("thread key collision safety", () => {
  it("does not collide when a separator moves between adjacent components", () => {
    // The exact failure of a `|`-joined key: these two are different
    // conversations but produced an identical key under the old format.
    const a = threadKeyOf({ ...BASE, listingItemRef: "1", counterpartyRef: "a|b" });
    const b = threadKeyOf({ ...BASE, listingItemRef: "1|a", counterpartyRef: "b" });
    expect(a).not.toBe(b);
  });

  it("keeps every hostile value pair distinct across both opaque fields", () => {
    const keys = new Map<string, string>();
    for (const listing of HOSTILE) {
      for (const counterparty of HOSTILE) {
        const key = threadKeyOf({
          ...BASE,
          listingItemRef: listing,
          counterpartyRef: counterparty,
        });
        const identity = JSON.stringify([listing, counterparty]);
        const clash = keys.get(key);
        expect(clash === undefined || clash === identity).toBe(true);
        keys.set(key, identity);
      }
    }
    expect(keys.size).toBe(HOSTILE.length * HOSTILE.length);
  });

  it("distinguishes a null listing from an empty-string listing", () => {
    const nullListing = threadKeyOf({ ...BASE, listingItemRef: null, strategy: "item_linked" });
    const emptyListing = threadKeyOf({ ...BASE, listingItemRef: "", strategy: "item_linked" });
    expect(nullListing).not.toBe(emptyListing);
  });

  it("distinguishes a numeric sub_source from a same-looking string field", () => {
    const a = threadKeyOf({ ...BASE, subSourceId: 12, listingItemRef: "3" });
    const b = threadKeyOf({ ...BASE, subSourceId: 1, listingItemRef: "23" });
    expect(a).not.toBe(b);
  });

  it("distinguishes segments even when a value ends in a digit", () => {
    const a = threadKeyOf({ ...BASE, counterpartyRef: "buyer1", segment: 0 });
    const b = threadKeyOf({ ...BASE, counterpartyRef: "buyer", segment: 10 });
    expect(a).not.toBe(b);
  });

  it("distinguishes strategy even with identical other components", () => {
    const itemLinked = threadKeyOf({ ...BASE, strategy: "item_linked", listingItemRef: null });
    const noItem = threadKeyOf({ ...BASE, strategy: "no_item", listingItemRef: null });
    expect(itemLinked).not.toBe(noItem);
  });

  it("ignores the listing reference for the no-item strategy", () => {
    const withListing = threadKeyOf({ ...BASE, strategy: "no_item", listingItemRef: "555" });
    const withoutListing = threadKeyOf({ ...BASE, strategy: "no_item", listingItemRef: null });
    expect(withListing).toBe(withoutListing);
  });

  it("round-trips to the exact component tuple", () => {
    const parts = { ...BASE, listingItemRef: 'a"|b\\c', counterpartyRef: "x],[y" };
    expect(JSON.parse(threadKeyOf(parts))).toEqual([
      parts.ruleVersion,
      parts.strategy,
      parts.subSourceId,
      parts.listingItemRef,
      parts.counterpartyRef,
      parts.segment,
    ]);
  });
});
