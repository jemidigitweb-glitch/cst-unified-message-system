import type { ThreadBuildResult } from "@/lib/domain/conversation";
import type { SourceMessage } from "@/lib/domain/source-message";
import {
  type ReferenceThreadingRules,
  buildReferenceConversations,
} from "@/lib/marketplaces/reference-thread-builder";

/**
 * Temu thread builder.
 *
 * Every message becomes its own conversation, flagged `needsContext`. There is
 * no `grouping` rule at all, and that absence is the design:
 *
 *   The sender address cannot be used — every message arrives from a Temu relay
 *   domain, so grouping on it would collapse every customer into one thread.
 *
 *   The source reference cannot be used either — only 439 of 1,091 rows carry
 *   one, and those resolve to 422 distinct values. A key that is 96% unique
 *   groups almost nothing while implying that grouping was performed.
 *
 * One message per conversation is not a claim that each customer wrote once. It
 * is the absence of a claim: the source gives nothing that would justify joining
 * any two of these messages together. That is what `needsContext` records, and
 * it is why no message is dropped.
 */

export const TEMU_UNRESOLVED_SINGLETON_RULE = "temu-unresolved-singleton-v1" as const;

export const TEMU_THREADING: ReferenceThreadingRules = {
  marketplace: "temu",
  singletonRule: TEMU_UNRESOLVED_SINGLETON_RULE,
  // No grouping rule: see above.
};

export function buildConversations(messages: readonly SourceMessage[]): ThreadBuildResult {
  return buildReferenceConversations(messages, TEMU_THREADING);
}
