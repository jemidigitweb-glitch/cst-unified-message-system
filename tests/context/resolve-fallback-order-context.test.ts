import { describe, expect, it } from "vitest";

import type { CustomerOrderContext } from "@/lib/domain/customer-order-fallback";
import {
  RELATIONSHIP_FACT,
  fallbackOrderFacts,
  resolveFallbackCustomerOrder,
} from "@/lib/context/resolve-fallback-order-context";

/**
 * Layer 2's gate, the ordered product it resolves, and the facts it may state.
 *
 * TWO PRODUCTS ARE IN PLAY THROUGHOUT: the listing the message is attached to,
 * and the product actually bought. Everything below exists to keep them apart.
 *
 * Synthetic fixtures. The SKU is a combo on purpose — 129,783 of 633,970 live
 * eBay order lines carry one, so atomicity is the common case, not an edge one.
 */

type Call = { text: string; values?: unknown[] };

const MESSAGE_ITEM = "111111111111";
const ORDER_ITEM = "222222222222";
const COMBO_SKU = "PSHYOS4BRBM+SPUPBM+SLDO210BM";
const ORDER_LISTING_URL = `https://www.ebay.co.uk/itm/Ceiling-Rose-Strap-Bracket/${ORDER_ITEM}`;
const MESSAGE_LISTING_URL = `https://www.ebay.co.uk/itm/Fabric-Cable/${MESSAGE_ITEM}`;

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    order_number: "AA-00000-00001",
    order_date: "2026-01-05 10:00:00",
    order_status: "Completed",
    storefront_id: 4,
    storefront_name: "Storefront Four",
    listing_match: false,
    order_line_count: 1,
    order_item_ref: ORDER_ITEM,
    order_sku: COMBO_SKU,
    order_product_title: "Ceiling Rose Strap Bracket Plate",
    ...overrides,
  };
}

/**
 * One fake serves both pools. It answers by which table the statement names, so
 * the listing lookups can be given the ORDER's listing while a *different* URL
 * exists for the message's listing — which is how "never copied" is tested.
 */
function fakes(options: {
  resolution?: string | null;
  orderRows?: unknown[];
  listingTitle?: string | null;
  listingUrl?: string | null;
}) {
  const calls: Call[] = [];
  const client = {
    query: async (config: { text: string; values?: unknown[] }) => {
      calls.push(config);
      if (config.text.includes("context_snapshots")) {
        return {
          rows:
            options.resolution == null
              ? []
              : [{ id: "1", conversation_id: "7", resolution: options.resolution }],
        };
      }
      if (config.text.includes("selected_variations")) {
        return {
          rows:
            options.listingTitle === undefined || options.listingTitle === null
              ? []
              : [{ title: options.listingTitle, selected_variations: [] }],
        };
      }
      if (config.text.includes("listing_url")) {
        return {
          rows:
            options.listingUrl === undefined || options.listingUrl === null
              ? []
              : [{ listing_url: options.listingUrl }],
        };
      }
      return { rows: options.orderRows ?? [] };
    },
  };
  return { calls, client };
}

const conversation = {
  id: "7",
  marketplace: "ebay",
  subSourceId: 4,
  counterpartyRef: "buyer-handle",
  listingItemRef: MESSAGE_ITEM,
};

const resolved = () =>
  fakes({
    resolution: "no_order",
    orderRows: [orderRow()],
    listingTitle: "Ceiling Rose Strap Bracket Strap Brace Plate",
    listingUrl: ORDER_LISTING_URL,
  });

/* ------------------------------------------------------------------------- *
 * THE GATE
 * ------------------------------------------------------------------------- */

describe("layer 2 runs only where layer 1 established nothing", () => {
  it("resolves the order and its own listing when the matcher recorded no_order", async () => {
    const { client } = resolved();
    const context = await resolveFallbackCustomerOrder(client, client, conversation);
    expect(context?.order.orderNumber).toBe("AA-00000-00001");
    expect(context?.listing?.itemRef).toBe(ORDER_ITEM);
  });

  /** 12. A conversation the matcher ANSWERED is never second-guessed. */
  it("returns nothing, and reads no order, for a resolved conversation", async () => {
    const { calls, client } = fakes({ resolution: "single_order", orderRows: [orderRow()] });
    expect(await resolveFallbackCustomerOrder(client, client, conversation)).toBeNull();
    expect(calls.filter((c) => c.text.includes("order_management"))).toHaveLength(0);
  });

  it("returns nothing while a reviewer is being asked to choose", async () => {
    const { calls, client } = fakes({ resolution: "ambiguous", orderRows: [orderRow()] });
    expect(await resolveFallbackCustomerOrder(client, client, conversation)).toBeNull();
    expect(calls.filter((c) => c.text.includes("order_management"))).toHaveLength(0);
  });

  it("returns nothing when the matcher never ran", async () => {
    const { client } = fakes({ resolution: null, orderRows: [orderRow()] });
    expect(await resolveFallbackCustomerOrder(client, client, conversation)).toBeNull();
  });

  it("returns nothing when the buyer has several orders on the storefront", async () => {
    const { client } = fakes({
      resolution: "no_order",
      orderRows: [orderRow(), orderRow({ order_number: "AA-00000-00002" })],
    });
    expect(await resolveFallbackCustomerOrder(client, client, conversation)).toBeNull();
  });

  it("declines a non-eBay conversation, a missing storefront and a sentinel handle", async () => {
    for (const override of [
      { marketplace: "amazon" },
      { subSourceId: null },
      { counterpartyRef: "unresolved:12345" },
    ]) {
      const { calls, client } = resolved();
      expect(
        await resolveFallbackCustomerOrder(client, client, { ...conversation, ...override }),
        JSON.stringify(override),
      ).toBeNull();
      expect(calls, JSON.stringify(override)).toHaveLength(0);
    }
  });

  /** 13. It writes nothing anywhere. */
  it("writes nothing", async () => {
    const { calls, client } = resolved();
    await resolveFallbackCustomerOrder(client, client, conversation);
    for (const call of calls) {
      expect(call.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * THE ORDERED PRODUCT
 * ------------------------------------------------------------------------- */

describe("the ordered product is resolved from the ORDER's own item", () => {
  /** 2 and 5. Both listing lookups are keyed on the order's item, not the message's. */
  it("looks the listing up by the order's item reference and storefront", async () => {
    const { calls, client } = resolved();
    await resolveFallbackCustomerOrder(client, client, conversation);

    const listingCalls = calls.filter((c) => c.text.includes("listings.ebay_listings"));
    expect(listingCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of listingCalls) {
      expect(call.values?.[0]).toBe(ORDER_ITEM);
      expect(call.values?.[0]).not.toBe(MESSAGE_ITEM);
      expect(call.values?.[1]).toBe(4);
    }
  });

  /** 5. The URL belongs to the order's item. */
  it("returns the order listing's own URL", async () => {
    const { client } = resolved();
    const context = await resolveFallbackCustomerOrder(client, client, conversation);
    expect(context?.listing?.url).toBe(ORDER_LISTING_URL);
    expect(context?.listing?.title).toBe("Ceiling Rose Strap Bracket Strap Brace Plate");
  });

  /**
   * 6. THE MESSAGE LISTING'S URL CANNOT LAND HERE, and the check is structural
   * rather than careful: `displayableListingUrl` requires the path to end in the
   * reference it is shown against, so a URL for the message's listing fails
   * against the order's item id even when handed straight to it.
   */
  it("refuses a URL that does not carry the order's own reference", async () => {
    const { client } = fakes({
      resolution: "no_order",
      orderRows: [orderRow()],
      listingTitle: "Ceiling Rose Strap Bracket",
      listingUrl: MESSAGE_LISTING_URL,
    });
    const context = await resolveFallbackCustomerOrder(client, client, conversation);
    expect(context?.listing?.url).toBeNull();
  });

  /** 10. Several lines: the database refused to pick, and so does this. */
  it("resolves no product at all for a multi-line order", async () => {
    const { calls, client } = fakes({
      resolution: "no_order",
      orderRows: [
        orderRow({
          order_line_count: 3,
          order_item_ref: null,
          order_sku: null,
          order_product_title: null,
        }),
      ],
      listingTitle: "should never be read",
      listingUrl: ORDER_LISTING_URL,
    });
    const context = await resolveFallbackCustomerOrder(client, client, conversation);
    expect(context?.order.orderNumber).toBe("AA-00000-00001");
    expect(context?.listing).toBeNull();
    expect(context?.order.orderLineCount).toBe(3);
    // ...and it does not even look a listing up, because there is no item to use.
    expect(calls.filter((c) => c.text.includes("listings.ebay_listings"))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- *
 * THE FACTS
 * ------------------------------------------------------------------------- */

describe("the facts a layer-2 order may state", () => {
  const context: CustomerOrderContext = {
    order: {
      orderNumber: "AA-00000-00001",
      orderDate: "2026-01-05 10:00:00",
      orderStatus: "Completed",
      storefrontId: 4,
      storefrontName: "Storefront Four",
      listingMatch: false,
      orderLineCount: 1,
      orderItemRef: ORDER_ITEM,
      orderSku: COMBO_SKU,
      orderProductTitle: "Ceiling Rose Strap Bracket Plate",
    },
    listing: {
      itemRef: ORDER_ITEM,
      title: "Ceiling Rose Strap Bracket Strap Brace Plate",
      url: ORDER_LISTING_URL,
    },
  };

  /** 2, 3, 4, 5. The order, and the product actually ordered. */
  it("states the order and its own product", () => {
    expect(fallbackOrderFacts(context).map((fact) => fact.name)).toEqual([
      "customer_order_number",
      "customer_order_date",
      "customer_order_status",
      "customer_order_storefront",
      "customer_order_listing_item_id",
      "customer_order_listing_title",
      "customer_order_listing_url",
      "customer_order_sku",
      "customer_order_product_title",
      RELATIONSHIP_FACT,
    ]);
  });

  /** 7. The flag is computed, never left to the model. */
  it("says the listings differ", () => {
    const value = fallbackOrderFacts(context).find((f) => f.name === RELATIONSHIP_FACT)?.value;
    expect(RELATIONSHIP_FACT).toBe("order_listing_matches_current_message_listing");
    expect(value).toBe("no");
  });

  /** 8. And says so when they are the same. */
  it("says the listings match when the order carries this listing", () => {
    const matching: CustomerOrderContext = {
      ...context,
      order: { ...context.order, listingMatch: true },
    };
    expect(
      fallbackOrderFacts(matching).find((f) => f.name === RELATIONSHIP_FACT)?.value,
    ).toBe("yes");
  });

  /** 9. ONE SKU, BYTE FOR BYTE. Never split on `+`, never trimmed. */
  it("keeps a combo SKU atomic", () => {
    const sku = fallbackOrderFacts(context).find((f) => f.name === "customer_order_sku")?.value;
    expect(sku).toBe(COMBO_SKU);
    expect(sku).toContain("+");
    // Not decomposed into its parts anywhere in the fact list.
    const serialised = JSON.stringify(fallbackOrderFacts(context));
    expect(serialised).not.toContain('"SPUPBM"');
    expect(serialised).not.toContain('"PSHYOS4BRBM"');
  });

  /**
   * 6. THE PREFIX IS LOAD-BEARING. Three downstream mechanisms key off exact
   * unprefixed names, and each would misfire: `sku` drives the SOT catalogue
   * lookup, `product_title` DROPS the current listing's title, and
   * `order_status` feeds `dispatchState`.
   */
  it("uses no name that would hijack the current listing or the dispatch state", () => {
    const names = fallbackOrderFacts(context).map((fact) => fact.name);
    for (const reserved of ["sku", "product_title", "order_status", "tracking_number", "dispatch_status", "listing_title"]) {
      expect(names, reserved).not.toContain(reserved);
    }
    // ...and every one still files under ORDER rather than PRODUCT.
    for (const name of names) expect(name, name).toMatch(/order|refund|tracking|delivery/i);
  });

  /** 10. Several lines: order-level metadata, plus the ambiguity, and no product. */
  it("reports the line count instead of a product for a multi-line order", () => {
    const ambiguous: CustomerOrderContext = {
      order: {
        ...context.order,
        orderLineCount: 3,
        orderItemRef: null,
        orderSku: null,
        orderProductTitle: null,
      },
      listing: null,
    };
    const names = fallbackOrderFacts(ambiguous).map((fact) => fact.name);
    expect(names).toEqual([
      "customer_order_number",
      "customer_order_date",
      "customer_order_status",
      "customer_order_storefront",
      "customer_order_line_count",
      RELATIONSHIP_FACT,
    ]);
    expect(
      fallbackOrderFacts(ambiguous).find((f) => f.name === "customer_order_line_count")?.value,
    ).toBe("3");
  });

  it("omits a field the source did not record rather than stating a blank", () => {
    const sparse: CustomerOrderContext = {
      order: { ...context.order, orderStatus: null, storefrontName: "  ", orderSku: null },
      listing: { itemRef: ORDER_ITEM, title: null, url: null },
    };
    expect(fallbackOrderFacts(sparse).map((fact) => fact.name)).toEqual([
      "customer_order_number",
      "customer_order_date",
      "customer_order_listing_item_id",
      "customer_order_product_title",
      RELATIONSHIP_FACT,
    ]);
  });
});
