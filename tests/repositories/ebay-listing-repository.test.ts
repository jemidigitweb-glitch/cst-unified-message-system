import { describe, expect, it } from "vitest";

import {
  type Queryable,
  findListingDetails,
  findListingUrl,
} from "@/lib/repositories/ebay-listing-repository";

type Call = { text: string; values?: unknown[] };

function fakeClient(rows: unknown[]) {
  const calls: Call[] = [];
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

const ITEM = "267367123779";
const URL_267 =
  "https://www.ebay.co.uk/itm/Vintage-Retro-Pendant-Ceiling-Light-Shade-Metal-Curvy-Easy-Fit-Lampshade-Kitchen-/267367123779";

describe("findListingUrl — the query", () => {
  it("reads the recorded URL for the item and sub-account, and nothing else", async () => {
    const { calls, client } = fakeClient([{ listing_url: URL_267 }]);

    await findListingUrl(client, { itemId: ITEM, subSourceId: 22 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual([ITEM, 22]);
    expect(calls[0]!.text).toContain("listings.ebay_listings");
    expect(calls[0]!.text).toContain("el.listing_url");
  });

  it("restricts to the parent row, so a listing's variants cannot fan out", async () => {
    // The brief's own example holds 52 rows under one item_id — 51 variants and
    // one parent. Without this the query would return the variants too.
    const { calls, client } = fakeClient([{ listing_url: URL_267 }]);

    await findListingUrl(client, { itemId: ITEM, subSourceId: 22 });

    expect(calls[0]!.text).toContain("el.is_parent = 1");
  });

  it("excludes blank and NULL URLs in SQL, so an empty string is never a value", async () => {
    const { calls, client } = fakeClient([]);

    await findListingUrl(client, { itemId: ITEM, subSourceId: 22 });

    expect(calls[0]!.text).toContain("el.listing_url IS NOT NULL");
    expect(calls[0]!.text).toContain("btrim(el.listing_url) <> ''");
  });

  it("is parameterised, never interpolated", async () => {
    const { calls, client } = fakeClient([]);

    await findListingUrl(client, { itemId: "'; DROP TABLE listings--", subSourceId: 1 });

    expect(calls[0]!.text).not.toContain("DROP TABLE");
    expect(calls[0]!.values).toEqual(["'; DROP TABLE listings--", 1]);
  });

  it("reads only, and reads no other column of the listing", async () => {
    const { calls, client } = fakeClient([]);

    await findListingUrl(client, { itemId: ITEM, subSourceId: 22 });

    const sql = calls[0]!.text;
    expect(sql.trim().startsWith("SELECT")).toBe(true);
    for (const forbidden of ["price", "title", "product_description", "quantity", "sku"]) {
      expect(sql, `${forbidden} must not be read`).not.toContain(forbidden);
    }
  });
});

describe("findListingUrl — what it returns", () => {
  it("returns the single recorded URL", async () => {
    const { client } = fakeClient([{ listing_url: URL_267 }]);

    expect(await findListingUrl(client, { itemId: ITEM, subSourceId: 22 })).toBe(URL_267);
  });

  it("returns null when the source recorded no URL for the listing", async () => {
    const { client } = fakeClient([]);

    expect(await findListingUrl(client, { itemId: ITEM, subSourceId: 22 })).toBeNull();
  });

  /**
   * 48 item_ids hold two URLs across their variant rows and 3 still do at parent
   * level. Picking one would be this module answering a question it has no
   * evidence for, so both rows are discarded.
   */
  it("returns null rather than choosing between conflicting URLs", async () => {
    const { client } = fakeClient([
      { listing_url: "https://www.ebay.co.uk/itm/Vintage-Bird-Cage-Handle-/163954129864" },
      { listing_url: "https://www.ebay.co.uk/itm/Bird-Cage-Kitchen-Cabinet-Handle-/163954129864" },
    ]);

    expect(await findListingUrl(client, { itemId: "163954129864", subSourceId: 1 })).toBeNull();
  });
});

describe("findListingDetails", () => {
  const row = {
    title: "Vintage Retro Pendant Ceiling Light Shade Metal Curvy Easy Fit Lampshade",
    selected_variations: [{ Name: "Colour", Value: ["Copper", "Rustic Red"] }],
  };

  it("reads the parent row's title and variations for one item and sub-account", async () => {
    const { calls, client } = fakeClient([row]);

    const details = await findListingDetails(client, { itemId: ITEM, subSourceId: 22 });

    expect(details).toEqual({
      title: row.title,
      variations: [{ name: "Colour", values: ["Copper", "Rustic Red"] }],
    });
    expect(calls[0]!.values).toEqual([ITEM, 22]);
    expect(calls[0]!.text).toContain("el.is_parent = 1");
  });

  /**
   * 53,736 characters on average, 486,634 at worst, HTML on all 869 live parent
   * rows. It is seller marketing, not a specification, and must never be read.
   */
  it("does not read the marketing description, or the price", async () => {
    const { calls, client } = fakeClient([row]);

    await findListingDetails(client, { itemId: ITEM, subSourceId: 22 });

    for (const forbidden of ["product_description", "price", "quantity"]) {
      expect(calls[0]!.text, `${forbidden} must not be read`).not.toContain(forbidden);
    }
  });

  it("returns null for no parent row, and rather than choosing between several", async () => {
    expect(await findListingDetails(fakeClient([]).client, { itemId: ITEM, subSourceId: 22 })).toBeNull();
    expect(
      await findListingDetails(fakeClient([row, { ...row, title: "Another" }]).client, {
        itemId: ITEM,
        subSourceId: 22,
      }),
    ).toBeNull();
  });

  it("returns the title with no variations when the column is unusable", async () => {
    const { client } = fakeClient([{ ...row, selected_variations: "not an array" }]);

    expect(await findListingDetails(client, { itemId: ITEM, subSourceId: 22 })).toEqual({
      title: row.title,
      variations: [],
    });
  });
});
