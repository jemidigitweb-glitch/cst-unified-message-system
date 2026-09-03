import { describe, expect, it } from "vitest";

import { resolveListingLink } from "@/lib/context/resolve-listing-link";
import type { Queryable as SourceQueryable } from "@/lib/repositories/ebay-listing-repository";

type Call = { text: string; values?: unknown[] };

const ITEM = "267367123779";
const URL_267 =
  "https://www.ebay.co.uk/itm/Vintage-Retro-Pendant-Ceiling-Light-Shade-Metal-Curvy-Easy-Fit-Lampshade-Kitchen-/267367123779";

function fakeSourceClient(rows: unknown[] = [{ listing_url: URL_267 }]) {
  const calls: Call[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

const ebayConversation = {
  marketplace: "ebay",
  subSourceId: 22,
  listingItemRef: ITEM,
};

describe("the case from the brief", () => {
  it("resolves item reference 267367123779 to its recorded listing URL", async () => {
    const { calls, client } = fakeSourceClient();

    expect(await resolveListingLink(client, ebayConversation)).toBe(URL_267);
    expect(calls[0]!.values).toEqual([ITEM, 22]);
  });
});

describe("a conversation with nothing to resolve queries nothing", () => {
  it("returns null and issues no query when there is no item reference", async () => {
    const { calls, client } = fakeSourceClient();

    expect(
      await resolveListingLink(client, { ...ebayConversation, listingItemRef: null }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("treats a blank item reference as no item reference", async () => {
    const { calls, client } = fakeSourceClient();

    expect(await resolveListingLink(client, { ...ebayConversation, listingItemRef: "   " })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null and issues no query when the conversation has no sub-account", async () => {
    const { calls, client } = fakeSourceClient();

    expect(await resolveListingLink(client, { ...ebayConversation, subSourceId: null })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  /**
   * An ASIN resolves to one URL per Amazon regional site and the conversation
   * cannot say which the customer bought from, so no link is the honest answer.
   * Shopify, B&Q and Temu record no item reference at all.
   */
  it("returns null and issues no query for every non-eBay marketplace", async () => {
    for (const marketplace of ["amazon", "shopify", "bandq", "temu"]) {
      const { calls, client } = fakeSourceClient();

      expect(await resolveListingLink(client, { ...ebayConversation, marketplace })).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });
});

describe("an item reference alone never becomes a URL", () => {
  it("returns null when the source recorded no URL", async () => {
    const { client } = fakeSourceClient([]);

    expect(await resolveListingLink(client, ebayConversation)).toBeNull();
  });

  it("returns null rather than choosing between conflicting URLs", async () => {
    const { client } = fakeSourceClient([
      { listing_url: `https://www.ebay.co.uk/itm/One-Title-/${ITEM}` },
      { listing_url: `https://www.ebay.co.uk/itm/Another-Title-/${ITEM}` },
    ]);

    expect(await resolveListingLink(client, ebayConversation)).toBeNull();
  });

  it("drops a stored URL that names a different listing", async () => {
    const { client } = fakeSourceClient([
      { listing_url: "https://www.ebay.co.uk/itm/Some-Other-Product-/161782384942" },
    ]);

    expect(await resolveListingLink(client, ebayConversation)).toBeNull();
  });

  it("drops a stored value that is not a fetchable web address", async () => {
    const { client } = fakeSourceClient([{ listing_url: `javascript:alert(1)//${ITEM}` }]);

    expect(await resolveListingLink(client, ebayConversation)).toBeNull();
  });
});

describe("resolving a listing link changes nothing", () => {
  it("issues exactly one statement, and it is a SELECT", async () => {
    const { calls, client } = fakeSourceClient();

    await resolveListingLink(client, ebayConversation);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text.trim().startsWith("SELECT")).toBe(true);
  });
});
