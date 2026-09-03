import { describe, expect, it } from "vitest";

import { displayableListingUrl } from "@/lib/domain/listing-link";

/**
 * What may be rendered into an `href`, and what may not.
 *
 * The URL shapes below are the live ones: every eBay listing URL in the source
 * is `https` and ends in `/<item_id>`, across ten country domains. The item id
 * used throughout is the one from the brief.
 */

const ITEM = "267367123779";
const LIVE_URL =
  "https://www.ebay.co.uk/itm/Vintage-Retro-Pendant-Ceiling-Light-Shade-Metal-Curvy-Easy-Fit-Lampshade-Kitchen-/267367123779";

describe("a URL that names the reference it is shown beside", () => {
  it("passes the live eBay shape through unchanged", () => {
    expect(displayableListingUrl(LIVE_URL, ITEM)).toBe(LIVE_URL);
  });

  it("accepts every country domain the source actually uses", () => {
    for (const host of [
      "www.ebay.co.uk",
      "www.ebay.com",
      "www.ebay.fr",
      "www.ebay.de",
      "www.ebay.es",
      "www.ebay.it",
      "www.ebay.ca",
      "www.ebay.at",
      "www.ebay.ie",
      "www.ebay.nl",
    ]) {
      const url = `https://${host}/itm/${ITEM}`;
      expect(displayableListingUrl(url, ITEM)).toBe(url);
    }
  });

  it("accepts a query string, because the reference is checked against the path", () => {
    const url = `https://www.ebay.co.uk/itm/${ITEM}?hash=item3e5`;
    expect(displayableListingUrl(url, ITEM)).toBe(url);
  });

  it("trims surrounding whitespace rather than rejecting the row", () => {
    expect(displayableListingUrl(`  ${LIVE_URL}  `, `  ${ITEM}  `)).toBe(LIVE_URL);
  });

  it("returns the source's own string, not a re-serialised one", () => {
    // `new URL().href` would rewrite this; a reviewer must be able to find the
    // value in the listing table character for character.
    const url = `https://www.ebay.co.uk/itm/Light Shade/${ITEM}`;
    expect(displayableListingUrl(url, ITEM)).toBe(url);
  });
});

describe("a URL that does not name the reference is never shown", () => {
  it("rejects a link to a different listing", () => {
    expect(displayableListingUrl(`https://www.ebay.co.uk/itm/${ITEM}`, "161782384942")).toBeNull();
  });

  it("rejects a reference that appears only in the query string", () => {
    expect(
      displayableListingUrl(`https://www.ebay.co.uk/itm/999999999999?item=${ITEM}`, ITEM),
    ).toBeNull();
  });

  it("rejects a reference that is only a suffix of the id in the path", () => {
    // `/1267367123779` must not vouch for `267367123779`; the check requires a
    // path separator before the reference.
    expect(displayableListingUrl(`https://www.ebay.co.uk/itm/1${ITEM}`, ITEM)).toBeNull();
  });

  it("rejects a listing search or a home page", () => {
    expect(displayableListingUrl("https://www.ebay.co.uk/", ITEM)).toBeNull();
    expect(displayableListingUrl(`https://www.ebay.co.uk/sch/i.html?_nkw=${ITEM}`, ITEM)).toBeNull();
  });
});

describe("nothing that is not a fetchable web address reaches an href", () => {
  it("rejects a script URL however it is cased or spaced", () => {
    for (const hostile of [
      `javascript:alert(1)//${ITEM}`,
      `JavaScript:alert(1)//${ITEM}`,
      `  javascript:alert(1)//${ITEM}`,
      `data:text/html,<script></script>/${ITEM}`,
      `vbscript:msgbox/${ITEM}`,
      `file:///etc/${ITEM}`,
    ]) {
      expect(displayableListingUrl(hostile, ITEM)).toBeNull();
    }
  });

  it("rejects a relative path, which has no marketplace to be relative to", () => {
    expect(displayableListingUrl(`/itm/${ITEM}`, ITEM)).toBeNull();
    expect(displayableListingUrl(`itm/${ITEM}`, ITEM)).toBeNull();
    expect(displayableListingUrl(`//www.ebay.co.uk/itm/${ITEM}`, ITEM)).toBeNull();
  });

  it("rejects a URL with no public host", () => {
    // The URL parser reads the first path segment of `https:///itm/<id>` as the
    // host, so "has a hostname" is not enough on its own.
    expect(displayableListingUrl(`https:///itm/${ITEM}`, ITEM)).toBeNull();
    expect(displayableListingUrl(`https://localhost/itm/${ITEM}`, ITEM)).toBeNull();
  });
});

describe("absent inputs are absent answers, never a constructed URL", () => {
  it("returns null for a missing or blank URL", () => {
    expect(displayableListingUrl(null, ITEM)).toBeNull();
    expect(displayableListingUrl("", ITEM)).toBeNull();
    expect(displayableListingUrl("   ", ITEM)).toBeNull();
  });

  it("returns null for a missing or blank item reference", () => {
    expect(displayableListingUrl(LIVE_URL, null)).toBeNull();
    expect(displayableListingUrl(LIVE_URL, "")).toBeNull();
    expect(displayableListingUrl(LIVE_URL, "   ")).toBeNull();
  });

  it("builds nothing from an item reference alone", () => {
    // The one guarantee that matters most: with no stored URL there is no
    // output, rather than an assembled `https://www.ebay.co.uk/itm/<ref>`.
    expect(displayableListingUrl(null, ITEM)).toBeNull();
  });
});
