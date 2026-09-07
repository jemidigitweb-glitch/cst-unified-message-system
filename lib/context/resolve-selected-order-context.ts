import "server-only";

import { ALLOWED_FACT_NAMES } from "@/lib/context/resolve-order-context";
import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import {
  type EligibleCustomerOrder,
  MANUAL_SELECTION_SOURCE,
} from "@/lib/domain/customer-order-fallback";
import type { VerifiedFact } from "@/lib/domain/draft";
import { displayableListingUrl } from "@/lib/domain/listing-link";
import {
  type Writable as SnapshotReadable,
  getContextSnapshot,
} from "@/lib/repositories/context-snapshot-repository";
import { listEligibleCustomerOrders } from "@/lib/repositories/customer-order-fallback-repository";
import { findListingUrl } from "@/lib/repositories/ebay-listing-repository";
import {
  type CandidateOrder,
  type Queryable as SourceQueryable,
  findCandidateEbayOrders,
} from "@/lib/repositories/order-context-repository";

/**
 * The verified facts for the ONE order a CST reviewer picked, when several
 * matched.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE RESOLVER. `resolveEbayOrderContext`
 * answers "which order does this conversation prove it is about", and its
 * answer for several matches is, correctly, none — it has no basis to choose
 * and must not invent one. This answers a different question: "a human looked
 * at the matches and said it is this one; what are that order's facts?" The
 * two must not be the same function, because the day they are, the resolver
 * acquires a way to pick, and the whole never-guesses property depends on it
 * not having one. `resolve-order-context.ts` is imported here for its fact
 * vocabulary and is otherwise untouched.
 *
 * THE SELECTION IS AN INPUT, NEVER A CONCLUSION. Nothing here is written down.
 * No snapshot is updated, no `verification_method` changes, no resolution
 * flips: the schema reserves `user_confirmed` for a confirmation that names
 * the confirming user, and this application has no user identity to name. So
 * a selection grounds one generation and nothing more — which is exactly what
 * a helper with no save button should do, and it is why this needed no
 * migration.
 *
 * THE ORDER MUST BE ONE THE RESOLVER ACTUALLY MATCHED. The selected order
 * number is checked against `findCandidateEbayOrders` — the same query, with
 * the same keys, that decided the conversation was ambiguous in the first
 * place. An order number that is not in that set produces no facts at all,
 * so a hand-edited request cannot ground a draft in an arbitrary order, or in
 * another customer's.
 *
 * ONE ORDER, NEVER A BLEND. Exactly one candidate is matched by order number,
 * and its own values become the facts. Nothing is filled in from a sibling
 * order, and if two candidates somehow shared an order number, this returns
 * nothing rather than picking one.
 */

export type ConversationForSelection = {
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly counterpartyRef: string;
  readonly listingItemRef: string | null;
};

/** Joins the non-empty address lines into one line, matching the resolver's own fact. */
function formatAddress(order: CandidateOrder): string | null {
  const parts = [
    order.addressLine1,
    order.addressLine2,
    order.addressLine3,
    order.city,
    order.region,
    order.postcode,
  ].filter((part): part is string => part !== null && part.trim() !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * The chosen order's data, as the same eight facts the resolver would produce
 * for a single match — same names, same order, same omit-when-empty rule.
 *
 * Filtered through `ALLOWED_FACT_NAMES` as a last line of defence: if this
 * ever drifts from the resolver's vocabulary, the extra fact is dropped rather
 * than reaching a prompt under a name nothing else in the system knows.
 */
function factsFromOrder(order: CandidateOrder): VerifiedFact[] {
  const facts: [string, string | null][] = [
    ["order_number", order.orderNumber],
    ["order_status", order.orderStatus],
    ["order_date", order.orderDate],
    ["tracking_number", order.trackingNumber],
    ["delivery_courier", order.carrierName],
    ["delivery_address", formatAddress(order)],
    ["sku", order.sku],
    ["product_title", order.productTitle],
  ];
  const allowed = new Set<string>(ALLOWED_FACT_NAMES);
  return facts
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1].trim() !== "")
    .filter(([name]) => allowed.has(name))
    .map(([name, value]) => ({ name, value }));
}

/**
 * The eight verified facts for the selected order, or none.
 *
 * Returns an empty list — the same "no order context" the caller already
 * handles — for every case that is not an unambiguous human choice among
 * orders this conversation genuinely matched: a non-eBay conversation, a
 * conversation missing a matching key, an order number that matched nothing,
 * or an order number that matched more than one candidate row.
 */
export async function resolveSelectedOrderContext(
  sourceClient: SourceQueryable,
  conversation: ConversationForSelection,
  selectedOrderNumber: string,
): Promise<VerifiedFact[]> {
  if (conversation.marketplace !== "ebay") return [];
  if (selectedOrderNumber.trim() === "") return [];
  if (
    conversation.subSourceId === null ||
    conversation.listingItemRef === null ||
    conversation.listingItemRef.trim() === "" ||
    isUnresolvedReference(conversation.counterpartyRef)
  ) {
    return [];
  }

  const candidates = await findCandidateEbayOrders(sourceClient, {
    subSourceId: conversation.subSourceId,
    itemId: conversation.listingItemRef,
    buyerUsername: conversation.counterpartyRef,
  });

  const matches = candidates.filter((order) => order.orderNumber === selectedOrderNumber);
  if (matches.length !== 1) return [];

  return factsFromOrder(matches[0]!);
}

/* ------------------------------------------------------------------------- *
 * MANUAL SELECTION, WHERE THE MATCHER FOUND NOTHING
 * ------------------------------------------------------------------------- */

/**
 * The verified facts for an order a reviewer picked on a conversation the
 * strict matcher could not place at all.
 *
 * ------------------------------------------------------------------------
 * WHY IT IS SEPARATE FROM THE AMBIGUOUS PATH ABOVE
 * ------------------------------------------------------------------------
 * The two validate against DIFFERENT SETS, and merging them would quietly widen
 * one of them. `resolveSelectedOrderContext` checks a choice against
 * `findCandidateEbayOrders` — buyer + storefront + LISTING — which is exactly
 * right for an ambiguous conversation, where every candidate is a genuine
 * purchase OF THIS LISTING. That set is empty for a `no_order` conversation, so
 * reusing it would make manual selection impossible; but widening it would let
 * an ambiguous conversation be answered with an order the matcher never
 * offered. So each path keeps its own set, and the STORED RESOLUTION decides
 * which path applies.
 *
 * GATED ON `no_order`, READ FROM THE SNAPSHOT. A conversation the matcher
 * answered cannot be overridden, and an ambiguous one keeps the behaviour it
 * already has.
 *
 * ONE ORDER, NEVER A BLEND, and never a rank. The selection must match exactly
 * one eligible order by number; zero or several produce nothing. The eligible
 * list's newest-first sort is for reading only — nothing here reads position,
 * and validation is membership of the set, not rank within it.
 *
 * NOTHING IS WRITTEN. No snapshot, no `verification_method`, no resolution
 * flip. The schema reserves `user_confirmed` for a confirmation that NAMES the
 * confirming user, and this application still has no user identity to name, so
 * a selection grounds the request that carries it and nothing more.
 */
export type ConversationForManualSelection = ConversationForSelection & {
  readonly id: string;
};

/** Provenance and relationship names, so callers and tests share one spelling. */
export const ORDER_CONTEXT_SOURCE_FACT = "order_context_source";
export const ORDER_LISTING_RELATIONSHIP_FACT =
  "order_listing_matches_current_message_listing";

/**
 * TWO NAMING RULES, AND EACH PREVENTS A DIFFERENT MERGE.
 *
 * ORDER, SHIPMENT AND ADDRESS FACTS TAKE THE NORMAL NAMES. They are true of the
 * order whatever it contains, a reviewer has confirmed this is the order in
 * question, and the whole point of the flow is that a delivery question can now
 * be answered — so `order_status`, `tracking_number` and `delivery_courier` are
 * exactly what they say, and `dispatchState()` may read them.
 *
 * PRODUCT IDENTITY IS NAMED BY WHETHER IT IS THE SAME PRODUCT. Where the
 * selected order carries this conversation's listing, `sku` and `product_title`
 * are the current product and take the normal names. Where it does NOT, the
 * same values would be a different product, and under those names they would
 * drive the SOT catalogue lookup and DROP the current listing's title — so they
 * are emitted as `customer_order_*` instead. Same data, different claim.
 */
function manualSelectionFacts(
  order: EligibleCustomerOrder,
  listingUrl: string | null,
): VerifiedFact[] {
  const sameProduct = order.listingMatch;

  const facts: [string, string | null][] = [
    [ORDER_CONTEXT_SOURCE_FACT, MANUAL_SELECTION_SOURCE],
    ["order_number", order.orderNumber],
    ["order_status", order.orderStatus],
    ["order_date", order.orderDate],
    ["order_storefront", order.storefrontName],

    /* ---- shipment, exactly as recorded; nothing inferred ---- */
    ["order_shipment_status", order.shipmentStatus],
    ["tracking_number", order.trackingNumber],
    ["delivery_courier", order.carrier],
    ["delivery_carrier_service", order.carrierService],
    ["order_shipment_created_at", order.shipmentCreatedAt],
    ["order_dispatched_at", order.shippedAt],
    ["order_shipment_cancelled_at", order.shipmentCancelledAt],
    ["delivery_address", order.deliveryAddress],

    /* ---- the product, named by whether it is this message's product ---- */
    [sameProduct ? "sku" : "customer_order_sku", order.orderSku],
    [sameProduct ? "product_title" : "customer_order_product_title", order.orderProductTitle],
    ["customer_order_listing_item_id", sameProduct ? null : order.orderItemRef],
    ["customer_order_listing_url", sameProduct ? null : listingUrl],
    [
      "customer_order_line_count",
      order.orderLineCount > 1 ? String(order.orderLineCount) : null,
    ],

    /* ---- the relationship, computed here and never left to the model ---- */
    [ORDER_LISTING_RELATIONSHIP_FACT, sameProduct ? "yes" : "no"],
  ];

  return facts
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1].trim() !== "")
    .map(([name, value]) => ({ name, value }));
}

export async function resolveManuallySelectedOrderContext(
  sourceClient: SourceQueryable,
  appClient: SnapshotReadable,
  conversation: ConversationForManualSelection,
  selectedOrderNumber: string,
): Promise<VerifiedFact[]> {
  if (conversation.marketplace !== "ebay") return [];
  if (selectedOrderNumber.trim() === "") return [];
  if (conversation.subSourceId === null) return [];
  if (isUnresolvedReference(conversation.counterpartyRef)) return [];

  // The matcher speaks first. Only a conversation it could not place at all is
  // open to a manual choice; `single_order` is answered and `ambiguous` belongs
  // to the path above.
  const snapshot = await getContextSnapshot(appClient, conversation.id);
  if (snapshot?.resolution !== "no_order") return [];

  const eligible = await listEligibleCustomerOrders(sourceClient, {
    buyerUsername: conversation.counterpartyRef,
    subSourceId: conversation.subSourceId,
    currentListingItemRef: conversation.listingItemRef,
  });

  // Membership, not rank. An order number the reviewer was never offered — a
  // hand-edited request, another customer's order, another storefront's —
  // is not in this set and produces nothing.
  const matches = eligible.filter((order) => order.orderNumber === selectedOrderNumber);
  if (matches.length !== 1) return [];
  const order = matches[0]!;

  /*
   * The ORDER's own listing URL, keyed on the ORDER's item and storefront —
   * never the conversation's. `displayableListingUrl` requires the path to end
   * in the reference it is shown against, so a current-message URL could not
   * pass here even if handed to it. Skipped for a multi-line order, where no
   * single item is named.
   */
  let listingUrl: string | null = null;
  if (!order.listingMatch && order.orderItemRef !== null) {
    const stored = await findListingUrl(sourceClient, {
      itemId: order.orderItemRef,
      subSourceId: order.storefrontId,
    });
    listingUrl = displayableListingUrl(stored, order.orderItemRef);
  }

  return manualSelectionFacts(order, listingUrl);
}
