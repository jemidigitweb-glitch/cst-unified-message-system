import { describe, expect, it } from "vitest";

import { resolveInvoiceOrderRowId } from "@/lib/context/resolve-invoice-order";

/**
 * WHICH ORDER A CONVERSATION MAY INVOICE.
 *
 * This is the access control for the invoice endpoint, so the properties that
 * matter are refusals. A browser names a conversation and never an order; an
 * order number in the query string can only ever FILTER a set the conversation
 * already matched; and an ambiguous conversation with no choice made produces
 * nothing at all.
 *
 * Synthetic fixtures throughout. The order numbers are the documented
 * placeholders — see `tests/guards/no-customer-data.test.ts`.
 */

type Call = { text: string; values?: unknown[] };

const ROW_A = "9000000001";
const ROW_B = "9000000002";
const ORDER_A = "20-00000-00001";
const ORDER_B = "20-00000-00002";
const OTHER_ORDER = "20-00000-00009";

const CONVERSATION = {
  id: "5001",
  marketplace: "ebay",
  subSourceId: 4,
  counterpartyRef: "buyer-handle",
  listingItemRef: "111111111111",
};

/** A strict-matcher candidate row, as `FIND_CANDIDATE_ORDERS` returns it. */
function candidate(rowId: string, orderNumber: string) {
  return {
    order_row_id: rowId,
    order_item_info_id: "1",
    order_number: orderNumber,
    order_date: "2026-01-05 10:00:00",
    order_status: "Completed",
    item_sku: "CBSF100",
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
  };
}

/** An eligible-order row, as `LIST_ELIGIBLE_ORDERS` returns it. */
function eligible(rowId: string, orderNumber: string) {
  return {
    order_row_id: rowId,
    order_number: orderNumber,
    order_date: "2026-01-05 10:00:00",
    order_status: "Completed",
    storefront_id: 4,
    storefront_name: "Storefront Four",
    order_line_count: 1,
    order_item_ref: "222222222222",
    order_sku: "CBSF100",
    order_product_title: "A product",
    listing_match: false,
  };
}

/**
 * Dispatches on the statement, so one fake stands in for three repositories.
 * `DISTINCT ON (o.id)` is the strict matcher; `ordered.sort_date` is the
 * eligible list.
 */
function fakes(options: {
  candidates?: unknown[];
  eligible?: unknown[];
  resolution?: string | null;
}) {
  const calls: Call[] = [];
  const source = {
    query: async (config: Call) => {
      calls.push(config);
      if (config.text.includes("DISTINCT ON (o.id)") && config.text.includes("ebay_buyer_id = $4")) {
        return { rows: options.candidates ?? [] };
      }
      if (config.text.includes("ordered.sort_date")) {
        return { rows: options.eligible ?? [] };
      }
      return { rows: [] };
    },
  };
  const app = {
    query: async (config: Call) => {
      calls.push(config);
      return {
        rows: options.resolution === undefined ? [] : [{ resolution: options.resolution }],
      };
    },
  };
  // The repositories take structural clients; the fakes satisfy them.
  return { calls, source: source as never, app: app as never };
}

/* ------------------------------------------------------------------------- *
 * THE MATCHED ORDER
 * ------------------------------------------------------------------------- */

describe("a conversation that matched exactly one order", () => {
  /** 1, 2. The row id comes off the matched row, never from the caller. */
  it("returns that order's row id", async () => {
    const { source, app } = fakes({ candidates: [candidate(ROW_A, ORDER_A)] });
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, null)).toBe(ROW_A);
  });

  /** A verified single match cannot be overridden by a query string. */
  it("ignores a selection naming a different order", async () => {
    const { source, app } = fakes({ candidates: [candidate(ROW_A, ORDER_A)] });
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, ORDER_B)).toBe(ROW_A);
  });
});

/* ------------------------------------------------------------------------- *
 * AMBIGUOUS
 * ------------------------------------------------------------------------- */

describe("a conversation that matched several orders", () => {
  /** 4. THE CENTRAL REFUSAL. No newest, no first, no guess. */
  it("returns nothing when no order has been selected", async () => {
    const { source, app } = fakes({
      candidates: [candidate(ROW_A, ORDER_A), candidate(ROW_B, ORDER_B)],
    });
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, null)).toBeNull();
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, "")).toBeNull();
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, "   ")).toBeNull();
  });

  /** 5, 6. The selection decides, and it decides exactly. */
  it("returns order A for a selection of A and order B for a selection of B", async () => {
    const rows = [candidate(ROW_A, ORDER_A), candidate(ROW_B, ORDER_B)];
    const a = fakes({ candidates: rows });
    const b = fakes({ candidates: rows });
    expect(await resolveInvoiceOrderRowId(a.source, a.app, CONVERSATION, ORDER_A)).toBe(ROW_A);
    expect(await resolveInvoiceOrderRowId(b.source, b.app, CONVERSATION, ORDER_B)).toBe(ROW_B);
  });

  /**
   * 3. THE ENUMERATION GUARD. An order number the conversation never matched
   * yields nothing — the number filters a set, it is never a lookup key.
   */
  it("returns nothing for an order number this conversation never matched", async () => {
    const { source, app, calls } = fakes({
      candidates: [candidate(ROW_A, ORDER_A), candidate(ROW_B, ORDER_B)],
    });
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, OTHER_ORDER)).toBeNull();
    // The number was never bound into a statement.
    for (const call of calls) {
      expect(call.values ?? []).not.toContain(OTHER_ORDER);
    }
  });

  /** Two candidates sharing a number is a refusal, not a coin toss. */
  it("returns nothing when two candidates share the selected number", async () => {
    const { source, app } = fakes({
      candidates: [candidate(ROW_A, ORDER_A), candidate(ROW_B, ORDER_A)],
    });
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, ORDER_A)).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * MANUAL SELECTION ON A no_order CONVERSATION
 * ------------------------------------------------------------------------- */

describe("a conversation the matcher could not place", () => {
  it("returns the row id of an eligible order the reviewer chose", async () => {
    const { source, app } = fakes({
      candidates: [],
      eligible: [eligible(ROW_B, ORDER_B)],
      resolution: "no_order",
    });
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, ORDER_B)).toBe(ROW_B);
  });

  it("returns nothing without a selection", async () => {
    const { source, app } = fakes({
      candidates: [],
      eligible: [eligible(ROW_B, ORDER_B)],
      resolution: "no_order",
    });
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, null)).toBeNull();
  });

  /** The stored resolution gates it, exactly as the manual fact resolver does. */
  it.each(["single_order", "ambiguous", "needs_context", "terminated_order"])(
    "refuses a manual choice on a %s conversation",
    async (resolution) => {
      const { source, app } = fakes({
        candidates: [],
        eligible: [eligible(ROW_B, ORDER_B)],
        resolution,
      });
      expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, ORDER_B)).toBeNull();
    },
  );

  it("returns nothing for an order the reviewer was never offered", async () => {
    const { source, app } = fakes({
      candidates: [],
      eligible: [eligible(ROW_B, ORDER_B)],
      resolution: "no_order",
    });
    expect(await resolveInvoiceOrderRowId(source, app, CONVERSATION, OTHER_ORDER)).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * CONVERSATIONS THAT CANNOT INVOICE AT ALL
 * ------------------------------------------------------------------------- */

describe("conversations with no usable keys", () => {
  it.each([
    ["a non-eBay conversation", { marketplace: "amazon" }],
    ["a conversation with no storefront", { subSourceId: null }],
    ["a conversation with a blank buyer", { counterpartyRef: "" }],
    ["a conversation grouped under the ungrouped sentinel", { counterpartyRef: "unresolved:4711" }],
  ])("returns nothing for %s", async (_name, overrides) => {
    const { source, app, calls } = fakes({ candidates: [candidate(ROW_A, ORDER_A)] });
    const result = await resolveInvoiceOrderRowId(
      source,
      app,
      { ...CONVERSATION, ...overrides } as typeof CONVERSATION,
      ORDER_A,
    );
    expect(result).toBeNull();
    // Rejected before any statement was issued.
    expect(calls).toHaveLength(0);
  });
});
