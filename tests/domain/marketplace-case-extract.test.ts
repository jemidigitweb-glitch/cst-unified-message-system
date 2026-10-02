import { describe, expect, it } from "vitest";

import {
  CASE_SOURCE_TABLES,
  CASE_TYPES,
  type CaseSourceTable,
  caseRejectionSummary,
  caseTypeFor,
  damageReportedBy,
  escalationFor,
  lifecycleFor,
  marketplaceFor,
  replacementConfirmedBy,
} from "@/lib/domain/marketplace-case";
import {
  type OrderResolution,
  type SourceCaseEvent,
  caseKeyOf,
  collapseCaseEvents,
  coverageInconsistencies,
  destinationInvariantViolations,
  orderLookupRequests,
  resolveOrderFor,
} from "@/lib/domain/marketplace-case-extract";

/**
 * The case extraction rules, tested with SYNTHETIC fixtures only.
 *
 * Every identifier below is obviously invented — `99-99999-99999` order numbers,
 * `synthetic-buyer-*` handles, repeated-digit item ids — because
 * `tests/guards/no-customer-data.test.ts` scans every tracked file and has
 * already caught a real order number committed into four fixtures.
 *
 * The scenarios are the ones the source actually produces, each measured during
 * discovery and named in the comment above it. A test here that passes on a
 * fixture nobody measured proves nothing.
 */

const EBAY_STOREFRONT = 21;
const AMAZON_STOREFRONT = 8;
const SHOPIFY_STOREFRONT = 104;
const VERIFIED_EBAY = new Set([EBAY_STOREFRONT, 22]);

/** A source event with every field absent, so a test states only what it means. */
function event(overrides: Partial<SourceCaseEvent> & { sourceTable: CaseSourceTable }): SourceCaseEvent {
  return {
    caseId: "1000000001",
    eventSeq: 0,
    rowId: "1",
    subSource: EBAY_STOREFRONT,
    orderRef: null,
    itemRef: null,
    txnRef: null,
    counterpartyRef: null,
    caseTypeRaw: null,
    status: null,
    state: null,
    resolution: null,
    reason: null,
    reasonFamily: null,
    fulfilment: null,
    disposition: null,
    isCase: null,
    escDate: null,
    buyerEsc: null,
    sellerEsc: null,
    azClaim: null,
    sellerActionOwed: null,
    sellerActionDueAt: null,
    quantity: null,
    refundAmount: null,
    refundCurrency: null,
    openedAt: "2026-05-01 09:00:00",
    closedAt: null,
    sourceUpdatedAt: null,
    ...overrides,
  };
}

/**
 * Resolutions are supplied as (store, case id, resolution) triples and keyed with
 * `caseKeyOf`, not by the bare id. The id spaces overlap across stores, and the
 * test below that passes id 123 in two stores is what proved keying on the id
 * alone merges two different cases.
 */
function collapse(
  rows: readonly SourceCaseEvent[],
  resolutions: ReadonlyArray<readonly [CaseSourceTable, string, OrderResolution]> = [],
  options: { superseded?: ReadonlySet<string>; verified?: ReadonlySet<number> } = {},
) {
  return collapseCaseEvents(rows, {
    verifiedSubSources: options.verified ?? VERIFIED_EBAY,
    supersededCaseIds: options.superseded,
    orderResolutions: new Map(
      resolutions.map(([store, caseId, resolution]) => [caseKeyOf(store, caseId), resolution]),
    ),
  });
}

const VERIFIED = (orderRef: string): OrderResolution => ({
  method: "source_order_id_verified",
  orderRef,
});

// ===========================================================================
describe("1 — a normal eBay return import", () => {
  /**
   * The shape the source actually has: a header row carrying every case-level
   * fact, and event rows carrying none. Measured: 4,427 header rows of 42,931.
   */
  const rows = [
    event({
      sourceTable: "ebay_returns",
      caseId: "5289490057",
      eventSeq: 0,
      rowId: "427",
      orderRef: "99-99999-99991",
      itemRef: "1111111111",
      txnRef: "2222333344441",
      status: "CLOSED",
      state: "CLOSED",
      resolution: "MONEY_BACK",
      reason: "WRONG_SIZE",
      reasonFamily: "REMORSE",
      buyerEsc: 0,
      sellerEsc: 0,
      sellerActionOwed: "SELLER_ISSUE_REFUND",
      sellerActionDueAt: "2026-05-10 09:00:00",
      quantity: 1,
      refundAmount: "24.99",
      refundCurrency: "GBP",
      openedAt: "2026-05-01 09:00:00",
      sourceUpdatedAt: "2026-05-11 10:00:00",
    }),
    // Event rows: no status, no state, no reason. The status trap in miniature.
    event({
      sourceTable: "ebay_returns",
      caseId: "5289490057",
      eventSeq: 3,
      rowId: "428",
      orderRef: "99-99999-99991",
      openedAt: "2026-05-04 11:00:00",
    }),
  ];

  it("produces one record per case, not one per event", () => {
    const { records, rejections } = collapse(rows, [["ebay_returns", "5289490057", VERIFIED("99-99999-99991")]]);
    expect(records).toHaveLength(1);
    expect(rejections).toEqual([]);
    expect(records[0]!.sourceRowCount).toBe(2);
  });

  it("preserves the source case id exactly, as text", () => {
    const { records } = collapse(rows, [["ebay_returns", "5289490057", VERIFIED("99-99999-99991")]]);
    expect(records[0]!.sourceCaseId).toBe("5289490057");
    expect(typeof records[0]!.sourceCaseId).toBe("string");
  });

  it("takes every preserved value from the newest NON-NULL row, not the newest row", () => {
    // The newest row by (eventSeq, rowId) is the event row, which carries no
    // status at all. A plain "latest row wins" collapse would store NULL here —
    // the trap 0021 documented and the eBay return store repeats.
    const { records } = collapse(rows, [["ebay_returns", "5289490057", VERIFIED("99-99999-99991")]]);
    expect(records[0]!.sourceStatus).toBe("CLOSED");
    expect(records[0]!.sourceReason).toBe("WRONG_SIZE");
    expect(records[0]!.sellerActionOwed).toBe("SELLER_ISSUE_REFUND");
  });

  it("takes opened_at as the EARLIEST date, so an old case cannot read as recent", () => {
    const { records } = collapse(rows, [["ebay_returns", "5289490057", VERIFIED("99-99999-99991")]]);
    expect(records[0]!.openedAt).toBe("2026-05-01 09:00:00");
  });

  it("carries the verified order and the method that established it", () => {
    const { records } = collapse(rows, [["ebay_returns", "5289490057", VERIFIED("99-99999-99991")]]);
    expect(records[0]!.orderRef).toBe("99-99999-99991");
    expect(records[0]!.orderMatchMethod).toBe("source_order_id_verified");
  });

  it("records no customer, because this store has no buyer column", () => {
    const { records } = collapse(rows, [["ebay_returns", "5289490057", VERIFIED("99-99999-99991")]]);
    expect(records[0]!.counterpartyRef).toBeNull();
  });
});

// ===========================================================================
describe("2 — INR exact-order matching through item + transaction", () => {
  /**
   * The two inquiry logs carry NO order id — 0 of 8,054 and 0 of 1,038 — but both
   * parts of the marketplace line key on 100% of rows. Measured: 1,182 of 1,189
   * cases resolve to exactly one order, 0 to several.
   */
  const inquiry = [
    event({
      sourceTable: "inquiries",
      caseId: "7000000001",
      eventSeq: 0,
      rowId: "10",
      itemRef: "1111111111",
      txnRef: "2222333344441",
      counterpartyRef: "synthetic-buyer-1",
      caseTypeRaw: "ITEM_NOT_RECEIVED",
      status: "CLOSED",
      isCase: 1,
      openedAt: "2026-03-01 08:00:00",
    }),
    event({
      sourceTable: "inquiries",
      caseId: "7000000001",
      eventSeq: 4,
      rowId: "11",
      itemRef: "1111111111",
      txnRef: "2222333344441",
      counterpartyRef: "synthetic-buyer-1",
      openedAt: "2026-03-05 08:00:00",
    }),
  ];

  it("asks for a derived lookup, never a source order reference", () => {
    const requests = orderLookupRequests(inquiry);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.sourceOrderRef).toBeNull();
    expect(requests[0]!.itemRef).toBe("1111111111");
    expect(requests[0]!.txnRef).toBe("2222333344441");
    expect(requests[0]!.subSourceId).toBe(EBAY_STOREFRONT);
  });

  it("resolves exactly one order to item_transaction", () => {
    const { resolution, ambiguous } = resolveOrderFor({
      sourceOrderRef: null,
      sourceOrderVerified: false,
      matchedOrderRefs: ["99-99999-99992"],
    });
    expect(resolution).toEqual({ method: "item_transaction", orderRef: "99-99999-99992" });
    expect(ambiguous).toBe(false);
  });

  it("stores the derived reference and the method that derived it", () => {
    const { records } = collapse(inquiry, [
      ["inquiries", "7000000001", { method: "item_transaction", orderRef: "99-99999-99992" }],
    ]);
    expect(records[0]!.caseType).toBe("ITEM_NOT_RECEIVED");
    expect(records[0]!.orderRef).toBe("99-99999-99992");
    expect(records[0]!.orderMatchMethod).toBe("item_transaction");
    expect(records[0]!.counterpartyRef).toBe("synthetic-buyer-1");
    expect(records[0]!.escalation).toBe("escalated");
  });
});

// ===========================================================================
describe("3 — an unmatched INR case", () => {
  /** Measured: 7 of 1,189 cases resolve to no order at all. */
  it("resolves to unmatched when the line key names no order", () => {
    const { resolution, ambiguous } = resolveOrderFor({
      sourceOrderRef: null,
      sourceOrderVerified: false,
      matchedOrderRefs: [],
    });
    expect(resolution).toEqual({ method: "unmatched" });
    expect(ambiguous).toBe(false);
  });

  it("stores the case with no order reference rather than dropping it", () => {
    const { records, rejections } = collapse([
      event({
        sourceTable: "inquiries",
        caseId: "7000000002",
        itemRef: "1111111112",
        txnRef: "2222333344442",
        counterpartyRef: "synthetic-buyer-2",
        caseTypeRaw: "ITEM_NOT_RECEIVED",
        status: "OPEN",
      }),
    ]);
    expect(rejections).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]!.orderRef).toBeNull();
    expect(records[0]!.orderMatchMethod).toBe("unmatched");
  });

  /** 0022's biconditional: unmatched IS no reference, in both directions. */
  it("never carries an order reference while reporting unmatched", () => {
    const { records } = collapse([
      event({ sourceTable: "inquiries", caseId: "7000000003", caseTypeRaw: "RETURN", status: "CLOSED" }),
    ]);
    expect(records[0]!.orderMatchMethod).toBe("unmatched");
    expect(records[0]!.orderRef).toBeNull();
  });
});

// ===========================================================================
describe("4 — ambiguous order matching is never resolved automatically", () => {
  /**
   * 2 of the 364,467 measured line keys collide, so "exactly one" is a property
   * to check rather than assume. Choosing between two real orders is the guess
   * this codebase rejects.
   */
  it("refuses on several distinct matches and reports the ambiguity", () => {
    const { resolution, ambiguous } = resolveOrderFor({
      sourceOrderRef: null,
      sourceOrderVerified: false,
      matchedOrderRefs: ["99-99999-99993", "99-99999-99994"],
    });
    expect(resolution).toEqual({ method: "unmatched" });
    expect(ambiguous).toBe(true);
  });

  it("does not call the same order twice an ambiguity", () => {
    const { resolution, ambiguous } = resolveOrderFor({
      sourceOrderRef: null,
      sourceOrderVerified: false,
      matchedOrderRefs: ["99-99999-99995", "99-99999-99995", " 99-99999-99995 "],
    });
    expect(resolution).toEqual({ method: "item_transaction", orderRef: "99-99999-99995" });
    expect(ambiguous).toBe(false);
  });

  /**
   * A source-recorded reference wins outright, and `verified` only describes
   * whether an order row was found for it. The Amazon return store has 16% that
   * find none, and saying so is different from saying nothing was recorded.
   */
  it("prefers a source-recorded reference, marking it verified or not", () => {
    expect(
      resolveOrderFor({
        sourceOrderRef: "99-99999-99996",
        sourceOrderVerified: true,
        matchedOrderRefs: ["99-99999-99997"],
      }).resolution,
    ).toEqual({ method: "source_order_id_verified", orderRef: "99-99999-99996" });

    expect(
      resolveOrderFor({
        sourceOrderRef: "99-99999-99996",
        sourceOrderVerified: false,
        matchedOrderRefs: [],
      }).resolution,
    ).toEqual({ method: "source_order_id_unverified", orderRef: "99-99999-99996" });
  });
});

// ===========================================================================
describe("5 — duplicate case events collapse to one record", () => {
  /**
   * Header rows are re-snapshotted at source: 195 returns have two and 75 have
   * three. Sampled duplicates were byte-identical; the 12 that disagreed had the
   * newest row by id carrying the later state.
   */
  it("keeps the newest header by id when two disagree", () => {
    const { records } = collapse([
      event({
        sourceTable: "ebay_returns",
        caseId: "5289490058",
        eventSeq: 0,
        rowId: "427",
        state: "ITEM_READY_TO_SHIP",
        status: "READY_FOR_SHIPPING",
        buyerEsc: 0,
        sellerEsc: 0,
      }),
      event({
        sourceTable: "ebay_returns",
        caseId: "5289490058",
        eventSeq: 0,
        rowId: "1453",
        state: "CLOSED",
        status: "CLOSED",
        buyerEsc: 0,
        sellerEsc: 0,
      }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]!.sourceStatus).toBe("CLOSED");
    expect(records[0]!.lifecycle).toBe("closed");
    expect(records[0]!.sourceRowCount).toBe(2);
  });

  /** A 7-digit id must not sort above a 10-digit one. */
  it("compares bigint row ids by length then lexically", () => {
    const { records } = collapse([
      event({ sourceTable: "ebay_returns", caseId: "9", eventSeq: 0, rowId: "9999999", state: "CLOSED", status: "CLOSED", buyerEsc: 0, sellerEsc: 0 }),
      event({ sourceTable: "ebay_returns", caseId: "9", eventSeq: 0, rowId: "1000000000", state: "ITEM_SHIPPED", status: "ITEM_SHIPPED", buyerEsc: 0, sellerEsc: 0 }),
    ]);
    expect(records[0]!.sourceStatus).toBe("ITEM_SHIPPED");
  });

  /** A null sequence sorts OLDEST, so it cannot displace a row that has one. */
  it("sorts a null event sequence oldest", () => {
    const { records } = collapse([
      event({ sourceTable: "payment_disputes", caseId: "5000000001", eventSeq: null, rowId: "1", status: "OPEN", orderRef: "99-99999-99998", counterpartyRef: "synthetic-buyer-3" }),
      event({ sourceTable: "payment_disputes", caseId: "5000000001", eventSeq: 3, rowId: "2", status: "CLOSED", orderRef: "99-99999-99998", counterpartyRef: "synthetic-buyer-3" }),
    ], [["payment_disputes", "5000000001", VERIFIED("99-99999-99998")]]);
    expect(records[0]!.sourceStatus).toBe("CLOSED");
    expect(records[0]!.lifecycle).toBe("closed");
  });
});

// ===========================================================================
describe("6 — two stores sharing a case id space", () => {
  /**
   * 69 of the formal-case store's 127 ids are the same CASES as inquiry rows,
   * measured as agreeing on buyer, storefront, type and date to the second. The
   * database would accept both rows — 0022's key includes `source_table`
   * precisely because the spaces overlap — so the deduplication is a rule.
   */
  it("drops the formal-case copy and counts it as superseded", () => {
    const shared = "7000000010";
    const { records, rejections } = collapse(
      [event({ sourceTable: "cases", caseId: shared, caseTypeRaw: "ITEM_NOT_RECEIVED", status: "CS_CLOSED", counterpartyRef: "synthetic-buyer-4" })],
      [],
      { superseded: new Set([shared]) },
    );
    expect(records).toEqual([]);
    expect(rejections).toEqual([
      { sourceTable: "cases", sourceCaseId: shared, reason: "superseded_by_inquiries", sourceRowCount: 1 },
    ]);
  });

  it("keeps a formal case whose id is NOT in the inquiry log", () => {
    const { records, rejections } = collapse(
      [event({ sourceTable: "cases", caseId: "7000000011", caseTypeRaw: "RETURN", status: "CLOSED", counterpartyRef: "synthetic-buyer-5" })],
      [],
      { superseded: new Set(["7000000010"]) },
    );
    expect(rejections).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]!.sourceTable).toBe("cases");
  });

  /** The same id in two stores is two distinct identities, by design. */
  it("treats the same id in two stores as two identities", () => {
    const { records } = collapse([
      event({ sourceTable: "payment_disputes", caseId: "123", status: "CLOSED", orderRef: "99-99999-99901", counterpartyRef: "synthetic-buyer-6" }),
      event({ sourceTable: "cases", caseId: "123", caseTypeRaw: "RETURN", status: "CLOSED", counterpartyRef: "synthetic-buyer-6" }),
    ], [["payment_disputes", "123", VERIFIED("99-99999-99901")]]);
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.sourceTable))).toEqual(
      new Set(["payment_disputes", "cases"]),
    );
  });
});

// ===========================================================================
describe("7 — closed versus active lifecycle", () => {
  /**
   * AN ESCALATED EBAY RETURN IS A CLOSED RETURN. All 150 measured rows whose
   * status is ESCALATED carry current_state CLOSED, so neither can be derived
   * from the other.
   */
  it("reads an escalated eBay return as CLOSED and escalated at once", () => {
    const { records } = collapse([
      event({
        sourceTable: "ebay_returns",
        caseId: "5289490059",
        status: "ESCALATED",
        state: "CLOSED",
        buyerEsc: 0,
        sellerEsc: 1,
      }),
    ]);
    expect(records[0]!.lifecycle).toBe("closed");
    expect(records[0]!.escalation).toBe("escalated");
    expect(records[0]!.sourceStatus).toBe("ESCALATED");
  });

  /** 6 measured rows carry status READY_FOR_SHIPPING against state ITEM_DELIVERED. */
  it("keeps both values when the two source columns disagree", () => {
    const { records } = collapse([
      event({
        sourceTable: "ebay_returns",
        caseId: "5289490060",
        status: "READY_FOR_SHIPPING",
        state: "ITEM_DELIVERED",
        buyerEsc: 0,
        sellerEsc: 0,
      }),
    ]);
    expect(records[0]!.lifecycle).toBe("active");
    expect(records[0]!.sourceStatus).toBe("READY_FOR_SHIPPING");
    expect(records[0]!.sourceState).toBe("ITEM_DELIVERED");
  });

  /**
   * AMAZON `Approved` IS NOT CLOSED. 13,315 rows of 13,343 carry it; the store
   * records no closure event and no closure date, so `unknown` is the only true
   * answer.
   */
  it("reads Amazon Approved as unknown, never closed", () => {
    expect(
      lifecycleFor({ sourceTable: "amazon_returns", status: "Approved", state: null, closedAt: null, fulfilment: "fbm" }),
    ).toBe("unknown");
    expect(
      lifecycleFor({ sourceTable: "amazon_returns", status: "PendingApproval", state: null, closedAt: null, fulfilment: "fbm" }),
    ).toBe("active");
    expect(
      lifecycleFor({ sourceTable: "amazon_returns", status: "Closed", state: null, closedAt: null, fulfilment: "fbm" }),
    ).toBe("closed");
  });

  /**
   * AN AMAZON-FULFILLED ROW'S `status` IS A WAREHOUSE DISPOSITION. Measured:
   * 2,577 rows carry sellable, customer-damaged, reimbursed and the rest. It must
   * never reach a field a screen could render as the customer's case status.
   */
  it("moves an Amazon warehouse disposition out of the status field entirely", () => {
    const { records } = collapse(
      [
        event({
          sourceTable: "amazon_returns",
          caseId: "RMA-SYNTH-1",
          subSource: AMAZON_STOREFRONT,
          status: "CUSTOMER_DAMAGED",
          fulfilment: "fba",
          orderRef: "999-9999999-9999991",
          azClaim: 0,
        }),
      ],
      [["amazon_returns", "RMA-SYNTH-1", VERIFIED("999-9999999-9999991")]],
      { verified: new Set([AMAZON_STOREFRONT]) },
    );
    expect(records[0]!.sourceStatus).toBeNull();
    expect(records[0]!.sourceDisposition).toBe("CUSTOMER_DAMAGED");
    expect(records[0]!.lifecycle).toBe("unknown");
  });

  /** inquiries: CS_CLOSED is closed BY CUSTOMER SERVICE, and is still closed. */
  it("treats CLOSED and CS_CLOSED as closed, and the three waiting states as active", () => {
    for (const status of ["CLOSED", "CS_CLOSED"]) {
      expect(lifecycleFor({ sourceTable: "inquiries", status, state: null, closedAt: null, fulfilment: null })).toBe("closed");
    }
    for (const status of ["OPEN", "WAITING_BUYER_RESPONSE", "WAITING_SELLER_RESPONSE"]) {
      expect(lifecycleFor({ sourceTable: "inquiries", status, state: null, closedAt: null, fulfilment: null })).toBe("active");
    }
  });

  /**
   * AN UNREVIEWED VALUE IS `unmapped`, NOT a guess. The importer refuses the
   * whole run on one, because an unreviewed status means the source changed shape.
   */
  it("reports an unreviewed status as unmapped and rejects the case", () => {
    expect(
      lifecycleFor({ sourceTable: "inquiries", status: "SOMETHING_NEW", state: null, closedAt: null, fulfilment: null }),
    ).toBe("unmapped");

    const { records, rejections, unmappedLifecycleValues } = collapse([
      event({ sourceTable: "inquiries", caseId: "7000000020", caseTypeRaw: "RETURN", status: "SOMETHING_NEW", counterpartyRef: "synthetic-buyer-7" }),
    ]);
    expect(records).toEqual([]);
    expect(rejections[0]!.reason).toBe("unmapped_lifecycle");
    expect(unmappedLifecycleValues).toHaveLength(1);
    expect(unmappedLifecycleValues[0]).toContain("SOMETHING_NEW");
  });

  it("reports an absent status as unknown, which is not a failure", () => {
    expect(lifecycleFor({ sourceTable: "inquiries", status: null, state: null, closedAt: null, fulfilment: null })).toBe("unknown");
    expect(lifecycleFor({ sourceTable: "shopify_returns", status: null, state: null, closedAt: null, fulfilment: null })).toBe("unknown");
  });
});

// ===========================================================================
describe("8 — confirmed versus unconfirmed replacement", () => {
  /**
   * The ONLY authoritative confirmation anywhere: 15 Amazon rows read
   * `Replacement` and 1 `ReturnlessReplacement`, out of 15,891.
   */
  it("confirms a replacement only from the Amazon resolution field", () => {
    expect(replacementConfirmedBy("amazon_returns", "Replacement")).toBe(true);
    expect(replacementConfirmedBy("amazon_returns", "ReturnlessReplacement")).toBe(true);
    expect(replacementConfirmedBy("amazon_returns", "StandardRefund")).toBe(false);
    expect(replacementConfirmedBy("amazon_returns", null)).toBe(false);
  });

  /**
   * THE NEAR-MISS THAT WOULD HAVE SHIPPED A WRONG FEATURE. The source holds a
   * 36-value return-action vocabulary and attaches "seller marked replacement
   * shipped" to 51 returns — but that table is an AVAILABLE-ACTIONS snapshot:
   * "external claim opened" is attached to 4,076 of 4,082 returns there and
   * appears as an actual activity on ZERO. Those 51 are offerable, not sent.
   */
  it("never reads an eBay available-action as a confirmed replacement", () => {
    expect(replacementConfirmedBy("ebay_returns", "SELLER_MARK_REPLACEMENT_SHIPPED")).toBe(false);
    expect(replacementConfirmedBy("ebay_returns", "SELLER_OFFER_REPLACEMENT")).toBe(false);
    expect(replacementConfirmedBy("ebay_returns", "Replacement")).toBe(false);

    const { records } = collapse([
      event({
        sourceTable: "ebay_returns",
        caseId: "5289490061",
        status: "CLOSED",
        state: "CLOSED",
        resolution: "SELLER_MARK_REPLACEMENT_SHIPPED",
        buyerEsc: 0,
        sellerEsc: 0,
      }),
    ]);
    expect(records[0]!.replacementConfirmed).toBe(false);
  });

  it("sets the flag on a real Amazon replacement", () => {
    const { records } = collapse(
      [
        event({
          sourceTable: "amazon_returns",
          caseId: "RMA-SYNTH-2",
          subSource: AMAZON_STOREFRONT,
          status: "Approved",
          fulfilment: "fbm",
          resolution: "Replacement",
          orderRef: "999-9999999-9999992",
          azClaim: 0,
        }),
      ],
      [["amazon_returns", "RMA-SYNTH-2", VERIFIED("999-9999999-9999992")]],
      { verified: new Set([AMAZON_STOREFRONT]) },
    );
    expect(records[0]!.replacementConfirmed).toBe(true);
    expect(records[0]!.sourceResolution).toBe("Replacement");
  });
});

// ===========================================================================
describe("9 — damage is a verified reason, not a case type", () => {
  /** eBay: one value, 271 rows. Amazon: four values, 1,133 rows between them. */
  it("detects every measured damage reason", () => {
    expect(damageReportedBy("ebay_returns", "ARRIVED_DAMAGED")).toBe(true);
    for (const reason of ["CR-DAMAGED_BY_FC", "CR-DAMAGED_BY_CARRIER", "DAMAGED_BY_FC", "DAMAGED_BY_CARRIER"]) {
      expect(damageReportedBy("amazon_returns", reason)).toBe(true);
    }
  });

  it("does not treat an ordinary remorse reason as damage", () => {
    expect(damageReportedBy("ebay_returns", "WRONG_SIZE")).toBe(false);
    expect(damageReportedBy("amazon_returns", "CR-UNWANTED_ITEM")).toBe(false);
    expect(damageReportedBy("inquiries", "ARRIVED_DAMAGED")).toBe(false);
  });

  it("keeps the reason visible beside the flag, and adds no DAMAGE case type", () => {
    const { records } = collapse([
      event({
        sourceTable: "ebay_returns",
        caseId: "5289490062",
        status: "CLOSED",
        state: "CLOSED",
        reason: "ARRIVED_DAMAGED",
        reasonFamily: "SNAD",
        buyerEsc: 0,
        sellerEsc: 0,
      }),
    ]);
    expect(records[0]!.damageReported).toBe(true);
    expect(records[0]!.sourceReason).toBe("ARRIVED_DAMAGED");
    expect(records[0]!.caseType).toBe("RETURN");
    expect(CASE_TYPES).not.toContain("DAMAGE");
  });
});

// ===========================================================================
describe("10 — a Shopify refund is classified REFUND, not RETURN", () => {
  /**
   * Seven columns at source: a date, an order, an amount, a currency and two
   * keys. No status, no reason, no lifecycle. Calling those 2,019 rows RETURN
   * would assert a case the source does not record.
   */
  it("classifies the store as REFUND with an unknown lifecycle", () => {
    const { records } = collapse(
      [
        event({
          sourceTable: "shopify_returns",
          caseId: "4001",
          subSource: SHOPIFY_STOREFRONT,
          orderRef: "SYNTH-SHOP-0001",
          refundAmount: "15.00",
          refundCurrency: "GBP",
          openedAt: "2026-04-02 12:00:00",
        }),
      ],
      [["shopify_returns", "4001", VERIFIED("SYNTH-SHOP-0001")]],
      { verified: new Set([SHOPIFY_STOREFRONT]) },
    );
    expect(records[0]!.caseType).toBe("REFUND");
    expect(records[0]!.lifecycle).toBe("unknown");
    expect(records[0]!.sourceStatus).toBeNull();
    expect(records[0]!.marketplace).toBe("shopify");
    expect(records[0]!.refundAmount).toBe("15.00");
  });

  it("classifies a Shopify cancellation as CANCELLATION, closed once cancelled", () => {
    const { records } = collapse(
      [
        event({
          sourceTable: "shopify_cancellations",
          caseId: "4002",
          subSource: SHOPIFY_STOREFRONT,
          orderRef: "SYNTH-SHOP-0002",
          status: "refunded",
          openedAt: "2026-04-03 12:00:00",
          closedAt: "2026-04-03 13:00:00",
        }),
      ],
      [["shopify_cancellations", "4002", VERIFIED("SYNTH-SHOP-0002")]],
      { verified: new Set([SHOPIFY_STOREFRONT]) },
    );
    expect(records[0]!.caseType).toBe("CANCELLATION");
    expect(records[0]!.lifecycle).toBe("closed");
  });

  it("maps every store to its measured case type and marketplace", () => {
    const expected: Record<CaseSourceTable, [string, string]> = {
      ebay_returns: ["RETURN", "ebay"],
      amazon_returns: ["RETURN", "amazon"],
      cancellation: ["CANCELLATION", "ebay"],
      amz_cancellations: ["CANCELLATION", "amazon"],
      shopify_returns: ["REFUND", "shopify"],
      shopify_cancellations: ["CANCELLATION", "shopify"],
      inquiries: ["ITEM_NOT_RECEIVED", "ebay"],
      cases: ["ITEM_NOT_RECEIVED", "ebay"],
      payment_disputes: ["PAYMENT_DISPUTE", "ebay"],
    };
    for (const store of CASE_SOURCE_TABLES) {
      const [type, marketplace] = expected[store];
      expect(caseTypeFor(store, "ITEM_NOT_RECEIVED"), store).toBe(type);
      expect(marketplaceFor(store), store).toBe(marketplace);
    }
  });

  /** 58 inquiry cases carry no type on any row. They are rejected, not guessed. */
  it("rejects an inquiry case whose type the source never recorded", () => {
    expect(caseTypeFor("inquiries", null)).toBeNull();
    expect(caseTypeFor("inquiries", "SOMETHING_ELSE")).toBeNull();
    const { records, rejections } = collapse([
      event({ sourceTable: "inquiries", caseId: "7000000030", caseTypeRaw: null, status: "CLOSED", counterpartyRef: "synthetic-buyer-8" }),
    ]);
    expect(records).toEqual([]);
    expect(rejections[0]!.reason).toBe("unmapped_case_type");
  });
});

// ===========================================================================
describe("storefront and date rejections are counted, never repaired", () => {
  it("rejects a case with no storefront", () => {
    const { rejections } = collapse([
      event({ sourceTable: "ebay_returns", caseId: "1", subSource: null, status: "CLOSED", state: "CLOSED" }),
    ]);
    expect(rejections[0]!.reason).toBe("no_storefront");
  });

  it("rejects a case on an unverified storefront rather than labelling it", () => {
    const { rejections } = collapse([
      event({ sourceTable: "ebay_returns", caseId: "1", subSource: 999, status: "CLOSED", state: "CLOSED" }),
    ]);
    expect(rejections[0]!.reason).toBe("unverified_storefront");
  });

  it("rejects a case with no date on any event row", () => {
    const { rejections } = collapse([
      event({ sourceTable: "ebay_returns", caseId: "1", openedAt: null, status: "CLOSED", state: "CLOSED" }),
    ]);
    expect(rejections[0]!.reason).toBe("no_opened_at");
  });

  /**
   * Rows with no case id are reported as ONE rejection carrying the row count,
   * not one per row: they have no identity to name, so counting them individually
   * would imply we know they were distinct cases. Measured: 1 such row.
   */
  it("reports id-less rows once, with their count", () => {
    const { rejections } = collapse([
      event({ sourceTable: "payment_disputes", caseId: null, rowId: "1" }),
      event({ sourceTable: "payment_disputes", caseId: null, rowId: "2" }),
    ]);
    expect(rejections).toEqual([
      { sourceTable: "payment_disputes", sourceCaseId: null, reason: "no_case_id", sourceRowCount: 2 },
    ]);
  });

  it("tallies rejections by reason for the run report", () => {
    const summary = caseRejectionSummary([
      { sourceTable: "cases", sourceCaseId: "1", reason: "superseded_by_inquiries", sourceRowCount: 3 },
      { sourceTable: "cases", sourceCaseId: "2", reason: "superseded_by_inquiries", sourceRowCount: 2 },
      { sourceTable: "inquiries", sourceCaseId: "3", reason: "unmapped_case_type", sourceRowCount: 1 },
    ]);
    expect(summary).toEqual({
      superseded_by_inquiries: { cases: 2, rows: 5 },
      unmapped_case_type: { cases: 1, rows: 1 },
    });
  });
});

// ===========================================================================
describe("escalation is three states, and not_recorded is not not_escalated", () => {
  it("reads the inquiry escalation signal from is_case or esc_date", () => {
    const base = { sourceTable: "inquiries" as const, status: null, buyerEsc: null, sellerEsc: null, azClaim: null };
    expect(escalationFor({ ...base, isCase: 1, escDate: null })).toBe("escalated");
    expect(escalationFor({ ...base, isCase: null, escDate: "2026-05-01 00:00:00" })).toBe("escalated");
    expect(escalationFor({ ...base, isCase: 0, escDate: null })).toBe("not_escalated");
  });

  it("reads an Amazon A-to-Z claim, and reports no signal as no signal", () => {
    const base = { sourceTable: "amazon_returns" as const, status: null, isCase: null, escDate: null, buyerEsc: null, sellerEsc: null };
    expect(escalationFor({ ...base, azClaim: 1 })).toBe("escalated");
    expect(escalationFor({ ...base, azClaim: 0 })).toBe("not_escalated");
    expect(escalationFor({ ...base, azClaim: null })).toBe("not_recorded");
  });

  /** Six of the nine stores have no escalation column at all. */
  it("returns not_recorded for every store with no escalation concept", () => {
    for (const store of ["cancellation", "amz_cancellations", "shopify_returns", "shopify_cancellations", "cases", "payment_disputes"] as const) {
      expect(
        escalationFor({ sourceTable: store, status: "CLOSED", isCase: 1, escDate: "2026-01-01 00:00:00", buyerEsc: 1, sellerEsc: 1, azClaim: 1 }),
        store,
      ).toBe("not_recorded");
    }
  });
});

// ===========================================================================
describe("a refund amount with no currency is refused, and the case is kept", () => {
  /**
   * THE FAILURE THAT PRODUCED THIS RULE. The first apply run was rejected by
   * 0022's `ck_marketplace_cases_refund_pair`. Measured on the source afterwards:
   * 1,367 Amazon return rows of the 9,760 carrying an amount have a blank
   * currency, while the eBay return and cancellation stores have none.
   *
   * 12.50 with no currency cannot distinguish pounds from dollars, so it is the
   * shape of a fact rather than one. Rejecting the whole case over it would have
   * discarded 1,367 real returns; relaxing the constraint would have stored a
   * number nobody can act on.
   */
  const amazonNoCurrency = [
    event({
      sourceTable: "amazon_returns",
      caseId: "RMA-SYNTH-9",
      subSource: AMAZON_STOREFRONT,
      status: "Approved",
      fulfilment: "fbm",
      orderRef: "999-9999999-9999999",
      azClaim: 0,
      refundAmount: "12.50",
      refundCurrency: null,
    }),
  ];

  it("keeps the case and drops only the uninterpretable number", () => {
    const { records, rejections, refundAmountsWithoutCurrency } = collapse(
      amazonNoCurrency,
      [["amazon_returns", "RMA-SYNTH-9", VERIFIED("999-9999999-9999999")]],
      { verified: new Set([AMAZON_STOREFRONT]) },
    );
    expect(rejections).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]!.refundAmount).toBeNull();
    expect(records[0]!.refundCurrency).toBeNull();
    expect(refundAmountsWithoutCurrency).toBe(1);
  });

  it("keeps a complete pair untouched", () => {
    const { records, refundAmountsWithoutCurrency } = collapse(
      [
        event({
          sourceTable: "ebay_returns",
          caseId: "5289490099",
          status: "CLOSED",
          state: "CLOSED",
          buyerEsc: 0,
          sellerEsc: 0,
          refundAmount: "24.99",
          refundCurrency: "GBP",
        }),
      ],
      [],
    );
    expect(records[0]!.refundAmount).toBe("24.99");
    expect(records[0]!.refundCurrency).toBe("GBP");
    expect(refundAmountsWithoutCurrency).toBe(0);
  });

  /** A currency with no amount is harmless and is left alone. */
  it("leaves a currency with no amount alone", () => {
    const { records, refundAmountsWithoutCurrency } = collapse(
      [
        event({
          sourceTable: "ebay_returns",
          caseId: "5289490098",
          status: "CLOSED",
          state: "CLOSED",
          buyerEsc: 0,
          sellerEsc: 0,
          refundAmount: null,
          refundCurrency: "GBP",
        }),
      ],
      [],
    );
    expect(records[0]!.refundAmount).toBeNull();
    expect(records[0]!.refundCurrency).toBe("GBP");
    expect(refundAmountsWithoutCurrency).toBe(0);
  });

  it("treats a blank currency as no currency", () => {
    const { records, refundAmountsWithoutCurrency } = collapse(
      [
        event({
          sourceTable: "ebay_returns",
          caseId: "5289490097",
          status: "CLOSED",
          state: "CLOSED",
          buyerEsc: 0,
          sellerEsc: 0,
          refundAmount: "9.99",
          refundCurrency: "   ",
        }),
      ],
      [],
    );
    expect(records[0]!.refundAmount).toBeNull();
    expect(refundAmountsWithoutCurrency).toBe(1);
  });
});

// ===========================================================================
describe("destination invariants are checked before the database is asked", () => {
  /**
   * A dry run writes nothing and so exercises no CHECK constraint — which is how
   * the first apply run reached transaction 2 before the database rejected a row.
   * This mirror refuses at the same point a rehearsal can see.
   */
  function good(): ReturnType<typeof collapse>["records"][number] {
    const { records } = collapse(
      [
        event({
          sourceTable: "ebay_returns",
          caseId: "5289490096",
          status: "CLOSED",
          state: "CLOSED",
          buyerEsc: 0,
          sellerEsc: 0,
        }),
      ],
      [],
    );
    return records[0]!;
  }

  it("passes a record the collapse produced", () => {
    expect(destinationInvariantViolations([good()])).toEqual([]);
  });

  it("catches a refund amount with no currency", () => {
    const v = destinationInvariantViolations([{ ...good(), refundAmount: "1.00", refundCurrency: null }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("refund_amount with no currency");
  });

  it("catches an order reference disagreeing with its method, in both directions", () => {
    expect(
      destinationInvariantViolations([
        { ...good(), orderMatchMethod: "unmatched", orderRef: "99-99999-99999" },
      ])[0],
    ).toContain("disagrees with order_ref");
    expect(
      destinationInvariantViolations([
        { ...good(), orderMatchMethod: "item_transaction", orderRef: null },
      ])[0],
    ).toContain("disagrees with order_ref");
  });

  it("catches escalation from a store that records none", () => {
    expect(
      destinationInvariantViolations([
        { ...good(), sourceTable: "cancellation", escalation: "escalated" },
      ])[0],
    ).toContain("records none");
  });

  it("catches a confirmed replacement outside the Amazon return store", () => {
    expect(
      destinationInvariantViolations([{ ...good(), replacementConfirmed: true }])[0],
    ).toContain("replacement_confirmed outside");
  });

  it("catches a disposition outside the Amazon return store", () => {
    expect(
      destinationInvariantViolations([{ ...good(), sourceDisposition: "SELLABLE" }])[0],
    ).toContain("source_disposition outside");
  });

  it("catches a blank value in any preserved source field", () => {
    expect(destinationInvariantViolations([{ ...good(), sourceStatus: "  " }])[0]).toContain(
      "blank source_status",
    );
    expect(destinationInvariantViolations([{ ...good(), counterpartyRef: "" }])[0]).toContain(
      "blank counterparty_ref",
    );
  });

  it("catches a non-positive source row count and a negative quantity", () => {
    expect(destinationInvariantViolations([{ ...good(), sourceRowCount: 0 }])[0]).toContain(
      "source_row_count below 1",
    );
    expect(destinationInvariantViolations([{ ...good(), quantity: -1 }])[0]).toContain(
      "negative quantity",
    );
  });
});

// ===========================================================================
describe("14 — source-table coverage is checked one way only", () => {
  /**
   * Every store that produced a record must be in the declared coverage, or
   * freshness would understate itself. The CONVERSE must not be checked: a store
   * read successfully that legitimately held no importable case STILL COUNTS AS
   * COVERED, and demanding a record from it would make an empty store look like
   * an unread one.
   */
  it("accepts a declared store that produced no record", () => {
    expect(coverageInconsistencies([], ["inquiries", "ebay_returns"])).toEqual([]);
  });

  it("rejects a record from a store the run did not declare", () => {
    const { records } = collapse([
      event({ sourceTable: "ebay_returns", caseId: "1", status: "CLOSED", state: "CLOSED", buyerEsc: 0, sellerEsc: 0 }),
    ]);
    expect(coverageInconsistencies(records, ["inquiries"])).toEqual(["ebay_returns"]);
    expect(coverageInconsistencies(records, ["inquiries", "ebay_returns"])).toEqual([]);
  });
});
