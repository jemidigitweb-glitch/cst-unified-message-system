import "server-only";

/**
 * Assembles the Case Detection Indicator for one conversation.
 *
 * READ-ONLY, AND POSTGRESQL ONLY. Four SELECTs against the application
 * database, no write of any kind, and no MySQL client anywhere in the call
 * graph. Unlike `resolve-order-context.ts` this resolver cannot even trigger an
 * incidental cache write: it reads the context snapshot and writes none.
 *
 * ---------------------------------------------------------------------------
 * IT RESOLVES NO ORDER. IT READS THE ONE ALREADY RESOLVED
 * ---------------------------------------------------------------------------
 * The order a case is matched against is whatever
 * `cst_app.context_snapshots.order_number` holds for this conversation — the
 * answer the existing order resolver reached, on its own evidence, and wrote
 * there. Nothing in this module matches an order, ranks a candidate, compares a
 * product title or a SKU, or consults a model. It has exactly two keys: an
 * order reference that another component verified, and a marketplace buyer
 * handle.
 *
 * `order_number` is non-null ONLY on a single-order snapshot —
 * `ck_context_snapshots_unresolved_has_no_order` in migration 0001 forbids an
 * unresolved snapshot from carrying one — so "there is an order to match on" is
 * a property of the schema here rather than a resolution value this module has
 * to interpret.
 *
 * THE KNOWN GAP, STATED RATHER THAN PAPERED OVER: a reviewer who manually picks
 * an order in the sidebar changes what the ORDER panel shows, and that choice is
 * held in the browser and never stored. It therefore does not reach this
 * resolver, and the case list for such a conversation is the customer's own
 * cases rather than that order's. Making it travel would mean re-validating the
 * chosen order against the live source on every case lookup, which is a source
 * read this feature was built specifically to avoid.
 *
 * ---------------------------------------------------------------------------
 * ABSENCE OF EVIDENCE IS REPORTED AS ABSENCE OF EVIDENCE
 * ---------------------------------------------------------------------------
 * The five states in `CasePanelState` exist because "no cases on screen" has
 * four different causes and three of them say nothing whatever about the
 * customer. A failed read, a marketplace whose stores were never imported, and
 * a conversation with no key to search on must never render as the fourth —
 * a published snapshot that was searched and held nothing.
 *
 * Per-store coverage travels with the answer for the same reason: a marketplace
 * can be partly imported, and a list drawn from four of five stores is not a
 * complete answer however many cases it contains.
 */

import {
  type CaseCoverage,
  type CasePanelState,
  caseCoverageFor,
  caseSnapshotIsStale,
} from "@/lib/domain/marketplace-case-display";
import type { Marketplace } from "@/lib/domain/marketplace";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import { verifyCustomerIdentity } from "@/lib/domain/repeat-customer-warning";
import { getContextSnapshot } from "@/lib/repositories/context-snapshot-repository";
import {
  type CaseList,
  type Queryable,
  findCasesForCustomer,
  findCasesForOrder,
  lastPublishedByStore,
} from "@/lib/repositories/marketplace-case-repository";

export type ConversationForCases = {
  readonly id: string;
  readonly marketplace: Marketplace;
  readonly subSourceId: number | null;
  readonly counterpartyRef: string;
};

export type CaseContextResult = {
  readonly state: CasePanelState;
  /** Cases on the order this conversation already resolved to. */
  readonly orderCases: CaseList;
  /** This customer's cases on any OTHER order of the same storefront. */
  readonly customerCases: CaseList;
  /** The order the first list was matched on, so the panel can name it. */
  readonly matchedOrderRef: string | null;
  readonly coverage: CaseCoverage;
  /** True when the oldest covered store is older than the staleness window. */
  readonly stale: boolean;
};

const EMPTY_LIST: CaseList = { cases: [], hasMore: false };

/**
 * The indicator for one conversation.
 *
 * `now` is a parameter, not `new Date()` reached for inside, so the staleness
 * decision is deterministic in a test and identical on both sides of the wire.
 *
 * THE TWO LOOKUPS RUN TOGETHER but are not interchangeable: an order match is
 * evidence about THIS conversation, a customer match is evidence about this
 * person. They are returned as two lists and the panel labels them separately,
 * because collapsing them would let a case about a different purchase read as
 * the one the customer is writing about — the same mistake the order panel's
 * listing-mismatch notice exists to prevent.
 */
export async function resolveCaseContext(
  appClient: Queryable,
  conversation: ConversationForCases,
  capability: Pick<MarketplaceCapability, "counterpartyIdentityVerified">,
  now: Date,
): Promise<CaseContextResult> {
  const publishedByStore = await lastPublishedByStore(appClient);
  const coverage = caseCoverageFor(conversation.marketplace, publishedByStore);
  const stale = caseSnapshotIsStale(coverage.asOf, now);

  /*
   * NOTHING HAS EVER BEEN IMPORTED FOR THIS MARKETPLACE, so no store was
   * searched and no absence may be claimed. Returned before either lookup
   * rather than after an empty one, so the state cannot be reached by a query
   * that happened to find nothing.
   */
  if (coverage.storesCovered.length === 0) {
    return {
      state: "never_imported",
      orderCases: EMPTY_LIST,
      customerCases: EMPTY_LIST,
      matchedOrderRef: null,
      coverage,
      stale,
    };
  }

  /*
   * The order this conversation already resolved to. The snapshot's own
   * `sub_source_id` is used for the order match — it is the storefront that
   * order was verified against — while the customer match uses the
   * conversation's, which is the storefront the message arrived on. They are
   * the same value on every row today; keeping them apart means a future
   * divergence is a different scope rather than a silently wrong join.
   */
  const snapshot = await getContextSnapshot(appClient, conversation.id);
  const matchedOrderRef = snapshot?.order_number ?? null;
  const orderSubSourceId = snapshot?.sub_source_id ?? conversation.subSourceId;

  /*
   * The same definition of "a verified customer" the Repeat-Customer Warning
   * uses, imported rather than rewritten. Two readings of what counts as a real
   * buyer handle would eventually disagree in front of a reviewer, and one of
   * the two would be matching cases against a platform sender.
   */
  const identity = verifyCustomerIdentity(conversation, capability);
  const counterpartyRef = identity.state === "verified" ? identity.counterpartyRef : null;

  const canMatchOrder = matchedOrderRef !== null && orderSubSourceId !== null;
  const canMatchCustomer = counterpartyRef !== null && conversation.subSourceId !== null;

  if (!canMatchOrder && !canMatchCustomer) {
    return {
      state: "no_search_key",
      orderCases: EMPTY_LIST,
      customerCases: EMPTY_LIST,
      matchedOrderRef: null,
      coverage,
      stale,
    };
  }

  const [orderCases, customerCases] = await Promise.all([
    canMatchOrder
      ? findCasesForOrder(appClient, {
          marketplace: conversation.marketplace,
          subSourceId: orderSubSourceId!,
          orderRef: matchedOrderRef!,
        })
      : Promise.resolve(EMPTY_LIST),
    canMatchCustomer
      ? findCasesForCustomer(appClient, {
          marketplace: conversation.marketplace,
          subSourceId: conversation.subSourceId!,
          counterpartyRef: counterpartyRef!,
          /*
           * Excluded from the customer list, so the two are disjoint and no
           * case can be presented twice under two different headings.
           */
          orderRef: matchedOrderRef,
        })
      : Promise.resolve(EMPTY_LIST),
  ]);

  const found = orderCases.cases.length > 0 || customerCases.cases.length > 0;

  return {
    state: found ? "found" : "none_found",
    orderCases,
    customerCases,
    matchedOrderRef: canMatchOrder ? matchedOrderRef : null,
    coverage,
    stale,
  };
}
