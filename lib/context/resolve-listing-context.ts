import "server-only";

import type { VerifiedFact } from "@/lib/domain/draft";
import {
  type Queryable as SourceQueryable,
  findListingDetails,
} from "@/lib/repositories/ebay-listing-repository";

/**
 * What the LISTING says — the title the customer clicked, and the options it
 * offers — as verified facts a draft may state.
 *
 * WHY THIS IS NOT THE SAME THING AS THE SOT CATALOGUE. SOT describes a product;
 * this describes an advertisement for it. They answer different questions and
 * they have wildly different coverage: measured over every eBay conversation CST
 * holds, SOT resolves for 3 of 869 listings while a title resolves for 869 of
 * 869 and variation options for 867. A customer asking "do you do this in
 * white?" is asking about the listing, and until now nothing on the draft path
 * could answer them — the item reference was passed to the model with an
 * explicit instruction NOT to describe the product from it, which was correct
 * and left the question unanswerable.
 *
 * OPTIONS ARE THE LISTING'S, NEVER THE CUSTOMER'S. `listing_options_colour`
 * says which colours this listing sells, not which one this customer bought or
 * wants. That distinction is stated in the prompt block rather than assumed, and
 * it is why these facts are safe to state even where an order resolved: a list
 * of what is offered cannot contradict a record of what was purchased.
 *
 * NO DESCRIPTION. `listings.ebay_listings.product_description` is excluded — see
 * `findListingDetails` for the measurements. It is 53KB of seller HTML on
 * average and is marketing rather than specification.
 *
 * SCOPED TO EBAY, like every other resolver on this path. Amazon carries an ASIN
 * whose listing row is per regional site; Shopify, B&Q and Temu carry no listing
 * reference at all.
 *
 * READ-ONLY. One SELECT, no snapshot, no cache, no write anywhere.
 */

export type ConversationForListingContext = {
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly listingItemRef: string | null;
};

const EMPTY: VerifiedFact[] = [];

/**
 * A fact name the prompt builder would file under the wrong heading.
 *
 * `contextBlocks()` in `lib/ai/draft-assembly.ts` sorts facts into the ORDER and
 * PRODUCT halves by testing the NAME against this expression. Variation axes are
 * named by whoever wrote the listing, so a listing offering a "Delivery Type"
 * option would otherwise be printed to the model as something the backend
 * established about this customer's delivery. The same guard, and the same
 * reasoning, as the first entry in `BLOCKED_SOT_ATTRIBUTE_PATTERNS`.
 */
const MISFILED_BY_THE_PROMPT_BUILDER = /order|refund|tracking|delivery/i;

/**
 * Longest option list this will state.
 *
 * A listing with fifty colours would otherwise put a paragraph of them in front
 * of the model. The cap matches `statableValue`'s in the SOT resolver, for the
 * same reason: past a certain length a value stops being a specification.
 */
const MAX_OPTIONS_LENGTH = 300;

/** `Colour` -> `listing_options_colour`. Lower case, no spaces, no punctuation. */
function optionFactName(variationName: string): string {
  const slug = variationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `listing_options_${slug}`;
}

/**
 * The listing facts for one conversation, or an empty list.
 *
 * `listing_title` is the listing's own title. The caller drops it where an order
 * resolved and named the purchased item's title — see the draft route — because
 * the two answer the same question and the order's answer is the more specific.
 */
export async function resolveListingContext(
  sourceClient: SourceQueryable,
  conversation: ConversationForListingContext,
): Promise<VerifiedFact[]> {
  if (conversation.marketplace !== "ebay") return EMPTY;
  if (conversation.subSourceId === null) return EMPTY;

  const itemRef = conversation.listingItemRef?.trim() ?? "";
  if (itemRef === "") return EMPTY;

  const details = await findListingDetails(sourceClient, {
    itemId: itemRef,
    subSourceId: conversation.subSourceId,
  });
  if (details === null) return EMPTY;

  const facts: VerifiedFact[] = [{ name: "listing_title", value: details.title }];

  for (const variation of details.variations) {
    const name = optionFactName(variation.name);
    // A slug that reduced to nothing, or one that would be misfiled — dropped
    // rather than renamed, because a name we invented is not the listing's.
    if (name === "listing_options_") continue;
    if (MISFILED_BY_THE_PROMPT_BUILDER.test(name)) continue;

    const value = variation.values.join(", ");
    if (value.length > MAX_OPTIONS_LENGTH) continue;
    facts.push({ name, value });
  }

  return facts;
}
