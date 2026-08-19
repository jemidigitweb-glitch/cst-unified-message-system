import type { Marketplace } from "@/lib/domain/marketplace";
import type { SourceMessage } from "@/lib/domain/source-message";
import type { ThreadingStrategy } from "@/lib/domain/threading";

/**
 * Marketplace-NEUTRAL derived conversation.
 *
 * Produced by a marketplace adapter's thread builder and consumed by everything
 * downstream. Carries no business context: no order, SKU, product, or listing
 * facts. Those are resolved and verified separately.
 */
export const inboxPlacements = ["reply_inbox", "outbound_only"] as const;

export type InboxPlacement = (typeof inboxPlacements)[number];

export type DerivedConversation = {
  readonly marketplace: Marketplace;

  /** Derived key, unique within its rule version. */
  readonly threadKey: string;
  /** Identifier of the rule that produced this grouping. */
  readonly threadingRuleVersion: string;
  readonly threadingStrategy: ThreadingStrategy;

  readonly subSourceId: number;
  readonly listingItemRef: string | null;
  readonly counterpartyRef: string;

  /** Exact naive source timestamps of the first and last message. Never converted. */
  readonly firstSourceTimestamp: string;
  readonly lastSourceTimestamp: string;

  readonly messageCount: number;
  readonly inboundCount: number;
  readonly outboundCount: number;

  /**
   * True when the conversation cannot be deterministically tied to business
   * context — currently every no-item conversation, since Day 1 discovery found
   * no authoritative order reference for them.
   */
  readonly needsContext: boolean;

  readonly inboxPlacement: InboxPlacement;

  /** Messages in source order: timestamp ASC, then source PK ASC. */
  readonly messages: readonly SourceMessage[];
};

/** Summary of one thread-building run, including what was deliberately excluded. */
export type ThreadBuildResult = {
  readonly conversations: readonly DerivedConversation[];
  readonly excludedSystemNoticeCount: number;
  readonly excludedUnusableCount: number;
};
