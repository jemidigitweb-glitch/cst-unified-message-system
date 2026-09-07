import "server-only";

import type { ListingVariationView } from "@/lib/domain/listing-link";
import { displayableListingUrl } from "@/lib/domain/listing-link";
import {
  type Queryable as SourceQueryable,
  findListingDetails,
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

/**
 * Everything the CURRENT LISTING says about itself, for the panel.
 *
 * ORDER-INDEPENDENT, WHICH IS THE ENTIRE POINT. The panel used to show one
 * sentence — "Order and product details not loaded yet" — for every conversation
 * whose order did not resolve, which conflated two unrelated findings: no order
 * matched, and nothing is known about the product. The second was never true.
 * The listing title and its variation axes resolve from the item reference alone
 * (measured live: 869 of 869 titles, 867 of 869 variation sets), so a reviewer
 * looking at a pre-sales enquiry can be told exactly what the customer was
 * looking at even though no order exists to link it to.
 *
 * NO SKU IS RETURNED, and none may be added — see `ListingLinkResponse`. A
 * listing holds one SKU per variant and nothing here says which the customer
 * means.
 *
 * TWO READS, ONE PURPOSE, AND NEITHER IS NEW. `findListingUrl` and
 * `findListingDetails` both already existed and both already run on the draft
 * path; this composes them for display. Still no snapshot and no write.
 *
 * DEGRADES PIECEWISE. A missing URL does not withhold the title and a missing
 * title does not withhold the URL — each is refused on its own evidence, because
 * a reviewer who can see the title but not open the link is better served than
 * one shown nothing.
 */
export type CurrentListing = {
  readonly listingUrl: string | null;
  readonly itemRef: string | null;
  readonly title: string | null;
  readonly variations: readonly ListingVariationView[];
};

const NO_LISTING: CurrentListing = {
  listingUrl: null,
  itemRef: null,
  title: null,
  variations: [],
};

export async function resolveCurrentListing(
  sourceClient: SourceQueryable,
  conversation: ConversationForListingLink,
): Promise<CurrentListing> {
  // The same three refusals as `resolveListingLink`, returning before touching
  // the source. `itemRef` is echoed only where there is genuinely one to echo.
  if (conversation.marketplace !== "ebay") return NO_LISTING;
  if (conversation.subSourceId === null) return NO_LISTING;

  const itemRef = conversation.listingItemRef?.trim() ?? "";
  if (itemRef === "") return NO_LISTING;

  const [listingUrl, details] = await Promise.all([
    resolveListingLink(sourceClient, conversation),
    findListingDetails(sourceClient, {
      itemId: itemRef,
      subSourceId: conversation.subSourceId,
    }),
  ]);

  return {
    listingUrl,
    // Known even where neither lookup resolved: the conversation carries it.
    itemRef,
    title: details?.title ?? null,
    variations: details?.variations ?? [],
  };
}
