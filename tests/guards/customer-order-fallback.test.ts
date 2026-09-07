import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUSTOMER_ORDER_HEADING,
  LISTING_MISMATCH_NOTICE,
  NO_MATCHING_ORDER_TEXT,
} from "@/lib/domain/customer-order-fallback";

/**
 * Standing guard on the two-layer order model.
 *
 * The invariant is invisible in a diff and expensive if lost: a layer-2 order is
 * a REAL order for a DIFFERENT product. Rendered without its notice, or stated
 * to a model with its SKU attached, it would produce a confident answer about
 * the wrong item — and the mistake would read exactly like a correct one.
 *
 * Structural assertions are read from source; this suite configures no DOM.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const panel = stripComments(read("components", "context-panel.tsx"));
const repository = stripComments(
  read("lib", "repositories", "customer-order-fallback-repository.ts"),
);
const resolver = stripComments(read("lib", "context", "resolve-fallback-order-context.ts"));
const draftRoute = stripComments(
  read("app", "api", "conversations", "[conversationId]", "draft", "route.ts"),
);
const orderContextRoute = stripComments(
  read("app", "api", "conversations", "[conversationId]", "order-context", "route.ts"),
);

/* ------------------------------------------------------------------------- *
 * 10. LAYER 1 IS UNTOUCHED
 * ------------------------------------------------------------------------- */

describe("the strict matcher is unchanged", () => {
  it("still requires buyer, storefront AND listing", () => {
    const matcher = read("lib", "repositories", "order-context-repository.ts");
    expect(matcher).toContain("WHERE ss.source_id = $1::int");
    expect(matcher).toContain("AND o.sub_source_id = $2::int");
    expect(matcher).toContain("AND oii.item_id = $3");
    expect(matcher).toContain("AND ci.ebay_buyer_id = $4");
    // The matcher cannot see layer 2 at all. Asserted on identifiers rather
    // than the word: the file already says "fallback" in an unrelated comment
    // about an unrecorded carrier brand.
    expect(matcher).not.toContain("customer-order-fallback");
    expect(matcher).not.toContain("findSoleSameStorefrontOrder");
    expect(matcher).not.toContain("FallbackCustomerOrder");
  });

  it("keeps its ambiguity handling", () => {
    const orderResolver = read("lib", "context", "resolve-order-context.ts");
    expect(orderResolver).toContain("candidates.length > 1");
    expect(orderResolver).toContain("saveAmbiguousSnapshot");
    expect(orderResolver).not.toMatch(/fallback/i);
  });

  /** Layer 2 is gated on the STORED resolution, so it cannot pre-empt layer 1. */
  it("runs layer 2 only for a recorded no_order", () => {
    expect(resolver).toContain('snapshot?.resolution !== "no_order"');
    // Both callers gate again on layer 1 having produced nothing.
    expect(draftRoute).toContain("orderFacts.length === 0");
    expect(orderContextRoute).toContain("resolveFallbackCustomerOrder");
  });
});

/* ------------------------------------------------------------------------- *
 * 5. NO AUTO-SELECTION
 * ------------------------------------------------------------------------- */

describe("layer 2 never picks between orders", () => {
  /**
   * Scoped to the AUTO-SELECTION query specifically. The same file also holds
   * the eligible-orders list a PERSON chooses from, which is legitimately
   * sorted newest-first for reading — the distinction is who decides, and only
   * the automatic path must be incapable of ranking.
   */
  it("has nothing to rank with", () => {
    const auto = repository.slice(
      repository.indexOf("const FIND_SAME_STOREFRONT_ORDERS"),
      repository.indexOf("type FallbackOrderRow"),
    );
    expect(auto).not.toBe("");
    expect(auto).not.toMatch(/\bORDER BY\b/i);
    expect(auto).not.toMatch(/\bDESC\b|\bASC\b/i);
    expect(auto).not.toMatch(/newest|latest|most recent/i);
  });

  it("refuses on anything but exactly one row", () => {
    expect(repository).toContain("if (rows.length !== 1) return null");
  });
});

/* ------------------------------------------------------------------------- *
 * 9. WHAT THE MODEL MAY BE TOLD
 * ------------------------------------------------------------------------- */

describe("a fallback order supplies the ordered product, safely", () => {
  /**
   * 6. THE PREFIX IS LOAD-BEARING. Three downstream mechanisms key off exact
   * unprefixed fact names, and each would misfire on one:
   *   `sku`            drives the SOT catalogue lookup in the draft route
   *   `product_title`  makes the draft route DROP `listing_title`
   *   `order_status`   feeds `dispatchState()`
   * Renaming any of these to its bare form is a correctness bug.
   */
  it("names no fact that would hijack the current listing or the dispatch state", () => {
    const facts = resolver.slice(resolver.indexOf("export function fallbackOrderFacts"));
    for (const reserved of [
      '["sku"',
      '["product_title"',
      '["order_status"',
      '["tracking_number"',
      '["listing_title"',
    ]) {
      expect(facts, reserved).not.toContain(reserved);
    }
    expect(read("app", "api", "conversations", "[conversationId]", "draft", "route.ts"))
      .toContain('orderFacts.find((fact) => fact.name === "sku")');
    expect(read("lib", "ai", "draft-validation.ts")).toContain('factValue(facts, "order_status")');
  });

  /** No parcel, ever: the shape has no field to carry one. */
  it("carries no tracking, carrier, delivery or refund field on the type", () => {
    const domain = stripComments(read("lib", "domain", "customer-order-fallback.ts"));
    const shape = /export type FallbackCustomerOrder = \{([\s\S]*?)\n\};/.exec(domain)?.[1] ?? "";
    expect(shape).not.toBe("");
    expect(shape).not.toMatch(/tracking|carrier|delivery|refund|address|total/i);
  });

  /** 7, 8. The relationship is computed, never left to the model. */
  it("states the listing relationship as a fact of its own", () => {
    expect(resolver).toContain("order_listing_matches_current_message_listing");
    expect(resolver).toContain("order.listingMatch ? \"yes\" : \"no\"");
  });

  /**
   * 5, 6. The ORDER's listing is looked up by the ORDER's item and storefront —
   * never the conversation's — so a current-message title or URL cannot land in
   * a `customer_order_listing_*` fact.
   */
  it("resolves the order's listing from the order's own item", () => {
    expect(resolver).toContain("itemId: order.orderItemRef");
    expect(resolver).toContain("subSourceId: order.storefrontId");
    expect(resolver).toContain("displayableListingUrl(storedUrl, order.orderItemRef)");
    // Never keyed on the conversation's listing.
    const lookup = resolver.slice(resolver.indexOf("if (order.orderItemRef !== null)"));
    expect(lookup.slice(0, 900)).not.toContain("conversation.listingItemRef");
  });

  /** 10. Multi-line orders are refused in SQL, not chosen from in code. */
  it("lets the database refuse to pick a line", () => {
    expect(repository).toContain("CASE WHEN count(*) = 1");
    expect(repository).toContain("line_count");
  });

  /** 11. The prompt states the separation as an instruction, not just a value. */
  it("instructs the model to keep the two products apart", () => {
    const assembly = stripComments(read("lib", "ai", "draft-assembly.ts"));
    expect(assembly).toContain("export function twoProductsBlock");
    expect(assembly).toContain("order_listing_matches_current_message_listing");
    expect(assembly).toMatch(/Do NOT merge their SKUs, titles/);
    // Emitted only for a genuine mismatch. The test now reads the helper the
    // check was refactored into, rather than the inline regex it used to be.
    expect(assembly).toContain("if (!listingsDiffer(orderFacts)) return null");
    expect(assembly).toMatch(/function listingsDiffer[\s\S]*?\/\^\\s\*no\\s\*\$\/i\.test/);
  });

  /** Layer 2 must not displace a resolved order or a reviewer's choice. */
  it("is applied after the resolver and after the reviewer's selection", () => {
    const resolved = draftRoute.indexOf("resolveEbayOrderContext(sourcePool, appPool, conversation)");
    const selected = draftRoute.indexOf("resolveSelectedOrderContext(sourcePool, conversation");
    const fallback = draftRoute.indexOf("resolveFallbackCustomerOrder(sourcePool, appPool");
    expect(resolved).toBeGreaterThan(-1);
    expect(selected).toBeGreaterThan(resolved);
    expect(fallback).toBeGreaterThan(selected);
  });

  /** The current listing stays the authoritative product context. */
  it("leaves listing facts resolving independently", () => {
    expect(draftRoute).toContain("resolveListingContext(sourcePool, conversation)");
  });
});

/* ------------------------------------------------------------------------- *
 * 6, 7. NO RELATED-ORDERS LIST ANYWHERE
 * ------------------------------------------------------------------------- */

describe("there is no related-orders list left in the product", () => {
  const sources = (dir: string): string[] => {
    const path = join(ROOT, dir);
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sources(join(dir, entry.name))
        : /\.(ts|tsx)$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  };

  /** 6. Nothing renders it. */
  it("renders no Related customer orders section", () => {
    expect(panel).not.toMatch(/Related customer orders/i);
    expect(panel).not.toContain("RelatedCustomerOrders");
  });

  /** 7. The route, repository and type are gone, not merely unused. */
  it("leaves no dead route, repository or type behind", () => {
    expect(
      existsSync(join(ROOT, "app/api/conversations/[conversationId]/related-orders")),
    ).toBe(false);
    expect(existsSync(join(ROOT, "lib/repositories/related-order-repository.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "lib/domain/related-order.ts"))).toBe(false);

    const offenders = ["lib", "app", "components"]
      .flatMap(sources)
      .filter((file) => /related-order|RelatedOrdersResponse|RelatedCustomerOrder\b/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- *
 * 3, 8. WHAT THE PANEL SAYS
 * ------------------------------------------------------------------------- */

describe("the panel never implies the fallback is this message's order", () => {
  /** 3. The notice is not optional. */
  it("shows the mismatch notice against a fallback order", () => {
    expect(LISTING_MISMATCH_NOTICE).toBe("Order product differs from current message listing");
    expect(panel).toContain("{LISTING_MISMATCH_NOTICE}");
    const block = panel.slice(panel.indexOf("function FallbackCustomerOrderBlock"));
    expect(block.indexOf("LISTING_MISMATCH_NOTICE")).toBeGreaterThan(-1);
    // Rendered when the order is NOT for this listing.
    expect(block).toContain("!order.listingMatch");
  });

  it("uses a heading that claims nothing about the listing", () => {
    expect(CUSTOMER_ORDER_HEADING).toBe("Customer order");
    expect(NO_MATCHING_ORDER_TEXT).toBe("No matching order for this listing");
  });

  /** 8. Current listing remains, and remains independent of the order. */
  it("keeps the current listing section resolving without an order", () => {
    expect(panel).toContain("CURRENT_LISTING_HEADING");
    expect(panel).toContain("<CurrentListingSection");
    expect(panel.indexOf("CURRENT_LISTING_HEADING")).toBeLessThan(
      panel.indexOf("function FallbackCustomerOrderBlock"),
    );
  });

  /** The fallback shows no product field, because it has none. */
  it("renders no product or tracking detail for a fallback order", () => {
    const block = panel.slice(
      panel.indexOf("function FallbackCustomerOrderBlock"),
      panel.indexOf("function FallbackCustomerOrderBlock") + 2000,
    );
    expect(block).not.toMatch(/sku|product|tracking|carrier|address/i);
  });
});

/* ------------------------------------------------------------------------- *
 * 11, 12
 * ------------------------------------------------------------------------- */

describe("nothing was introduced that writes or sends", () => {
  it("adds no write to any source path", () => {
    for (const file of [repository, resolver]) {
      expect(file).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/);
    }
  });

  it("introduces no sending capability", () => {
    for (const file of [repository, resolver, panel]) {
      expect(file).not.toMatch(/\bsendMessage\b|\bsend_message\b|smtp|nodemailer/i);
    }
  });
});
