import "server-only";

import { displayableListingUrl } from "@/lib/domain/listing-link";
import {
  type Queryable as SourceQueryable,
  findListingUrl,
} from "@/lib/repositories/ebay-listing-repository";

/**
 * Connects a conversation's item reference to the marketplace listing it names.
 *
 * ORDER-INDEPENDENT, and that is the point of resolving it here rather than
 * folding it into the order context. A listing link needs an item reference and
 * nothing else: it is just as available on a pre-sales enquiry that resolved to
 * no order as on a delivery complaint that resolved to one, and pre-sales is
 * where a reviewer most often wants to open the listing. Riding on the order
 * resolver would have withheld the link from exactly those conversations.
 *
 * READ-ONLY, AND WRITES NO SNAPSHOT. Unlike `resolveEbayOrderContext` this
 * caches nothing and cannot trigger a first resolution as a side effect — same
 * contract as `resolveEbayImageContext`. It is a live read: a listing re-titled
 * this morning shows this morning's URL.
 *
 * EBAY ONLY, and that is a limit of the data rather than a preference. eBay's
 * `listings.ebay_listings` maps one item id to one listing URL. Amazon's
 * `listings.amazon_listings` maps one ASIN to one URL PER REGIONAL SITE —
 * 21,167 of 49,828 ASINs carry several, one each for amazon.co.uk, .de, .fr,
 * .ie and the rest — and the conversation cannot pick between them: all 616
 * Amazon conversations sit under a single sub-account, so nothing in the
 * conversation says which site the customer bought from. Choosing anyway would
 * put an amazon.fr link in front of a reviewer answering a UK buyer. Until an
 * Amazon conversation carries its marketplace, no Amazon link is the honest
 * answer. Shopify, B&Q and Temu record no item reference at all.
 */

export type ConversationForListingLink = {
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly listingItemRef: string | null;
};

/**
 * The listing URL for one conversation, or null when there is none to show.
 *
 * Every refusal returns null and none of them queries anything it does not need
 * to: a marketplace whose listings cannot be resolved from an item reference, a
 * conversation with no sub-account, and a conversation with no item reference
 * all return before touching the source.
 */
export async function resolveListingLink(
  sourceClient: SourceQueryable,
  conversation: ConversationForListingLink,
): Promise<string | null> {
  if (conversation.marketplace !== "ebay") return null;
  if (conversation.subSourceId === null) return null;

  const itemRef = conversation.listingItemRef?.trim() ?? "";
  if (itemRef === "") return null;

  const stored = await findListingUrl(sourceClient, {
    itemId: itemRef,
    subSourceId: conversation.subSourceId,
  });

  // Checked against the reference it will be displayed beside, never merely
  // against itself — see `displayableListingUrl`.
  return displayableListingUrl(stored, itemRef);
}
