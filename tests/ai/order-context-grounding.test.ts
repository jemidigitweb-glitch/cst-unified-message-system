import { describe, expect, it } from "vitest";

import { contextBlocks } from "@/lib/ai/draft-assembly";
import type { DraftRequest } from "@/lib/ai/provider";
import {
  type DraftResult,
  settleReviewRequirement,
  ungroundedClaims,
} from "@/lib/domain/draft";
import { resolveEbayOrderContext } from "@/lib/context/resolve-order-context";
import { resolveEbayReturnContext } from "@/lib/context/resolve-return-context";
import type { Writable as AppWritable } from "@/lib/repositories/context-snapshot-repository";
import type { Queryable as SourceQueryable } from "@/lib/repositories/order-context-repository";
import type { Queryable as ImageSourceQueryable } from "@/lib/repositories/ebay-image-repository";

/**
 * Proves the resolver's output actually reaches the live prompt-builder
 * correctly bucketed, and that the existing grounding gate
 * (`ungroundedClaims` / `settleReviewRequirement`) works with this feature's
 * fact vocabulary -- without modifying `draft-assembly.ts` or `draft.ts`,
 * which stay exactly as they are today.
 */

function fakeAppClient(): AppWritable {
  return {
    query: async (config) => {
      if (config.text.includes("FROM cst_app.context_snapshots") && config.text.startsWith("\nSELECT")) {
        return { rows: [] };
      }
      if (config.text.includes("INSERT INTO cst_app.context_snapshots")) {
        return { rows: [{ id: "1" }] };
      }
      return { rows: [] };
    },
  };
}

function fakeSourceClient(rows: unknown[]): SourceQueryable {
  return { query: async () => ({ rows }) };
}

/** A conversation already resolved to a single order, exactly as read back on every draft after the first. */
function cachedSingleOrderAppClient(): AppWritable {
  return {
    query: async (config) => {
      if (config.text.includes("FROM cst_app.context_snapshots") && config.text.startsWith("\nSELECT")) {
        return {
          rows: [
            {
              id: "1",
              conversation_id: "32103",
              resolution: "single_order",
              sub_source_id: 1,
              order_number: "ORD-1001",
              order_date: "2026-08-01",
              order_status_summary: "Dispatched",
              tracking_number: "TRK-1",
              delivery_courier: "Royal Mail",
              delivery_address: "1 Test Street, Testville, Testshire, TE5 7ST",
              listing_item_ref: "166239358700",
              verification_method: "deterministic_single",
            },
          ],
        };
      }
      if (config.text.includes("FROM cst_app.context_items") && config.text.includes("SELECT")) {
        return {
          rows: [{ id: "9", exact_sku: "REAL-SKU-1", product_title: "Synthetic Widget", image_url: null }],
        };
      }
      return { rows: [] };
    },
  };
}

/** A conversation already resolved to a single order, for the return-context tests. */
function cachedSingleOrderForReturnAppClient(): AppWritable {
  return {
    query: async (config) => {
      if (config.text.includes("FROM cst_app.context_snapshots") && config.text.startsWith("\nSELECT")) {
        return {
          rows: [
            {
              id: "1",
              conversation_id: "32439",
              resolution: "single_order",
              sub_source_id: 1,
              order_number: "13-15029-03048",
              listing_item_ref: "167833569765",
              verification_method: "deterministic_single",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
}

function fakeReturnsSourceClient(returnRows: unknown[]): ImageSourceQueryable {
  return {
    query: async (config) => {
      if (config.text.includes("customer_service.ebay_returns")) return { rows: returnRows };
      return { rows: [] };
    },
  };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    order_row_id: "501",
    order_item_info_id: "9001",
    order_number: "ORD-1001",
    order_date: "2026-08-01 10:00:00",
    order_status: "Dispatched",
    item_sku: "LISTING-SKU-1",
    real_sku: "REAL-SKU-1",
    item_title: "Synthetic Widget",
    item_img: "https://example.test/widget.png",
    address_line_1: "1 Test Street",
    address_line_2: null,
    address_line_3: null,
    city: "Testville",
    region: "Testshire",
    postcode: "TE5 7ST",
    tracking_number: "TRK-1",
    carrier_name: "Royal Mail Tracked 48",
    carrier: "Royal Mail",
    ...overrides,
  };
}

describe("resolver output through the live prompt builder", () => {
  it("buckets every order fact under VERIFIED CONTEXT — ORDER and sku/product_title under PRODUCT/SKU", async () => {
    const facts = await resolveEbayOrderContext(fakeSourceClient([candidateRow()]), fakeAppClient(), {
      id: "32103",
      marketplace: "ebay",
      subSourceId: 1,
      counterpartyRef: "kraskir24",
      listingItemRef: "166239358700",
    });

    const request: DraftRequest = {
      messages: [],
      marketplace: "ebay",
      listingItemRef: "166239358700",
      facts,
    };

    const blocks = contextBlocks(request);
    const orderSection = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:")[0]!;
    const productSection = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:")[1]!;

    for (const name of ["order_number", "order_status", "order_date", "tracking_number", "delivery_courier", "delivery_address"]) {
      expect(orderSection).toContain(name);
    }
    expect(orderSection).not.toContain("no order has been resolved");

    expect(productSection).toContain("sku: REAL-SKU-1");
    expect(productSection).toContain("product_title: Synthetic Widget");
    expect(productSection).not.toContain("order_number");
  });

  it("still hands tracking number, courier and delivery address to the model on a cached (not first) resolution", async () => {
    const facts = await resolveEbayOrderContext(fakeSourceClient([]), cachedSingleOrderAppClient(), {
      id: "32103",
      marketplace: "ebay",
      subSourceId: 1,
      counterpartyRef: "kraskir24",
      listingItemRef: "166239358700",
    });

    const request: DraftRequest = {
      messages: [],
      marketplace: "ebay",
      listingItemRef: "166239358700",
      facts,
    };

    const orderSection = contextBlocks(request).split("VERIFIED CONTEXT — PRODUCT/SKU:")[0]!;
    expect(orderSection).toContain("tracking_number: TRK-1");
    expect(orderSection).toContain("delivery_courier: Royal Mail");
    expect(orderSection).toContain("delivery_address: 1 Test Street, Testville, Testshire, TE5 7ST");
  });

  it("states plainly that no order is verified when the resolver finds none, rather than leaving the section blank", async () => {
    const facts = await resolveEbayOrderContext(fakeSourceClient([]), fakeAppClient(), {
      id: "32103",
      marketplace: "ebay",
      subSourceId: 1,
      counterpartyRef: "kraskir24",
      listingItemRef: "166239358700",
    });

    const request: DraftRequest = {
      messages: [],
      marketplace: "ebay",
      listingItemRef: "166239358700",
      facts,
    };

    expect(contextBlocks(request)).toContain("no order has been resolved and verified for this conversation");
  });
});

describe("return context through the live prompt builder", () => {
  it("adds a VERIFIED CONTEXT — RETURN block, separate from ORDER and PRODUCT/SKU, for a verified order with a photographed return", async () => {
    const orderFacts = await resolveEbayOrderContext(
      fakeSourceClient([]),
      cachedSingleOrderForReturnAppClient(),
      { id: "32439", marketplace: "ebay", subSourceId: 1, counterpartyRef: "someone", listingItemRef: "167833569765" },
    );
    const returnFacts = await resolveEbayReturnContext(
      fakeReturnsSourceClient([
        { id: "41031", img: "https://i.ebayimg.com/images/g/a/s-l1600.jpg", reason: "ARRIVED_DAMAGED", status: "CLOSED" },
      ]),
      cachedSingleOrderForReturnAppClient(),
      { id: "32439", marketplace: "ebay" },
    );

    const request: DraftRequest = {
      messages: [],
      marketplace: "ebay",
      listingItemRef: "167833569765",
      facts: [...orderFacts, ...returnFacts],
    };

    const blocks = contextBlocks(request);
    expect(blocks).toContain("VERIFIED CONTEXT — RETURN:");
    const returnSection = blocks.split("VERIFIED CONTEXT — RETURN:")[1]!;
    expect(returnSection).toContain("return_status: CLOSED");
    expect(returnSection).toContain("return_reason: ARRIVED_DAMAGED");
    expect(returnSection).toContain("return_evidence_available: Yes");

    // Never leaks into ORDER or PRODUCT/SKU, and no image URL of any kind reaches the model.
    const orderSection = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:")[0]!;
    const productSection = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:")[1]!.split("VERIFIED CONTEXT — RETURN:")[0]!;
    expect(orderSection).not.toContain("return_status");
    expect(productSection).not.toContain("return_status");
    expect(blocks).not.toContain("ebayimg");
    expect(blocks).not.toContain("http");
  });

  it("omits the RETURN block entirely when the verified order has no photographed return -- not an empty section", async () => {
    const orderFacts = await resolveEbayOrderContext(
      fakeSourceClient([]),
      cachedSingleOrderForReturnAppClient(),
      { id: "32439", marketplace: "ebay", subSourceId: 1, counterpartyRef: "someone", listingItemRef: "167833569765" },
    );
    const returnFacts = await resolveEbayReturnContext(
      fakeReturnsSourceClient([]),
      cachedSingleOrderForReturnAppClient(),
      { id: "32439", marketplace: "ebay" },
    );

    expect(returnFacts).toEqual([]);

    const request: DraftRequest = {
      messages: [],
      marketplace: "ebay",
      listingItemRef: "167833569765",
      facts: [...orderFacts, ...returnFacts],
    };

    expect(contextBlocks(request)).not.toContain("VERIFIED CONTEXT — RETURN");
  });

  it("omits the RETURN block for an ambiguous/no_order conversation -- never guesses a return record", async () => {
    const ambiguousAppClient: AppWritable = {
      query: async (config) => {
        if (config.text.includes("FROM cst_app.context_snapshots") && config.text.startsWith("\nSELECT")) {
          return {
            rows: [
              { id: "2", conversation_id: "32439", resolution: "ambiguous", sub_source_id: null, order_number: null, listing_item_ref: null, verification_method: "none" },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const orderFacts = await resolveEbayOrderContext(fakeSourceClient([]), ambiguousAppClient, {
      id: "32439",
      marketplace: "ebay",
      subSourceId: 1,
      counterpartyRef: "someone",
      listingItemRef: "167833569765",
    });
    const returnFacts = await resolveEbayReturnContext(
      fakeReturnsSourceClient([{ id: "999", img: "https://i.ebayimg.com/x.jpg", reason: "SHOULD_NOT_APPEAR", status: "CLOSED" }]),
      ambiguousAppClient,
      { id: "32439", marketplace: "ebay" },
    );

    expect(orderFacts).toEqual([]);
    expect(returnFacts).toEqual([]);

    const request: DraftRequest = {
      messages: [],
      marketplace: "ebay",
      listingItemRef: "167833569765",
      facts: [...orderFacts, ...returnFacts],
    };

    const blocks = contextBlocks(request);
    expect(blocks).not.toContain("VERIFIED CONTEXT — RETURN");
    expect(blocks).not.toContain("SHOULD_NOT_APPEAR");
  });
});

describe("no unverified order claims can be generated", () => {
  const facts = [
    { name: "tracking_number", value: "TRK-1" },
    { name: "order_status", value: "Dispatched" },
  ];

  function draftResult(overrides: Partial<DraftResult> = {}): DraftResult {
    return {
      draft_reply: "Thanks for reaching out.",
      sources_used: [{ kind: "verified_fact", ref: "tracking_number", label: null }],
      missing_information: [],
      requires_review: false,
      ...overrides,
    };
  }

  it("does not flag a tracking claim that matches a verified tracking_number fact", () => {
    const result = draftResult({ draft_reply: "Your tracking number is: TRK-1." });
    expect(ungroundedClaims(result.draft_reply, facts)).toEqual([]);
  });

  it("flags and forces review for a refund claim with no verified refund fact, even though a tracking fact exists", () => {
    const result = draftResult({
      draft_reply: "We have issued your refund and your tracking number is: TRK-1.",
      requires_review: false,
    });

    const claims = ungroundedClaims(result.draft_reply, facts);
    expect(claims).toContain("refund decision");

    const settled = settleReviewRequirement(result, facts);
    expect(settled.requiresReview).toBe(true);
    expect(settled.missingInformation.some((m) => m.includes("refund decision"))).toBe(true);
  });

  it("forces review for a delivery-date promise when the resolver found no order at all (empty facts)", () => {
    const result = draftResult({
      draft_reply: "This will arrive by tomorrow.",
      requires_review: false,
    });

    const settled = settleReviewRequirement(result, []);
    expect(settled.requiresReview).toBe(true);
  });
});

/**
 * The sidebar now shows an ambiguous conversation's candidate orders. The
 * prompt still shows the model nothing.
 *
 * This is the whole risk the display change carries: three real order numbers
 * now exist in the application, one HTTP hop from the draft pipeline, and a
 * model handed any of them would state it as though the backend had confirmed
 * it. These tests assert the separation at the point it matters -- what
 * `contextBlocks` actually renders.
 */
describe("displaying candidates changes nothing the model sees", () => {
  it("tells the prompt no order was resolved, and names none of the candidates", async () => {
    const orderFacts = await resolveEbayOrderContext(
      fakeSourceClient([
        candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
        candidateRow({ order_row_id: "502", order_number: "ORD-1002" }),
        candidateRow({ order_row_id: "503", order_number: "ORD-1003" }),
      ]),
      fakeAppClient(),
      {
        id: "32103",
        marketplace: "ebay",
        subSourceId: 1,
        counterpartyRef: "kraskir24",
        listingItemRef: "166239358700",
      },
    );

    expect(orderFacts).toEqual([]);

    const request: DraftRequest = {
      messages: [],
      marketplace: "ebay",
      listingItemRef: "166239358700",
      facts: orderFacts,
    };
    const blocks = contextBlocks(request);

    // The ORDER block still renders -- saying plainly that nothing was
    // resolved, which is the same thing it said before candidates were
    // displayed anywhere.
    expect(blocks).toContain("no order has been resolved and verified for this conversation");
    for (const candidateOrderNumber of ["ORD-1001", "ORD-1002", "ORD-1003"]) {
      expect(blocks, `${candidateOrderNumber} must never reach the prompt`).not.toContain(
        candidateOrderNumber,
      );
    }
    // Nor the product and shipment detail the source returned for those
    // candidates and the resolver deliberately discarded.
    for (const discarded of ["REAL-SKU-1", "Synthetic Widget", "TRK-1", "Test Street"]) {
      expect(blocks).not.toContain(discarded);
    }
  });

  it("still forces review for a draft that names an order when the match was ambiguous", async () => {
    const orderFacts = await resolveEbayOrderContext(
      fakeSourceClient([
        candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
        candidateRow({ order_row_id: "502", order_number: "ORD-1002" }),
      ]),
      fakeAppClient(),
      {
        id: "32103",
        marketplace: "ebay",
        subSourceId: 1,
        counterpartyRef: "kraskir24",
        listingItemRef: "166239358700",
      },
    );

    const result: DraftResult = {
      draft_reply: "Your tracking number is: TRK-1 for order ORD-1001.",
      sources_used: [],
      missing_information: [],
      requires_review: false,
    };

    const settled = settleReviewRequirement(result, orderFacts);
    expect(settled.requiresReview).toBe(true);
    expect(ungroundedClaims(result.draft_reply, orderFacts)).toContain("tracking number");
  });
});
