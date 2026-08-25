import type { DerivedConversation, ThreadBuildResult } from "@/lib/domain/conversation";
import { compareSourceOrder, type SourceMessage } from "@/lib/domain/source-message";
import {
  THREAD_GAP_MS,
  type ThreadingStrategy,
  belongsInReplyInbox,
  gapMillis,
  threadKeyOf,
} from "@/lib/domain/threading";

/**
 * eBay thread builder.
 *
 * The source exposes no thread id, so conversations are derived. Each rule
 * carries a durable identifier stored alongside every thread, so a future rule
 * can regenerate grouping without colliding with or corrupting existing work.
 *
 * Item-linked: sub_source + listing item + counterparty, segmented on a gap
 * greater than 30 days.
 *
 * No-item: sub_source + counterparty, same segmentation. Day 1 discovery found
 * no authoritative order reference for these (0 of 1,091 subjects contained an
 * order number), so every no-item conversation is flagged `needsContext`. This
 * builder makes no attempt to attach an order by buyer handle, and never reads
 * message text to infer one.
 *
 * Output is deterministic: identical input always yields identical thread keys,
 * ordering, and conversation order.
 */

export const EBAY_ITEM_LINKED_RULE = "ebay-item-counterparty-gap-v1" as const;
export const EBAY_NO_ITEM_RULE = "ebay-counterparty-gap-v1" as const;

type GroupKey = {
  readonly strategy: ThreadingStrategy;
  readonly ruleVersion: string;
  readonly subSourceId: number;
  readonly counterpartyRef: string;
  readonly listingItemRef: string | null;
};

function groupKeyOf(message: SourceMessage): GroupKey {
  const itemLinked = message.listingItemRef !== null;
  return {
    strategy: itemLinked ? "item_linked" : "no_item",
    ruleVersion: itemLinked ? EBAY_ITEM_LINKED_RULE : EBAY_NO_ITEM_RULE,
    subSourceId: message.subSourceId,
    counterpartyRef: message.counterpartyRef ?? "",
    listingItemRef: itemLinked ? message.listingItemRef : null,
  };
}

/**
 * Stable map key. Canonical JSON for the same reason as `threadKeyOf`: the
 * listing and counterparty refs are opaque source strings, so a delimiter join
 * could merge two distinct conversations whose values happen to contain that
 * delimiter.
 */
function groupKeyString(key: GroupKey): string {
  return JSON.stringify([
    key.ruleVersion,
    key.strategy,
    key.subSourceId,
    key.listingItemRef,
    key.counterpartyRef,
  ]);
}

/**
 * Builds conversations from normalized messages.
 *
 * Messages without a counterparty never reach here — the adapter refuses to
 * normalize them — so grouping cannot silently collapse unrelated customers.
 */
export function buildConversations(messages: readonly SourceMessage[]): ThreadBuildResult {
  const groups = new Map<string, { key: GroupKey; messages: SourceMessage[] }>();
  let excludedUnusableCount = 0;

  for (const message of messages) {
    if (message.counterpartyRef === null || message.counterpartyRef === "") {
      excludedUnusableCount += 1;
      continue;
    }
    const key = groupKeyOf(message);
    const id = groupKeyString(key);
    const existing = groups.get(id);
    if (existing) existing.messages.push(message);
    else groups.set(id, { key, messages: [message] });
  }

  const conversations: DerivedConversation[] = [];

  for (const group of groups.values()) {
    const ordered = [...group.messages].sort(compareSourceOrder);
    for (const [segment, run] of segmentByGap(ordered).entries()) {
      conversations.push(toConversation(group.key, segment, run));
    }
  }

  conversations.sort(
    (a, b) =>
      (a.firstSourceTimestamp < b.firstSourceTimestamp
        ? -1
        : a.firstSourceTimestamp > b.firstSourceTimestamp
          ? 1
          : 0) || (a.threadKey < b.threadKey ? -1 : a.threadKey > b.threadKey ? 1 : 0),
  );

  return {
    conversations,
    // System notices are no longer excluded upstream — the repository only
    // counts them for visibility. Every row that normalizes reaches this
    // builder and can form (or join) a conversation like any other message.
    excludedSystemNoticeCount: 0,
    excludedUnusableCount,
  };
}

/** Splits an ordered run wherever the gap to the previous message exceeds the threshold. */
function segmentByGap(ordered: readonly SourceMessage[]): SourceMessage[][] {
  const segments: SourceMessage[][] = [];
  let current: SourceMessage[] = [];

  for (const message of ordered) {
    const previous = current.at(-1);
    if (previous && gapMillis(previous.sourceTimestamp, message.sourceTimestamp) > THREAD_GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) segments.push(current);

  return segments;
}

function toConversation(
  key: GroupKey,
  segment: number,
  run: readonly SourceMessage[],
): DerivedConversation {
  const inboundCount = run.filter((m) => m.direction === "inbound").length;
  const outboundCount = run.length - inboundCount;

  return {
    marketplace: "ebay",
    threadKey: threadKeyOf({
      ruleVersion: key.ruleVersion,
      strategy: key.strategy,
      subSourceId: key.subSourceId,
      counterpartyRef: key.counterpartyRef,
      listingItemRef: key.listingItemRef,
      segment,
    }),
    threadingRuleVersion: key.ruleVersion,
    threadingStrategy: key.strategy,
    subSourceId: key.subSourceId,
    listingItemRef: key.listingItemRef,
    counterpartyRef: key.counterpartyRef,
    firstSourceTimestamp: run[0]!.sourceTimestamp,
    lastSourceTimestamp: run.at(-1)!.sourceTimestamp,
    messageCount: run.length,
    inboundCount,
    outboundCount,
    // Every no-item conversation needs human context: there is no authoritative
    // order reference for it in the source.
    needsContext: key.strategy === "no_item",
    inboxPlacement: belongsInReplyInbox({ inboundCount }) ? "reply_inbox" : "outbound_only",
    // eBay's source is a dedicated message feed, not a shared mailbox: there is
    // no courier or supplier traffic in it to filter out.
    inboxFilterReason: null,
    messages: run,
  };
}
