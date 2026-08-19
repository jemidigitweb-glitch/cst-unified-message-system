/**
 * Marketplace-NEUTRAL conversation grouping contract.
 *
 * No marketplace source exposes a thread or conversation id, so a thread key is
 * derived. Every derived thread carries the identifier of the rule that produced
 * it, so grouping can be recalculated later without corrupting saved work.
 *
 * The rule identifiers themselves belong to each marketplace adapter — how a
 * conversation is recognised is marketplace-specific. So is deciding whether a
 * row is a platform notice rather than a customer message.
 *
 * Status: ACCEPTABLE WITH BUSINESS APPROVAL — not verified fact.
 */

/** Conversations are segmented when the gap between consecutive messages exceeds this. */
export const THREAD_GAP_DAYS = 30;

export const THREAD_GAP_MS = THREAD_GAP_DAYS * 24 * 60 * 60 * 1000;

export const THREADING_STRATEGIES = ["item_linked", "no_item"] as const;

export type ThreadingStrategy = (typeof THREADING_STRATEGIES)[number];

export type ThreadKeyParts = {
  /** Durable identifier of the rule that produced this grouping. */
  readonly ruleVersion: string;
  readonly strategy: ThreadingStrategy;
  readonly subSourceId: number;
  readonly counterpartyRef: string;
  /** Present only for `item_linked`. */
  readonly listingItemRef?: string | null;
  /** Ordinal of the gap-segmented run within the key, oldest first. */
  readonly segment: number;
};

/**
 * Canonical, collision-safe thread key.
 *
 * A delimiter-joined key is NOT safe here. `counterpartyRef` and
 * `listingItemRef` are opaque source strings, and nothing guarantees they
 * exclude whatever separator we pick. With a `|` join these two distinct
 * conversations produce the identical key:
 *
 *   { listingItemRef: "1",   counterpartyRef: "a|b" }  ->  ...|1|a|b|0
 *   { listingItemRef: "1|a", counterpartyRef: "b"   }  ->  ...|1|a|b|0
 *
 * Two different customers would silently merge into one thread. So the key is a
 * canonical JSON array instead: JSON escaping makes the encoding injective, the
 * element order is fixed by construction, and `null` stays distinguishable from
 * the empty string. The rule version is the first element, so a key produced by
 * one rule can never be mistaken for another's.
 */
export function threadKeyOf(parts: ThreadKeyParts): string {
  const listing = parts.strategy === "item_linked" ? (parts.listingItemRef ?? null) : null;
  return JSON.stringify([
    parts.ruleVersion,
    parts.strategy,
    parts.subSourceId,
    listing,
    parts.counterpartyRef,
    parts.segment,
  ]);
}

/**
 * Whether a derived group belongs in the customer-reply inbox.
 *
 * It must contain at least one inbound customer message — there is otherwise
 * nothing to reply to. Outbound-only groups stay classifiable and visible
 * elsewhere; they are never silently dropped.
 */
export function belongsInReplyInbox(group: { inboundCount: number }): boolean {
  return group.inboundCount >= 1;
}

/**
 * Milliseconds between two naive source timestamps, for gap arithmetic only.
 *
 * Both values are interpreted at a FIXED zero offset. That is not a claim that
 * the source is UTC — the zone is still unconfirmed. It fixes the offset so a
 * daylight-saving boundary cannot silently shift a gap by an hour and split or
 * merge a conversation. The timestamps themselves are never rewritten; only
 * this difference is computed.
 */
export function gapMillis(earlier: string, later: string): number {
  return parseFixedOffset(later) - parseFixedOffset(earlier);
}

function parseFixedOffset(timestamp: string): number {
  const normalized = timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T");
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const ms = Date.parse(withZone);
  if (Number.isNaN(ms)) throw new Error(`Unparseable source timestamp: ${timestamp}`);
  return ms;
}
