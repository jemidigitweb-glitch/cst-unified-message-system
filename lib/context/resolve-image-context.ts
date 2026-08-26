import "server-only";

import {
  type Queryable as SourceQueryable,
  type ProductImage,
  type ReturnEvidenceImage,
  findProductListingImages,
  findReturnEvidenceImages,
} from "@/lib/repositories/ebay-image-repository";
import { type Writable as AppWritable, getContextSnapshot } from "@/lib/repositories/context-snapshot-repository";

/**
 * Connects an eBay conversation to existing eBay-hosted images — a seller's
 * own listing photos, and a verified order's return-case evidence — for
 * display in the conversation CONTEXT PANEL only.
 *
 * NEVER FOR THE CHAT THREAD. Neither image source is a customer message
 * attachment: a listing photo is the seller's own upload, and a return photo
 * comes from a case record, not from any specific message in this thread.
 * Rendering either inside a message bubble would misrepresent it as
 * something the customer sent in that message. `components/context-panel.tsx`
 * is the only caller; `components/conversation-view.tsx` (the chat thread)
 * must never call this.
 *
 * READ-ONLY IN BOTH DATABASES. This reads `cst_app.context_snapshots` (via
 * the same `getContextSnapshot` the order resolver already uses) but never
 * writes one — unlike `resolveEbayOrderContext`, this never triggers a first
 * resolution. If a conversation has not yet been resolved, return evidence is
 * simply omitted rather than forcing a resolution as a side effect of
 * opening the image panel.
 *
 * SCOPED TO EBAY ONLY, same as the order resolver. Every other marketplace
 * returns no images, unchanged from today.
 */

export type ConversationForImageContext = {
  readonly id: string;
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly listingItemRef: string | null;
};

export type ImageContext = {
  readonly productImages: ProductImage[];
  readonly returnEvidenceImages: ReturnEvidenceImage[];
};

const EMPTY: ImageContext = { productImages: [], returnEvidenceImages: [] };

/**
 * Resolves one eBay conversation's product/listing images and, when a
 * verified single order already exists for it, its return-case evidence
 * photos.
 *
 * Product images depend only on `listingItemRef` + `subSourceId` — they work
 * for any eBay conversation with an item reference, order or no order.
 *
 * Return evidence depends on a `single_order` context snapshot already being
 * on record. No snapshot, or any resolution other than `single_order`
 * (`no_order`, `ambiguous`, `needs_context`, `terminated_order`), returns no
 * return-evidence images — this never guesses which order a case belongs to,
 * mirroring `resolveEbayOrderContext`'s own "never guesses" discipline.
 */
export async function resolveEbayImageContext(
  sourceClient: SourceQueryable,
  appClient: AppWritable,
  conversation: ConversationForImageContext,
): Promise<ImageContext> {
  if (conversation.marketplace !== "ebay") return EMPTY;
  if (conversation.subSourceId === null) return EMPTY;

  const productImages =
    conversation.listingItemRef !== null && conversation.listingItemRef.trim() !== ""
      ? await findProductListingImages(sourceClient, {
          itemId: conversation.listingItemRef,
          subSourceId: conversation.subSourceId,
        })
      : [];

  const snapshot = await getContextSnapshot(appClient, conversation.id);
  const hasVerifiedOrder =
    snapshot !== null &&
    snapshot.resolution === "single_order" &&
    snapshot.order_number !== null &&
    snapshot.sub_source_id !== null &&
    snapshot.listing_item_ref !== null;

  const returnEvidenceImages = hasVerifiedOrder
    ? await findReturnEvidenceImages(sourceClient, {
        orderNumber: snapshot!.order_number!,
        itemId: snapshot!.listing_item_ref!,
        subSourceId: snapshot!.sub_source_id!,
      })
    : [];

  return { productImages, returnEvidenceImages };
}
