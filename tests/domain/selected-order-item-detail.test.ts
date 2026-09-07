import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ConversationOrderContext,
  ORDER_DETAIL_FIELDS,
  orderDetailFromFacts,
} from "@/lib/domain/order";
import { restorableSelection } from "@/lib/domain/order-selection-storage";

/**
 * The ordered item on a manually selected order: SKU, product and listing
 * reference, which were rendering blank.
 *
 * THE CAUSE WAS A VOCABULARY GAP, not a missing lookup. The resolver names a
 * different-listing order's product `customer_order_*` so it cannot displace
 * the current listing in the prompt; the panel's fact mapper only ever read the
 * unprefixed names, so it found nothing to show. Both vocabularies are read
 * here, and a matched order is unaffected.
 *
 * Synthetic fixtures. The SKU is a combo, as a fifth of live order lines are.
 */

const CONTEXT: ConversationOrderContext = { buyer: "buyer-handle", market: "eBay" };
const ORDER_ITEM = "222222222222";
const COMBO_SKU = "PSHYOS4BRBM+SPUPBM+SLDO210BM";
const ORDER_URL = `https://www.ebay.co.uk/itm/Ceiling-Rose-Bracket/${ORDER_ITEM}`;

const fact = (name: string, value: string) => ({ name, value });

/* ------------------------------------------------------------------------- *
 * THE THREE ROWS THAT WERE BLANK
 * ------------------------------------------------------------------------- */

describe("a manually selected order fills its own item rows", () => {
  const detail = orderDetailFromFacts(
    [
      fact("order_number", "20-00000-00001"),
      fact("order_status", "Completed"),
      fact("customer_order_sku", COMBO_SKU),
      fact("customer_order_product_title", "Ceiling Rose Strap Bracket Plate"),
      fact("customer_order_listing_item_id", ORDER_ITEM),
      fact("customer_order_listing_url", ORDER_URL),
      fact("order_listing_matches_current_message_listing", "no"),
    ],
    CONTEXT,
  );

  /** 2, 11. The exact SKU, byte for byte. */
  it("shows the ordered SKU", () => {
    expect(detail.sku).toBe(COMBO_SKU);
    expect(detail.sku).toContain("+");
  });

  /** 3. */
  it("shows the ordered product title", () => {
    expect(detail.productDetails).toBe("Ceiling Rose Strap Bracket Plate");
  });

  /** 1, 4. The listing reference is the ORDER's item, not the message's. */
  it("shows the ordered item's listing reference", () => {
    expect(detail.listingReference).toBe(ORDER_ITEM);
  });

  /** 5, 6. The URL is carried so the reference can be a link. */
  it("carries the order's own listing URL for the reference", () => {
    expect(detail.listingReferenceUrl).toBe(ORDER_URL);
    // The URL names the very reference it is shown against.
    expect(detail.listingReferenceUrl).toContain(detail.listingReference!);
  });

  /** The URL is not a row of its own — it hides behind the reference. */
  it("shows no separate URL row", () => {
    const keys = ORDER_DETAIL_FIELDS.map((field) => field.key);
    expect(keys).toContain("listingReference");
    expect(keys).not.toContain("listingReferenceUrl");
  });
});

/* ------------------------------------------------------------------------- *
 * A MATCHED ORDER IS UNAFFECTED
 * ------------------------------------------------------------------------- */

describe("a matched order is unchanged", () => {
  /** 7. The unprefixed vocabulary still wins and still works. */
  it("still reads sku and product_title", () => {
    const detail = orderDetailFromFacts(
      [
        fact("order_number", "20-00000-00002"),
        fact("sku", "CBSF100"),
        fact("product_title", "A matched product"),
      ],
      CONTEXT,
    );
    expect(detail.sku).toBe("CBSF100");
    expect(detail.productDetails).toBe("A matched product");
    // No listing link is invented for it.
    expect(detail.listingReferenceUrl).toBeNull();
  });

  /** 8. Nothing from the current message listing can appear here. */
  it("reads no current-listing fact", () => {
    const detail = orderDetailFromFacts(
      [
        fact("order_number", "20-00000-00003"),
        fact("listing_title", "2/3 Core Vintage Fabric Style Cable"),
        fact("listing_options_colour", "Black, Grey"),
      ],
      CONTEXT,
    );
    expect(detail.sku).toBeNull();
    expect(detail.productDetails).toBeNull();
    expect(detail.listingReference).toBeNull();
    expect(detail.listingReferenceUrl).toBeNull();
  });

  /** 12. A multi-line order named no product, so no product is shown. */
  it("shows no product for an order whose lines were ambiguous", () => {
    const detail = orderDetailFromFacts(
      [
        fact("order_number", "20-00000-00004"),
        fact("customer_order_line_count", "3"),
        fact("order_listing_matches_current_message_listing", "no"),
      ],
      CONTEXT,
    );
    expect(detail.sku).toBeNull();
    expect(detail.productDetails).toBeNull();
    expect(detail.listingReference).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * SURVIVING A RELOAD
 * ------------------------------------------------------------------------- */

describe("a manual selection survives a reload", () => {
  /**
   * The stored choice is validated against BOTH lists. Before a selection
   * resolves, the order is only in `eligibleOrders`; after it resolves, only in
   * `orders`. Checking one list alone is what discarded a manual selection on
   * every reload.
   */
  it("restores a choice that is in the eligible list", () => {
    expect(restorableSelection("20-00000-00001", ["20-00000-00001"])).toBe("20-00000-00001");
  });

  it("restores a choice that has already resolved into an order", () => {
    expect(restorableSelection("20-00000-00001", ["20-00000-00001", "20-00000-00009"])).toBe(
      "20-00000-00001",
    );
  });

  /** A stale choice is still discarded rather than silently grounding a draft. */
  it("discards a choice in neither list", () => {
    expect(restorableSelection("20-00000-00404", ["20-00000-00001"])).toBeNull();
  });

  /** The panel checks both lists — asserted on source, as this suite has no DOM. */
  it("checks both lists when restoring", () => {
    const panel = readFileSync(
      join(__dirname, "..", "..", "components", "context-panel.tsx"),
      "utf8",
    );
    const restore = panel.slice(panel.indexOf("const available = ["));
    expect(restore.slice(0, 260)).toContain("context.orders.map");
    expect(restore.slice(0, 260)).toContain("context.eligibleOrders.map");
  });
});
