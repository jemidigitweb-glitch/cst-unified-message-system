import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_CAPABILITIES,
  MARKETPLACE_TAB_ORDER,
} from "@/lib/domain/marketplace-capabilities";

/**
 * Standing guard on the listing link.
 *
 * The failure this exists to prevent is a link that LOOKS right. An eBay item
 * URL is `https://www.ebay.<tld>/itm/<slug>/<item_id>`, which is trivial to
 * assemble from an item reference and a hard-coded domain — and an assembled
 * one would resolve, would look exactly like a real link, and would be wrong
 * for every listing whose site is not the one guessed. So the rule is not
 * "prefer the stored URL"; it is that no code on this path may contain the
 * ingredients of a URL at all.
 *
 * Asserted against source, matching the rest of this suite: no DOM environment
 * is configured, and the properties that matter here are structural.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const repository = stripComments(read("lib", "repositories", "ebay-listing-repository.ts"));
const resolver = stripComments(read("lib", "context", "resolve-listing-link.ts"));
const domain = stripComments(read("lib", "domain", "listing-link.ts"));
const route = stripComments(read("app", "api", "conversations", "[conversationId]", "listing", "route.ts"));
const panel = stripComments(read("components", "context-panel.tsx"));

const PATH = [repository, resolver, domain, route, panel];

describe("no listing URL is ever constructed", () => {
  it("names no marketplace domain anywhere on the path", () => {
    for (const source of PATH) {
      expect(source).not.toMatch(/ebay\.(co\.uk|com|de|fr|es|it|ca|at|ie|nl)/);
      expect(source).not.toMatch(/amazon\.(co\.uk|com|de|fr)/);
      expect(source).not.toContain("/itm/");
    }
  });

  it("assembles no URL from a template or a concatenation", () => {
    for (const source of PATH) {
      expect(source).not.toMatch(/["'`]https?:\/\//);
    }
  });

  it("reads the URL the source recorded", () => {
    expect(repository).toContain("listings.ebay_listings");
    expect(repository).toContain("listing_url");
  });
});

describe("the link must prove it is the listing beside it", () => {
  it("checks the stored URL against the reference it will be shown with", () => {
    expect(resolver).toContain("displayableListingUrl");
    expect(domain).toContain("parsed.pathname.endsWith");
  });

  it("allows only fetchable web schemes", () => {
    expect(domain).toContain("ALLOWED_SCHEMES");
    expect(domain).toContain('"https:"');
    for (const scheme of ["javascript:", "data:", "vbscript:"]) {
      expect(domain).not.toContain(scheme);
    }
  });
});

describe("the sidebar shows a reference with or without a link, never a broken one", () => {
  it("renders the reference through one row component either way", () => {
    expect(panel).toContain("<ListingReference");
    expect(panel).toContain('label="Item reference"');
    // `href` is optional on the row, so the no-link case is the row's own
    // default rather than a second layout that could drift from it.
    expect(panel).toMatch(/href\?:\s*string/);
    expect(panel).toContain("href={listingUrl ?? undefined}");
  });

  it("opens the listing safely in a new tab", () => {
    expect(panel).toContain('target="_blank"');
    expect(panel).toContain('rel="noopener noreferrer"');
  });

  /**
   * Light blue, and underlined as well.
   *
   * The colour is what marks the one clickable value in a sidebar of plain
   * rows. The underline is what says the same thing to a reviewer who cannot
   * tell the colour apart from the text around it, which is why removing it and
   * keeping only the colour would be a regression rather than a tidy-up.
   */
  it("colours the linked value light blue, and keeps it underlined", () => {
    // The row's own anchor, not the customer-image one earlier in the file.
    const row = panel.slice(panel.indexOf("function Row("));
    const anchor = row.slice(row.indexOf("<a"), row.indexOf("</a>"));
    expect(anchor).toContain("text-sky-500");
    expect(anchor).toContain("dark:text-sky-300");
    expect(anchor).toContain("underline");
  });

  it("gates on the capability, never on a marketplace name", () => {
    expect(panel).toContain("capability.listingLinkResolvable");
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      expect(panel).not.toContain(`"${marketplace}"`);
    }
  });

  it("remounts per conversation, so one conversation's link cannot appear on another", () => {
    const mount = panel.slice(panel.indexOf("<ListingReference"));
    // Prefixed rather than the bare id: `OrderContextFacts` is a sibling keyed
    // by the same conversation, and duplicate sibling keys are a React error.
    expect(mount.slice(0, mount.indexOf("/>"))).toContain("key={`item-ref-${conversation.id}`}");
  });
});

describe("resolving a listing link writes nothing", () => {
  it("never resolves an order, so it cannot trigger a snapshot write", () => {
    for (const source of [resolver, route]) {
      expect(source).not.toContain("resolveEbayOrderContext");
      expect(source).not.toContain("saveContextSnapshot");
    }
  });

  it("exposes a read method only", () => {
    expect(route).toContain("export async function GET");
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(route).not.toContain(`export async function ${method}`);
    }
  });
});

describe("every marketplace states whether its reference names one listing", () => {
  it("answers the question for all five", () => {
    for (const marketplace of MARKETPLACE_TAB_ORDER) {
      expect(typeof MARKETPLACE_CAPABILITIES[marketplace].listingLinkResolvable).toBe("boolean");
    }
  });

  it("claims it only where the source can support it", () => {
    expect(MARKETPLACE_CAPABILITIES.ebay.listingLinkResolvable).toBe(true);
    // Amazon: one ASIN, one URL per regional site, nothing to choose between
    // them. The other three record no item reference at all.
    for (const marketplace of ["amazon", "shopify", "bandq", "temu"] as const) {
      expect(MARKETPLACE_CAPABILITIES[marketplace].listingLinkResolvable).toBe(false);
    }
  });
});
