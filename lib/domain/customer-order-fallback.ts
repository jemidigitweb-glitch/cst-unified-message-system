/**
 * The customer order shown when the strict matcher found none.
 *
 * ------------------------------------------------------------------------
 * TWO LAYERS, AND THE SECOND NEVER OVERRULES THE FIRST
 * ------------------------------------------------------------------------
 *   LAYER 1  buyer + eBay + storefront + LISTING. Unchanged, and it still
 *            decides. One match is the verified current order; several is the
 *            existing ambiguous flow; none falls through to layer 2.
 *   LAYER 2  buyer + eBay + storefront, WITHOUT the listing. Runs only where
 *            layer 1 established nothing at all.
 *
 * WHY LAYER 2 EXISTS. A customer writing from a listing they have not bought is
 * still a customer, and CST was showing a reviewer nothing about them — no
 * order, no history, no indication they had ever purchased. Measured live, 44
 * eBay conversations have no listing match but do have an order from the same
 * buyer on the same storefront, and 34 of those have exactly one.
 *
 * WHY IT IS NOT A LOOSER MATCHER. Removing the listing predicate from layer 1
 * was measured and rejected: it rescues 44 conversations while degrading ~93
 * currently-unambiguous matches into ambiguous ones. Layer 2 runs ONLY on the
 * conversations layer 1 gave up on, so it cannot take a single verified match
 * away from anyone.
 *
 * ------------------------------------------------------------------------
 * EXACTLY ONE, OR NOTHING
 * ------------------------------------------------------------------------
 * Two orders on the storefront and layer 2 returns null. It does NOT pick the
 * newest, the oldest, the completed one, or the one nearest the message date.
 * Ranking would manufacture a verified-looking answer out of a coin toss, and a
 * wrong order number in front of a customer reads exactly like a right one. The
 * repository has no ORDER BY for that reason — there is nothing to rank with.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT THIS MESSAGE'S ORDER, AND SAYS SO
 * ------------------------------------------------------------------------
 * `listingMatch` carries the relationship. Because layer 2 runs only after
 * layer 1 found nothing, an order reaching here CANNOT contain the
 * conversation's listing — if it did, layer 1 would have matched it — so the
 * flag is false in every case this can currently produce. It is still read from
 * the data rather than assumed: a true here would mean the two layers disagreed,
 * which is worth seeing rather than hard-coding away.
 */

/** The one order layer 2 is willing to name, or nothing. */
export type FallbackCustomerOrder = {
  readonly orderNumber: string;
  /** The stored source date, verbatim as text. Never parsed, never converted. */
  readonly orderDate: string | null;
  readonly orderStatus: string | null;
  /** Always this conversation's own storefront — layer 2 does not cross them. */
  readonly storefrontId: number;
  readonly storefrontName: string | null;
  /**
   * Whether this order actually contains the conversation's listing.
   *
   * False for everything layer 2 can produce today. The interface must say so
   * in words rather than leaving a reviewer to assume the order is the one the
   * message is about — see `LISTING_MISMATCH_NOTICE`.
   */
  readonly listingMatch: boolean;
  /**
   * How many lines the order holds. The ambiguity signal, reported rather than
   * resolved away: 543,382 of 582,716 live eBay orders have one line, 39,334
   * have more.
   */
  readonly orderLineCount: number;
  /**
   * The ordered item's own reference, SKU and title — ONLY where the order has
   * exactly one line.
   *
   * DETERMINISTIC OR NULL, NEVER A CHOICE. Naming "the" product of a three-line
   * order means picking one, any pick is arbitrary, and an arbitrary product
   * name attached to a real order number is the mistake that looks correct. The
   * QUERY nulls all three itself for a multi-line order, so the choice cannot be
   * made further up by accident.
   *
   * THIS IS THE ORDER'S PRODUCT, NEVER THE MESSAGE'S. Where `listingMatch` is
   * false it is a different product from the one the customer is writing about.
   */
  readonly orderItemRef: string | null;
  /**
   * The ordered SKU, EXACTLY as the source recorded it.
   *
   * ONE OPAQUE IDENTIFIER. Never split on `+`, `-`, `_`, `/` or a space, never
   * trimmed, case-folded, normalised or interpreted — see `lib/domain/sku.ts`.
   * `PSHYOS4BRBM+SPUPBM+SLDO210BM` is a single SKU with its own product master
   * row; 129,783 of 633,970 live eBay order lines carry one, so this is the
   * common case rather than an edge case. Components are already decomposed in
   * `order_management.order_combo` and are never derived from the string.
   *
   * `real_sku` where the source recorded a corrected value, else `item_sku` —
   * the same precedence the strict matcher already applies.
   */
  readonly orderSku: string | null;
  /** The product title recorded ON THE ORDER LINE, not the listing's title. */
  readonly orderProductTitle: string | null;
};

/**
 * The listing the ORDERED item belongs to, resolved separately from the
 * conversation's own listing and never copied from it.
 *
 * Resolved through the same deterministic mechanism the current listing uses
 * (`findListingDetails` / `findListingUrl` + `displayableListingUrl`) but keyed
 * on the ORDER's item reference and the ORDER's storefront. The URL check ties
 * a link to the reference it is shown against, so a current-message URL cannot
 * be presented here even by mistake: it would not carry this item's reference.
 */
export type CustomerOrderListing = {
  readonly itemRef: string;
  readonly title: string | null;
  readonly url: string | null;
};

/** One layer-2 order, with the listing of the product actually ordered. */
export type CustomerOrderContext = {
  readonly order: FallbackCustomerOrder;
  /** Null where the order has several lines, so no single product is identified. */
  readonly listing: CustomerOrderListing | null;
};

/**
 * One order a reviewer may choose from when the strict matcher found none.
 *
 * EVERYTHING A PERSON NEEDS TO RECOGNISE THE RIGHT ORDER, and nothing they do
 * not: order identity, the product where it is unambiguous, and the shipment.
 * No customer name, no email — the delivery address is carried because it is
 * already an approved fact for a matched order (`delivery_address`) and nothing
 * wider is added here.
 *
 * IT IS A CANDIDATE, NOT A CONCLUSION. Being in this list means "this order
 * belongs to this buyer on this storefront", which is all the backend can
 * establish. Whether it is the order the customer is writing about is the
 * reviewer's judgement, and until they make it nothing here reaches a draft.
 */
export type EligibleCustomerOrder = {
  readonly orderNumber: string;
  readonly orderDate: string | null;
  readonly orderStatus: string | null;
  readonly storefrontId: number;
  readonly storefrontName: string | null;
  /** Several lines means no single product is named — see `orderItemRef`. */
  readonly orderLineCount: number;
  readonly orderItemRef: string | null;
  /** Exact and opaque. Never split, trimmed or normalised — see `lib/domain/sku.ts`. */
  readonly orderSku: string | null;
  readonly orderProductTitle: string | null;
  /* ---- shipment, exactly as the source recorded it ---- */
  readonly trackingNumber: string | null;
  readonly shipmentStatus: string | null;
  readonly shipmentCreatedAt: string | null;
  readonly shipmentCancelledAt: string | null;
  readonly carrier: string | null;
  readonly carrierService: string | null;
  readonly shippedAt: string | null;
  /** The approved single address fact, joined as the matched-order path joins it. */
  readonly deliveryAddress: string | null;
  /**
   * Whether ANY line of this order carries the conversation's listing.
   *
   * Read from the data rather than inferred from `orderItemRef`, so it stays
   * correct for a multi-line order where no single item is named.
   */
  readonly listingMatch: boolean;
};

/**
 * Where an order context came from, stated to the model rather than implied.
 *
 * `manual_selected` is the one value this file introduces: a reviewer looked at
 * the customer's orders and said it is this one. It is NOT `user_confirmed` —
 * that is a persisted, attributable confirmation this application cannot make
 * because it has no authenticated user identity, and borrowing the word for an
 * unattributable choice would put a claim in the audit vocabulary that nothing
 * can stand behind.
 */
export const MANUAL_SELECTION_SOURCE = "manual_selected";

/** Heading for the choose-an-order section, shown only where none matched. */
export const SELECT_ORDER_HEADING = "Select customer order";

/** Said against a selected order whose product differs from the message's. */
export const SELECTED_ORDER_MISMATCH_NOTICE =
  "Selected order is for a different listing from the current message.";

/**
 * WHAT IS DELIBERATELY ABSENT, and why each one.
 *
 * NO SKU AND NO PRODUCT TITLE. This order is for something else. Naming its
 * product beside a message about a different listing is the single most
 * misleading thing this feature could do — a reviewer, or a model, would answer
 * about the wrong item in good faith.
 *
 * NO TRACKING, CARRIER, DELIVERY STATUS, REFUND OR REPLACEMENT. Those describe
 * the handling of a parcel that is not what the customer is writing about.
 * Absent by construction rather than filtered downstream: there is no field to
 * put them in, so no later edit can start passing them.
 *
 * The CURRENT LISTING remains the authoritative product context for the
 * message — see `resolveCurrentListing`.
 */

/** Heading for the one order block, whether it came from layer 1 or layer 2. */
export const CUSTOMER_ORDER_HEADING = "Customer order";

/** Shown when the strict matcher found nothing and layer 2 named no order either. */
export const NO_MATCHING_ORDER_TEXT = "No matching order for this listing";

/**
 * The sentence that must appear against a layer-2 order.
 *
 * Stated once, here, so the notice cannot drift into something softer. It names
 * the fact rather than hedging: the order is real and verified, and it is for a
 * different product than the one this message is about.
 */
export const LISTING_MISMATCH_NOTICE = "Order product differs from current message listing";
