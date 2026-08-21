import type { ThreadBuildResult } from "@/lib/domain/conversation";
import type { SourceMessage } from "@/lib/domain/source-message";
import {
  type ReferenceThreadingRules,
  buildReferenceConversations,
} from "@/lib/marketplaces/reference-thread-builder";

/**
 * Amazon thread builder.
 *
 * Order-linked: messages sharing (sub_source, order_id) form one conversation.
 * The order reference is a genuine marketplace identifier — 94% of messages
 * carry one and 99.8% of those resolve against the order tables — so this is a
 * source-supported grouping, not a heuristic, and a grouped thread does not by
 * itself need human context.
 *
 * Now that direction is mapped from the sender fields, a thread carries both
 * sides: the customer's messages and the CST replies relayed back into it,
 * interleaved in source order.
 *
 * A message with no order reference gets its own conversation flagged
 * `needsContext`. It is NOT grouped by sender address — that is a shared Amazon
 * relay, and grouping on one would merge unrelated customers.
 */

export const AMAZON_ORDER_THREAD_RULE = "amazon-order-thread-v1" as const;
export const AMAZON_UNRESOLVED_SINGLETON_RULE = "amazon-unresolved-singleton-v1" as const;

export const AMAZON_THREADING: ReferenceThreadingRules = {
  marketplace: "amazon",
  singletonRule: AMAZON_UNRESOLVED_SINGLETON_RULE,
  grouping: {
    rule: AMAZON_ORDER_THREAD_RULE,
    referenceOf: (message) => message.sourceMetadata.orderRef ?? null,
    needsContext: false,
  },
};

export function buildConversations(messages: readonly SourceMessage[]): ThreadBuildResult {
  return buildReferenceConversations(messages, AMAZON_THREADING);
}
