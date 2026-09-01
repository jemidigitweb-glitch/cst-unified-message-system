import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveVerifiedTracking } from "@/lib/context/resolve-tracking-context";
import type { VerifiedFact } from "@/lib/domain/draft";

/**
 * One choice, one shipment — and nothing at all until the choice is made.
 *
 * THE FAILURE THIS PREVENTS. A conversation whose buyer bought the same listing
 * three times matches three genuine orders, each with its own parcel. Showing a
 * reviewer "your item was delivered on the 28th" before they have said WHICH
 * order they mean is a confident statement about, at best, a one-in-three
 * guess — and it would be read as settled.
 *
 * WHERE THE GUARANTEE ACTUALLY LIVES, which is why most of this file asserts on
 * the backend rather than the component: everything downstream keys off
 * `facts`, and `resolveEbayOrderContext` returns an EMPTY LIST for an ambiguous
 * conversation. No facts, no tracking number, no lookup. The panel cannot show
 * a shipment it was never sent, and the model cannot state one it was never
 * given. The UI is the last line here, not the first.
 *
 * Asserted against source for the interface, matching the rest of this suite:
 * no DOM environment is configured, and what matters is structural.
 */

const ROOT = join(__dirname, "..", "..");

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const panel = read("components", "context-panel.tsx");
const orderRoute = read("app", "api", "conversations", "[conversationId]", "order-context", "route.ts");
const draftRoute = read("app", "api", "conversations", "[conversationId]", "draft", "route.ts");
const resolver = read("lib", "context", "resolve-order-context.ts");

/* ---------------------------------------------------------------- UI ---- */

describe("the order context disclosure", () => {
  /** 1. A single match needs no control: there was never a choice to make. */
  it("renders a single order without a disclosure", () => {
    // The non-selectable branch is a plain div with the heading and the list.
    expect(panel).toMatch(/selectable \? \(/);
    expect(panel).toMatch(/\) : \(\s*<div className="flex flex-col gap-2">\s*<SectionHeading>Order context<\/SectionHeading>/);
  });

  /** 2 and 3. Several candidates get one, and it holds the same list. */
  it("wraps several candidates in a disclosure over the same list", () => {
    expect(panel).toContain("<details open={selectedOrderNumber === null}");
    expect(panel).toContain("<summary");
    // ONE list, shared by both branches — there is no second, thinner layout
    // for the multi-match case, which is a property the sidebar already pins.
    expect(panel.match(/const list = \(/g)).toHaveLength(1);
    expect(panel.match(/\{list\}/g)).toHaveLength(2);
  });

  /**
   * 4. Collapsed once a choice exists, expanded while none does. The panel's
   * job before a choice is to get one made; hiding the candidates would bury
   * the action that unblocks tracking.
   */
  it("opens while nothing is chosen and closes once something is", () => {
    expect(panel).toContain("open={selectedOrderNumber === null}");
  });

  /** 5. The choice stays legible on the control after collapsing. */
  it("names the chosen order on the collapsed control", () => {
    expect(panel).toMatch(/Order \$\{selectedOrderNumber\} selected/);
  });
});

/* ---------------------------------------------------- tracking flow ---- */

describe("tracking waits for the choice", () => {
  /** 6. A single match is unchanged: facts exist, so tracking resolves. */
  it("leaves a single-order conversation exactly as it was", () => {
    // The resolver returns the eight facts for one candidate; nothing in the
    // route conditions tracking on a selection.
    expect(orderRoute).toContain("resolveVerifiedTracking({ facts })");
    expect(orderRoute).not.toMatch(/if \(selectedOrderNumber[^)]*\)\s*\{?\s*.*resolveVerifiedTracking/);
  });

  /**
   * 7. THE LOAD-BEARING ONE. An ambiguous conversation resolves to no facts,
   * and no facts is no tracking — asserted against the real resolver rather
   * than against a comment about it.
   */
  it("produces no tracking at all without verified order facts", async () => {
    const context = await resolveVerifiedTracking({ facts: [] });
    expect(context.tracking).toBeNull();
    expect(context.tracking === null && context.reason).toBe("no_tracking_number");
  });

  it("returns an empty fact list for an ambiguous conversation", () => {
    // `saveAmbiguousSnapshot(...)` then `return []` — the candidates are
    // recorded for display and none of them becomes a fact.
    const ambiguous = resolver.slice(resolver.indexOf("if (candidates.length > 1)"));
    expect(ambiguous.slice(0, ambiguous.indexOf("}"))).toContain("saveAmbiguousSnapshot");
    expect(ambiguous).toMatch(/saveAmbiguousSnapshot[\s\S]{0,400}?return \[\];/);
  });

  /** 8 and 9. The choice reaches the backend, which resolves that order only. */
  it("sends the chosen order to the route and refetches on a change", () => {
    expect(panel).toContain("selectedOrder=${encodeURIComponent(selectedOrderNumber)}");
    expect(panel).toContain("[conversationId, selectedOrderNumber]");
  });

  it("resolves the chosen order through the checked path, never the query string", () => {
    expect(orderRoute).toContain("resolveSelectedOrderContext");
    // `resolveSelectedOrderContext` re-checks the number against the orders the
    // conversation actually matched, so a request naming any other order gets
    // nothing back.
    expect(orderRoute).toContain('searchParams.get("selectedOrder")');
  });

  /**
   * 10. NEVER ONE OF SEVERAL. The resolver speaks first — the guard is
   * `facts.length === 0` — so a conversation that resolved on its own evidence
   * cannot be overridden, and an ambiguous one takes the selection or nothing.
   * No first, no newest, no likeliest.
   */
  it("never picks an order for the reviewer", () => {
    expect(orderRoute).toContain("facts.length === 0 && selectedOrderNumber !== null");
    for (const forbidden of ["orders[0]", "candidates[0]", "\\.at\\(-1\\)", "mostRecent", "bestMatch"]) {
      expect(orderRoute, forbidden).not.toMatch(new RegExp(forbidden));
    }
    // The panel preselects nothing either.
    expect(panel).not.toMatch(/defaultChecked|checked=\{true\}/);
  });
});

/* ---------------------------------------------------------- AI path ---- */

describe("what the model is given", () => {
  /**
   * 11. No selection, no facts, no tracking — the same empty list the draft
   * route has always handled, reached before any model call.
   */
  it("passes no ambiguous tracking to the draft", () => {
    // The draft resolves tracking FROM the facts, so an empty fact list is an
    // empty tracking context by construction.
    expect(draftRoute).toContain("resolveVerifiedTracking({ facts })");
  });

  /** 12. With a selection, the draft resolves that order and only that order. */
  it("passes only the chosen order's context to the draft", () => {
    expect(draftRoute).toContain("resolveSelectedOrderContext");
    expect(draftRoute).toContain("orderFacts.length === 0 && selectedOrderNumber !== null");
  });

  /**
   * ONE CHOICE, ONE ANSWER. Both routes apply the same precedence, so the
   * sidebar and the draft can never disagree about which order is in play —
   * which is the state this change existed to remove.
   */
  it("applies the same precedence in both routes", () => {
    for (const route of [orderRoute, draftRoute]) {
      expect(route).toContain("resolveSelectedOrderContext");
      expect(route).toMatch(/length === 0 && selectedOrderNumber !== null/);
    }
  });
});
