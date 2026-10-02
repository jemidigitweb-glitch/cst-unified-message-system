/**
 * The display rules behind the Case Detection Indicator.
 *
 * PURE. No network, no database, no clock — a caller that needs the time passes
 * it. That is what lets the same function decide the staleness marker on the
 * server and in the browser, and what makes every branch below testable without
 * a database.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * The imported snapshot carries four traps that a plain field dump walks
 * straight into, each measured rather than imagined:
 *
 *   1. 12,397 Amazon returns read `Approved`, which means the RETURN REQUEST
 *      was approved and NOT that the case closed — the store records no closure
 *      event and no closure date. `lifecycle` is `unknown` for all of them, and
 *      `unknown` must never be worded as "closed" or as "no longer open".
 *   2. 2,019 Shopify rows are a REFUND record — a date, an order, an amount and
 *      a currency, with no status, no reason and no lifecycle. Rendering one as
 *      a return case would assert a return request the source does not hold.
 *   3. The Amazon return store puts a WAREHOUSE DISPOSITION in the same source
 *      column as a case status for its Amazon-fulfilled rows. 0022 splits them
 *      into two columns; this file keeps them under two different labels, so a
 *      stockroom outcome can never be read as where the customer's case stands.
 *   4. 765 cases are escalated AND closed. On the eBay return store all 146
 *      rows whose status is ESCALATED carry `current_state = CLOSED`, so an
 *      escalation cannot be read off a lifecycle and a closed case cannot be
 *      assumed un-escalated. Both facts are rendered, side by side.
 *
 * ---------------------------------------------------------------------------
 * ABSENCE IS NOT A VALUE
 * ---------------------------------------------------------------------------
 * A field the source never recorded is omitted, never filled with "Unknown",
 * "N/A" or a dash — each of which reads as a value the system checked and
 * settled on. The one exception is the lifecycle, which is always stated,
 * because "the source does not say where this case stands" is itself the most
 * important thing an agent can be told about an Amazon approved return.
 */

import {
  CASE_SOURCE_TABLES,
  type CaseEscalation,
  type CaseLifecycle,
  type CaseSourceTable,
  type CaseType,
  type OrderMatchMethod,
  marketplaceFor,
} from "./marketplace-case";

/**
 * WHAT TRAVELS TO THE BROWSER.
 *
 * Declared here rather than in the route, following the convention
 * `OrderContextResponse` and `ListingLinkResponse` already set: the server and
 * the panel share one shape from a pure module, so a field added on one side
 * cannot quietly fail to arrive on the other. A component importing a type out
 * of `app/api/` would also drag a server module into a client graph.
 *
 * Identifiers of RECORDS only. There is no buyer handle, name, address, email
 * address, telephone number, message body or case correspondence here, and no
 * source table name — none of which the panel needs, and the first of which the
 * conversation header already shows.
 */
export type CaseDetectionCase = {
  readonly caseRef: string;
  /**
   * The vocabularies are domain types rather than loose strings, and that is
   * deliberate: each is CHECK-constrained by migration 0022, so the panel can
   * exhaust them and a new value arriving is a compile error rather than an
   * unlabelled chip on a reviewer's screen.
   */
  readonly caseType: CaseType;
  readonly lifecycle: CaseLifecycle;
  readonly sourceStatus: string | null;
  readonly sourceState: string | null;
  /** The Amazon warehouse outcome. Never a case status — see `caseFactsFor`. */
  readonly warehouseDisposition: string | null;
  readonly sourceResolution: string | null;
  readonly sourceReason: string | null;
  readonly damageReported: boolean;
  readonly replacementConfirmed: boolean;
  readonly escalation: CaseEscalation;
  readonly sellerActionOwed: string | null;
  /** A naive source datetime. No zone is known for it and none may be implied. */
  readonly sellerActionDueAt: string | null;
  readonly quantity: number | null;
  readonly refundAmount: string | null;
  readonly refundCurrency: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly orderRef: string | null;
  readonly orderMatchMethod: OrderMatchMethod;
};

export type CaseDetectionResponse = {
  readonly state: CasePanelState;
  /** Cases on the order this conversation resolved to. */
  readonly orderCases: readonly CaseDetectionCase[];
  /** The same customer's cases on their OTHER orders of this storefront. */
  readonly customerCases: readonly CaseDetectionCase[];
  /** A capped list says so, so a reader can tell "that is all" from "I stopped". */
  readonly orderCasesHasMore: boolean;
  readonly customerCasesHasMore: boolean;
  readonly matchedOrderRef: string | null;
  /**
   * Coverage as COUNTS, not store names. A reviewer needs to know that a case
   * source has never been imported; what the message application calls its
   * tables is not theirs to read.
   */
  readonly coverage: {
    readonly covered: number;
    readonly neverImported: number;
    /** The OLDEST covered store's publication time, so it reads as a floor. */
    readonly asOf: string | null;
  };
  readonly stale: boolean;
};

/**
 * Which source stores can hold a case for a given marketplace.
 *
 * DERIVED from `marketplaceFor`, never retyped. The importer decides which
 * marketplace a store belongs to; inverting its own function is what stops this
 * list and that one disagreeing about, say, whether `amz_cancellations` is an
 * Amazon store — a disagreement that would quietly report a store as "never
 * imported" for a marketplace it was never going to cover.
 */
export function storesForMarketplace(marketplace: string): readonly CaseSourceTable[] {
  return CASE_SOURCE_TABLES.filter((table) => marketplaceFor(table) === marketplace);
}

/**
 * How current a snapshot has to be before it is shown without a caveat.
 *
 * NOTHING SCHEDULES THE IMPORT. It is a manual command run by a person against
 * an hourly-capped source account, so the honest assumption is that a snapshot
 * is a day old rather than minutes old. Past this the panel says the data may
 * not include a case opened since — it does not hide the cases, because a
 * day-old case list is still the best evidence there is, and withholding it
 * would send an agent to the other system for information CST already holds.
 */
export const CASE_SNAPSHOT_STALE_AFTER_HOURS = 24;

/**
 * Whether a published snapshot is old enough to be worth qualifying.
 *
 * `now` is passed in. Returns false when there is no timestamp at all, because
 * "never imported" is a different state with its own wording and must not
 * borrow this one.
 */
export function caseSnapshotIsStale(
  publishedAt: string | null,
  now: Date,
  staleAfterHours: number = CASE_SNAPSHOT_STALE_AFTER_HOURS,
): boolean {
  if (publishedAt === null) return false;
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return false;
  return now.getTime() - published > staleAfterHours * 60 * 60 * 1000;
}

/**
 * The coverage of one marketplace's stores, from the per-store freshness map.
 *
 * `neverImported` is the half this type exists for. A store with no published
 * run has never been read, and a panel that showed "no cases found" while one
 * of its five stores had never been imported would be reporting an absence it
 * has no evidence for.
 */
export type CaseCoverage = {
  readonly storesCovered: readonly CaseSourceTable[];
  readonly storesNeverImported: readonly CaseSourceTable[];
  /** The OLDEST publication across the covered stores — see below. */
  readonly asOf: string | null;
};

/**
 * What has been imported for this marketplace, and when.
 *
 * `asOf` IS THE OLDEST COVERED STORE, NOT THE NEWEST, and that is the whole
 * point of holding freshness per store. A run covering only the inquiry log
 * would otherwise make the return stores look refreshed; reporting the oldest
 * means the timestamp on screen is a floor — every store is at least this
 * current — which is the only reading that cannot overstate the data.
 */
export function caseCoverageFor(
  marketplace: string,
  publishedByStore: ReadonlyMap<string, string>,
): CaseCoverage {
  const stores = storesForMarketplace(marketplace);
  const covered: CaseSourceTable[] = [];
  const never: CaseSourceTable[] = [];
  let oldest: string | null = null;

  for (const store of stores) {
    const publishedAt = publishedByStore.get(store);
    if (publishedAt === undefined) {
      never.push(store);
      continue;
    }
    covered.push(store);
    if (oldest === null || Date.parse(publishedAt) < Date.parse(oldest)) oldest = publishedAt;
  }

  return { storesCovered: covered, storesNeverImported: never, asOf: oldest };
}

/* ===========================================================================
 * WORDING
 * ===========================================================================
 * Every label below is service language a CST agent can act on. None of them is
 * a stored value printed raw: `RETURN`, `ITEM_NOT_RECEIVED` and
 * `source_order_id_unverified` are this system's bookkeeping, and an agent
 * reading them learns nothing they can use.
 */

/**
 * The five case types, in CST's words.
 *
 * `REFUND` reads "Refund recorded" and deliberately NOT "Return". The Shopify
 * store records that money went back and nothing else — no request, no status,
 * no lifecycle — so calling it a return would assert a case the source does not
 * hold. It is the one label in this map that had to be argued about.
 */
const CASE_TYPE_LABEL: Readonly<Record<CaseType, string>> = {
  RETURN: "Return",
  CANCELLATION: "Cancellation",
  ITEM_NOT_RECEIVED: "Item not received",
  PAYMENT_DISPUTE: "Payment dispute",
  REFUND: "Refund recorded",
};

export function caseTypeLabel(caseType: CaseType): string {
  return CASE_TYPE_LABEL[caseType];
}

/**
 * The lifecycle, in words that cannot be mistaken for each other.
 *
 * `unknown` is "Status not recorded", NEVER "Closed" and never a blank. It is
 * the honest answer for 14,436 of 21,022 cases, and the wording has to carry
 * that it is an absence in the SOURCE rather than a failure of this import.
 */
const LIFECYCLE_LABEL: Readonly<Record<CaseLifecycle, string>> = {
  active: "Open",
  closed: "Closed",
  unknown: "Status not recorded",
};

export function caseLifecycleLabel(lifecycle: CaseLifecycle): string {
  return LIFECYCLE_LABEL[lifecycle];
}

/**
 * Whether a case belongs in the prominent list.
 *
 * ACTIVE AND UNKNOWN BOTH DO. An unknown case is not a finished one, and the
 * largest population behind it — Amazon approved returns — is precisely the set
 * an agent needs to see before replying. Only `closed` is demoted, and it is
 * still shown, behind a disclosure.
 */
export function caseNeedsAttention(lifecycle: CaseLifecycle): boolean {
  return lifecycle !== "closed";
}

/** One labelled fact about a case, for a definition list. */
export type CaseFact = {
  readonly label: string;
  readonly value: string;
};

/**
 * The qualifier shown where a case's own order reference is not a verified
 * order, or null where it is.
 *
 * FOUR STATES, NOT A BOOLEAN, because they are four different claims:
 *
 *   source_order_id_verified    the source recorded an order id and it names a
 *                               real order on this storefront. Nothing to say.
 *   source_order_id_unverified  the source recorded an order id that resolves
 *                               to no order here. 155 cases. It must NOT read
 *                               as an exact match to the conversation's order.
 *   item_transaction            this application DERIVED the order from the
 *                               marketplace item and transaction identifiers.
 *                               1,055 cases, measured at 99.4% resolving to
 *                               exactly one order. A derived match is a
 *                               different claim from a recorded one.
 *   unmatched                   no order reference at all. 7 cases.
 */
const MATCH_CAVEAT: Readonly<Record<string, string | null>> = {
  source_order_id_verified: null,
  source_order_id_unverified: "Order reference recorded by the marketplace, not matched to an order here",
  item_transaction: "Order identified from the marketplace item and transaction references",
  unmatched: "No order reference recorded",
};

export function orderMatchCaveat(method: string): string | null {
  return MATCH_CAVEAT[method] ?? null;
}

/**
 * The facts to render under one case, in reading order.
 *
 * A FIELD THE SOURCE NEVER RECORDED IS ABSENT FROM THIS LIST. There is no
 * placeholder, because a row reading "Reason —" reports nothing while occupying
 * the space of something that does.
 *
 * `escalation` is the one tri-state here, and all three states are distinct:
 * `escalated` is rendered, `not_recorded` is rendered as nothing at all because
 * six of the nine stores have no escalation concept and silence is the truthful
 * rendering of a signal that was never collected, and `not_escalated` is also
 * rendered as nothing — "this was not escalated" is not news an agent needs on
 * every one of 16,693 cases.
 */
export function caseFactsFor(view: {
  readonly lifecycle: CaseLifecycle;
  readonly sourceStatus: string | null;
  readonly sourceState: string | null;
  readonly warehouseDisposition: string | null;
  readonly sourceReason: string | null;
  readonly sourceResolution: string | null;
  readonly damageReported: boolean;
  readonly replacementConfirmed: boolean;
  readonly escalation: string;
  readonly sellerActionOwed: string | null;
  readonly quantity: number | null;
  readonly refundAmount: string | null;
  readonly refundCurrency: string | null;
}): readonly CaseFact[] {
  const facts: CaseFact[] = [
    { label: "Case status", value: caseLifecycleLabel(view.lifecycle) },
  ];

  /*
   * The marketplace's own word for the status, beside CST's reading of it and
   * never instead of it. The two are separate columns because they measurably
   * disagree — 6 eBay returns read READY_FOR_SHIPPING against a state of
   * ITEM_DELIVERED — so collapsing them would force a choice between two values
   * the source never reconciled.
   */
  const sourceWord = view.sourceStatus ?? view.sourceState;
  if (sourceWord !== null) {
    facts.push({ label: "Marketplace status", value: sourceWord });
  }

  /*
   * A STOCKROOM OUTCOME, UNDER ITS OWN LABEL, AND NEVER UNDER "status".
   * This is the Amazon-fulfilled warehouse disposition — sellable, customer
   * damaged, reimbursed, unit returned to inventory. It describes what happened
   * to the goods in a warehouse, not where the customer's case stands, and the
   * label has to say so in words because the values themselves read like
   * outcomes.
   */
  if (view.warehouseDisposition !== null) {
    facts.push({ label: "Warehouse outcome (not a case status)", value: view.warehouseDisposition });
  }

  if (view.sourceReason !== null) facts.push({ label: "Reason given", value: view.sourceReason });

  /*
   * The marketplace's recorded resolution. Shown as what the source says was
   * resolved, never as a claim that anything was dispatched — see the
   * replacement fact below for why that distinction is load-bearing.
   */
  if (view.sourceResolution !== null) {
    facts.push({ label: "Recorded resolution", value: view.sourceResolution });
  }

  if (view.damageReported) {
    facts.push({ label: "Damage", value: "The customer reported damage" });
  }

  /*
   * CONFIRMED, AND ONLY FROM THE ONE AUTHORITATIVE FIELD.
   *
   * 16 cases across the whole snapshot carry this, from the Amazon resolution
   * column. The eBay return-action table attaches "seller marked replacement
   * shipped" to 51 returns and is an AVAILABLE-ACTIONS snapshot rather than
   * history — proven by the same table attaching "external claim opened" to
   * 4,076 returns that show the action on none of them. 0022 makes a confirmed
   * replacement unrepresentable outside the Amazon store, so this wording
   * cannot be reached by an available action.
   */
  if (view.replacementConfirmed) {
    facts.push({ label: "Replacement", value: "Confirmed by the marketplace" });
  }

  if (view.escalation === "escalated") {
    facts.push({ label: "Escalation", value: "Escalated at the marketplace" });
  }

  if (view.sellerActionOwed !== null) {
    facts.push({ label: "Action owed by us", value: view.sellerActionOwed });
  }

  if (view.quantity !== null) facts.push({ label: "Quantity", value: String(view.quantity) });

  /*
   * An amount with no currency is a number nobody can act on, and 0022's
   * `ck_marketplace_cases_refund_pair` already refuses to store one — so the
   * pair is rendered together or not at all.
   */
  if (view.refundAmount !== null && view.refundCurrency !== null) {
    facts.push({ label: "Refund recorded", value: `${view.refundAmount} ${view.refundCurrency}` });
  }

  return facts;
}

/* ===========================================================================
 * THE STATES THE PANEL MAY BE IN
 * ===========================================================================
 * Five, and no two of them may be collapsed. The first three are all "no cases
 * on screen" and they mean completely different things to a reviewer:
 *
 *   unavailable      the lookup could not run. Says nothing about the customer.
 *   never_imported   no published run covers this marketplace's stores. The
 *                    question has never been asked.
 *   no_verified_order AND no verified customer identity — there is no key to
 *                    match on, so no search was possible.
 *   none_found       every store was searched in a published snapshot and held
 *                    nothing. THIS is the only state that is evidence of
 *                    absence, and the only one worded as such.
 *   found            cases, split into this order and the customer's others.
 *
 * "Partial" is NOT a sixth state, and making it one was the first draft's
 * mistake: an incompletely imported marketplace can both find cases and be
 * missing a store, so completeness is a property carried ALONGSIDE the state —
 * `storesNeverImported` — rather than a state that would have to replace one.
 */
export const CASE_PANEL_STATES = [
  "unavailable",
  "never_imported",
  "no_search_key",
  "none_found",
  "found",
] as const;

export type CasePanelState = (typeof CASE_PANEL_STATES)[number];

/** The sentence for a state that shows no case list. Null where cases render. */
export function caseEmptyStateText(
  state: CasePanelState,
  options: { readonly hasNeverImportedStore: boolean },
): string | null {
  switch (state) {
    case "found":
      return null;
    case "unavailable":
      // Deliberately not "no cases": a failed read must never be drawn as a
      // clean record.
      return "Case records could not be checked.";
    case "never_imported":
      return "Marketplace case records have not been imported for this marketplace yet.";
    case "no_search_key":
      // No verified order and no verified customer identity. Nothing was
      // searched, so nothing may be concluded.
      return "No verified order or customer reference, so case records could not be matched.";
    case "none_found":
      return options.hasNeverImportedStore
        ? "No cases found in the records that have been imported. Some case sources have never been imported, so this is not a complete answer."
        : "No marketplace cases recorded for this order or customer.";
  }
}
