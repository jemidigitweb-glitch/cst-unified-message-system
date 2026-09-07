import { describe, expect, it } from "vitest";

import { resolveCurrentListing } from "@/lib/context/resolve-listing-link";
import type { Queryable as SourceQueryable } from "@/lib/repositories/ebay-listing-repository";

/**
 * The CURRENT LISTING, resolved without any order.
 *
 * This is the half of the panel that was missing: a conversation whose strict
 * matcher found no order was told nothing about the product either, even though
 * the listing had resolved perfectly well from the item reference alone.
 *
 * Synthetic item references and titles throughout.
 */

type Call = { text: string; values?: unknown[] };

const ITEM = "900000000001";
const LISTING_URL = `https://www.ebay.co.uk/itm/Some-Listing-Title/${ITEM}`;

/**
 * `resolveCurrentListing` issues TWO reads — the URL and the details — so the
 * fake answers by which table the statement names rather than returning one
 * fixed set of rows to both.
 */
function fakeSource(options: { url?: unknown[]; details?: unknown[] } = {}) {
  const calls: Call[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      const wantsDetails = config.text.includes("selected_variations");
      return { rows: (wantsDetails ? options.details : options.url) ?? [] };
    },
  };
  return { calls, client };
}

const conversation = { marketplace: "ebay", subSourceId: 22, listingItemRef: ITEM };

const DETAILS = [
  {
    title: "2/3 Core Vintage Fabric Style Cable Braided Twisted Flexible",
    selected_variations: [
      { Name: "Colour", Value: ["Black", "Grey", "Cream"] },
      { Name: "Cores", Value: ["2 Core", "3 Core"] },
    ],
  },
];

/* ------------------------------------------------------------------------- *
 * WITHOUT AN ORDER
 * ------------------------------------------------------------------------- */

describe("the listing resolves with no order anywhere in sight", () => {
  /** 1 and 2. Nothing here consults an order, a snapshot or a buyer. */
  it("returns the reference, title, options and link from the item alone", async () => {
    const { calls, client } = fakeSource({
      url: [{ listing_url: LISTING_URL }],
      details: DETAILS,
    });

    const listing = await resolveCurrentListing(client, conversation);

    expect(listing.itemRef).toBe(ITEM);
    expect(listing.title).toBe(DETAILS[0]!.title);
    expect(listing.listingUrl).toBe(LISTING_URL);
    expect(listing.variations).toEqual([
      { name: "Colour", values: ["Black", "Grey", "Cream"] },
      { name: "Cores", values: ["2 Core", "3 Core"] },
    ]);

    // Neither read mentions an order, a buyer or a snapshot.
    for (const call of calls) {
      expect(call.text).not.toMatch(/order|buyer|customer_info|context_snapshots/i);
    }
  });

  /** 3. A listing sells many SKUs; the contract has nowhere to put one. */
  it("returns no SKU, because nothing here can say which one is meant", async () => {
    const { client } = fakeSource({ url: [{ listing_url: LISTING_URL }], details: DETAILS });
    const listing = await resolveCurrentListing(client, conversation);

    expect(Object.keys(listing).sort()).toEqual(["itemRef", "listingUrl", "title", "variations"]);
    expect(JSON.stringify(listing)).not.toMatch(/sku/i);
  });
});

/* ------------------------------------------------------------------------- *
 * PIECEWISE REFUSAL
 * ------------------------------------------------------------------------- */

describe("each piece is refused on its own evidence", () => {
  it("keeps the title when no URL was recorded", async () => {
    const { client } = fakeSource({ url: [], details: DETAILS });
    const listing = await resolveCurrentListing(client, conversation);
    expect(listing.listingUrl).toBeNull();
    expect(listing.title).toBe(DETAILS[0]!.title);
    expect(listing.itemRef).toBe(ITEM);
  });

  it("keeps the URL when the listing has no readable title", async () => {
    const { client } = fakeSource({ url: [{ listing_url: LISTING_URL }], details: [] });
    const listing = await resolveCurrentListing(client, conversation);
    expect(listing.listingUrl).toBe(LISTING_URL);
    expect(listing.title).toBeNull();
    expect(listing.variations).toEqual([]);
  });

  it("still reports the reference when neither lookup resolved", async () => {
    const { client } = fakeSource({ url: [], details: [] });
    const listing = await resolveCurrentListing(client, conversation);
    expect(listing.itemRef).toBe(ITEM);
    expect(listing.listingUrl).toBeNull();
    expect(listing.title).toBeNull();
  });

  /** Several parent rows is a disagreement, and a disagreement is not an answer. */
  it("refuses a title where the source recorded more than one", async () => {
    const { client } = fakeSource({
      url: [],
      details: [DETAILS[0]!, { ...DETAILS[0]!, title: "A different title" }],
    });
    expect((await resolveCurrentListing(client, conversation)).title).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT IT WILL NOT TOUCH
 * ------------------------------------------------------------------------- */

describe("it refuses before querying anything it cannot answer", () => {
  it("returns nothing, and reads nothing, for a non-eBay conversation", async () => {
    for (const marketplace of ["amazon", "shopify", "bandq", "temu"]) {
      const { calls, client } = fakeSource({ url: [{ listing_url: LISTING_URL }] });
      const listing = await resolveCurrentListing(client, { ...conversation, marketplace });
      expect(listing.itemRef, marketplace).toBeNull();
      expect(listing.title, marketplace).toBeNull();
      expect(calls, marketplace).toHaveLength(0);
    }
  });

  it("returns nothing for a conversation with no item reference", async () => {
    for (const listingItemRef of [null, "", "   "]) {
      const { calls, client } = fakeSource({ url: [{ listing_url: LISTING_URL }] });
      const listing = await resolveCurrentListing(client, { ...conversation, listingItemRef });
      expect(listing.itemRef).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it("returns nothing for a conversation with no storefront", async () => {
    const { calls, client } = fakeSource({ url: [{ listing_url: LISTING_URL }] });
    const listing = await resolveCurrentListing(client, { ...conversation, subSourceId: null });
    expect(listing.itemRef).toBeNull();
    expect(calls).toHaveLength(0);
  });

  /** Read-only, and it writes no snapshot — unlike the order resolver. */
  it("issues only SELECTs", async () => {
    const { calls, client } = fakeSource({ url: [{ listing_url: LISTING_URL }], details: DETAILS });
    await resolveCurrentListing(client, conversation);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
    }
  });
});
