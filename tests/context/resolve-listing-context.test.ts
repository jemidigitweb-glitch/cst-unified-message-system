import { describe, expect, it } from "vitest";

import { resolveListingContext } from "@/lib/context/resolve-listing-context";
import type { Queryable as SourceQueryable } from "@/lib/repositories/ebay-listing-repository";

/**
 * The listing's own words reaching the draft path.
 *
 * Every shape below is the live one: `title` is a short plain string (57–80
 * characters across all 869 parent rows behind live conversations) and
 * `selected_variations` is eBay's `[{"Name": ..., "Value": [...]}]` array.
 */

type Call = { text: string; values?: unknown[] };

function fakeSourceClient(rows: unknown[]) {
  const calls: Call[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

const TITLE = "Vintage Retro Pendant Ceiling Light Shade Metal Curvy Easy Fit Lampshade Kitchen";

const conversation = { marketplace: "ebay", subSourceId: 22, listingItemRef: "267367123779" };

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    title: TITLE,
    selected_variations: [{ Name: "Colour", Value: ["Copper", "Rustic Red", "Brushed Silver"] }],
    ...overrides,
  };
}

describe("what the listing contributes", () => {
  it("states the title and each variation axis the listing offers", async () => {
    const { client } = fakeSourceClient([listingRow()]);

    expect(await resolveListingContext(client, conversation)).toEqual([
      { name: "listing_title", value: TITLE },
      { name: "listing_options_colour", value: "Copper, Rustic Red, Brushed Silver" },
    ]);
  });

  it("scopes the read to the item and sub-account, on the parent row", async () => {
    const { calls, client } = fakeSourceClient([listingRow()]);

    await resolveListingContext(client, conversation);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(["267367123779", 22]);
    expect(calls[0]!.text).toContain("el.is_parent = 1");
  });

  it("names each axis after the listing's own wording", async () => {
    const { client } = fakeSourceClient([
      listingRow({
        selected_variations: [
          { Name: "Watts", Value: ["5W", "9W", "12W"] },
          { Name: "Cable Length", Value: ["1m", "2m"] },
        ],
      }),
    ]);

    const facts = await resolveListingContext(client, conversation);

    expect(facts.map((fact) => fact.name)).toEqual([
      "listing_title",
      "listing_options_watts",
      "listing_options_cable_length",
    ]);
  });

  /**
   * The description is 53,736 characters on average and is HTML on all 869 live
   * parent rows. It is marketing rather than specification, so it must not be
   * read at all — not read-then-discarded.
   */
  it("never reads the listing's marketing description", async () => {
    const { calls, client } = fakeSourceClient([listingRow()]);

    await resolveListingContext(client, conversation);

    expect(calls[0]!.text).not.toContain("product_description");
  });
});

describe("a variation axis that would be misread is dropped", () => {
  /**
   * `contextBlocks()` files a fact by matching its NAME against
   * /order|refund|tracking|delivery/i. Variation axes are named by whoever wrote
   * the listing, so this one would otherwise be printed to the model as a
   * verified fact about the customer's delivery.
   */
  it("drops an axis whose name would file it under ORDER", async () => {
    const { client } = fakeSourceClient([
      listingRow({
        selected_variations: [
          { Name: "Delivery Type", Value: ["Standard", "Express"] },
          { Name: "Colour", Value: ["Black"] },
        ],
      }),
    ]);

    const facts = await resolveListingContext(client, conversation);

    expect(facts.map((fact) => fact.name)).toEqual(["listing_title", "listing_options_colour"]);
  });

  it("drops an axis whose options would fill the prompt", async () => {
    const { client } = fakeSourceClient([
      listingRow({
        selected_variations: [
          { Name: "Colour", Value: Array.from({ length: 60 }, (_, i) => `Shade number ${i}`) },
        ],
      }),
    ]);

    expect(await resolveListingContext(client, conversation)).toEqual([
      { name: "listing_title", value: TITLE },
    ]);
  });

  it("drops an axis whose name is only punctuation", async () => {
    const { client } = fakeSourceClient([
      listingRow({ selected_variations: [{ Name: "---", Value: ["a"] }] }),
    ]);

    expect(await resolveListingContext(client, conversation)).toEqual([
      { name: "listing_title", value: TITLE },
    ]);
  });
});

describe("a malformed variations column costs the draft nothing", () => {
  it.each([
    ["null", null],
    ["an object rather than an array", { Colour: ["Black"] }],
    ["a string", "Colour: Black"],
    ["an array of strings", ["Black", "White"]],
    ["entries with no Value", [{ Name: "Colour" }]],
    ["entries with no Name", [{ Value: ["Black"] }]],
    ["a Value holding non-strings", [{ Name: "Colour", Value: [1, 2] }]],
    ["blank names and values", [{ Name: "  ", Value: ["  "] }]],
  ])("still states the title when the column holds %s", async (_label, variations) => {
    const { client } = fakeSourceClient([listingRow({ selected_variations: variations })]);

    expect(await resolveListingContext(client, conversation)).toEqual([
      { name: "listing_title", value: TITLE },
    ]);
  });
});

describe("nothing to state means nothing stated", () => {
  it("returns no facts and issues no query for a non-eBay conversation", async () => {
    for (const marketplace of ["amazon", "shopify", "bandq", "temu"]) {
      const { calls, client } = fakeSourceClient([listingRow()]);

      expect(await resolveListingContext(client, { ...conversation, marketplace })).toEqual([]);
      expect(calls).toHaveLength(0);
    }
  });

  it("returns no facts and issues no query without an item reference", async () => {
    const { calls, client } = fakeSourceClient([listingRow()]);

    expect(await resolveListingContext(client, { ...conversation, listingItemRef: null })).toEqual(
      [],
    );
    expect(await resolveListingContext(client, { ...conversation, listingItemRef: "  " })).toEqual(
      [],
    );
    expect(calls).toHaveLength(0);
  });

  it("returns no facts and issues no query without a sub-account", async () => {
    const { calls, client } = fakeSourceClient([listingRow()]);

    expect(await resolveListingContext(client, { ...conversation, subSourceId: null })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns no facts when the listing has no parent row", async () => {
    const { client } = fakeSourceClient([]);

    expect(await resolveListingContext(client, conversation)).toEqual([]);
  });

  it("returns no facts rather than choosing between several parent rows", async () => {
    const { client } = fakeSourceClient([listingRow(), listingRow({ title: "A different title" })]);

    expect(await resolveListingContext(client, conversation)).toEqual([]);
  });

  it("returns no facts when the title is absent or blank", async () => {
    for (const title of [null, "", "   "]) {
      const { client } = fakeSourceClient([listingRow({ title })]);
      expect(await resolveListingContext(client, conversation)).toEqual([]);
    }
  });
});
