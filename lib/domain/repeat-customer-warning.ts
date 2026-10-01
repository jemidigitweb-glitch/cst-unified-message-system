/**
 * Whether a conversation's customer has verified prior history worth flagging,
 * and which facts say so.
 *
 * PURE. No network, no database, no clock — the caller supplies the facts and
 * the conversation's own source timestamp. The same function therefore decides
 * the answer on the server and can be reasoned about in a unit test without a
 * database, which is this codebase's rule for `lib/domain`.
 *
 * ------------------------------------------------------------------------
 * IT REPORTS FACTS. IT DOES NOT SCORE A PERSON
 * ------------------------------------------------------------------------
 * There is no risk score here, no "high risk" band, no fraud signal and no
 * model. Every output is a COUNT OF VERIFIED RECORDS with the record type
 * named. A customer who returned two faulty lamps and opened one case is
 * indistinguishable, in this data, from one acting in bad faith — and the
 * warning deliberately cannot tell an agent which they are looking at, because
 * the data cannot.
 *
 * That is why the reasons are nouns about RECORDS ("previous conversations",
 * "previous refunded orders") and never adjectives about PEOPLE. A previous
 * complaint or refund is not evidence of wrongdoing, and the vocabulary must
 * not let an interface imply it is.
 *
 * ------------------------------------------------------------------------
 * UNAVAILABLE IS NOT ZERO, AND THE TYPE ENFORCES IT
 * ------------------------------------------------------------------------
 * Every signal is a `FactCount`, which is either a known count or
 * `unavailable`. It is deliberately NOT `number | null` and deliberately not
 * zero-defaulted: a source that could not be read must not render as "no
 * history", because "we checked and there is none" and "we could not check"
 * lead an agent to opposite conclusions. Same discipline as the
 * `resolved | unavailable | ambiguous` shape used throughout the context
 * resolvers.
 *
 * An unavailable signal can never raise the warning, and is reported in
 * `unavailableSignals` so the interface can say the picture is partial rather
 * than quietly presenting it as complete.
 */

import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";

/**
 * ===========================================================================
 * IDENTITY: WHETHER THERE IS A CUSTOMER TO HAVE A HISTORY
 * ===========================================================================
 * No history may be looked up, and no warning shown, without a verified
 * customer identity. Each rejection below is a DISTINCT state rather than a
 * boolean, because the interface must be able to stay silent for a reason
 * someone can name — and because "no verified customer" and "no history" must
 * never collapse into the same rendering.
 *
 * ------------------------------------------------------------------------
 * THE PLATFORM IS NOT A CUSTOMER, AND THIS IS THE BUG IT PREVENTS
 * ------------------------------------------------------------------------
 * Measured 2026-10-01: 358 of 2,123 eBay conversations — 17% — carry
 * `counterparty_ref = 'eBay'`, spread across all 14 storefronts. That is eBay
 * itself writing to CST, not a buyer.
 *
 * Without this rejection all 358 would be treated as ONE customer, and every
 * one of them would display "Previous conversations: 357". A false
 * repeat-customer warning on a sixth of the eBay inbox, naming a volume of
 * history that belongs to nobody.
 *
 * The list is matched case-insensitively and exactly — never as a substring —
 * so a real buyer whose handle merely CONTAINS one of these words keeps their
 * history. A buyer called `ebay_spares_uk` is a person; `eBay` is not.
 */
const PLATFORM_IDENTITIES: readonly string[] = [
  "ebay",
  "ebay member",
  "ebay customer support",
  "system",
  "support",
];

export type CustomerHistoryIdentity =
  | {
      readonly state: "verified";
      readonly counterpartyRef: string;
    }
  /** The source has no verified customer identity at all — see `capabilityOf`. */
  | { readonly state: "unsupported_marketplace" }
  /** The counterparty is the marketplace or a support desk, not a buyer. */
  | { readonly state: "platform_sender" }
  /** The ungrouped sentinel: this message could not be grouped with any other. */
  | { readonly state: "unresolved_reference" }
  /** Blank, or no storefront to scope the lookup to. */
  | { readonly state: "missing_identity" };

/**
 * Whether this conversation has a customer whose history may be looked up.
 *
 * PURE, and it decides nothing about history — only whether the question can
 * honestly be asked. The order of the checks is the order of certainty: the
 * marketplace's own capability first (a source that never carries a customer
 * identity cannot have one here), then the three ways a reference can fail to
 * be a person.
 *
 * `counterpartyIdentityVerified` is read from the existing capability table
 * rather than tested by marketplace name, so enabling Amazon or Shopify later
 * is a data change in `marketplace-capabilities.ts` plus a history provider —
 * not an edit here and not an edit to the interface.
 */
export function verifyCustomerIdentity(
  conversation: {
    readonly counterpartyRef: string;
    readonly subSourceId: number | null;
  },
  capability: Pick<MarketplaceCapability, "counterpartyIdentityVerified">,
): CustomerHistoryIdentity {
  if (!capability.counterpartyIdentityVerified) {
    return { state: "unsupported_marketplace" };
  }

  const ref = conversation.counterpartyRef.trim();
  if (ref === "" || conversation.subSourceId === null) {
    return { state: "missing_identity" };
  }
  if (isUnresolvedReference(ref)) {
    return { state: "unresolved_reference" };
  }
  // Exact match on the whole handle, case-insensitively. Never a substring:
  // `ebay_spares_uk` is a buyer, `eBay` is the platform.
  if (PLATFORM_IDENTITIES.includes(ref.toLowerCase())) {
    return { state: "platform_sender" };
  }

  return { state: "verified", counterpartyRef: ref };
}

/** The record types a warning can cite. Nouns about records, never about people. */
export const WARNING_REASON_TYPES = [
  "previous_contacts",
  "previous_refunded_orders",
  "previous_formal_case",
  "previous_payment_dispute",
  "previous_escalation",
] as const;

export type WarningReasonType = (typeof WARNING_REASON_TYPES)[number];

/**
 * A count that is known, or a signal that could not be read.
 *
 * `unavailable` carries no number on purpose — there is no field a caller
 * could accidentally read as zero.
 */
export type FactCount =
  | { readonly state: "known"; readonly count: number }
  | { readonly state: "unavailable" };

export const unavailable: FactCount = { state: "unavailable" };
export function known(count: number): FactCount {
  return { state: "known", count };
}

/** The verified history behind one conversation, each signal independently readable. */
export type CustomerHistoryFacts = {
  /** Distinct OTHER conversations with this buyer on this storefront, started earlier. */
  readonly previousConversations: FactCount;
  /** Distinct earlier orders by this buyer on this storefront whose status is Refunded. */
  readonly previousRefundedOrders: FactCount;
  /** Distinct earlier formal marketplace cases (`cases`), not inquiries. */
  readonly previousFormalCases: FactCount;
  /** Distinct earlier payment disputes. */
  readonly previousPaymentDisputes: FactCount;
  /** Distinct earlier cases whose authoritative state is `escalated`. */
  readonly previousEscalations: FactCount;
};

export type WarningReason = {
  readonly type: WarningReasonType;
  readonly count: number;
};

export type RepeatCustomerWarning = {
  /**
   * Whether a verified customer identity was established and history could be
   * looked up at all. False means NO warning may be shown — not "no history".
   */
  readonly available: boolean;
  readonly warning: boolean;
  /** Only the signals that actually crossed their threshold. Never a zero row. */
  readonly reasons: readonly WarningReason[];
  /** Signals that could not be read. Never counted as zero, never a trigger. */
  readonly unavailableSignals: readonly WarningReasonType[];
};

/**
 * ===========================================================================
 * PROVISIONAL THRESHOLDS — NOT APPROVED CST POLICY
 * ===========================================================================
 * These are implementation defaults so the feature can be built, reviewed and
 * demonstrated against real history. **No CST owner has approved them**, and
 * nothing in this repository should be read as claiming otherwise.
 *
 * They are deliberately in ONE place, as plain data, with no database row and
 * no admin screen behind them — storing them would make them look settled, and
 * an unapproved number that is hard to change is worse than one that is easy.
 *
 * HOW THE CST OWNER APPROVES OR ADJUSTS THEM
 *
 *   1. Read the measured distribution first. `sql/` holds the queries behind
 *      the figures below so they can be re-derived rather than trusted.
 *      Measured over the 1,098 imported cases and 1,031 distinct buyers:
 *      51 buyers have more than one case and the busiest has 5.
 *   2. Decide each number against what an agent should ACT on. A threshold of
 *      1 for `previousConversations` would flag almost every returning
 *      customer and the warning would stop meaning anything; 2 is the smallest
 *      value that says "this has happened before, more than once".
 *   3. Change the value here, in this object, and run
 *      `npx vitest run tests/domain/repeat-customer-warning.test.ts` — the
 *      threshold tests read these constants rather than hardcoding numbers, so
 *      they follow a change instead of failing it.
 *   4. Record the approval in `capability/` with the date and who approved it,
 *      and only then treat the numbers as policy.
 *
 * Until step 4 has happened, the warning is an informational prototype.
 */
export type RepeatCustomerThresholds = {
  readonly previousConversations: number;
  readonly previousRefundedOrders: number;
  readonly previousFormalCases: number;
  readonly previousPaymentDisputes: number;
  readonly previousEscalations: number;
};

/**
 * TYPED AS `number`, NOT AS ITS OWN LITERALS, and typecheck caught the
 * difference. Declared `as const` and inferred with `typeof`, every value
 * became a literal type — so `previousConversations` was the type `2`, and a
 * caller passing an adjusted threshold of 99 was a compile error. A
 * configuration object nobody can reconfigure is not configuration, and it
 * would have made the approval route above impossible to follow.
 */
export const REPEAT_CUSTOMER_THRESHOLDS: RepeatCustomerThresholds = {
  /** Two or more OTHER earlier conversations. One prior contact is ordinary. */
  previousConversations: 2,
  /** Two or more earlier refunded orders. One refund is ordinary. */
  previousRefundedOrders: 2,
  /**
   * ONE formal case is enough. A formal marketplace case is not an ordinary
   * event the way a message or a refund is — see the comment on
   * `previousFormalCases` in `CustomerHistoryFacts` for why inquiries are
   * excluded from this count entirely.
   */
  previousFormalCases: 1,
  /** One verified payment dispute is enough, for the same reason. */
  previousPaymentDisputes: 1,
  /** One authoritative `escalated` state is enough. */
  previousEscalations: 1,
};

/** Which fact feeds which reason, and which threshold it must reach. */
const SIGNALS: readonly {
  readonly type: WarningReasonType;
  readonly fact: keyof CustomerHistoryFacts;
  readonly threshold: keyof RepeatCustomerThresholds;
}[] = [
  { type: "previous_contacts", fact: "previousConversations", threshold: "previousConversations" },
  { type: "previous_refunded_orders", fact: "previousRefundedOrders", threshold: "previousRefundedOrders" },
  { type: "previous_formal_case", fact: "previousFormalCases", threshold: "previousFormalCases" },
  { type: "previous_payment_dispute", fact: "previousPaymentDisputes", threshold: "previousPaymentDisputes" },
  { type: "previous_escalation", fact: "previousEscalations", threshold: "previousEscalations" },
];

/**
 * Evaluates the verified facts against the configured thresholds.
 *
 * A reason appears ONLY when its own count reached its own threshold. Nothing
 * is summed across signals: two previous conversations and one previous refund
 * do not combine into "three concerning things", because the counts measure
 * different kinds of record and adding them would invent a quantity the data
 * does not contain. That is also why there is no total and no score.
 *
 * `available: false` is returned when the caller could establish no verified
 * customer identity, and it is NOT the same as `warning: false` — the first
 * means the question could not be asked, the second that it was asked and the
 * answer was no. The interface must render nothing for the first.
 */
export function evaluateRepeatCustomerWarning(
  facts: CustomerHistoryFacts,
  options: { readonly available: boolean; readonly thresholds?: RepeatCustomerThresholds },
): RepeatCustomerWarning {
  if (!options.available) {
    return { available: false, warning: false, reasons: [], unavailableSignals: [] };
  }

  const thresholds = options.thresholds ?? REPEAT_CUSTOMER_THRESHOLDS;
  const reasons: WarningReason[] = [];
  const unavailableSignals: WarningReasonType[] = [];

  for (const signal of SIGNALS) {
    const fact = facts[signal.fact];
    if (fact.state === "unavailable") {
      // Recorded, never counted. An unreadable signal cannot raise a warning
      // and must not be presented as an absence of history.
      unavailableSignals.push(signal.type);
      continue;
    }
    if (fact.count >= thresholds[signal.threshold]) {
      reasons.push({ type: signal.type, count: fact.count });
    }
  }

  return {
    available: true,
    warning: reasons.length > 0,
    reasons,
    unavailableSignals,
  };
}
