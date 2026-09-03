import type { Marketplace } from "@/lib/domain/marketplace";

/**
 * What each marketplace source can honestly support.
 *
 * Every marketplace is ACTIVE. The four modes below describe how much of a
 * conversation a source can prove, not whether it is switched on:
 *
 *   full          direction is a stored source field and previous CST replies
 *                 exist in the source, so both sides can be rendered.
 *   inbound_only  direction is verified inbound; the source carries no reply
 *                 history at all.
 *   degraded      direction is verified inbound, but grouping and/or business
 *                 context cannot be resolved for some or all messages.
 *   unresolved    direction, identity and grouping are all unproven. The data
 *                 is shown, with no directional meaning attached to it.
 *
 * Generic components read these flags instead of testing for a marketplace by
 * name, so adding a marketplace stays a data change rather than a UI edit.
 */
export const MARKETPLACE_MODES = ["full", "inbound_only", "degraded", "unresolved"] as const;

export type MarketplaceMode = (typeof MARKETPLACE_MODES)[number];

/**
 * Which read model backs a marketplace tab.
 *
 * `conversations` is the shared marketplace-neutral conversation store.
 * `unresolved_messages` is the source-message feed used where direction and
 * grouping are unproven, so no conversation may be asserted.
 */
export const MARKETPLACE_FEEDS = ["conversations", "unresolved_messages"] as const;

export type MarketplaceFeed = (typeof MARKETPLACE_FEEDS)[number];

/**
 * How a conversation's stored reference should be introduced in the interface.
 * `customer_handle` is a real counterparty identity from the source; anything
 * else is a source reference and must not be presented as a person.
 */
export const CONVERSATION_REFERENCE_KINDS = ["customer_handle", "source_reference"] as const;

export type ConversationReferenceKind = (typeof CONVERSATION_REFERENCE_KINDS)[number];

export type MarketplaceCapability = {
  readonly marketplace: Marketplace;
  /** Business name shown in the interface. Never a source table name. */
  readonly label: string;
  readonly mode: MarketplaceMode;
  readonly feed: MarketplaceFeed;

  /** Whether the source states which way a message travelled. */
  readonly directionVerified: boolean;
  /** Whether the source carries previous CST replies at all. */
  readonly hasOutboundHistory: boolean;
  /** Whether every message can be placed in a source-supported conversation. */
  readonly groupingVerified: boolean;
  /** Whether the stored conversation reference is a real customer identity. */
  readonly counterpartyIdentityVerified: boolean;
  /**
   * Whether a conversation's item reference alone identifies ONE listing URL.
   *
   * Not "does this marketplace have listings" — all of them do. The question is
   * whether the reference CST stores is enough to name a single one of them.
   * See `resolve-listing-link.ts` for the measurements behind each answer;
   * Amazon's is false because an ASIN resolves to one URL per regional site and
   * nothing in the conversation says which site the customer bought from.
   */
  readonly listingLinkResolvable: boolean;

  readonly conversationReferenceKind: ConversationReferenceKind;
  /**
   * What to call the reference in the interface, e.g. "Order". Combined with
   * the marketplace label to title a conversation — "B&Q Order 1234567890-A".
   * Present only when the source supplies a reference to title with.
   */
  readonly referenceNoun?: string;
};

/** Tab order is fixed and product-defined. */
export const MARKETPLACE_TAB_ORDER: readonly Marketplace[] = [
  "ebay",
  "amazon",
  "shopify",
  "bandq",
  "temu",
];

/**
 * There is deliberately no per-marketplace notice copy.
 *
 * The flags above still govern what the interface may claim — an inbound-only
 * source never renders a reply column, an unverified-direction source never
 * aligns or labels a message. Those guarantees live in the layout, where they
 * cannot be dismissed or scrolled past. What has gone is the running commentary
 * about them: an agent reading a message does not need to be told which
 * internal check has not run.
 */
export const MARKETPLACE_CAPABILITIES: Readonly<Record<Marketplace, MarketplaceCapability>> = {
  ebay: {
    marketplace: "ebay",
    label: "eBay",
    mode: "full",
    feed: "conversations",
    // `folder_id` is a stored direction field; both sides exist in the source.
    directionVerified: true,
    hasOutboundHistory: true,
    groupingVerified: true,
    counterpartyIdentityVerified: true,
    // `listings.ebay_listings` holds the URL against the item id. Measured over
    // every eBay conversation CST holds: 867 of 890 item references resolve to
    // exactly one URL, 23 have none recorded, none is ambiguous.
    listingLinkResolvable: true,
    conversationReferenceKind: "customer_handle",
  },
  amazon: {
    marketplace: "amazon",
    label: "Amazon",
    mode: "full",
    feed: "conversations",
    // Direction is mapped from two stored sender fields — see the adapter for
    // the rule and the measurements behind it. Both sides are present: 3,081
    // customer messages and 4,293 CST replies.
    directionVerified: true,
    hasOutboundHistory: true,
    // A message with no order reference still cannot be grouped.
    groupingVerified: false,
    // The conversation reference is an order reference, not a person: the
    // sender addresses are shared relays and would merge unrelated customers.
    counterpartyIdentityVerified: false,
    // An ASIN names a product, not a listing on one site: 21,167 of 49,828
    // ASINs carry a URL for each of amazon.co.uk, .de, .fr, .ie and the rest,
    // and all 616 Amazon conversations sit under one sub-account, so nothing
    // here says which site the customer bought from. A link would be a guess
    // between real alternatives, so none is offered.
    listingLinkResolvable: false,
    conversationReferenceKind: "source_reference",
    referenceNoun: "Order",
  },
  shopify: {
    marketplace: "shopify",
    label: "Shopify",
    mode: "full",
    feed: "conversations",
    // Decided by the two addresses against the reviewed company-domain list:
    // 17,043 inbound and 4,209 outbound resolve. The 3,699 that do not are
    // never stored as conversations, so every message on this feed has a
    // direction the addresses established.
    directionVerified: true,
    hasOutboundHistory: true,
    groupingVerified: false,
    // The source carries suppliers, couriers and platform mail beside
    // customers, so an address here is not a verified customer identity.
    counterpartyIdentityVerified: false,
    // The adapter records no item reference on a Shopify message, so there is
    // nothing to resolve a listing from.
    listingLinkResolvable: false,
    conversationReferenceKind: "source_reference",
    referenceNoun: "Order",
  },
  bandq: {
    marketplace: "bandq",
    label: "B&Q",
    mode: "degraded",
    feed: "conversations",
    // Verified: every message is addressed to a company domain and none
    // originates from one.
    directionVerified: true,
    hasOutboundHistory: false,
    groupingVerified: false,
    counterpartyIdentityVerified: false,
    // No item reference on a B&Q message, so nothing to resolve a listing from.
    listingLinkResolvable: false,
    conversationReferenceKind: "source_reference",
    // Titled "B&Q Order <ref>". The reference is the order number B&Q itself
    // puts on the message, so an agent will recognise it; the panel still says
    // plainly that it has not been linked to an order record here.
    referenceNoun: "Order",
  },
  temu: {
    marketplace: "temu",
    label: "Temu",
    mode: "degraded",
    feed: "conversations",
    // Verified: every message is addressed to a company domain and none
    // originates from one.
    directionVerified: true,
    hasOutboundHistory: false,
    groupingVerified: false,
    counterpartyIdentityVerified: false,
    // No item reference on a Temu message, so nothing to resolve a listing from.
    listingLinkResolvable: false,
    conversationReferenceKind: "source_reference",
    // No reference to title with, so every Temu conversation is titled
    // "Temu enquiry". See `conversationTitle`.
  },
};

export function capabilityOf(marketplace: Marketplace): MarketplaceCapability {
  return MARKETPLACE_CAPABILITIES[marketplace];
}

/**
 * Whether a marketplace is active — which, by construction, every one with a
 * tab is. There is no enabled/disabled flag to consult, and deliberately so:
 * how much a source proves is expressed by `mode`, not by whether a CST agent
 * can look at it.
 */
export function isMarketplaceActive(marketplace: Marketplace): boolean {
  return MARKETPLACE_TAB_ORDER.includes(marketplace);
}

/** Marketplaces served by the shared conversation API. The allowlist for it. */
export const CONVERSATION_MARKETPLACES: readonly Marketplace[] = MARKETPLACE_TAB_ORDER.filter(
  (marketplace) => MARKETPLACE_CAPABILITIES[marketplace].feed === "conversations",
);

/**
 * Marketplaces the read-only unresolved feed may be asked for: ALL of them.
 *
 * `feed` says which read model a marketplace's TAB is built around, and every
 * marketplace is now conversation-backed — which left this list empty and the
 * unresolved feed unreachable. That was wrong in a way that hid data: a message
 * whose direction the source cannot decide is stored in
 * `unresolved_marketplace_messages` and was then queryable by nothing. 1,164
 * messages sat there, including a real German order notification, with no route
 * that would return them.
 *
 * Any marketplace can produce such a message, so any marketplace may be asked
 * for them. A marketplace with none simply returns an empty feed, which is a
 * true answer rather than a rejected request.
 */
export const UNRESOLVED_FEED_MARKETPLACES: readonly Marketplace[] = MARKETPLACE_TAB_ORDER;

/**
 * Resolves an untrusted marketplace name against an explicit allowlist.
 *
 * The allowlist is a fixed array of literals, so nothing a caller supplies can
 * reach a query — a marketplace served by a different feed is rejected here
 * rather than silently querying the wrong store.
 */
export function parseMarketplaceForFeed(
  raw: string | null,
  feed: MarketplaceFeed,
): Marketplace | null {
  if (raw === null) return null;
  const allowed = feed === "conversations" ? CONVERSATION_MARKETPLACES : UNRESOLVED_FEED_MARKETPLACES;
  return allowed.find((marketplace) => marketplace === raw) ?? null;
}

/** Any marketplace tab name, validated against the allowlist. */
export function parseMarketplace(raw: string | null): Marketplace | null {
  if (raw === null) return null;
  return MARKETPLACE_TAB_ORDER.find((marketplace) => marketplace === raw) ?? null;
}
