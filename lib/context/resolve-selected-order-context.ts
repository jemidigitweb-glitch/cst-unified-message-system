import "server-only";

import { ALLOWED_FACT_NAMES } from "@/lib/context/resolve-order-context";
import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import type { VerifiedFact } from "@/lib/domain/draft";
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
