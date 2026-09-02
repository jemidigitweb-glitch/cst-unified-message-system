import { describe, expect, it } from "vitest";

import { contextBlocks } from "@/lib/ai/draft-assembly";
import type { DraftRequest } from "@/lib/ai/provider";
import { resolveSotProductContext } from "@/lib/context/resolve-sot-product-context";
import { settleReviewRequirement, ungroundedClaims } from "@/lib/domain/draft";
import type { DraftResult } from "@/lib/domain/draft";
import type { Queryable as SourceQueryable } from "@/lib/repositories/sot-product-repository";

/**
 * Proves the SOT resolver's output reaches the live prompt-builder correctly
 * bucketed, and — the part that matters most — that a pre-sale conversation
 * WITHOUT a SOT match produces byte-identical prompt context to what it
 * produced before this feature existed.
 *
 * Neither `draft-assembly.ts` nor `draft.ts` is modified by this work; both are
 * exercised here exactly as they ship.
 */

function fakeSourceClient(parentRows: unknown[], attributeRows: unknown[] = []): SourceQueryable {
  return {
    query: async (config) => {
      if (config.text.includes("listings.ebay_listings")) return { rows: parentRows };
      if (config.text.includes("configurator.components_sot_skus")) return { rows: attributeRows };
      return { rows: [] };
    },
  };
}

const conversation = { marketplace: "ebay", subSourceId: 1, listingItemRef: "166872810291" };

function attributeRow(key: string, value: string | null) {
  return {
    sot_sku_id: "12",
    sku: "LSDO210BM",
    source_tab: "lampshade",
    synced_at: "2026-08-20 06:41:56",
    attribute_key: key,
    attribute_label: key,
    value,
  };
}

const MATCHED = fakeSourceClient(
  [{ sku: "LSDO210BM" }],
  [
    attributeRow("product_name", "Industrial Metal Cone Lampshade"),
    attributeRow("diameter_mm", "220"),
    attributeRow("bulb_base_compat", "E26 / E27"),
    attributeRow("max_bulb_wattage_w", "60"),
    attributeRow("reducer_ring_included", "Y"),
  ],
);

function requestWith(facts: DraftRequest["facts"]): DraftRequest {
  return { messages: [], marketplace: "ebay", listingItemRef: "166872810291", facts };
}

describe("SOT product context through the live prompt builder", () => {
  it("puts every SOT attribute in the PRODUCT/SKU block, never in ORDER", async () => {
    const facts = await resolveSotProductContext(MATCHED, conversation);
    const blocks = contextBlocks(requestWith(facts));

    const orderSection = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:")[0]!;
    const productSection = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:")[1]!;

    expect(productSection).toContain("sku: LSDO210BM");
    expect(productSection).toContain("diameter_mm: 220");
    expect(productSection).toContain("bulb_base_compat: E26 / E27");
    expect(productSection).toContain("max_bulb_wattage_w: 60");

    // The order half is untouched and still says plainly that no order exists —
    // which on a pre-sale enquiry is the truth.
    expect(orderSection).toContain("no order has been resolved and verified for this conversation");
    expect(orderSection).not.toContain("diameter_mm");
  });

  it("adds no RETURN block", async () => {
    const facts = await resolveSotProductContext(MATCHED, conversation);
    expect(contextBlocks(requestWith(facts))).not.toContain("VERIFIED CONTEXT — RETURN");
  });

  /**
   * The regression that matters. On the overwhelming majority of pre-sale
   * conversations SOT holds nothing — measured live, 1,747 of 24,467 eBay
   * messages over 180 days reach a SOT SKU at all, and only a handful of those
   * on a single-SKU listing. Every one of the rest must be exactly as it was.
   */
  it("leaves the prompt byte-identical when SOT holds nothing for the listing", async () => {
    const before = contextBlocks(requestWith([]));

    const facts = await resolveSotProductContext(fakeSourceClient([{ sku: "NOT-IN-SOT" }], []), conversation);
    const after = contextBlocks(requestWith(facts));

    expect(facts).toEqual([]);
    expect(after).toBe(before);
    // The PRODUCT block still holds only the standing warning about the listing
    // reference, exactly as it did before this resolver existed.
    expect(after).toContain(
      "- Marketplace listing reference: 166872810291 (this is a listing id, NOT a SKU and NOT a product name — do not describe the product from it)",
    );
    expect(after).not.toContain("diameter_mm");
  });

  it("leaves the prompt byte-identical for a listing with several parent SKUs", async () => {
    const facts = await resolveSotProductContext(
      fakeSourceClient([{ sku: "LSDO210BM" }, { sku: "LSDO210WH" }]),
      conversation,
    );

    expect(facts).toEqual([]);
    expect(contextBlocks(requestWith(facts))).toBe(contextBlocks(requestWith([])));
  });

  it("leaves the prompt byte-identical on a marketplace with no listing reference", async () => {
    const facts = await resolveSotProductContext(MATCHED, {
      marketplace: "temu",
      subSourceId: 1,
      listingItemRef: null,
    });

    expect(facts).toEqual([]);
    expect(contextBlocks(requestWith(facts))).toBe(contextBlocks(requestWith([])));
  });
});

describe("SOT facts and the grounding gate", () => {
  /**
   * `ungroundedClaims` allows a prohibited claim when the claim's first word
   * appears anywhere in the concatenated fact names and values. Catalogue
   * attributes must not be a back door into that.
   */
  it("does not let catalogue attributes ground a refund or delivery claim", async () => {
    const facts = await resolveSotProductContext(MATCHED, conversation);

    expect(
      ungroundedClaims("We have processed your refund today.", facts),
    ).toContain("refund decision");
    expect(
      ungroundedClaims("Your order will be delivered on Tuesday.", facts),
    ).toContain("delivery promise");
  });

  it("still forces review when a draft grounded on SOT facts cites nothing", async () => {
    const facts = await resolveSotProductContext(MATCHED, conversation);
    const result: DraftResult = {
      draft_reply: "The shade measures 220 mm across and takes an E27 bulb.",
      requires_review: false,
      missing_information: [],
      sources_used: [],
    };

    expect(settleReviewRequirement(result, facts).requiresReview).toBe(true);
  });
});
