import "server-only";

import { getContextSnapshot } from "@/lib/repositories/context-snapshot-repository";
import { listEligibleCustomerOrders } from "@/lib/repositories/customer-order-fallback-repository";
import { findCandidateEbayOrders } from "@/lib/repositories/order-context-repository";

import { isUnresolvedReference } from "@/lib/domain/conversation-reference";

import type { ConversationForManualSelection } from "@/lib/context/resolve-selected-order-context";

/**
 * WHICH ORDER, IF ANY, A CONVERSATION IS ALLOWED TO PRODUCE AN INVOICE FOR.
 *
 * ------------------------------------------------------------------------
 * THIS IS THE ACCESS CONTROL, NOT A CONVENIENCE
 * ------------------------------------------------------------------------
 * The invoice endpoint must never accept an order id. `order_management.orders`
 * holds 1,101,548 rows keyed by a dense integer, so a route that took one would
 * let anyone walk 1..1.1M and download every customer's invoice in the
 * business. The browser therefore names a CONVERSATION, and the order is
 * DERIVED here from that conversation's own buyer, storefront and listing —
 * exactly the keys the strict matcher already uses.
 *
 * That is the same capability model the order-context and draft routes already
 * enforce, reproduced rather than reinvented: a caller can only ever reach the
 * orders their conversation genuinely matches. There is no new authentication
 * mechanism here because the application has none to extend — see the note on
 * the absent user identity in `resolve-selected-order-context.ts`.
 *
 * ------------------------------------------------------------------------
 * THE PRECEDENCE IS THE ROUTES' OWN, IN THE SAME ORDER
 * ------------------------------------------------------------------------
 *   1. The strict matcher found exactly one order   -> that order.
 *   2. It found several (ambiguous) and a reviewer picked one of THEM -> that.
 *   3. It found none, the snapshot says `no_order`, and a reviewer picked one
 *      of the eligible orders -> that.
 *   4. Anything else -> null.
 *
 * AMBIGUOUS WITHOUT A CHOICE IS NULL. Several genuine purchases of the same
 * listing by the same buyer is precisely the case where guessing produces a
 * real invoice for the wrong order, which reads exactly like the right one.
 * There is no ranking here, no newest, no first.
 *
 * A SELECTION IS VALIDATED BY MEMBERSHIP, NEVER TRUSTED. The order number from
 * the query string is only ever used to FILTER a set already fetched by the
 * conversation's own keys. It is never put into a lookup: 655 order numbers are
 * reused across 1,608 source rows, so a query keyed on one can return a
 * different customer's order. The row id returned here is read off the row that
 * the membership check matched.
 */

type SourceQueryable = Parameters<typeof findCandidateEbayOrders>[0];
type SnapshotReadable = Parameters<typeof getContextSnapshot>[0];

/** eBay, on `sub_source.source_id` — a platform check, never a region guess. */
const EBAY_MARKETPLACE = "ebay";

/**
 * The stable source row id of the one order this conversation may invoice, or
 * null.
 *
 * Null is the answer for every case that is not an unambiguous single order:
 * a non-eBay conversation, a conversation missing a matching key, an ambiguous
 * conversation with no choice made, a choice naming an order the reviewer was
 * never offered, and a conversation the matcher placed but whose snapshot does
 * not permit a manual override.
 */
export async function resolveInvoiceOrderRowId(
  sourceClient: SourceQueryable,
  appClient: SnapshotReadable,
  conversation: ConversationForManualSelection,
  selectedOrderNumber: string | null,
): Promise<string | null> {
  if (conversation.marketplace !== EBAY_MARKETPLACE) return null;
  if (conversation.subSourceId === null) return null;
  // The ungrouped sentinel, and a blank. The sibling resolvers check only the
  // sentinel; a blank buyer would reach the source as `ebay_buyer_id = ''` and
  // match nothing, so this is belt-and-braces rather than a fix — but a value
  // that cannot identify a customer has no business reaching a query that
  // decides whose invoice a caller may download.
  if (conversation.counterpartyRef.trim() === "") return null;
  if (isUnresolvedReference(conversation.counterpartyRef)) return null;

  const chosen =
    selectedOrderNumber !== null && selectedOrderNumber.trim() !== ""
      ? selectedOrderNumber
      : null;

  /* ---- 1 and 2: the strict matcher's own set ---- */
  if (conversation.listingItemRef !== null && conversation.listingItemRef.trim() !== "") {
    const candidates = await findCandidateEbayOrders(sourceClient, {
      subSourceId: conversation.subSourceId,
      itemId: conversation.listingItemRef,
      buyerUsername: conversation.counterpartyRef,
    });

    // Exactly one match is the verified order. Nothing may override it — not a
    // query string, not a reviewer's stale selection.
    if (candidates.length === 1) return candidates[0]!.orderRowId;

    if (candidates.length > 1) {
      // AMBIGUOUS. Without a choice this refuses; with one it must name an
      // order that is actually in this conversation's candidate set.
      if (chosen === null) return null;
      const matches = candidates.filter((order) => order.orderNumber === chosen);
      return matches.length === 1 ? matches[0]!.orderRowId : null;
    }
  }

  /* ---- 3: manual selection, only where the matcher placed nothing ---- */
  if (chosen === null) return null;

  // The matcher speaks first, read from the stored resolution exactly as
  // `resolveManuallySelectedOrderContext` does. `single_order` is answered and
  // `ambiguous` belongs to the branch above.
  const snapshot = await getContextSnapshot(appClient, conversation.id);
  if (snapshot?.resolution !== "no_order") return null;

  const eligible = await listEligibleCustomerOrders(sourceClient, {
    buyerUsername: conversation.counterpartyRef,
    subSourceId: conversation.subSourceId,
    currentListingItemRef: conversation.listingItemRef,
  });

  const matches = eligible.filter((order) => order.orderNumber === chosen);
  return matches.length === 1 ? matches[0]!.orderRowId : null;
}
