import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { contextBlocks } from "@/lib/ai/draft-assembly";
import type { DraftRequest } from "@/lib/ai/provider";
import { resolveListingContext } from "@/lib/context/resolve-listing-context";
import {
  resolveSotProductContext,
  resolveSotProductContextForSku,
} from "@/lib/context/resolve-sot-product-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { Queryable as SourceQueryable } from "@/lib/repositories/sot-product-repository";

/**
 * Product context reaching the model on POST-SALE conversations, which is what
 * this change is for.
 *
 * THE DEFECT THIS PINS. Product context used to be gated on
 * `orderFacts.length === 0`, so a conversation that resolved an order got the
 * order and nothing else — no dimensions, no parts list, no bundle components.
 * Measured over the 1,334 live eBay conversations, that was 735 of them,
 * including 63 of the 78 "parts missing" cases and 15 of the 24 "wrong
 * description" cases. The gate existed for a real reason — the listing's parent
 * SKU is not necessarily the customer's variant — and the fix is to resolve by
 * the ORDER'S OWN SKU rather than to remove the safeguard.
 *
 * Everything below exercises the shipped `contextBlocks` and the shipped
 * resolvers. Nothing here reimplements them.
 */

const ROOT = join(__dirname, "..", "..");

function sotClient(attributeRows: unknown[], parentRows: unknown[] = [{ sku: "LSDO210BM" }]) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      if (config.text.includes("configurator.components_sot_skus")) return { rows: attributeRows };
      if (config.text.includes("listings.ebay_listings")) return { rows: parentRows };
      return { rows: [] };
    },
  };
  return { calls, client };
}

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

const LAMPSHADE = [
  attributeRow("diameter_mm", "220"),
  attributeRow("bulb_base_compat", "E26 / E27"),
  attributeRow("table_lamp", "Y"),
  attributeRow("reducer_ring_included", "Y"),
  attributeRow("req_electrician", "N"),
  attributeRow("parts_list", "Lampshade, Reducer Ring"),
];

const ORDER_FACTS: VerifiedFact[] = [
  { name: "order_number", value: "12-34567-89012" },
  { name: "order_status", value: "Dispatched" },
  { name: "sku", value: "LSDO210BM" },
  { name: "product_title", value: "Industrial Metal Cone Lampshade — Copper" },
];

function requestWith(facts: readonly VerifiedFact[]): DraftRequest {
  return { messages: [], marketplace: "ebay", listingItemRef: "166872810291", facts };
}

const productSection = (request: DraftRequest) =>
  contextBlocks(request).split("VERIFIED CONTEXT — PRODUCT/SKU:")[1]!;

describe("the purchased SKU is what the catalogue is read against", () => {
  it("resolves SOT attributes for the order's own SKU, skipping the listing entirely", async () => {
    const { calls, client } = sotClient(LAMPSHADE);

    const facts = await resolveSotProductContextForSku(client, "LSDO210BM");

    // One statement, and it is the attribute lookup — the parent-row query that
    // could name a different variant is never issued.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("configurator.components_sot_skus");
    expect(calls[0]!.values?.[0]).toBe("LSDO210BM");
    expect(facts).toContainEqual({ name: "diameter_mm", value: "220" });
    expect(facts).toContainEqual({ name: "parts_list", value: "Lampshade, Reducer Ring" });
  });

  /** The order already stated it, and two `sku` facts could only disagree. */
  it("returns no sku fact of its own", async () => {
    const { client } = sotClient(LAMPSHADE);

    const facts = await resolveSotProductContextForSku(client, "LSDO210BM");

    expect(facts.some((fact) => fact.name === "sku")).toBe(false);
  });

  it("still applies the commercial denylist and the value checks", async () => {
    const { calls, client } = sotClient([
      attributeRow("diameter_mm", "220"),
      attributeRow("eb_price_gbp", "24.99"),
      attributeRow("room_suitability", "Kitchen [VERIFY]"),
      attributeRow("img_main", "https://i.ebayimg.com/x.jpg"),
      attributeRow("blank_one", "   "),
    ]);

    const facts = await resolveSotProductContextForSku(client, "LSDO210BM");

    // Blocked in SQL as well as in code — the patterns travel to the database.
    expect(calls[0]!.values?.[1]).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(facts).toEqual([{ name: "diameter_mm", value: "220" }]);
  });

  it("states nothing for an unknown SKU, and never invents attributes", async () => {
    const { client } = sotClient([]);

    expect(await resolveSotProductContextForSku(client, "NOT-IN-SOT")).toEqual([]);
    expect(await resolveSotProductContextForSku(client, "   ")).toEqual([]);
  });

  it("refuses rows spanning more than one SOT record rather than picking one", async () => {
    const { client } = sotClient([
      attributeRow("diameter_mm", "220"),
      { ...attributeRow("diameter_mm", "320"), sot_sku_id: "99" },
    ]);

    expect(await resolveSotProductContextForSku(client, "LSDO210BM")).toEqual([]);
  });
});

describe("order facts and catalogue facts now travel together", () => {
  it("puts the order in ORDER and the specification in PRODUCT, on one request", async () => {
    const { client } = sotClient(LAMPSHADE);
    const sot = await resolveSotProductContextForSku(client, "LSDO210BM");

    const blocks = contextBlocks(requestWith([...ORDER_FACTS, ...sot]));
    const [order, product] = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:");

    expect(order).toContain("order_number: 12-34567-89012");
    expect(order).not.toContain("diameter_mm");
    expect(product).toContain("diameter_mm: 220");
    expect(product).toContain("parts_list: Lampshade, Reducer Ring");
    // The purchased SKU stays the order's, and appears once.
    expect(blocks.match(/- sku: /g)).toHaveLength(1);
  });

  /**
   * The "answer from what you hold, then ask only for their own setup" rule.
   * It was previously unreachable on any conversation with an order, because
   * `sku` and `product_title` are excluded from it and they were all a
   * post-sale draft ever had.
   */
  it("switches on the answer-first rule for a post-sale conversation", async () => {
    const { client } = sotClient(LAMPSHADE);
    const sot = await resolveSotProductContextForSku(client, "LSDO210BM");

    const before = productSection(requestWith(ORDER_FACTS));
    const after = productSection(requestWith([...ORDER_FACTS, ...sot]));

    expect(before).not.toContain("USING THE VERIFIED PRODUCT INFORMATION");
    expect(after).toContain("USING THE VERIFIED PRODUCT INFORMATION");
    expect(after).toContain("Do not ask the customer for something already stated there");
  });

  it("tells the model not to ask a lampshade owner for their voltage", async () => {
    const { client } = sotClient(LAMPSHADE);
    const sot = await resolveSotProductContextForSku(client, "LSDO210BM");

    const after = productSection(requestWith([...ORDER_FACTS, ...sot]));

    expect(after).toContain("needs no electrical installation");
    expect(after).toContain("Do NOT ask this customer for voltage");
  });
});

describe("the listing's own words", () => {
  const listingClient = {
    query: async () => ({
      rows: [
        {
          title: "Vintage Retro Pendant Ceiling Light Shade Metal Curvy Easy Fit Lampshade",
          selected_variations: [
            { Name: "Colour", Value: ["Copper", "Rustic Red", "Brushed Silver"] },
          ],
        },
      ],
    }),
  };

  it("reaches the PRODUCT block, never the ORDER block", async () => {
    const facts = await resolveListingContext(listingClient, {
      marketplace: "ebay",
      subSourceId: 22,
      listingItemRef: "267367123779",
    });

    const blocks = contextBlocks(requestWith(facts));
    const [order, product] = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:");

    expect(order).not.toContain("listing_");
    expect(product).toContain("listing_title: Vintage Retro Pendant");
    expect(product).toContain("listing_options_colour: Copper, Rustic Red, Brushed Silver");
  });

  /**
   * A list of colours the listing sells is not a statement about which one this
   * customer has, and the prompt must say so — otherwise "your Rustic Red shade"
   * is one plausible sentence away.
   */
  it("carries the warning that options are the listing's, not the customer's", async () => {
    const facts = await resolveListingContext(listingClient, {
      marketplace: "ebay",
      subSourceId: 22,
      listingItemRef: "267367123779",
    });

    const product = productSection(requestWith(facts));

    expect(product).toContain("lists what THE LISTING OFFERS");
    expect(product).toContain("Never state or imply which option is theirs");
  });

  /**
   * Measured on conversation 32623: the option list reached the model as
   * `Black, Black Inner Gold, Black Inner White`, the customer had asked "do you
   * do this in white", and the reply asked them for a listing link instead.
   */
  it("requires availability questions to be answered outright from the list", async () => {
    const facts = await resolveListingContext(listingClient, {
      marketplace: "ebay",
      subSourceId: 22,
      listingItemRef: "267367123779",
    });

    const product = productSection(requestWith(facts));

    expect(product).toContain("ANSWER AVAILABILITY AND VARIATION QUESTIONS DIRECTLY FROM IT");
    expect(product).toContain("say it is offered, or say plainly that it is not");
    expect(product).toContain("do not ask the customer to confirm what the listing sells");
  });

  it("forbids asking for a listing link or item reference we already hold", async () => {
    const facts = await resolveListingContext(listingClient, {
      marketplace: "ebay",
      subSourceId: 22,
      listingItemRef: "267367123779",
    });

    const product = productSection(requestWith(facts));

    expect(product).toContain("DO NOT ASK FOR THIS LISTING");
    for (const asked of ["listing link", "an item number", "an item reference", "a screenshot"]) {
      expect(product).toContain(asked);
    }
    // The one case where asking IS right stays permitted, so this cannot make
    // the model refuse to identify a genuinely different product.
    expect(product).toContain("Ask for an external listing ONLY where they are plainly asking about a DIFFERENT product");
  });

  it("says none of it when the listing offers no options", async () => {
    const product = productSection(
      requestWith([
        { name: "listing_title", value: "A plain listing" },
        { name: "diameter_mm", value: "220" },
      ]),
    );

    expect(product).toContain("USING THE VERIFIED PRODUCT INFORMATION");
    expect(product).not.toContain("ANSWER AVAILABILITY AND VARIATION QUESTIONS");
    expect(product).not.toContain("DO NOT ASK FOR THIS LISTING");
  });

  it("adds no such warning when the listing has no options", async () => {
    const product = productSection(
      requestWith([{ name: "listing_title", value: "A plain listing" }]),
    );

    expect(product).not.toContain("lists what THE LISTING OFFERS");
  });

  /** A title names the product; it settles no question about it. */
  it("does not let a title alone switch on the answer-first rule", async () => {
    const product = productSection(
      requestWith([{ name: "listing_title", value: "A plain listing" }]),
    );

    expect(product).not.toContain("USING THE VERIFIED PRODUCT INFORMATION");
  });
});

describe("pre-sale conversations are unchanged", () => {
  it("still resolves the catalogue through the listing's parent row", async () => {
    const { calls, client } = sotClient(LAMPSHADE);

    const facts = await resolveSotProductContext(client, {
      marketplace: "ebay",
      subSourceId: 1,
      listingItemRef: "166872810291",
    });

    expect(calls[0]!.text).toContain("listings.ebay_listings");
    expect(facts[0]).toEqual({ name: "sku", value: "LSDO210BM" });
  });

  it("still states the standing empty wording when nothing resolved", async () => {
    const blocks = contextBlocks(requestWith([]));

    expect(blocks).toContain("(no order has been resolved and verified for this conversation");
    expect(blocks).toContain("- Marketplace listing reference: 166872810291");
  });
});

/**
 * The composition rules live in `verifiedFactsFor`, which is module-private to
 * the route. Asserted against source, matching how the rest of this suite
 * guards route-level behaviour.
 */
describe("the draft route composes the four sources correctly", () => {
  const route = readFileSync(
    join(ROOT, "app", "api", "conversations", "[conversationId]", "draft", "route.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  it("no longer gates the catalogue or the bundle on the absence of an order", () => {
    expect(route).not.toContain("if (orderFacts.length === 0 && productFacts.length === 0)");
    expect(route).toContain("if (productFacts.length === 0)");
  });

  it("reads the catalogue against the order's SKU when there is one", () => {
    expect(route).toContain('orderFacts.find((fact) => fact.name === "sku")');
    expect(route).toContain("resolveSotProductContextForSku");
    expect(route).toContain("resolveSotProductContext(sourcePool, conversation)");
  });

  it("keeps the order's own title authoritative over the listing's", () => {
    expect(route).toContain('fact.name !== "listing_title"');
    expect(route).toContain('orderFacts.some((fact) => fact.name === "product_title")');
  });

  it("carries all four sources into the request", () => {
    expect(route).toContain("[...orderFacts, ...returnFacts, ...productFacts, ...listingFacts]");
  });

  it("guards every lookup separately, so one failure cannot discard the others", () => {
    // Five resolvers, five independent try/catch blocks.
    expect(route.match(/console\.error\("\[draft\] [a-z ]+ (context )?resolution failed/g))
      .toHaveLength(5);
  });

  it("still writes nothing of its own and still cannot send", () => {
    for (const forbidden of ["sendMessage", "transmit", "DELETE FROM", "INSERT INTO"]) {
      expect(route).not.toContain(forbidden);
    }
  });
});
