import "server-only";

import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import type { SourceOrderDetail } from "@/lib/domain/order";
import {
  type Queryable as DisplayQueryable,
  findOrderDetailsForDisplay,
} from "@/lib/repositories/order-display-repository";

/**
 * Loads the orders behind a conversation, for the sidebar only.
 *
 * DELIBERATELY NOT THE RESOLVER, and deliberately not a second one. It
 * resolves nothing, decides nothing, writes no snapshot, and returns no
 * `VerifiedFact` — it answers one question, "what does the source say matched
 * this conversation", and hands the rows to a panel. Every judgement about
 * what a draft may state stays in `resolveEbayOrderContext`, which this does
 * not call, import, or influence.
 *
 * THE SAME GUARDS, FOR A DIFFERENT REASON. eBay only, and only where the
 * conversation carries a sub-account, a listing reference and a verified buyer
 * identity — not because showing more would be unsafe here, but because
 * without those three the query has no key to match on and would either return
 * nothing or, worse, every order for a blank buyer.
 *
 * SEVERAL ROWS IS A NORMAL ANSWER. A buyer who ordered the same listing three
 * times gets three rows, and all three are returned. Nothing here picks one,
 * ranks them, or folds them together.
 */

export type ConversationForDisplay = {
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly counterpartyRef: string;
  readonly listingItemRef: string | null;
};

export async function loadOrderDisplayDetails(
  sourceClient: DisplayQueryable,
  conversation: ConversationForDisplay,
): Promise<SourceOrderDetail[]> {
  if (conversation.marketplace !== "ebay") return [];
  if (
    conversation.subSourceId === null ||
    conversation.listingItemRef === null ||
    conversation.listingItemRef.trim() === "" ||
    isUnresolvedReference(conversation.counterpartyRef)
  ) {
    return [];
  }

  return findOrderDetailsForDisplay(sourceClient, {
    subSourceId: conversation.subSourceId,
    itemId: conversation.listingItemRef,
    buyerUsername: conversation.counterpartyRef,
  });
}
