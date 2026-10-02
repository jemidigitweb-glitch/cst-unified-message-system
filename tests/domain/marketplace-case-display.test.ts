import { describe, expect, it } from "vitest";

import { CASE_SOURCE_TABLES, CASE_TYPES, CASE_LIFECYCLES } from "@/lib/domain/marketplace-case";
import {
  CASE_SNAPSHOT_STALE_AFTER_HOURS,
  caseCoverageFor,
  caseEmptyStateText,
  caseFactsFor,
  caseLifecycleLabel,
  caseNeedsAttention,
  caseSnapshotIsStale,
  caseTypeLabel,
  orderMatchCaveat,
  storesForMarketplace,
} from "@/lib/domain/marketplace-case-display";

/**
 * The display rules, which are where this feature can lie to a CST agent
 * without any test noticing. Each block below pins one claim the data does NOT
 * support, so making it would fail the build rather than ship.
 *
 * PURE. No database, no clock — `now` is passed in everywhere it is needed.
 */

function view(overrides: Partial<Parameters<typeof caseFactsFor>[0]> = {}) {
  return {
    lifecycle: "closed" as const,
    sourceStatus: null,
    sourceState: null,
    warehouseDisposition: null,
    sourceReason: null,
    sourceResolution: null,
    damageReported: false,
    replacementConfirmed: false,
    escalation: "not_recorded",
    sellerActionOwed: null,
    quantity: null,
    refundAmount: null,
    refundCurrency: null,
    ...overrides,
  };
}

function valueFor(facts: readonly { label: string; value: string }[], label: string) {
  return facts.find((fact) => fact.label === label)?.value;
}

describe("the store-to-marketplace map is derived, never retyped", () => {
  it("covers every store exactly once across the marketplaces", () => {
    const seen = ["ebay", "amazon", "shopify", "bandq", "temu"].flatMap((marketplace) =>
      storesForMarketplace(marketplace),
    );
    expect([...seen].sort()).toEqual([...CASE_SOURCE_TABLES].sort());
  });

  it("gives the marketplaces with no case source an empty list", () => {
    expect(storesForMarketplace("bandq")).toEqual([]);
    expect(storesForMarketplace("temu")).toEqual([]);
  });

  it("puts both Amazon stores under Amazon and both Shopify stores under Shopify", () => {
    expect([...storesForMarketplace("amazon")].sort()).toEqual([
      "amazon_returns",
      "amz_cancellations",
    ]);
    expect([...storesForMarketplace("shopify")].sort()).toEqual([
      "shopify_cancellations",
      "shopify_returns",
    ]);
  });
});

describe("coverage distinguishes never-imported from empty", () => {
  it("reports an unpublished store as never imported rather than as covered", () => {
    const coverage = caseCoverageFor(
      "ebay",
      new Map([
        ["ebay_returns", "2026-10-02 09:00:00+02"],
        ["cancellation", "2026-10-02 09:00:00+02"],
        ["inquiries", "2026-10-02 09:00:00+02"],
        ["cases", "2026-10-02 09:00:00+02"],
      ]),
    );
    expect(coverage.storesNeverImported).toEqual(["payment_disputes"]);
    expect(coverage.storesCovered).toHaveLength(4);
  });

  /**
   * THE OLDEST, NOT THE NEWEST. A run covering only the inquiry log would
   * otherwise make the return stores read as refreshed. Reporting the oldest
   * makes the timestamp a floor — every store is at least this current — which
   * is the only reading that cannot overstate the data.
   */
  it("reports the oldest covered store as the as-of time", () => {
    const coverage = caseCoverageFor(
      "amazon",
      new Map([
        ["amazon_returns", "2026-09-01 09:00:00+02"],
        ["amz_cancellations", "2026-10-02 09:00:00+02"],
      ]),
    );
    expect(coverage.asOf).toBe("2026-09-01 09:00:00+02");
  });

  it("reports nothing covered for a marketplace with no case source", () => {
    const coverage = caseCoverageFor("temu", new Map([["ebay_returns", "2026-10-02 09:00:00+02"]]));
    expect(coverage.storesCovered).toEqual([]);
    expect(coverage.storesNeverImported).toEqual([]);
    expect(coverage.asOf).toBeNull();
  });
});

describe("staleness", () => {
  const now = new Date("2026-10-03T12:00:00Z");

  it("marks a snapshot older than the window", () => {
    expect(caseSnapshotIsStale("2026-10-01T09:00:00Z", now)).toBe(true);
  });

  it("leaves a recent snapshot unmarked", () => {
    expect(caseSnapshotIsStale("2026-10-03T06:00:00Z", now)).toBe(false);
  });

  /**
   * NEVER IMPORTED IS NOT STALE. They are different states with different
   * wording, and borrowing one for the other would tell an agent that data
   * which has never existed is merely old.
   */
  it("does not call an absent snapshot stale", () => {
    expect(caseSnapshotIsStale(null, now)).toBe(false);
  });

  it("does not call an unparseable timestamp stale", () => {
    expect(caseSnapshotIsStale("not a date", now)).toBe(false);
  });

  it("uses a window measured in a day, because nothing schedules the import", () => {
    expect(CASE_SNAPSHOT_STALE_AFTER_HOURS).toBe(24);
  });
});

describe("the wording never asserts what the source does not", () => {
  it("has a label for every case type and every lifecycle", () => {
    for (const type of CASE_TYPES) expect(caseTypeLabel(type)).toBeTruthy();
    for (const lifecycle of CASE_LIFECYCLES) expect(caseLifecycleLabel(lifecycle)).toBeTruthy();
  });

  /**
   * A SHOPIFY REFUND IS NOT A RETURN REQUEST. Those 2,019 records hold a date,
   * an order, an amount and a currency and nothing else; calling them a return
   * would assert a case the source does not record.
   */
  it("calls a refund record a refund, never a return", () => {
    expect(caseTypeLabel("REFUND")).toBe("Refund recorded");
    expect(caseTypeLabel("REFUND").toLowerCase()).not.toContain("return");
  });

  /**
   * AN UNKNOWN LIFECYCLE IS NOT A CLOSED ONE. 14,436 of 21,022 cases are
   * unknown, overwhelmingly Amazon returns reading `Approved` — approved, and
   * not finished.
   */
  it("never words an unknown lifecycle as closed or as resolved", () => {
    const label = caseLifecycleLabel("unknown").toLowerCase();
    for (const forbidden of ["closed", "complete", "resolved", "finished", "no longer"]) {
      expect(label).not.toContain(forbidden);
    }
  });

  it("puts an unknown case in the prominent list, not behind the closed disclosure", () => {
    expect(caseNeedsAttention("unknown")).toBe(true);
    expect(caseNeedsAttention("active")).toBe(true);
    expect(caseNeedsAttention("closed")).toBe(false);
  });

  it("prints no stored identifier at a reviewer", () => {
    for (const type of CASE_TYPES) {
      expect(caseTypeLabel(type)).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });
});

describe("the facts under a case", () => {
  it("always states the case status, so an absent lifecycle cannot read as blank", () => {
    const facts = caseFactsFor(view({ lifecycle: "unknown" }));
    expect(valueFor(facts, "Case status")).toBe("Status not recorded");
  });

  /**
   * THE WAREHOUSE OUTCOME CANNOT REACH THE STATUS ROW. It is the Amazon
   * stockroom disposition — sellable, customer damaged, reimbursed — and the
   * label has to say in words that it is not where the customer's case stands,
   * because the values themselves read like outcomes.
   */
  it("labels a warehouse disposition as not a case status", () => {
    const facts = caseFactsFor(
      view({ warehouseDisposition: "Unit returned to inventory", lifecycle: "unknown" }),
    );
    expect(valueFor(facts, "Warehouse outcome (not a case status)")).toBe(
      "Unit returned to inventory",
    );
    expect(valueFor(facts, "Marketplace status")).toBeUndefined();
    expect(valueFor(facts, "Case status")).toBe("Status not recorded");
  });

  it("shows the marketplace's own status beside CST's reading, never instead of it", () => {
    const facts = caseFactsFor(view({ lifecycle: "active", sourceStatus: "READY_FOR_SHIPPING" }));
    expect(valueFor(facts, "Case status")).toBe("Open");
    expect(valueFor(facts, "Marketplace status")).toBe("READY_FOR_SHIPPING");
  });

  it("falls back to the source state where no status was recorded", () => {
    const facts = caseFactsFor(view({ sourceStatus: null, sourceState: "REFUND_INITIATED" }));
    expect(valueFor(facts, "Marketplace status")).toBe("REFUND_INITIATED");
  });

  /**
   * CONFIRMED REPLACEMENT COMES FROM ONE FIELD. The eBay action table attaches
   * "seller marked replacement shipped" to 51 returns and is an
   * available-actions snapshot rather than history; 0022 makes a confirmed
   * replacement unrepresentable outside the Amazon store, so this wording is
   * unreachable from an available action.
   */
  it("says a replacement is confirmed only when the flag is set", () => {
    expect(valueFor(caseFactsFor(view({ replacementConfirmed: true })), "Replacement")).toBe(
      "Confirmed by the marketplace",
    );
    expect(valueFor(caseFactsFor(view()), "Replacement")).toBeUndefined();
  });

  it("never claims a replacement was dispatched", () => {
    const facts = caseFactsFor(view({ replacementConfirmed: true }));
    const text = facts.map((f) => `${f.label} ${f.value}`).join(" ").toLowerCase();
    for (const forbidden of ["dispatched", "shipped", "sent", "on its way"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  /**
   * `not_recorded` IS NOT `not_escalated`, and neither is rendered. Six of the
   * nine stores have no escalation signal at all, so silence is the truthful
   * rendering of a signal that was never collected.
   */
  it("renders only a positive escalation", () => {
    expect(valueFor(caseFactsFor(view({ escalation: "escalated" })), "Escalation")).toBe(
      "Escalated at the marketplace",
    );
    expect(valueFor(caseFactsFor(view({ escalation: "not_escalated" })), "Escalation")).toBeUndefined();
    expect(valueFor(caseFactsFor(view({ escalation: "not_recorded" })), "Escalation")).toBeUndefined();
  });

  it("keeps an escalated closed case both escalated and closed", () => {
    const facts = caseFactsFor(view({ lifecycle: "closed", escalation: "escalated" }));
    expect(valueFor(facts, "Case status")).toBe("Closed");
    expect(valueFor(facts, "Escalation")).toBe("Escalated at the marketplace");
  });

  it("omits a field the source never recorded rather than standing in for it", () => {
    const facts = caseFactsFor(view());
    for (const fact of facts) {
      expect(fact.value).not.toMatch(/^(N\/A|Unknown|-|—|null)$/i);
    }
    expect(valueFor(facts, "Reason given")).toBeUndefined();
    expect(valueFor(facts, "Refund recorded")).toBeUndefined();
  });

  /** 0022 refuses to store an amount without a currency; neither is shown alone. */
  it("renders a refund only as an amount with its currency", () => {
    expect(valueFor(caseFactsFor(view({ refundAmount: "12.34", refundCurrency: "GBP" })), "Refund recorded")).toBe(
      "12.34 GBP",
    );
    expect(
      valueFor(caseFactsFor(view({ refundAmount: "12.34", refundCurrency: null })), "Refund recorded"),
    ).toBeUndefined();
  });
});

describe("an unverified order match is never presented as an exact one", () => {
  it("says nothing extra where the order was verified", () => {
    expect(orderMatchCaveat("source_order_id_verified")).toBeNull();
  });

  it("qualifies a reference the marketplace recorded but nothing here matched", () => {
    expect(orderMatchCaveat("source_order_id_unverified")).toMatch(/not matched to an order here/);
  });

  it("says when this application derived the order rather than reading one", () => {
    expect(orderMatchCaveat("item_transaction")).toMatch(/item and transaction references/);
  });

  it("says when the source recorded no order at all", () => {
    expect(orderMatchCaveat("unmatched")).toMatch(/No order reference recorded/);
  });
});

describe("the empty states are four different sentences", () => {
  it("never says there are no cases when the lookup failed", () => {
    const text = caseEmptyStateText("unavailable", { hasNeverImportedStore: false }) ?? "";
    expect(text).toMatch(/could not be checked/);
    expect(text.toLowerCase()).not.toMatch(/no cases|no marketplace cases/);
  });

  it("never says there are no cases when nothing was ever imported", () => {
    const text = caseEmptyStateText("never_imported", { hasNeverImportedStore: true }) ?? "";
    expect(text).toMatch(/have not been imported/);
    expect(text.toLowerCase()).not.toMatch(/no cases found/);
  });

  it("says no search was possible when there is no order and no customer", () => {
    const text = caseEmptyStateText("no_search_key", { hasNeverImportedStore: false }) ?? "";
    expect(text).toMatch(/could not be matched/);
  });

  /**
   * THE ONLY STATE THAT IS EVIDENCE OF ABSENCE — and even here, a store that
   * has never been imported downgrades it from an answer to a partial one.
   */
  it("claims an absence only from a complete published snapshot", () => {
    expect(caseEmptyStateText("none_found", { hasNeverImportedStore: false })).toBe(
      "No marketplace cases recorded for this order or customer.",
    );
    const partial = caseEmptyStateText("none_found", { hasNeverImportedStore: true }) ?? "";
    expect(partial).toMatch(/not a complete answer/);
  });

  it("says nothing at all when cases are on screen", () => {
    expect(caseEmptyStateText("found", { hasNeverImportedStore: false })).toBeNull();
  });
});
