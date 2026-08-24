import type { CstRule } from "@/lib/domain/knowledge";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import { normaliseRef } from "@/lib/knowledge/rule-evidence";

/**
 * Whether the CURRENT approved CST knowledge can ground a reply at all.
 *
 * THE BUG THIS EXISTS FOR. A draft was generated first and its citations
 * checked afterwards, so a conversation could show "NO CST RULE / TEMPLATE
 * AVAILABLE" and "DRAFT REPLY — REVISION 1" at the same time. Both statements
 * were true of the same conversation and they contradict each other: a reply
 * had been written, and nothing in the rule base authorised a word of it.
 *
 * SO THE CHECK MOVED IN FRONT OF THE MODEL CALL. Two gates, and they answer
 * different questions:
 *
 *   BEFORE  `coverageFor` — is there an approved corpus for this marketplace
 *           at all? No corpus means no possible grounding, and the model must
 *           not be called: whatever it returned would be written from general
 *           knowledge of retail, which is precisely the failure the grounding
 *           design exists to prevent.
 *
 *   AFTER   `citationsAreValid` — did the reply it produced actually cite a
 *           rule that resolves against the corpus TODAY? A stale ref, a deleted
 *           rule, a legacy-format ref and an invented one all fail this. None
 *           of them is a valid rule, so none of them may authorise a draft, and
 *           the revision is discarded rather than saved and flagged.
 *
 * WHY THE FIRST GATE IS NOT A RELEVANCE FILTER. It deliberately does not decide
 * which rules apply to a conversation. Choosing a subset before the model reads
 * anything is the "rule selection" layer this project removed on purpose —
 * retrieval belongs to File Search, and second-guessing it locally is how a
 * relevant rule gets hidden from the model that needed it. This gate asks only
 * whether there is anything to retrieve FROM.
 *
 * PURE. No network, no database, no model call.
 */

export type RuleCoverage = {
  /** Whether generation may proceed. */
  readonly covered: boolean;
  /** Why not, for the reviewer. Null when covered. */
  readonly reason: string | null;
  /** Rules available to ground this conversation. */
  readonly rulesAvailable: number;
};

export const NO_CORPUS_REASON =
  "No applicable CST rule or approved template was found.";

/**
 * The pre-generation gate.
 *
 * `state` is the corpus loader's own answer — "available" with rules, or a
 * failure to read the workbooks. An empty corpus and an unreadable one are the
 * same outcome here: nothing to ground in, so nothing to call the model for.
 */
export function coverageFor(knowledge: {
  readonly state: string;
  readonly rules?: readonly CstRule[];
}): RuleCoverage {
  const rules = knowledge.state === "available" ? (knowledge.rules ?? []) : [];
  if (rules.length === 0) {
    return { covered: false, reason: NO_CORPUS_REASON, rulesAvailable: 0 };
  }
  return { covered: true, reason: null, rulesAvailable: rules.length };
}

/**
 * The post-generation gate: did the reply cite a rule that still exists?
 *
 * Resolved against the SAME corpus that was supplied, by the same
 * normalisation the evidence endpoint uses — so a ref stored with brackets
 * resolves here exactly as it does there. A citation that does not resolve is
 * not a rule; it is a string that looks like one.
 */
export function citationsAreValid(
  rules: readonly CstRef[],
  citedRefs: readonly string[],
): boolean {
  if (citedRefs.length === 0) return false;
  const known = new Set(rules.map((rule) => normaliseRef(rule.ref)));
  return citedRefs.some((ref) => known.has(normaliseRef(ref)));
}

/** Only the ref is needed to validate a citation. */
type CstRef = { readonly ref: string };

/**
 * What the API returns when generation is refused.
 *
 * A distinct `code`, not a generic 503. The interface has to tell "the rule
 * base cannot answer this" apart from "the provider is down": the first is a
 * finished, actionable state that produces an export, the second is a retry.
 */
export const NO_APPLICABLE_RULE_CODE = "no_applicable_rule";
