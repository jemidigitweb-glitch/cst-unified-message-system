import "server-only";

import type { VerifiedFact } from "@/lib/domain/draft";
import {
  type Queryable as SourceQueryable,
  findReturnEvidenceImages,
} from "@/lib/repositories/ebay-image-repository";
import { type Writable as AppWritable, getContextSnapshot } from "@/lib/repositories/context-snapshot-repository";

/**
 * Verified return-case facts for grounding an AI draft — TEXT ONLY.
 *
 * Deliberately reuses `findReturnEvidenceImages` rather than a new query: the
 * context panel already shows exactly these rows as "Return Evidence
 * Photos" (see `resolveEbayImageContext`), and having the AI's return facts
 * come from a different query than the human-visible evidence would let the
 * two silently disagree about which return this conversation's evidence
 * even is. One matched set, two views of it — a status/reason summary for
 * the model, the photo itself for the human.
 *
 * NO IMAGE DATA REACHES THE MODEL. `return_evidence_available` is a plain
 * "Yes"/"No" fact — the model is told a photo exists, never shown it and
 * never told what it depicts. Neither this provider integration nor this
 * function performs image analysis or a vision call.
 *
 * SAME "NEVER GUESSES" DISCIPLINE AS THE ORDER AND IMAGE RESOLVERS. Return
 * facts are produced ONLY when a `single_order` context snapshot already
 * exists for this conversation, and the return lookup is scoped by that
 * snapshot's own `order_number` + `listing_item_ref` + `sub_source_id` —
 * never by item_id alone, which `ebay-image-repository.ts` documents as
 * unsafe (confirmed live: most item_ids have a return photo belonging to
 * some OTHER buyer). A `no_order`, `ambiguous`, or absent snapshot returns
 * no return facts at all, exactly as it returns no return-evidence images.
 *
 * READ-ONLY. Reads `cst_app.context_snapshots` (via the same
 * `getContextSnapshot` the order and image resolvers already use) but never
 * writes one — opening a draft's return context cannot trigger a first
 * order resolution as a side effect.
 */

export type ConversationForReturnContext = {
  readonly id: string;
  readonly marketplace: string;
};

const EMPTY: VerifiedFact[] = [];

/**
 * Resolves the verified return-case facts for one eBay conversation, or an
 * empty list when there is nothing safe to say.
 *
 * Empty for: any non-eBay conversation, any conversation without a
 * `single_order` snapshot, and any verified order with no photographed
 * return event on record. An empty list here means the RETURN block is
 * omitted from the prompt entirely — see `contextBlocks` in
 * `draft-assembly.ts` — not rendered as "no return found", since the large
 * majority of conversations never had a return and a block insisting so on
 * every draft would be noise, unlike ORDER/PRODUCT which are always
 * relevant.
 *
 * When more than one photographed return event exists for the same order
 * (a return re-opened, observed live), the MOST RECENT one — last by id,
 * matching `findReturnEvidenceImages`'s own ordering — is what the model is
 * told about, since that is the return's current state.
 */
export async function resolveEbayReturnContext(
  sourceClient: SourceQueryable,
  appClient: AppWritable,
  conversation: ConversationForReturnContext,
): Promise<VerifiedFact[]> {
  if (conversation.marketplace !== "ebay") return EMPTY;

  const snapshot = await getContextSnapshot(appClient, conversation.id);
  const hasVerifiedOrder =
    snapshot !== null &&
    snapshot.resolution === "single_order" &&
    snapshot.order_number !== null &&
    snapshot.sub_source_id !== null &&
    snapshot.listing_item_ref !== null;

  if (!hasVerifiedOrder) return EMPTY;

  const returns = await findReturnEvidenceImages(sourceClient, {
    orderNumber: snapshot.order_number!,
    itemId: snapshot.listing_item_ref!,
    subSourceId: snapshot.sub_source_id!,
  });

  if (returns.length === 0) return EMPTY;

  const latest = returns[returns.length - 1]!;
  const facts: [string, string | null][] = [
    ["return_status", latest.status],
    ["return_reason", latest.reason],
  ];

  return [
    ...facts
      .filter((entry): entry is [string, string] => entry[1] !== null && entry[1].trim() !== "")
      .map(([name, value]) => ({ name, value })),
    { name: "return_evidence_available", value: "Yes" },
  ];
}
