import type { ThreadBuildResult } from "@/lib/domain/conversation";
import type { SourceMessage } from "@/lib/domain/source-message";
import {
  type ReferenceThreadingRules,
  buildReferenceConversations,
} from "@/lib/marketplaces/reference-thread-builder";

/**
 * B&Q thread builder.
 *
 * Grouped: messages sharing (sub_source, source order reference) form one
 * conversation. The reference is deterministic in the source — uniform in shape
 * across all 5,943 rows that carry one, and repeated across messages belonging
 * to the same correspondence — so grouping on it is source-supported.
 *
 * `needsContext` is nevertheless TRUE for grouped threads as well as singletons.
 * Grouping and context are separate claims: the reference proves two messages
 * belong together, but it has NOT been matched against the order tables, so
 * nothing has established which purchase — if any — the thread concerns. Marking
 * a grouped thread as resolved would assert the second claim from evidence for
 * only the first.
 *
 * A message with no source reference gets its own conversation. It is NOT
 * grouped by sender address: every message arrives from a platform or courier
 * relay domain, so grouping on one would merge unrelated customers.
 */

export const BANDQ_SOURCE_ORDER_THREAD_RULE = "bandq-source-order-thread-v1" as const;
export const BANDQ_UNRESOLVED_SINGLETON_RULE = "bandq-unresolved-singleton-v1" as const;

export const BANDQ_THREADING: ReferenceThreadingRules = {
  marketplace: "bandq",
  singletonRule: BANDQ_UNRESOLVED_SINGLETON_RULE,
  grouping: {
    rule: BANDQ_SOURCE_ORDER_THREAD_RULE,
    referenceOf: (message) => message.sourceMetadata.sourceOrderRef ?? null,
    // The source reference is not a resolved application order. See above.
    needsContext: true,
  },
};

export function buildConversations(messages: readonly SourceMessage[]): ThreadBuildResult {
  return buildReferenceConversations(messages, BANDQ_THREADING);
}
