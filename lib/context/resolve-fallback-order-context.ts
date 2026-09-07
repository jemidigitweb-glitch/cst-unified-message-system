import "server-only";

import type { CustomerOrderContext } from "@/lib/domain/customer-order-fallback";
import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import type { VerifiedFact } from "@/lib/domain/draft";
import { displayableListingUrl } from "@/lib/domain/listing-link";
import {
  findListingDetails,
  findListingUrl,
} from "@/lib/repositories/ebay-listing-repository";
import {
  type Queryable as SourceQueryable,
  findSoleSameStorefrontOrder,
} from "@/lib/repositories/customer-order-fallback-repository";
import {
  type Writable as AppWritable,
  getContextSnapshot,
} from "@/lib/repositories/context-snapshot-repository";

/**
 * Layer 2 of the order model, and the gate that keeps it subordinate to layer 1.
 *
 * ONE PLACE DECIDES WHETHER THE FALLBACK APPLIES, and both callers — the sidebar
 * route and the draft route — ask it rather than deciding for themselves. Two
 * copies of this condition would eventually disagree, and the way they would
 * disagree is one of them showing a fallback order for a conversation that
 * actually resolved.
 *
 * ------------------------------------------------------------------------
 * THE GATE IS THE STORED RESOLUTION, NOT AN EMPTY FACT LIST
 * ------------------------------------------------------------------------
 * "No facts" is TWO different findings. `no_order` means the matcher found
 * nothing, which is what layer 2 exists for. `ambiguous` means it found several
 * real purchases of this very listing and is waiting for a human to choose —
 * and offering a same-storefront fallback there would answer a question the
 * reviewer has already been asked to answer, with a different order. So the gate
 * reads `resolution === "no_order"` and nothing else: `single_order` is already
 * answered, `ambiguous` belongs to the reviewer, and a null snapshot means the
 * matcher never ran.
 *
 * WHICH ALSO MEANS THE MATCHER RUNS FIRST, ALWAYS. The snapshot this reads is
 * written by `resolveEbayOrderContext`, so callers must resolve layer 1 before
 * calling this — both do.
 *
 * READ-ONLY, AND WRITES NO SNAPSHOT. Unlike the order resolver this caches
 * nothing and records nothing: layer 2 is a live read, and its answer is never
 * stored as a resolution. A conversation whose fallback order exists today and
 * whose listing match appears tomorrow is resolved by layer 1 the moment it
 * does, with no stale negative in the way.
 */

export type ConversationForFallbackOrder = {
  readonly id: string;
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly counterpartyRef: string;
  readonly listingItemRef: string | null;
};

/**
 * The one same-storefront order for a conversation the matcher gave up on, or
 * null.
 *
 * Null for a non-eBay conversation, one with no storefront, one whose reference
 * is not a real customer identity, one the matcher answered or is still asking a
 * human about, and one whose buyer has anything other than exactly one order on
 * this storefront.
 */
export async function resolveFallbackCustomerOrder(
  sourceClient: SourceQueryable,
  appClient: AppWritable,
  conversation: ConversationForFallbackOrder,
): Promise<CustomerOrderContext | null> {
  if (conversation.marketplace !== "ebay") return null;
  if (conversation.subSourceId === null) return null;
  // The matcher's own identity bar: elsewhere the stored reference is a
  // platform relay or an ungrouped sentinel, and querying orders by one would
  // attach a stranger's purchase to this conversation.
  if (isUnresolvedReference(conversation.counterpartyRef)) return null;

  const snapshot = await getContextSnapshot(appClient, conversation.id);
  if (snapshot?.resolution !== "no_order") return null;

  const order = await findSoleSameStorefrontOrder(sourceClient, {
    buyerUsername: conversation.counterpartyRef,
    subSourceId: conversation.subSourceId,
    currentListingItemRef: conversation.listingItemRef,
  });
  if (order === null) return null;

  /**
   * THE ORDER'S OWN LISTING, RESOLVED FROM THE ORDER'S OWN ITEM REFERENCE.
   *
   * Keyed on `order.orderItemRef` and `order.storefrontId` — never on the
   * conversation's listing — so a current-message title or URL cannot end up
   * here. The URL check is what makes that structural rather than careful:
   * `displayableListingUrl` requires the URL's path to end in the reference it
   * is shown against, so the conversation's URL could not pass this call even
   * if it were handed to it.
   *
   * Skipped entirely for a multi-line order, where `orderItemRef` is already
   * null because the database refused to pick a line.
   */
  let listing: CustomerOrderContext["listing"] = null;
  if (order.orderItemRef !== null) {
    const [details, storedUrl] = await Promise.all([
      findListingDetails(sourceClient, {
        itemId: order.orderItemRef,
        subSourceId: order.storefrontId,
      }),
      findListingUrl(sourceClient, {
        itemId: order.orderItemRef,
        subSourceId: order.storefrontId,
      }),
    ]);
    listing = {
      itemRef: order.orderItemRef,
      title: details?.title ?? null,
      url: displayableListingUrl(storedUrl, order.orderItemRef),
    };
  }

  return { order, listing };
}

/**
 * The ONLY fields of a fallback order a draft may be told, and the flag that
 * stops it reading them as this message's order.
 *
 * ------------------------------------------------------------------------
 * WHAT IS HERE, AND WHY IT IS SAFE
 * ------------------------------------------------------------------------
 * A number, a date, a status and a storefront are facts about a purchase this
 * customer genuinely made. Stated alongside `customer_order_is_for_this_listing:
 * no`, they let a reply acknowledge a returning customer without asserting
 * anything about the product they are writing about.
 *
 * ------------------------------------------------------------------------
 * TWO PRODUCTS, KEPT APART BY THEIR NAMES
 * ------------------------------------------------------------------------
 * The ordered product IS supplied — item reference, exact SKU, order-line title
 * and the order listing's own title and URL — because CST staff can see all of
 * it and a model that cannot is answering with less than the person reviewing
 * it. What must never happen is the two products merging.
 *
 * THE `customer_order_` PREFIX IS LOAD-BEARING, NOT DECORATION. Three separate
 * mechanisms downstream key off exact fact names, and every one of them would
 * misfire on an unprefixed name:
 *
 *   `sku`            the draft route resolves the SOT catalogue from a fact
 *                    called `sku`. Named that, the ORDERED product's catalogue
 *                    entry would be presented as the current product's.
 *   `product_title`  the draft route DROPS `listing_title` when this is
 *                    present. Named that, the current listing's title would be
 *                    replaced by the historical order's.
 *   `order_status`   `dispatchState()` reads this exact name. Named that, a
 *                    three-year-old order could establish dispatch for a
 *                    message about something else.
 *
 * A guard test pins all three. Renaming any of these facts to its unprefixed
 * form is a correctness bug, not a tidy-up.
 *
 * EVERY NAME CONTAINS "order" ON PURPOSE, TOO. `contextBlocks()` files a fact
 * into the ORDER or PRODUCT half by testing its NAME against
 * `/order|refund|tracking|delivery/i`. These are order facts and belong in the
 * order half; a name missing that pattern would be printed under PRODUCT, which
 * is the one heading the ordered product must never appear beneath.
 *
 * NO TRACKING, NO CARRIER, NO DELIVERY STATE, NO REFUND OR REPLACEMENT. Those
 * describe a different PARCEL, and `FallbackCustomerOrder` has no field to
 * carry them, so this function could not state them if it tried.
 *
 * THE RELATIONSHIP IS COMPUTED HERE and stated as a fact, deliberately last so
 * it is the closest line to whatever the model reads next. The model is never
 * asked to work it out by comparing two item ids itself.
 */
export const RELATIONSHIP_FACT = "order_listing_matches_current_message_listing";

export function fallbackOrderFacts(context: CustomerOrderContext): VerifiedFact[] {
  const { order, listing } = context;

  const facts: [string, string | null][] = [
    /* ---- the order itself ---- */
    ["customer_order_number", order.orderNumber],
    ["customer_order_date", order.orderDate],
    ["customer_order_status", order.orderStatus],
    ["customer_order_storefront", order.storefrontName],

    /* ---- the product ACTUALLY ordered, or the ambiguity ---- */
    // Present only for a single-line order. On a multi-line order every one of
    // these is null and `customer_order_line_count` says why, so the model is
    // told there are several products rather than shown one of them.
    ["customer_order_listing_item_id", listing?.itemRef ?? null],
    ["customer_order_listing_title", listing?.title ?? null],
    ["customer_order_listing_url", listing?.url ?? null],
    ["customer_order_sku", order.orderSku],
    ["customer_order_product_title", order.orderProductTitle],
    [
      "customer_order_line_count",
      order.orderLineCount > 1 ? String(order.orderLineCount) : null,
    ],

    /* ---- the relationship, computed here and never left to the model ---- */
    [RELATIONSHIP_FACT, order.listingMatch ? "yes" : "no"],
  ];

  return facts
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1].trim() !== "")
    .map(([name, value]) => ({ name, value }));
}
