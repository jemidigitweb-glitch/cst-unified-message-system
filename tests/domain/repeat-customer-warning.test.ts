import { describe, expect, it } from "vitest";

import {
  type CustomerHistoryFacts,
  REPEAT_CUSTOMER_THRESHOLDS,
  type RepeatCustomerThresholds,
  evaluateRepeatCustomerWarning,
  known,
  unavailable,
  verifyCustomerIdentity,
} from "@/lib/domain/repeat-customer-warning";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";
import { unresolvedReferenceFor } from "@/lib/domain/conversation-reference";
import {
  repeatCustomerWarningLines,
} from "@/components/repeat-customer-warning";

/**
 * SYNTHETIC ONLY. Every buyer handle below is obviously fake (`buyer-a`), and
 * no value came from live output — `tests/guards/no-customer-data.test.ts`
 * scans every tracked file and has already caught a real order number in four
 * fixtures.
 *
 * THE THRESHOLD TESTS READ THE CONSTANTS, they do not hardcode 2. The numbers
 * are explicitly provisional and not approved CST policy, so a test that
 * pinned them would fail the moment the CST owner adjusted one — turning an
 * approved policy change into a broken build. These assert the BEHAVIOUR at
 * the boundary (below triggers nothing, at triggers) whatever the number is.
 */

/** No signal known. The starting point for a test that turns one on. */
const NOTHING_KNOWN: CustomerHistoryFacts = {
  previousConversations: unavailable,
  previousRefundedOrders: unavailable,
  previousFormalCases: unavailable,
  previousPaymentDisputes: unavailable,
  previousEscalations: unavailable,
};

/** Every signal known and zero. A customer with a clean, fully-read history. */
const ALL_ZERO: CustomerHistoryFacts = {
  previousConversations: known(0),
  previousRefundedOrders: known(0),
  previousFormalCases: known(0),
  previousPaymentDisputes: known(0),
  previousEscalations: known(0),
};

const evaluate = (facts: Partial<CustomerHistoryFacts>, thresholds?: RepeatCustomerThresholds) =>
  evaluateRepeatCustomerWarning({ ...ALL_ZERO, ...facts }, { available: true, thresholds });

describe("identity — whether there is a customer to have a history", () => {
  const ebay = capabilityOf("ebay");

  it("accepts a verified eBay buyer", () => {
    const identity = verifyCustomerIdentity(
      { counterpartyRef: "buyer-a", subSourceId: 22 },
      ebay,
    );
    expect(identity).toEqual({ state: "verified", counterpartyRef: "buyer-a" });
  });

  /**
   * THE 358-CONVERSATION BUG THIS PREVENTS.
   *
   * Measured 2026-10-01: 358 of 2,123 eBay conversations carry
   * `counterparty_ref = 'eBay'` — the platform writing to CST, across all 14
   * storefronts. Treated as a buyer they would be ONE customer, and every one
   * of them would show "Previous conversations: 357".
   */
  it("rejects the marketplace itself as a counterparty", () => {
    for (const ref of ["eBay", "ebay", "EBAY", "  eBay  ", "system", "Support"]) {
      expect(verifyCustomerIdentity({ counterpartyRef: ref, subSourceId: 1 }, ebay)).toEqual({
        state: "platform_sender",
      });
    }
  });

  /** Exact match on the whole handle, never a substring: this is a person. */
  it("keeps a real buyer whose handle merely contains a platform word", () => {
    for (const ref of ["ebay_spares_uk", "theebayshop", "support-tools-ltd"]) {
      expect(
        verifyCustomerIdentity({ counterpartyRef: ref, subSourceId: 1 }, ebay).state,
      ).toBe("verified");
    }
  });

  it("rejects the ungrouped sentinel reference", () => {
    const identity = verifyCustomerIdentity(
      { counterpartyRef: unresolvedReferenceFor("123456"), subSourceId: 1 },
      ebay,
    );
    expect(identity).toEqual({ state: "unresolved_reference" });
  });

  it("rejects a blank reference and a missing storefront", () => {
    expect(verifyCustomerIdentity({ counterpartyRef: "   ", subSourceId: 1 }, ebay)).toEqual({
      state: "missing_identity",
    });
    expect(
      verifyCustomerIdentity({ counterpartyRef: "buyer-a", subSourceId: null }, ebay),
    ).toEqual({ state: "missing_identity" });
  });

  /**
   * Driven by the existing capability table, not by a marketplace name. eBay
   * is the only source whose stored reference is a verified customer identity;
   * the other four are order references or shared platform relays.
   */
  it.each(["amazon", "shopify", "bandq", "temu"] as const)(
    "reports %s as unsupported, because its reference is not a customer identity",
    (marketplace) => {
      expect(
        verifyCustomerIdentity(
          { counterpartyRef: "whatever", subSourceId: 1 },
          capabilityOf(marketplace),
        ),
      ).toEqual({ state: "unsupported_marketplace" });
    },
  );

  /** The capability flag is the gate, so enabling a marketplace is a data change. */
  it("accepts any marketplace whose capability declares identity verified", () => {
    const identity = verifyCustomerIdentity(
      { counterpartyRef: "buyer-a", subSourceId: 7 },
      { counterpartyIdentityVerified: true },
    );
    expect(identity.state).toBe("verified");
  });
});

describe("unavailable is never zero", () => {
  /**
   * The single most important rule in the feature. A source that could not be
   * read must not render as "no history" — the two lead an agent to opposite
   * conclusions.
   */
  it("never triggers on an unavailable signal", () => {
    const result = evaluateRepeatCustomerWarning(NOTHING_KNOWN, { available: true });
    expect(result.warning).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.unavailableSignals).toHaveLength(5);
  });

  it("reports which signals were unreadable rather than hiding the gap", () => {
    const result = evaluate({ previousRefundedOrders: unavailable, previousConversations: known(5) });
    expect(result.warning).toBe(true);
    expect(result.reasons.map((r) => r.type)).toEqual(["previous_contacts"]);
    expect(result.unavailableSignals).toEqual(["previous_refunded_orders"]);
  });

  /**
   * `available: false` means the question could not be asked. It is NOT
   * `warning: false`, which means it was asked and answered no — and the
   * interface renders nothing for the former.
   */
  it("returns no warning and no reasons when identity is unverified", () => {
    const result = evaluateRepeatCustomerWarning(ALL_ZERO, { available: false });
    expect(result).toEqual({
      available: false,
      warning: false,
      reasons: [],
      unavailableSignals: [],
    });
  });

  it("reports a fully-read clean history as available with no warning", () => {
    const result = evaluateRepeatCustomerWarning(ALL_ZERO, { available: true });
    expect(result.available).toBe(true);
    expect(result.warning).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.unavailableSignals).toEqual([]);
  });
});

describe("thresholds — the boundary, not the number", () => {
  const { previousConversations, previousRefundedOrders } = REPEAT_CUSTOMER_THRESHOLDS;

  it("does not trigger one below the previous-conversations threshold", () => {
    const result = evaluate({ previousConversations: known(previousConversations - 1) });
    expect(result.warning).toBe(false);
  });

  it("triggers exactly at the previous-conversations threshold", () => {
    const result = evaluate({ previousConversations: known(previousConversations) });
    expect(result.warning).toBe(true);
    expect(result.reasons).toEqual([
      { type: "previous_contacts", count: previousConversations },
    ]);
  });

  it("does not trigger one below the refund threshold", () => {
    expect(evaluate({ previousRefundedOrders: known(previousRefundedOrders - 1) }).warning).toBe(
      false,
    );
  });

  it("triggers exactly at the refund threshold", () => {
    const result = evaluate({ previousRefundedOrders: known(previousRefundedOrders) });
    expect(result.reasons).toEqual([
      { type: "previous_refunded_orders", count: previousRefundedOrders },
    ]);
  });

  /** A single formal case is enough — it is not an ordinary event. */
  it("triggers on one verified formal case", () => {
    expect(evaluate({ previousFormalCases: known(1) }).reasons).toEqual([
      { type: "previous_formal_case", count: 1 },
    ]);
  });

  it("triggers on one verified payment dispute", () => {
    expect(evaluate({ previousPaymentDisputes: known(1) }).reasons).toEqual([
      { type: "previous_payment_dispute", count: 1 },
    ]);
  });

  it("triggers on one verified buyer escalation", () => {
    expect(evaluate({ previousEscalations: known(1) }).reasons).toEqual([
      { type: "previous_escalation", count: 1 },
    ]);
  });

  /** The thresholds must be adjustable without editing the evaluator. */
  it("honours a caller's thresholds, so an approved change is a data change", () => {
    const strict: RepeatCustomerThresholds = {
      ...REPEAT_CUSTOMER_THRESHOLDS,
      previousConversations: 99,
    };
    expect(evaluate({ previousConversations: known(5) }, strict).warning).toBe(false);
    expect(evaluate({ previousConversations: known(100) }, strict).warning).toBe(true);
  });
});

describe("the counts are reported, never scored", () => {
  /**
   * Nothing is summed across signals. Two previous conversations and one
   * previous refund are not "three concerning things" — they measure different
   * kinds of record, and adding them would invent a quantity the data does not
   * contain. That is also why there is no total and no score field.
   */
  it("reports each qualifying signal separately with its own count", () => {
    const result = evaluate({
      previousConversations: known(3),
      previousRefundedOrders: known(2),
      previousPaymentDisputes: known(1),
    });
    expect(result.reasons).toEqual([
      { type: "previous_contacts", count: 3 },
      { type: "previous_refunded_orders", count: 2 },
      { type: "previous_payment_dispute", count: 1 },
    ]);
  });

  it("exposes no score, severity or total on the result", () => {
    const result = evaluate({ previousConversations: known(9) });
    expect(Object.keys(result).sort()).toEqual([
      "available",
      "reasons",
      "unavailableSignals",
      "warning",
    ]);
  });

  /** A signal below its threshold is absent, never a zero row. */
  it("omits a non-qualifying signal rather than reporting it as zero", () => {
    const result = evaluate({
      previousConversations: known(1),
      previousRefundedOrders: known(2),
    });
    expect(result.reasons.map((r) => r.type)).toEqual(["previous_refunded_orders"]);
  });
});

describe("the card's render decision", () => {
  /**
   * `repeatCustomerWarningLines` is the whole of the show/hide behaviour, and
   * it is exported and pure precisely so it can be asserted here — this
   * repository's test environment is `node` with no DOM (see
   * `vitest.config.mts`), so there is no renderer to mount a component in.
   */
  it("shows the triggered reasons with agent-facing wording", () => {
    const lines = repeatCustomerWarningLines({
      state: "ready",
      warning: true,
      reasons: [
        { type: "previous_contacts", count: 3 },
        { type: "previous_payment_dispute", count: 1 },
      ],
      unavailableSignals: [],
      historyAsOf: null,
    });
    expect(lines).toEqual([
      { label: "Previous conversations", count: 3 },
      { label: "Previous payment disputes", count: 1 },
    ]);
  });

  it("shows nothing while loading", () => {
    expect(repeatCustomerWarningLines({ state: "loading" })).toBeNull();
  });

  /** An unreadable history and a clean one must not look the same upstream... */
  it("shows nothing when history is unavailable", () => {
    expect(repeatCustomerWarningLines({ state: "unavailable" })).toBeNull();
  });

  /** ...but both correctly render nothing. */
  it("shows nothing when there is no qualifying history", () => {
    expect(
      repeatCustomerWarningLines({
        state: "ready",
        warning: false,
        reasons: [],
        unavailableSignals: [],
        historyAsOf: null,
      }),
    ).toBeNull();
  });

  /**
   * A reason type this build has no copy for renders as nothing rather than as
   * a raw identifier like `previous_payment_dispute`, and a card with no
   * renderable line is not shown at all.
   */
  it("shows nothing rather than a raw identifier for an unknown reason type", () => {
    expect(
      repeatCustomerWarningLines({
        state: "ready",
        warning: true,
        reasons: [{ type: "some_future_signal", count: 4 }],
        unavailableSignals: [],
        historyAsOf: null,
      }),
    ).toBeNull();
  });

  it("drops only the unknown reason when a known one is also present", () => {
    const lines = repeatCustomerWarningLines({
      state: "ready",
      warning: true,
      reasons: [
        { type: "some_future_signal", count: 4 },
        { type: "previous_escalation", count: 1 },
      ],
      unavailableSignals: [],
      historyAsOf: null,
    });
    expect(lines).toEqual([{ label: "Previously escalated cases", count: 1 }]);
  });
});
