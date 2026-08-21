import type { ThreadBuildResult } from "@/lib/domain/conversation";
import type { SourceMessage } from "@/lib/domain/source-message";
import {
  type ReferenceThreadingRules,
  buildReferenceConversations,
} from "@/lib/marketplaces/reference-thread-builder";

/**
 * Shopify thread builder.
 *
 * Grouped: messages sharing (sub_source, order reference) form one
 * conversation. The reference resolves against the order tables for 1,433 of
 * 1,807 distinct values (79%), so grouping on it is source-supported.
 *
 * `needsContext` stays TRUE for grouped threads. Grouping and context are
 * separate claims: the reference proves two messages concern the same order,
 * and a fifth of those references do not resolve to an order we hold, so
 * nothing here has established which purchase a thread is about.
 *
 * A message with no reference gets its own conversation. It is NOT grouped by
 * email address: this source carries suppliers, couriers, marketplace notices
 * and cold sales mail alongside customers, and grouping strangers by address
 * would assert a relationship the source does not support.
 *
 * Only messages whose direction the addresses decided reach here. Ambiguous
 * ones never enter a conversation at all — see the adapter.
 */

export const SHOPIFY_ORDER_THREAD_RULE = "shopify-order-thread-v1" as const;
export const SHOPIFY_UNRESOLVED_SINGLETON_RULE = "shopify-unresolved-singleton-v1" as const;

export const SHOPIFY_THREADING: ReferenceThreadingRules = {
  marketplace: "shopify",
  singletonRule: SHOPIFY_UNRESOLVED_SINGLETON_RULE,
  // This mailbox carries bounces, courier notices, other channels' alerts and
  // unsolicited mail alongside customers. All of it stays stored and threaded;
  // only the reply inbox is filtered. See `inbox-filter.ts`.
  filterReasonOf: (message) => message.sourceMetadata.inboxFilterReason ?? null,
  grouping: {
    rule: SHOPIFY_ORDER_THREAD_RULE,
    referenceOf: (message) => message.sourceMetadata.orderRef ?? null,
    // The reference is not a confirmed order for every thread. See above.
    needsContext: true,
  },
};

export function buildConversations(messages: readonly SourceMessage[]): ThreadBuildResult {
  return buildReferenceConversations(messages, SHOPIFY_THREADING);
}
