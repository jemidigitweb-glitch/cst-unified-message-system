import type { DerivedConversation, ThreadBuildResult } from "@/lib/domain/conversation";
import { unresolvedReferenceFor } from "@/lib/domain/conversation-reference";
import type { Marketplace } from "@/lib/domain/marketplace";
import { compareSourceOrder, type SourceMessage } from "@/lib/domain/source-message";
import { belongsInReplyInbox, threadKeyOf } from "@/lib/domain/threading";

/**
 * Shared thread builder for sources that group by a SOURCE REFERENCE.
 *
 * eBay is not built on this: it groups on a listing plus a real buyer handle
 * and needs gap segmentation, because that pair recurs across unrelated
 * purchases months apart. Amazon, B&Q and Temu instead carry a per-order source
 * reference that does not recur, so segmentation would split one order's
 * correspondence for no reason and is deliberately absent.
 *
 * Two invariants hold for every marketplace built on this:
 *
 *   No message is discarded. A message the source gives nothing to group by
 *   becomes its own conversation, keyed on its immutable source PK, and is
 *   flagged `needsContext` — an honest "ungrouped message", not a complete
 *   thread that happens to be short.
 *
 *   Nothing is ever grouped by sender address. Every one of these sources
 *   delivers through a shared platform relay, so that address identifies the
 *   channel and grouping on it would merge unrelated customers.
 *
 * Neither strategy is item-linked, so both use the neutral `no_item` strategy;
 * the rule version recorded on each conversation distinguishes them.
 */

export type ReferenceThreadingRules = {
  readonly marketplace: Marketplace;
  /** Rule for a message that stands alone. Such a conversation always needs context. */
  readonly singletonRule: string;
  /**
   * Grouping rule. Omitted entirely when the source supplies no reference that
   * is reliable enough to group on — every message then stands alone.
   */
  /**
   * Why a message is not reply work, or null when it is. Omitted entirely by
   * marketplaces that filter nothing.
   *
   * Applied per message, but decided per conversation: a thread is filtered
   * only when EVERY message in it is. One genuine customer message is enough
   * to keep the whole thread visible, so a filter rule can never hide a real
   * conversation because a courier notice happened to join it.
   */
  readonly filterReasonOf?: (message: SourceMessage) => string | null;
  readonly grouping?: {
    readonly rule: string;
    /** The source grouping reference for a message, or null when absent. */
    readonly referenceOf: (message: SourceMessage) => string | null;
    /**
     * Whether a grouped conversation still needs human context. True where the
     * grouping reference has not been proven to resolve to an application
     * order — grouping two messages together and knowing what they concern are
     * separate claims.
     */
    readonly needsContext: boolean;
  };
};

type GroupKey = {
  readonly ruleVersion: string;
  readonly subSourceId: number;
  /** The source reference for a grouped thread, or the source PK for a singleton. */
  readonly conversationRef: string;
  readonly needsContext: boolean;
};

function groupKeyOf(message: SourceMessage, rules: ReferenceThreadingRules): GroupKey {
  const reference = rules.grouping?.referenceOf(message) ?? null;
  if (rules.grouping !== undefined && reference !== null && reference !== "") {
    return {
      ruleVersion: rules.grouping.rule,
      subSourceId: message.subSourceId,
      conversationRef: reference,
      needsContext: rules.grouping.needsContext,
    };
  }
  return {
    ruleVersion: rules.singletonRule,
    subSourceId: message.subSourceId,
    conversationRef: unresolvedReferenceFor(message.sourcePk),
    needsContext: true,
  };
}

/**
 * Stable map key. Canonical JSON for the same reason as `threadKeyOf`: the
 * reference is an opaque source string, so a delimiter join could merge two
 * distinct conversations whose values happen to contain that delimiter.
 */
function groupKeyString(key: GroupKey): string {
  return JSON.stringify([key.ruleVersion, key.subSourceId, key.conversationRef]);
}

export function buildReferenceConversations(
  messages: readonly SourceMessage[],
  rules: ReferenceThreadingRules,
): ThreadBuildResult {
  const groups = new Map<string, { key: GroupKey; messages: SourceMessage[] }>();
  let excludedUnusableCount = 0;

  for (const message of messages) {
    // Cross-marketplace input is a programming error, not data to absorb: it
    // would file another source's message under this marketplace's tab.
    if (message.marketplace !== rules.marketplace) {
      excludedUnusableCount += 1;
      continue;
    }
    const key = groupKeyOf(message, rules);
    const id = groupKeyString(key);
    const existing = groups.get(id);
    if (existing) existing.messages.push(message);
    else groups.set(id, { key, messages: [message] });
  }

  const conversations: DerivedConversation[] = [];
  for (const group of groups.values()) {
    const ordered = [...group.messages].sort(compareSourceOrder);
    conversations.push(toConversation(rules.marketplace, group.key, ordered, rules.filterReasonOf));
  }

  conversations.sort(
    (a, b) =>
      (a.firstSourceTimestamp < b.firstSourceTimestamp
        ? -1
        : a.firstSourceTimestamp > b.firstSourceTimestamp
          ? 1
          : 0) || (a.threadKey < b.threadKey ? -1 : a.threadKey > b.threadKey ? 1 : 0),
  );

  return { conversations, excludedSystemNoticeCount: 0, excludedUnusableCount };
}

/**
 * The conversation's item reference, used only when every message agrees.
 * A thread whose messages name different items reports none rather than picking
 * one arbitrarily.
 */
function agreedItemRef(messages: readonly SourceMessage[]): string | null {
  const refs = new Set(messages.map((m) => m.listingItemRef));
  return refs.size === 1 ? (messages[0]!.listingItemRef ?? null) : null;
}

function toConversation(
  marketplace: Marketplace,
  key: GroupKey,
  run: readonly SourceMessage[],
  filterReasonOf?: (message: SourceMessage) => string | null,
): DerivedConversation {
  const inboundCount = run.filter((m) => m.direction === "inbound").length;

  // Filtered only when every message is. See `filterReasonOf`.
  const reasons = filterReasonOf ? run.map(filterReasonOf) : [];
  const filtered = reasons.length > 0 && reasons.every((reason) => reason !== null);
  const filterReason = filtered ? (reasons[0] as string) : null;

  return {
    marketplace,
    threadKey: threadKeyOf({
      ruleVersion: key.ruleVersion,
      // Not item-linked: grouping is by source reference, or not at all.
      strategy: "no_item",
      subSourceId: key.subSourceId,
      counterpartyRef: key.conversationRef,
      listingItemRef: null,
      segment: 0,
    }),
    threadingRuleVersion: key.ruleVersion,
    threadingStrategy: "no_item",
    subSourceId: key.subSourceId,
    listingItemRef: agreedItemRef(run),
    counterpartyRef: key.conversationRef,
    firstSourceTimestamp: run[0]!.sourceTimestamp,
    lastSourceTimestamp: run.at(-1)!.sourceTimestamp,
    messageCount: run.length,
    inboundCount,
    outboundCount: run.length - inboundCount,
    needsContext: key.needsContext,
    // Computed, not assumed. A source that carries CST replies can produce a
    // thread with no customer message in the window — a reply whose inbound
    // half falls outside it. That is not a customer-reply conversation, and
    // `cst_app.conversations` rejects one claiming to be.
    inboxPlacement: filtered
      ? "filtered"
      : belongsInReplyInbox({ inboundCount })
        ? "reply_inbox"
        : "outbound_only",
    inboxFilterReason: filterReason,
    messages: run,
  };
}
