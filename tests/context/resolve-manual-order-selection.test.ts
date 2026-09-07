import { describe, expect, it } from "vitest";

import {
  ORDER_CONTEXT_SOURCE_FACT,
  ORDER_LISTING_RELATIONSHIP_FACT,
  resolveManuallySelectedOrderContext,
  resolveSelectedOrderContext,
} from "@/lib/context/resolve-selected-order-context";

/**
 * Manual order selection on a conversation the strict matcher could not place.
 *
 * The properties that matter are all refusals: nothing is auto-selected, an
 * order the reviewer was never offered cannot ground a draft, and a resolved or
 * ambiguous conversation is never reopened by this path.
 *
 * Synthetic fixtures. The SKU is a combo because a fifth of live eBay order
 * lines carry one. No customer name, email or address appears in any fixture.
 */

type Call = { text: string; values?: unknown[] };

const MESSAGE_ITEM = "111111111111";
const ORDER_ITEM = "222222222222";
const COMBO_SKU = "PSHYOS4BRBM+SPUPBM+SLDO210BM";
const CHOSEN = "20-00000-00001";
const OTHER = "20-00000-00002";
const ORDER_URL = `https://www.ebay.co.uk/itm/Ceiling-Rose-Bracket/${ORDER_ITEM}`;

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    order_row_id: "900",
    order_number: CHOSEN,
    order_date: "2023-10-07 18:48:26",
    order_status: "Completed",
    storefront_id: 4,
    storefront_name: "Storefront Four",
    order_line_count: 1,
    order_item_ref: ORDER_ITEM,
    order_sku: COMBO_SKU,
    order_product_title: "Ceiling Rose Strap Bracket Plate",
    tracking_number: "AA000000000000000000A",
    shipment_status: "Completed",
    shipment_created_at: "2023-10-08 06:31:49",
    shipment_cancelled_at: null,
    carrier: "Royal Mail 48",
    carrier_service: "CRL48 100g LL",
    shipped_time: "2023-10-08 09:12:38",
    address_line_1: "1 Example Street",
    city: "Exampleton",
    postcode: "EX1 1EX",
    listing_match: false,
    ...overrides,
  };
}

/**
 * One fake serves both pools, answering by which table the statement names.
 * `strictRows` feeds the ambiguous path's own query so the two can be told
 * apart in a single test.
 */
function fakes(options: {
  resolution?: string | null;
  eligible?: unknown[];
  strictRows?: unknown[];
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
      if (config.text.includes("listing_url")) {
        return { rows: options.listingUrl == null ? [] : [{ listing_url: options.listingUrl }] };
      }
      // The eligible list is the only statement joining order_info.
      if (config.text.includes("order_management.order_info")) {
        return { rows: options.eligible ?? [] };
      }
      return { rows: options.strictRows ?? [] };
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

const ready = () =>
  fakes({ resolution: "no_order", eligible: [eligibleRow()], listingUrl: ORDER_URL });

const factMap = (facts: readonly { name: string; value: string }[]) =>
  Object.fromEntries(facts.map((f) => [f.name, f.value]));

/* ------------------------------------------------------------------------- *
 * WHEN IT APPLIES
 * ------------------------------------------------------------------------- */

describe("manual selection applies only where the matcher found nothing", () => {
  /** 2, 12. */
  it("resolves the chosen order on a no_order conversation", async () => {
    const { client } = ready();
    const facts = await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN);
    expect(factMap(facts).order_number).toBe(CHOSEN);
  });

  /** 1, 27. A conversation the matcher answered is never reopened. */
  it("refuses on a resolved conversation, and reads no orders", async () => {
    const { calls, client } = fakes({
      resolution: "single_order",
      eligible: [eligibleRow()],
    });
    expect(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    ).toEqual([]);
    expect(calls.filter((c) => c.text.includes("order_management.order_info"))).toHaveLength(0);
  });

  /** 4. The ambiguous flow keeps its own set; this path declines it. */
  it("refuses on an ambiguous conversation, leaving that flow untouched", async () => {
    const { calls, client } = fakes({ resolution: "ambiguous", eligible: [eligibleRow()] });
    expect(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    ).toEqual([]);
    expect(calls.filter((c) => c.text.includes("order_management.order_info"))).toHaveLength(0);
  });

  it("refuses when the matcher never ran", async () => {
    const { client } = fakes({ resolution: null, eligible: [eligibleRow()] });
    expect(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    ).toEqual([]);
  });

  /** The existing ambiguous resolver still works, unchanged. */
  it("leaves the ambiguous selection resolver working", async () => {
    const { client } = fakes({
      strictRows: [
        {
          order_row_id: "1",
          order_item_info_id: "2",
          order_number: CHOSEN,
          order_date: "2026-01-01",
          order_status: "Completed",
          item_sku: COMBO_SKU,
          real_sku: null,
          item_title: "A product",
          item_img: null,
          address_line_1: null,
          address_line_2: null,
          address_line_3: null,
          city: null,
          region: null,
          postcode: null,
          tracking_number: null,
          carrier_name: null,
          carrier: null,
        },
      ],
    });
    const facts = await resolveSelectedOrderContext(client, conversation, CHOSEN);
    expect(factMap(facts).order_number).toBe(CHOSEN);
  });
});

/* ------------------------------------------------------------------------- *
 * VALIDATION
 * ------------------------------------------------------------------------- */

describe("the server validates the choice rather than trusting it", () => {
  /** 3. Nothing is auto-selected: no selection, no facts. */
  it("selects nothing on its own", async () => {
    const { client } = ready();
    expect(await resolveManuallySelectedOrderContext(client, client, conversation, "")).toEqual([]);
    expect(
      await resolveManuallySelectedOrderContext(client, client, conversation, "   "),
    ).toEqual([]);
  });

  /**
   * 6, 7. An order the reviewer was never offered grounds nothing. The eligible
   * query is already pinned to this buyer and storefront, so an order belonging
   * to another customer or another storefront is simply not in the returned set
   * — which is what this asserts by naming one that is not.
   */
  it("rejects an order number that is not in the eligible set", async () => {
    const { client } = ready();
    expect(
      await resolveManuallySelectedOrderContext(client, client, conversation, OTHER),
    ).toEqual([]);
  });

  it("queries by the conversation's own buyer and storefront", async () => {
    const { calls, client } = ready();
    await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN);
    const list = calls.find((c) => c.text.includes("order_management.order_info"))!;
    expect(list.text).toContain("ci.ebay_buyer_id = $3");
    expect(list.text).toContain("o.sub_source_id = $2::int");
    expect(list.text).toContain("ss.source_id = $1::int");
    expect(list.values?.[1]).toBe(4);
    expect(list.values?.[2]).toBe("buyer-handle");
  });

  it("refuses if two eligible orders somehow share a number", async () => {
    const { client } = fakes({
      resolution: "no_order",
      eligible: [eligibleRow({ order_row_id: "900" }), eligibleRow({ order_row_id: "901" })],
    });
    expect(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    ).toEqual([]);
  });

  it("declines a non-eBay conversation, no storefront, and a sentinel handle", async () => {
    for (const override of [
      { marketplace: "amazon" },
      { subSourceId: null },
      { counterpartyRef: "unresolved:1" },
    ]) {
      const { calls, client } = ready();
      expect(
        await resolveManuallySelectedOrderContext(
          client,
          client,
          { ...conversation, ...override },
          CHOSEN,
        ),
        JSON.stringify(override),
      ).toEqual([]);
      expect(calls, JSON.stringify(override)).toHaveLength(0);
    }
  });

  /** 27. Nothing is persisted — no snapshot write, no confirmation. */
  it("writes nothing at all", async () => {
    const { calls, client } = ready();
    await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN);
    for (const call of calls) {
      expect(call.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
      // The snapshot is READ (its SELECT list names `verification_method`), but
      // nothing here assigns to a confirmation column.
      expect(call.text).not.toMatch(/verification_method\s*=/);
      expect(call.text).not.toMatch(/confirmed_by_user_id\s*=/);
      expect(call.text).not.toMatch(/confirmed_at\s*=/);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * THE FACTS
 * ------------------------------------------------------------------------- */

describe("the facts a manually selected order supplies", () => {
  /** 22. Provenance is stated, not implied. */
  it("declares the context source as manual_selected", async () => {
    const { client } = ready();
    const facts = await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN);
    expect(factMap(facts)[ORDER_CONTEXT_SOURCE_FACT]).toBe("manual_selected");
  });

  /** 9, 14, 15, 16, 17, 19, 23. Order, shipment and the approved address. */
  it("carries the order and its shipment under the normal names", async () => {
    const { client } = ready();
    const facts = factMap(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    );
    expect(facts.order_number).toBe(CHOSEN);
    expect(facts.order_status).toBe("Completed");
    expect(facts.order_shipment_status).toBe("Completed");
    expect(facts.tracking_number).toBe("AA000000000000000000A");
    expect(facts.delivery_courier).toBe("Royal Mail 48");
    expect(facts.delivery_carrier_service).toBe("CRL48 100g LL");
    expect(facts.order_shipment_created_at).toBe("2023-10-08 06:31:49");
    expect(facts.order_dispatched_at).toBe("2023-10-08 09:12:38");
    expect(facts.delivery_address).toContain("EX1 1EX");
    // Not cancelled: the fact is omitted rather than asserted as empty.
    expect(facts.order_shipment_cancelled_at).toBeUndefined();
  });

  /**
   * 18. A TRACKING NUMBER IS NOT A SCAN HISTORY. Nothing here reads
   * `shipment_tracking_log`, so zero rows there can produce no events — there
   * is no fact in this vocabulary that could carry one.
   */
  it("states no scan history, because it never reads one", async () => {
    const { calls, client } = ready();
    const facts = await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN);
    for (const call of calls) expect(call.text).not.toContain("shipment_tracking_log");
    for (const fact of facts) {
      expect(fact.name).not.toMatch(/scan|history|event|checkpoint/i);
    }
  });

  /**
   * 10, 11, 13, 21, 24. THE PRODUCT IS NAMED BY WHETHER IT IS THIS MESSAGE'S.
   * A different listing means `customer_order_*`, because under `sku` and
   * `product_title` the values would drive the SOT catalogue and DROP the
   * current listing's title.
   */
  it("keeps a different-listing product out of the current-product names", async () => {
    const { client } = ready();
    const facts = factMap(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    );
    expect(facts[ORDER_LISTING_RELATIONSHIP_FACT]).toBe("no");
    expect(facts.customer_order_sku).toBe(COMBO_SKU);
    expect(facts.customer_order_product_title).toBe("Ceiling Rose Strap Bracket Plate");
    expect(facts.customer_order_listing_item_id).toBe(ORDER_ITEM);
    expect(facts.customer_order_listing_url).toBe(ORDER_URL);
    // The names that would hijack the current listing are absent.
    expect(facts.sku).toBeUndefined();
    expect(facts.product_title).toBeUndefined();
  });

  /** 21. Same listing: it IS the current product, and takes the normal names. */
  it("uses the normal product names when the order carries this listing", async () => {
    const { client } = fakes({
      resolution: "no_order",
      eligible: [eligibleRow({ listing_match: true, order_item_ref: MESSAGE_ITEM })],
    });
    const facts = factMap(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    );
    expect(facts[ORDER_LISTING_RELATIONSHIP_FACT]).toBe("yes");
    expect(facts.sku).toBe(COMBO_SKU);
    expect(facts.product_title).toBe("Ceiling Rose Strap Bracket Plate");
    expect(facts.customer_order_sku).toBeUndefined();
  });

  /** 11, 25. ONE SKU, byte for byte. */
  it("keeps a combo SKU atomic", async () => {
    const { client } = ready();
    const facts = factMap(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    );
    expect(facts.customer_order_sku).toBe(COMBO_SKU);
    expect(JSON.stringify(facts)).not.toContain('"SPUPBM"');
  });

  /** 13. The URL is looked up by the ORDER's item, never the message's. */
  it("resolves the listing URL from the order's own item", async () => {
    const { calls, client } = ready();
    await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN);
    const urlCall = calls.find((c) => c.text.includes("listing_url"))!;
    expect(urlCall.values?.[0]).toBe(ORDER_ITEM);
    expect(urlCall.values?.[0]).not.toBe(MESSAGE_ITEM);
  });

  /** A multi-line order is selectable, but names no product. */
  it("names no product for a multi-line order", async () => {
    const { client } = fakes({
      resolution: "no_order",
      eligible: [
        eligibleRow({
          order_line_count: 3,
          order_item_ref: null,
          order_sku: null,
          order_product_title: null,
        }),
      ],
    });
    const facts = factMap(
      await resolveManuallySelectedOrderContext(client, client, conversation, CHOSEN),
    );
    expect(facts.order_number).toBe(CHOSEN);
    expect(facts.customer_order_line_count).toBe("3");
    expect(facts.customer_order_sku).toBeUndefined();
    expect(facts.customer_order_product_title).toBeUndefined();
  });
});
