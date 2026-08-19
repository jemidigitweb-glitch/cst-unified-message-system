/**
 * Conversation grouping.
 *
 * The source has NO thread/conversation id on any marketplace message table, so
 * a thread key is derived. The rule version is stored alongside every derived
 * thread so grouping can be recalculated later without corrupting saved drafts.
 *
 * Status: ACCEPTABLE WITH BUSINESS APPROVAL — not verified fact. Nothing here
 * should be treated as settled until sign-off.
 */

/** Bump when any grouping input or the gap changes. Persist with every thread. */
export const THREADING_RULE_VERSION = "v1" as const;

/** Conversations are segmented when the gap between messages exceeds this. */
export const THREAD_GAP_DAYS = 30;

export const THREADING_STRATEGIES = ["item_linked", "no_item"] as const;

export type ThreadingStrategy = (typeof THREADING_STRATEGIES)[number];

/**
 * Item-linked conversations: sub_source + listing item + counterparty, plus gap
 * segmentation, with structurally verified system notices excluded.
 *
 * No-item conversations: sub_source + counterparty, plus gap segmentation,
 * requiring at least one inbound message for normal inbox placement. These are
 * always flagged `needs_context` — Day 1 found no authoritative order reference
 * for them (0 of 1,091 subjects contained an order number), so any buyer-order
 * match is a candidate for CST to confirm and must never be auto-attached.
 */
export type ThreadKeyParts = {
  readonly strategy: ThreadingStrategy;
  readonly subSource: number;
  readonly counterparty: string;
  /** Present only for `item_linked`. */
  readonly itemId?: string;
  /** Ordinal of the gap-segmented run within the key, oldest first. */
  readonly segment: number;
};

export function threadKeyOf(parts: ThreadKeyParts): string {
  const item = parts.strategy === "item_linked" ? (parts.itemId ?? "") : "";
  return [
    THREADING_RULE_VERSION,
    parts.strategy,
    parts.subSource,
    item,
    parts.counterparty,
    parts.segment,
  ].join("|");
}

/**
 * Deciding whether a row is a platform notice rather than a customer message is
 * marketplace-specific, so it lives in the marketplace adapter
 * (`lib/marketplaces/<marketplace>/adapter.ts`), not here. System notices are
 * never ingested as conversations.
 */

/**
 * Outbound-only no-item groups (7 groups / 201 messages in Day 1 data, dominated
 * by one single-day bulk send) are excluded from the customer-reply inbox: there
 * is no customer message to answer. They stay visible in a separate read-only
 * view — never silently dropped.
 */
export function belongsInReplyInbox(group: { inboundCount: number }): boolean {
  return group.inboundCount >= 1;
}
