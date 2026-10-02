/**
 * The vocabulary and the record shape behind `cst_app.marketplace_cases`.
 *
 * PURE. No network, no database, no clock. Every value set below was MEASURED
 * against the source and is the whole observed population at the time stated;
 * nothing here is a plausible-looking list. A value outside one of these sets
 * must fail the import and be looked at, not be stored as a vocabulary nobody
 * has reviewed.
 *
 * The constants mirror migration 0022's CHECK constraints exactly, so a value
 * this module admits is a value the database admits. `tests/domain/` asserts
 * the two agree rather than trusting that they do.
 */

/** The nine source stores 0022 admits. */
export const CASE_SOURCE_TABLES = [
  "ebay_returns",
  "amazon_returns",
  "cancellation",
  "amz_cancellations",
  "shopify_returns",
  "shopify_cancellations",
  "inquiries",
  "cases",
  "payment_disputes",
] as const;
export type CaseSourceTable = (typeof CASE_SOURCE_TABLES)[number];

/**
 * FIVE case types, and the fifth is the interesting one.
 *
 * `REFUND` exists for the Shopify store, which records a date, an order, an
 * amount and a currency and nothing else — no status, no reason, no lifecycle.
 * Calling those 2,019 rows `RETURN` would assert a case the source does not
 * record. There is deliberately no `DAMAGE` and no `REPLACEMENT`: the source
 * issues no identifier for either, so both are flags on a case rather than
 * kinds of case.
 */
export const CASE_TYPES = [
  "RETURN",
  "CANCELLATION",
  "ITEM_NOT_RECEIVED",
  "PAYMENT_DISPUTE",
  "REFUND",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

/**
 * CST's own reading of where a case stands. THREE values, never a boolean.
 *
 * `unknown` is not a failure state. It is the honest answer for a large,
 * measured population — see `lifecycleFor` — and collapsing it into either of
 * the others would state something the source does not.
 */
export const CASE_LIFECYCLES = ["active", "closed", "unknown"] as const;
export type CaseLifecycle = (typeof CASE_LIFECYCLES)[number];

/**
 * How the order reference was established. FOUR states, because they are four
 * different claims and a reader must be able to tell them apart.
 */
export const ORDER_MATCH_METHODS = [
  "source_order_id_verified",
  "source_order_id_unverified",
  "item_transaction",
  "unmatched",
] as const;
export type OrderMatchMethod = (typeof ORDER_MATCH_METHODS)[number];

/** Same three states as 0021. `not_recorded` is not `not_escalated`. */
export const CASE_ESCALATIONS = ["escalated", "not_escalated", "not_recorded"] as const;
export type CaseEscalation = (typeof CASE_ESCALATIONS)[number];

/** The three stores that record an escalation signal at all. */
export const ESCALATION_RECORDING_TABLES: readonly CaseSourceTable[] = [
  "inquiries",
  "ebay_returns",
  "amazon_returns",
];

/**
 * DAMAGE IS A REASON, NOT A CASE TYPE, and these are the values that say so.
 *
 * Measured 2026-10-02 over the replicated copy: eBay records one damage reason
 * (271 rows) and Amazon four (657 + 386 + 71 + 19 = 1,133 rows). A census of all
 * fourteen case-related source tables found no damage table, no damage status
 * and no damage case identifier anywhere, so there is nothing to key a `DAMAGE`
 * case type on.
 */
export const EBAY_DAMAGE_REASONS: ReadonlySet<string> = new Set(["ARRIVED_DAMAGED"]);
export const AMAZON_DAMAGE_REASONS: ReadonlySet<string> = new Set([
  "CR-DAMAGED_BY_FC",
  "CR-DAMAGED_BY_CARRIER",
  "DAMAGED_BY_FC",
  "DAMAGED_BY_CARRIER",
]);

/**
 * THE ONLY AUTHORITATIVE CONFIRMATION OF A REPLACEMENT ANYWHERE IN THE SOURCE.
 *
 * 15 rows read `Replacement` and 1 `ReturnlessReplacement`, out of 15,891.
 *
 * eBay has NONE, and the near-miss is why this set is so small. The source holds
 * a 36-value return-action vocabulary including "seller marked replacement
 * shipped", and a per-return table attaches it to 51 returns — but that table
 * is an AVAILABLE-ACTIONS snapshot, not history. Proof: the action "external
 * claim opened" is attached to 4,076 of 4,082 returns there and appears as an
 * actual activity on ZERO of them, while "seller issued refund" is attached to
 * 78 and appears as an activity on 2,931. Reading those 51 as confirmations
 * would tell a CST agent that 51 customers received a replacement nobody sent.
 */
export const AMAZON_REPLACEMENT_RESOLUTIONS: ReadonlySet<string> = new Set([
  "Replacement",
  "ReturnlessReplacement",
]);

/**
 * ONE ROW PER CASE, shaped to 0022's columns exactly.
 *
 * `sourceStatus` and `lifecycle` are separate members for the reason 0022's
 * header gives at length: on the eBay return store the two source columns are
 * orthogonal and measurably disagree, so a single field would have to pick
 * between two values the source never reconciled.
 */
export type MarketplaceCaseRecord = {
  readonly sourceDatabase: "message_app";
  readonly sourceTable: CaseSourceTable;
  readonly sourceCaseId: string;
  readonly marketplace: "ebay" | "amazon" | "shopify" | "bandq" | "temu";
  readonly subSourceId: number;
  readonly caseType: CaseType;

  readonly orderRef: string | null;
  readonly orderMatchMethod: OrderMatchMethod;
  readonly orderLineItemRef: string | null;
  readonly orderTxnRef: string | null;

  /** Null where the SOURCE records no customer — four of the nine stores. */
  readonly counterpartyRef: string | null;

  readonly lifecycle: CaseLifecycle;
  readonly sourceStatus: string | null;
  readonly sourceState: string | null;
  /** Amazon-fulfilled warehouse outcome. NEVER a case status. */
  readonly sourceDisposition: string | null;
  readonly sourceResolution: string | null;
  readonly sourceReason: string | null;
  readonly sourceReasonFamily: string | null;

  readonly damageReported: boolean;
  readonly replacementConfirmed: boolean;
  readonly escalation: CaseEscalation;

  readonly sellerActionOwed: string | null;
  readonly sellerActionDueAt: string | null;

  readonly quantity: number | null;
  readonly refundAmount: string | null;
  readonly refundCurrency: string | null;

  /** Naive source datetimes, preserved byte-for-byte. */
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly sourceUpdatedAt: string | null;

  readonly sourceRowCount: number;
};

/**
 * Why a case was not imported. Every one is counted and reported; none is
 * repaired with a default.
 *
 * `unmapped_lifecycle` is the one that FAILS THE RUN rather than merely
 * dropping a case: a status outside the reviewed vocabulary means the source has
 * changed shape, and importing the rest as though nothing happened would hide
 * that behind a rejection count nobody reads.
 */
export const CASE_REJECTION_REASONS = [
  "no_case_id",
  "no_storefront",
  "unverified_storefront",
  "no_opened_at",
  "unmapped_case_type",
  "unmapped_lifecycle",
  "superseded_by_inquiries",
] as const;
export type CaseRejectionReason = (typeof CASE_REJECTION_REASONS)[number];

export type CaseRejection = {
  readonly sourceTable: CaseSourceTable;
  /** Null only when the case id itself was missing. */
  readonly sourceCaseId: string | null;
  readonly reason: CaseRejectionReason;
  readonly sourceRowCount: number;
};

/** Tallies rejections by reason, for a report that names what was dropped. */
export function caseRejectionSummary(
  rejections: readonly CaseRejection[],
): Record<string, { cases: number; rows: number }> {
  const out: Record<string, { cases: number; rows: number }> = {};
  for (const rejection of rejections) {
    const entry = out[rejection.reason] ?? { cases: 0, rows: 0 };
    entry.cases += 1;
    entry.rows += rejection.sourceRowCount;
    out[rejection.reason] = entry;
  }
  return out;
}

/**
 * ===========================================================================
 * LIFECYCLE, PER STORE, FROM MEASURED VOCABULARIES ONLY
 * ===========================================================================
 * Each store uses a different column for closure, so there is no single rule.
 * What IS uniform is the discipline: a value outside the reviewed set returns
 * `unmapped` rather than being folded into the nearest plausible state.
 *
 * `unmapped` is distinct from `unknown`. `unknown` means the SOURCE records no
 * usable state — a measured, expected answer. `unmapped` means the source
 * records a state THIS IMPORT HAS NOT REVIEWED, which is a reason to stop.
 */
export type LifecycleVerdict = CaseLifecycle | "unmapped";

/** `current_state`. Closed is exactly 'CLOSED'; the other nine are open states. */
const EBAY_RETURN_CLOSED: ReadonlySet<string> = new Set(["CLOSED"]);
const EBAY_RETURN_ACTIVE: ReadonlySet<string> = new Set([
  "ITEM_READY_TO_SHIP",
  "ITEM_SHIPPED",
  "ITEM_DELIVERED",
  "RMA_PENDING",
  "RETURN_REQUESTED",
  "RETURN_LABEL_PENDING",
  "RETURN_LABEL_PENDING_TIMEOUT",
  "REFUND_INITIATED",
  "REFUND_TIMEOUT",
]);

/** `status` on both inquiry logs. CS_CLOSED is closed BY CUSTOMER SERVICE. */
const INQUIRY_CLOSED: ReadonlySet<string> = new Set(["CLOSED", "CS_CLOSED"]);
const INQUIRY_ACTIVE: ReadonlySet<string> = new Set([
  "OPEN",
  "WAITING_BUYER_RESPONSE",
  "WAITING_SELLER_RESPONSE",
]);

const DISPUTE_CLOSED: ReadonlySet<string> = new Set(["CLOSED"]);
const DISPUTE_ACTIVE: ReadonlySet<string> = new Set(["OPEN"]);

const CANCELLATION_CLOSED: ReadonlySet<string> = new Set(["CLOSED"]);
const CANCELLATION_ACTIVE: ReadonlySet<string> = new Set(["APPROVAL_PENDING"]);

/**
 * Merchant-fulfilled Amazon returns only.
 *
 * `Approved` IS NOT CLOSED, and this is the most consequential mapping in the
 * file. It means the return request was approved; the store records no closure
 * event and no closure date, so 13,315 rows of 13,343 resolve to `unknown`.
 * Mapping them to `closed` would tell an agent a case is finished when the
 * parcel may not have moved.
 */
const AMAZON_FBM_CLOSED: ReadonlySet<string> = new Set(["Closed"]);
const AMAZON_FBM_ACTIVE: ReadonlySet<string> = new Set(["PendingApproval"]);
const AMAZON_FBM_UNKNOWN: ReadonlySet<string> = new Set(["Approved"]);

function verdict(
  value: string | null,
  closed: ReadonlySet<string>,
  active: ReadonlySet<string>,
  unknown: ReadonlySet<string> = new Set(),
): LifecycleVerdict {
  if (value === null || value.trim() === "") return "unknown";
  if (closed.has(value)) return "closed";
  if (active.has(value)) return "active";
  if (unknown.has(value)) return "unknown";
  return "unmapped";
}

/**
 * The lifecycle of one case, from the column its own store uses for closure.
 *
 * `fulfilment` matters for exactly one store: an Amazon-fulfilled return's
 * `status` column holds a WAREHOUSE DISPOSITION rather than a case status
 * (sellable, customer-damaged, reimbursed...), so its lifecycle is `unknown` by
 * construction and the disposition goes to its own field. Measured: 2,577 of
 * 15,920 rows.
 */
export function lifecycleFor(input: {
  readonly sourceTable: CaseSourceTable;
  readonly status: string | null;
  readonly state: string | null;
  readonly closedAt: string | null;
  readonly fulfilment: string | null;
}): LifecycleVerdict {
  switch (input.sourceTable) {
    case "ebay_returns":
      return verdict(input.state, EBAY_RETURN_CLOSED, EBAY_RETURN_ACTIVE);
    case "cancellation":
      return verdict(input.state, CANCELLATION_CLOSED, CANCELLATION_ACTIVE);
    case "inquiries":
    case "cases":
      return verdict(input.status, INQUIRY_CLOSED, INQUIRY_ACTIVE);
    case "payment_disputes":
      return verdict(input.status, DISPUTE_CLOSED, DISPUTE_ACTIVE);
    case "amazon_returns":
      // An Amazon-fulfilled row carries no case status at all.
      if (isAmazonFulfilledByAmazon(input.fulfilment)) return "unknown";
      return verdict(input.status, AMAZON_FBM_CLOSED, AMAZON_FBM_ACTIVE, AMAZON_FBM_UNKNOWN);
    case "shopify_cancellations":
    case "amz_cancellations":
      // Both record the fact of cancellation and no lifecycle beyond it.
      return input.closedAt === null ? "unknown" : "closed";
    case "shopify_returns":
      // Seven columns, none of them a status. `unknown` is the only true answer.
      return "unknown";
  }
}

/** `fulfilment` is 'fba' or 'fbm' on every measured row. */
export function isAmazonFulfilledByAmazon(fulfilment: string | null): boolean {
  return fulfilment !== null && fulfilment.trim().toLowerCase() === "fba";
}

/**
 * Whether the customer reported damage, from the one reason column each store
 * has. Returns false for every store with no damage vocabulary — which is an
 * absence of the signal, and the column it lands in is a boolean because the
 * reason itself is preserved beside it in `sourceReason`.
 */
export function damageReportedBy(sourceTable: CaseSourceTable, reason: string | null): boolean {
  if (reason === null) return false;
  const value = reason.trim();
  if (sourceTable === "ebay_returns") return EBAY_DAMAGE_REASONS.has(value);
  if (sourceTable === "amazon_returns") return AMAZON_DAMAGE_REASONS.has(value);
  return false;
}

/**
 * Whether a replacement is CONFIRMED. One store, one column, two values.
 *
 * Deliberately takes the source table, so a caller cannot pass an eBay
 * return-action value and have it accepted — 0022's
 * ck_marketplace_cases_replacement_source would reject the row anyway, and this
 * makes the refusal happen before the database is involved.
 */
export function replacementConfirmedBy(
  sourceTable: CaseSourceTable,
  resolution: string | null,
): boolean {
  if (sourceTable !== "amazon_returns" || resolution === null) return false;
  return AMAZON_REPLACEMENT_RESOLUTIONS.has(resolution.trim());
}

/**
 * Escalation, from whichever flag its store records.
 *
 * `not_recorded` for the six stores with no escalation concept — the state that
 * says the source carries no signal, as distinct from a signal meaning no.
 * 0022's ck_marketplace_cases_escalation_source makes anything else
 * unrepresentable for those six.
 */
export function escalationFor(input: {
  readonly sourceTable: CaseSourceTable;
  readonly status: string | null;
  readonly isCase: number | null;
  readonly escDate: string | null;
  readonly buyerEsc: number | null;
  readonly sellerEsc: number | null;
  readonly azClaim: number | null;
}): CaseEscalation {
  switch (input.sourceTable) {
    case "inquiries":
      // 0021's rule, reused verbatim.
      return input.isCase === 1 || (input.escDate !== null && input.escDate.trim() !== "")
        ? "escalated"
        : "not_escalated";
    case "ebay_returns": {
      // Three signals, any of which is an escalation. `status = 'ESCALATED'`
      // coexists with a CLOSED lifecycle on all 150 measured rows, which is why
      // this cannot be derived from the lifecycle.
      const escalated =
        input.status === "ESCALATED" || input.buyerEsc === 1 || input.sellerEsc === 1;
      if (escalated) return "escalated";
      // The flags are NOT NULL on every header row, so "both zero" is a real no.
      return input.buyerEsc === null && input.sellerEsc === null
        ? "not_recorded"
        : "not_escalated";
    }
    case "amazon_returns":
      if (input.azClaim === 1) return "escalated";
      return input.azClaim === null ? "not_recorded" : "not_escalated";
    default:
      return "not_recorded";
  }
}

/**
 * The case kind, from the store and — for the two inquiry logs only — its own
 * type column.
 *
 * Returns null for an unrecognised value, and the caller rejects and counts the
 * case. 58 inquiry cases carry no type on any row (measured), and they are
 * rejected rather than given one.
 */
export function caseTypeFor(
  sourceTable: CaseSourceTable,
  rawType: string | null,
): CaseType | null {
  switch (sourceTable) {
    case "ebay_returns":
    case "amazon_returns":
      return "RETURN";
    case "cancellation":
    case "amz_cancellations":
    case "shopify_cancellations":
      return "CANCELLATION";
    case "payment_disputes":
      return "PAYMENT_DISPUTE";
    // The Shopify store records a refund, not a return case. See CASE_TYPES.
    case "shopify_returns":
      return "REFUND";
    case "inquiries":
    case "cases": {
      if (rawType === null) return null;
      const value = rawType.trim();
      if (value === "ITEM_NOT_RECEIVED") return "ITEM_NOT_RECEIVED";
      if (value === "RETURN") return "RETURN";
      return null;
    }
  }
}

/** The marketplace each store belongs to, verified in Tasks 1-3. */
export function marketplaceFor(sourceTable: CaseSourceTable): MarketplaceCaseRecord["marketplace"] {
  switch (sourceTable) {
    case "amazon_returns":
    case "amz_cancellations":
      return "amazon";
    case "shopify_returns":
    case "shopify_cancellations":
      return "shopify";
    default:
      return "ebay";
  }
}
