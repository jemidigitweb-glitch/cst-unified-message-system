import "server-only";

import {
  type CustomerHistoryFacts,
  type RepeatCustomerWarning,
  evaluateRepeatCustomerWarning,
  known,
  unavailable,
  verifyCustomerIdentity,
} from "@/lib/domain/repeat-customer-warning";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import type { Marketplace } from "@/lib/domain/marketplace";
import {
  type Queryable,
  countPreviousCases,
  countPreviousConversations,
  countPreviousRefundedOrders,
} from "@/lib/repositories/customer-history-repository";

/**
 * Assembles the Repeat-Customer Warning for one conversation.
 *
 * READ-ONLY, AND POSTGRESQL ONLY. Three SELECTs, no write, and no MySQL
 * client anywhere in the call graph. Unlike `resolve-order-context.ts`, this
 * resolver cannot even trigger an incidental cache write: it reads no context
 * snapshot and writes none.
 *
 * ------------------------------------------------------------------------
 * THE BOUNDARY IS THE CONVERSATION'S OWN TIMESTAMP, NEVER `now()`
 * ------------------------------------------------------------------------
 * Every lookup is bounded by `conversation.firstSourceTs` — the moment the
 * customer's first message on THIS thread arrived at the source.
 *
 * Using the server clock instead would be wrong in a way that is invisible on
 * a fresh conversation and silently wrong on an old one: opening a thread from
 * March today would count everything that happened between March and now as
 * "previous history" for it, so the warning an agent reads would depend on
 * WHEN THEY OPENED IT rather than on what the customer had done when they
 * wrote. Two agents reading the same thread a week apart would see different
 * warnings.
 *
 * `first_source_ts` is a naive `timestamp` carrying a preserved source value,
 * and so are `event_at` and `order_date` on the other side of each comparison.
 * All three are compared directly with no timezone conversion, which is the
 * only safe thing to do with three naive values of unknown zone — converting
 * any one of them would invent an offset. See migration 0001 on why source
 * timestamps are stored naive.
 *
 * TIES RESOLVE TO "NOT PREVIOUS". Every comparison is strictly `<`. An event
 * sharing this conversation's exact first-message timestamp is not evidence of
 * earlier history, so the ambiguous case falls on the side that cannot invent
 * a warning.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS CANNOT DO, STATED BECAUSE IT IS A REAL LIMITATION
 * ------------------------------------------------------------------------
 * There is no deterministic link between a conversation and a case. 0021
 * deliberately holds no foreign key to `conversations` (a buyer's history is
 * most valuable before their next conversation exists), and the source case
 * tables carry no message or thread reference.
 *
 * So the timestamp is the ONLY deterministic separator available, and it is
 * imperfect in one direction: a case opened by this same customer about this
 * same issue a few minutes BEFORE they messaged would be counted as previous
 * history. It is not inferred away — guessing which prior case is "the same
 * issue" from timing and type would be exactly the manufactured association
 * this feature must not make. The honest position is that the count is "cases
 * on record before this conversation began", and the interface says precisely
 * that.
 *
 * ------------------------------------------------------------------------
 * ONE STOREFRONT
 * ------------------------------------------------------------------------
 * `sub_source_id` is in every predicate. Cross-storefront aggregation is not
 * approved, so it is not implemented — and the `HistoryScope` type carries the
 * storefront so adding it later means changing a shape deliberately rather
 * than forgetting a filter.
 *
 * ------------------------------------------------------------------------
 * A FAILING SIGNAL DEGRADES, IT DOES NOT ZERO
 * ------------------------------------------------------------------------
 * The refund count reads the marketplace source, which is a different database
 * from the other two and can be unavailable on its own. Its failure is caught
 * and reported as `unavailable` — never as 0 — so a source outage cannot make
 * a customer with six refunds render as having none. The two `cst_app` reads
 * are allowed to fail the whole request, because if the application database
 * is unreachable there is nothing honest to show at all.
 */

export type ConversationForCustomerHistory = {
  readonly id: string;
  readonly marketplace: Marketplace;
  readonly subSourceId: number | null;
  readonly counterpartyRef: string;
  /** Naive source timestamp of the first message on this thread. */
  readonly firstSourceTimestamp: string;
};

export type CustomerHistoryResult = RepeatCustomerWarning & {
  /**
   * Why no warning could be evaluated, when `available` is false. Null when
   * the lookup ran. Deliberately a reason an interface can act on rather than
   * a message it must display verbatim.
   */
  readonly unavailableReason:
    | "unsupported_marketplace"
    | "platform_sender"
    | "unresolved_reference"
    | "missing_identity"
    | null;
  /**
   * When the imported case history was last confirmed against its source.
   * Null when this customer has no case history in range — which is not the
   * same as the import never having run.
   */
  readonly historyAsOf: string | null;
};

const NO_FACTS: CustomerHistoryFacts = {
  previousConversations: unavailable,
  previousRefundedOrders: unavailable,
  previousFormalCases: unavailable,
  previousPaymentDisputes: unavailable,
  previousEscalations: unavailable,
};

/**
 * The warning for one conversation, or an explicit unavailable state.
 *
 * `sourceClient` is optional: without it the refund signal reports
 * `unavailable` and the other four still evaluate. That is what lets a caller
 * serve the warning when the marketplace source is down, rather than serving
 * nothing or — far worse — serving zeros.
 */
export async function resolveCustomerHistory(
  appClient: Queryable,
  sourceClient: Queryable | null,
  conversation: ConversationForCustomerHistory,
  capability: Pick<MarketplaceCapability, "counterpartyIdentityVerified">,
): Promise<CustomerHistoryResult> {
  const identity = verifyCustomerIdentity(conversation, capability);
  if (identity.state !== "verified") {
    return {
      ...evaluateRepeatCustomerWarning(NO_FACTS, { available: false }),
      unavailableReason: identity.state,
      historyAsOf: null,
    };
  }

  // Non-null by the identity check above; narrowed here for the scope type.
  const subSourceId = conversation.subSourceId!;
  const scope = {
    marketplace: conversation.marketplace,
    subSourceId,
    counterpartyRef: identity.counterpartyRef,
    before: conversation.firstSourceTimestamp,
    excludeConversationId: conversation.id,
  };

  /*
   * The two application reads run together — they are independent single-row
   * aggregates on one pool, which is the same two-statement fan-out
   * `/api/performance/summary` already makes. The refund read is NOT in this
   * Promise.all: it is on a different pool and must be able to fail alone.
   */
  const [conversations, cases] = await Promise.all([
    countPreviousConversations(appClient, scope),
    countPreviousCases(appClient, scope),
  ]);

  let refundedOrders = unavailable;
  if (sourceClient !== null) {
    try {
      refundedOrders = known(await countPreviousRefundedOrders(sourceClient, scope));
    } catch (cause) {
      /*
       * Logged and reported as unavailable, never as zero. A customer with six
       * refunds must not read as a customer with none because the marketplace
       * source was briefly unreachable.
       */
      console.error("[customer-history] refunded-order count unavailable", cause);
      refundedOrders = unavailable;
    }
  }

  const facts: CustomerHistoryFacts = {
    previousConversations: known(conversations),
    previousRefundedOrders: refundedOrders,
    previousFormalCases: known(cases.formalCases),
    previousPaymentDisputes: known(cases.paymentDisputes),
    previousEscalations: known(cases.escalations),
  };

  return {
    ...evaluateRepeatCustomerWarning(facts, { available: true }),
    unavailableReason: null,
    historyAsOf: cases.historyAsOf,
  };
}
