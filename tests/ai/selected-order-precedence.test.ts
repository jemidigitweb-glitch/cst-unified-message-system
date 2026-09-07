import { describe, expect, it } from "vitest";

import { contextBlocks, twoProductsBlock } from "@/lib/ai/draft-assembly";
import type { DraftRequest } from "@/lib/ai/provider";

/**
 * WHICH PRODUCT THE MODEL IS ASKED ABOUT, when two verified products are in the
 * prompt at once.
 *
 * The defect this pins: a reviewer selected a bracket order on a conversation
 * whose message was attached to a cable listing, and the draft answered about
 * the cable. It did so correctly from what it was shown — the cable filled the
 * block headed PRODUCT/SKU while the bracket sat among the order facts.
 *
 * Synthetic fixtures throughout; the shapes mirror the diagnostic case without
 * naming it. The SKU is a combo, as a fifth of live order lines are.
 */

const MESSAGE_ITEM = "111111111111";
const ORDER_ITEM = "222222222222";
const COMBO_SKU = "AAA111+BBB222+CCC333";

const fact = (name: string, value: string) => ({ name, value });

function request(facts: { name: string; value: string }[]): DraftRequest {
  return {
    marketplace: "ebay",
    listingItemRef: MESSAGE_ITEM,
    messages: [],
    facts,
    rules: [],
    bundle: null,
  } as unknown as DraftRequest;
}

/** The message's own listing — a cable, in the diagnostic shape. */
const CURRENT_LISTING = [
  fact("listing_title", "2/3 Core Vintage Fabric Style Cable Braided Twisted"),
  fact("listing_options_colour", "Black, Grey, Cream"),
];

/** A human-selected order for a different product — a bracket. */
const SELECTED_ORDER = [
  fact("order_context_source", "manual_selected"),
  fact("order_number", "20-00000-00001"),
  fact("order_status", "Completed"),
  fact("customer_order_product_title", "Ceiling Rose Strap Bracket Plate"),
  fact("customer_order_sku", COMBO_SKU),
  fact("customer_order_listing_item_id", ORDER_ITEM),
  fact("order_listing_matches_current_message_listing", "no"),
];

const PRIMARY = "VERIFIED CONTEXT — PRODUCT ACTUALLY ORDERED (PRIMARY PRODUCT CONTEXT):";
const SECONDARY = "VERIFIED CONTEXT — LISTING ATTACHED TO THE MESSAGE (SECONDARY";
const ORDINARY_PRODUCT = "VERIFIED CONTEXT — PRODUCT/SKU:";

/* ------------------------------------------------------------------------- *
 * THE FIX
 * ------------------------------------------------------------------------- */

describe("a human-selected order outranks a conflicting message listing", () => {
  const blocks = contextBlocks(request([...SELECTED_ORDER, ...CURRENT_LISTING]));

  /** 1, 2, 16. The ordered product is the primary product context. */
  it("promotes the ordered product to its own primary block", () => {
    expect(blocks).toContain(PRIMARY);
    const primary = blocks.slice(blocks.indexOf(PRIMARY), blocks.indexOf(SECONDARY));
    expect(primary).toContain("Ceiling Rose Strap Bracket Plate");
    expect(primary).toContain(COMBO_SKU);
    expect(primary).toContain(ORDER_ITEM);
    // ...and the cable is NOT in it.
    expect(primary).not.toMatch(/cable/i);
  });

  /** 3, 7. The message's listing is retained, and clearly demoted. */
  it("keeps the message listing as secondary provenance", () => {
    expect(blocks).toContain(SECONDARY);
    expect(blocks).not.toContain(ORDINARY_PRODUCT);
    expect(blocks).toContain("2/3 Core Vintage Fabric Style Cable Braided Twisted");
    expect(blocks).toContain(MESSAGE_ITEM);
  });

  /** The primary block is read before the secondary one. */
  it("puts the ordered product ahead of the message listing", () => {
    expect(blocks.indexOf(PRIMARY)).toBeLessThan(blocks.indexOf(SECONDARY));
  });

  /** 4, 5, 6, 8. Every selected-order fact still reaches the model. */
  it("carries the order, its SKU, its listing reference and the mismatch flag", () => {
    for (const value of [
      "20-00000-00001",
      "Completed",
      COMBO_SKU,
      ORDER_ITEM,
      "Ceiling Rose Strap Bracket Plate",
    ]) {
      expect(blocks, value).toContain(value);
    }
    expect(blocks).toContain("order_listing_matches_current_message_listing: no");
  });

  /** 7. Provenance is stated. */
  it("tells the model the order was chosen by a person", () => {
    expect(blocks).toContain("order_context_source: manual_selected");
    expect(blocks).toContain("A member of CST staff SELECTED this order");
  });

  /** 17. One SKU, byte for byte. */
  it("keeps the combo SKU atomic", () => {
    expect(blocks).toContain(COMBO_SKU);
    expect(blocks).not.toMatch(/\bBBB222\b(?!\+|.*CCC333)/);
  });
});

/* ------------------------------------------------------------------------- *
 * THE INSTRUCTIONS
 * ------------------------------------------------------------------------- */

describe("the instruction matches who chose the order", () => {
  /** 1. Human-selected: the ordered product is the subject. */
  it("makes the selected product authoritative when a person chose it", () => {
    const block = twoProductsBlock(SELECTED_ORDER)!;
    expect(block).toContain("A member of CST staff SELECTED this order");
    expect(block).toContain("Treat the ordered product above as the product the customer is asking about");
    expect(block).toContain("That listing is secondary provenance only");
    // The opposite instruction must NOT appear.
    expect(block).not.toContain("the authoritative product context for the question itself");
  });

  /**
   * 12. Not selected: the backend found the order on buyer and storefront
   * alone, so the message's listing remains the subject. The two cases need
   * opposite instructions, and giving both the same one caused the defect.
   */
  it("keeps the message listing authoritative when nobody chose the order", () => {
    const unselected = SELECTED_ORDER.filter((f) => f.name !== "order_context_source");
    const block = twoProductsBlock(unselected)!;
    expect(block).toContain("the authoritative product context for the question itself");
    expect(block).not.toContain("A member of CST staff SELECTED this order");
  });

  /** 9. "How long" is not automatically a delivery question. */
  it("forbids reading a bare measurement question as a delivery question", () => {
    const block = twoProductsBlock(SELECTED_ORDER)!;
    expect(block).toMatch(/how long is it\?/i);
    expect(block).toContain("unless the customer's own words, or a verified order or shipment fact");
  });

  /** 10. An unavailable dimension is asked about, never invented. */
  it("forbids inventing a dimension and requires a product-specific question", () => {
    const block = twoProductsBlock(SELECTED_ORDER)!;
    expect(block).toContain("Do not invent a dimension");
    expect(block).toContain("ask one short clarifying question ABOUT THE SELECTED PRODUCT");
  });

  /** Emitted only where the listings actually differ. */
  it("says nothing when the selected order carries this listing", () => {
    const matching = SELECTED_ORDER.map((f) =>
      f.name === "order_listing_matches_current_message_listing" ? fact(f.name, "yes") : f,
    );
    expect(twoProductsBlock(matching)).toBeNull();
    expect(twoProductsBlock([fact("order_number", "20-00000-00001")])).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * NOTHING ELSE MOVES
 * ------------------------------------------------------------------------- */

describe("every other flow is unchanged", () => {
  /** 13. A strict matched order: normal names, ordinary product block. */
  it("leaves a matched order's layout alone", () => {
    const blocks = contextBlocks(
      request([
        fact("order_number", "20-00000-00002"),
        fact("sku", "CBSF100"),
        fact("product_title", "A matched product"),
        ...CURRENT_LISTING,
      ]),
    );
    expect(blocks).toContain(ORDINARY_PRODUCT);
    expect(blocks).not.toContain(PRIMARY);
    expect(blocks).not.toContain(SECONDARY);
    expect(blocks).toContain("A matched product");
  });

  /** 12. A genuine pre-sale with no order at all. */
  it("leaves a pre-sale conversation alone", () => {
    const blocks = contextBlocks(request([...CURRENT_LISTING]));
    expect(blocks).toContain(ORDINARY_PRODUCT);
    expect(blocks).not.toContain(PRIMARY);
    expect(blocks).toContain("2/3 Core Vintage Fabric Style Cable Braided Twisted");
    expect(blocks).toContain("no order has been resolved and verified");
  });

  /** 11. A real delivery question keeps its order and shipment facts. */
  it("leaves a genuine delivery question's order facts in the order block", () => {
    const blocks = contextBlocks(
      request([
        fact("order_number", "20-00000-00003"),
        fact("order_status", "Completed"),
        fact("tracking_number", "AA000000000000000000A"),
        fact("delivery_courier", "Royal Mail 48"),
      ]),
    );
    expect(blocks).toContain("tracking_number: AA000000000000000000A");
    expect(blocks).toContain("delivery_courier: Royal Mail 48");
    expect(blocks).not.toContain(PRIMARY);
  });

  /**
   * 14, 15. A selected order that IS for this listing needs no split: it is the
   * same product, so the ordinary layout is correct.
   */
  it("uses the ordinary layout when the selected order is for this listing", () => {
    const blocks = contextBlocks(
      request([
        fact("order_context_source", "manual_selected"),
        fact("order_number", "20-00000-00004"),
        fact("sku", "CBSF100"),
        fact("product_title", "The very product on this listing"),
        fact("order_listing_matches_current_message_listing", "yes"),
        ...CURRENT_LISTING,
      ]),
    );
    expect(blocks).toContain(ORDINARY_PRODUCT);
    expect(blocks).not.toContain(PRIMARY);
    expect(blocks).toContain("The very product on this listing");
  });

  /** 18. No tracking event is invented anywhere by this change. */
  it("adds no tracking or scan wording", () => {
    const block = twoProductsBlock(SELECTED_ORDER)!;
    expect(block).not.toMatch(/scan|checkpoint|in transit|out for delivery/i);
  });
});
