import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ORDER_SELECTION_KEY_PREFIX,
  type StorageLike,
  orderSelectionKey,
  readStoredSelection,
  restorableSelection,
  saveStoredSelection,
} from "@/lib/domain/order-selection-storage";

/**
 * ONE SELECTION MODEL, TWO FLOWS.
 *
 * An ambiguous conversation and a `no_order` one are chosen from different
 * lists — the matcher's candidates and the buyer's eligible orders — but the
 * choice itself must be remembered, restored, revalidated and changed in
 * exactly one way. Two mechanisms would eventually disagree about which order a
 * draft was grounded in, and the disagreement would be invisible.
 *
 * The property that must NOT hold: restoring is not selecting. A conversation
 * nobody has ever chosen for stays unchosen.
 *
 * Structural assertions read from source; this suite configures no DOM.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const panel = read("components", "context-panel.tsx");
const route = read(
  "app", "api", "conversations", "[conversationId]", "order-context", "route.ts",
);
const selected = read("lib", "context", "resolve-selected-order-context.ts");

/** An in-memory store, so the shared helpers can be exercised for real. */
function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const storage: StorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
  return { data, storage };
}

const AMBIGUOUS_PICK = "20-00000-00001";
const MANUAL_PICK = "20-00000-00007";

/* ------------------------------------------------------------------------- *
 * ONE MECHANISM
 * ------------------------------------------------------------------------- */

describe("both flows share one selection mechanism", () => {
  /** 2, 5, 8, 9. Choosing and re-choosing works identically for either list. */
  it("remembers and replaces a choice the same way for both", () => {
    const { storage } = memoryStorage();

    saveStoredSelection(storage, "ambiguous-conv", AMBIGUOUS_PICK);
    saveStoredSelection(storage, "no-order-conv", MANUAL_PICK);
    expect(readStoredSelection(storage, "ambiguous-conv")).toBe(AMBIGUOUS_PICK);
    expect(readStoredSelection(storage, "no-order-conv")).toBe(MANUAL_PICK);

    // Changing a choice replaces it rather than accumulating.
    saveStoredSelection(storage, "no-order-conv", "20-00000-00008");
    expect(readStoredSelection(storage, "no-order-conv")).toBe("20-00000-00008");

    // Clearing forgets it.
    saveStoredSelection(storage, "no-order-conv", null);
    expect(readStoredSelection(storage, "no-order-conv")).toBeNull();
    // ...and the other conversation is untouched throughout.
    expect(readStoredSelection(storage, "ambiguous-conv")).toBe(AMBIGUOUS_PICK);
  });

  /** 10. A selection belongs to one conversation, by key construction. */
  it("cannot leak a selection between conversations", () => {
    const { data, storage } = memoryStorage();
    saveStoredSelection(storage, "conv-a", AMBIGUOUS_PICK);
    expect(readStoredSelection(storage, "conv-b")).toBeNull();
    expect(orderSelectionKey("conv-a")).toBe(`${ORDER_SELECTION_KEY_PREFIX}conv-a`);
    expect(orderSelectionKey("conv-a")).not.toBe(orderSelectionKey("conv-b"));
    expect([...data.keys()]).toEqual([orderSelectionKey("conv-a")]);
  });

  /** The panel uses the shared helpers, not a second store of its own. */
  it("keeps one storage implementation", () => {
    expect(panel).toContain("browserOrderSelectionStorage()");
    expect(panel).toContain("readStoredSelection");
    expect(panel).toContain("saveStoredSelection");
    expect(panel).toContain("restorableSelection");
    // No hand-rolled localStorage access anywhere in the panel.
    expect(panel).not.toMatch(/localStorage\.(?:get|set|remove)Item/);
    // One save path, used by both flows.
    expect(panel.match(/saveStoredSelection\(/g) ?? []).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- *
 * RESTORING IS NOT SELECTING
 * ------------------------------------------------------------------------- */

describe("a conversation nobody chose for stays unchosen", () => {
  /** 1, 4. Nothing stored, nothing restored — for either flow. */
  it("restores nothing when there was never a selection", () => {
    const { storage } = memoryStorage();
    expect(readStoredSelection(storage, "fresh-conv")).toBeNull();
    expect(restorableSelection(null, [AMBIGUOUS_PICK, MANUAL_PICK])).toBeNull();
  });

  /** The restore effect bails before doing anything when nothing is stored. */
  it("bails out of the restore path with no stored value", () => {
    const restore = panel.slice(panel.indexOf("const stored = readStoredSelection"));
    expect(restore.slice(0, 200)).toContain("if (stored === null) return");
  });

  /** No list position is ever turned into a choice. */
  it("picks no order by position", () => {
    expect(panel).not.toMatch(/eligibleOrders\[0\]|orders\[0\]|\.at\(0\)/);
    expect(route).not.toMatch(/eligibleOrders\[0\]/);
  });
});

/* ------------------------------------------------------------------------- *
 * RESTORING, FOR BOTH LISTS
 * ------------------------------------------------------------------------- */

describe("a previous choice is restored on reopen", () => {
  /**
   * 3, 6. The stored number is validated against BOTH lists. Before a manual
   * choice resolves it appears only in `eligibleOrders`; once resolved it
   * appears in `orders`. Checking one alone dropped a manual selection on every
   * reopen, which is precisely the divergence this task removes.
   */
  it("accepts a choice from either list", () => {
    expect(restorableSelection(AMBIGUOUS_PICK, [AMBIGUOUS_PICK])).toBe(AMBIGUOUS_PICK);
    expect(restorableSelection(MANUAL_PICK, [MANUAL_PICK])).toBe(MANUAL_PICK);
  });

  it("reads both lists when restoring", () => {
    const restore = panel.slice(panel.indexOf("const available = ["));
    expect(restore.slice(0, 300)).toContain("context.orders.map");
    expect(restore.slice(0, 300)).toContain("context.eligibleOrders.map");
  });

  /** A stale choice is discarded rather than silently swapped for another. */
  it("discards a stored order that is in neither list", () => {
    expect(restorableSelection("20-00000-00404", [AMBIGUOUS_PICK, MANUAL_PICK])).toBeNull();
  });

  it("forgets a stale choice instead of leaving it to reappear", () => {
    const restore = panel.slice(panel.indexOf("const restorable = restorableSelection"));
    expect(restore.slice(0, 260)).toContain("saveStoredSelection(storage, conversationId, null)");
  });
});

/* ------------------------------------------------------------------------- *
 * THE CONTROL STAYS ON SCREEN
 * ------------------------------------------------------------------------- */

describe("the chooser behaves the same after choosing, in both flows", () => {
  /**
   * 7. The restored order shows as ticked, and the list is still there to
   * change. `eligibleOrders` is therefore loaded for every `no_order`
   * conversation, not only an unchosen one.
   */
  it("keeps the eligible list after a choice has resolved", () => {
    expect(route).toContain('if (resolution === "no_order") {');
    const load = route.slice(route.indexOf('if (resolution === "no_order") {'));
    expect(load.slice(0, 200)).not.toContain("facts.length === 0");
  });

  it("renders the chooser alongside the resolved order", () => {
    // Present in the resolved branch, above the order blocks.
    const resolved = panel.slice(panel.indexOf("const selectable = orders.length > 1"));
    expect(resolved).toContain("<SelectCustomerOrder");
    expect(resolved.indexOf("<SelectCustomerOrder")).toBeLessThan(resolved.indexOf("{list}"));
  });

  /** Selected state is driven by the same comparison in both flows. */
  it("marks the chosen order selected by the same rule", () => {
    expect(panel).toContain("checked={selectedOrderNumber === order.orderNumber}");
    expect(panel.match(/checked=\{selectedOrderNumber === order\.orderNumber\}/g) ?? [])
      .toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- *
 * THE SERVER STILL DECIDES
 * ------------------------------------------------------------------------- */

describe("a restored choice is revalidated server-side", () => {
  /**
   * 11, 12, 13. The browser's memory is a convenience, never an authority. A
   * restored number is re-checked against the orders this buyer actually has on
   * this storefront, so a stored value that has become someone else's order, or
   * an order on another storefront, produces no facts at all.
   */
  it("re-matches the number against the server's own list", () => {
    expect(selected).toContain("listEligibleCustomerOrders");
    expect(selected).toContain("eligible.filter((order) => order.orderNumber === selectedOrderNumber)");
    expect(selected).toContain("if (matches.length !== 1) return []");
    // ...and the ambiguous path keeps its own re-match, unchanged.
    expect(selected).toContain("findCandidateEbayOrders");
    expect(selected).toContain("candidates.filter((order) => order.orderNumber === selectedOrderNumber)");
  });

  it("scopes that list to the exact buyer and storefront", () => {
    const repository = read("lib", "repositories", "customer-order-fallback-repository.ts");
    const list = repository.slice(repository.indexOf("const LIST_ELIGIBLE_ORDERS"));
    expect(list).toContain("ss.source_id = $1::int");
    expect(list).toContain("o.sub_source_id = $2::int");
    expect(list).toContain("ci.ebay_buyer_id = $3");
    expect(list).not.toMatch(/lower\s*\(\s*ci\.ebay_buyer_id/i);
  });

  /** 20. Nothing on the restore path writes anywhere. */
  it("writes nothing to restore a selection", () => {
    expect(selected).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(route).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
  });
});

/* ------------------------------------------------------------------------- *
 * 16, 17, 19, 21
 * ------------------------------------------------------------------------- */

describe("the rest of the pipeline is unchanged", () => {
  /** Draft and Regenerate both carry the selection, restored or fresh. */
  it("sends the selection with every generation", () => {
    const draftPanel = read("components", "draft-panel.tsx");
    expect(draftPanel).toContain('params.set("selectedOrder"');
    // Regenerate adds force=1 and keeps the same parameter builder.
    expect(draftPanel).toContain("force=1");
  });

  it("leaves the strict matcher alone", () => {
    const matcher = read("lib", "repositories", "order-context-repository.ts");
    expect(matcher).toContain("AND oii.item_id = $3");
    expect(matcher).toContain("AND ci.ebay_buyer_id = $4");
    expect(matcher).not.toMatch(/eligible|restore/i);
  });

  it("introduces no sending capability", () => {
    for (const file of [panel, route, selected]) {
      expect(file).not.toMatch(/\bsendMessage\b|smtp|nodemailer/i);
    }
  });
});
