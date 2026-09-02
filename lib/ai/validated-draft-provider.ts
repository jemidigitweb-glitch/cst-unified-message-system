import { type DraftValidation, validateDraftAccuracy } from "./draft-validation";
import type { DraftOutcome, DraftProvider, DraftRequest, DraftUsage } from "./provider";

/**
 * The accuracy gate, wrapped around any provider.
 *
 * WHY A WRAPPER AND NOT A STEP IN EACH PROVIDER. Two providers with their own
 * copy of the same retry is how they quietly stop behaving identically — one
 * regenerates, the other does not, and the difference only shows up in front of
 * a customer. This sits above both, so OpenAI and Gemini are gated by exactly
 * the same code, and it is the same code the tests exercise with a fake.
 *
 * WHY NOT IN THE ROUTE. The route would then have to know that generation can
 * happen twice, and the workflow, the transaction and the usage accounting are
 * all written around one draft in and one draft out. This keeps that contract:
 * the caller asks for a draft and gets a draft. What changed is how hard the
 * draft was checked before it was handed over.
 *
 * WHAT IT CAN AND CANNOT DO.
 *
 *   can     ask for exactly one regeneration, carrying specific corrections.
 *   can     force human review and attach its findings for the reviewer.
 *   cannot  approve a draft, suppress a draft, or reach a customer. There is no
 *           transport here and no state after `reviewed`.
 *
 * A DRAFT IS NEVER DISCARDED. If the regeneration fails to fix things, or the
 * provider is unreachable for the second call, the reviewer still gets a draft
 * — flagged, with the findings written down. Returning nothing would turn a
 * flawed reply into no reply, which is a worse outcome for the person waiting.
 */

/** One regeneration, and no more. */
export const MAX_REGENERATIONS = 1;

/** Both attempts' tokens, so a regeneration is not missing from the accounting. */
function combineUsage(
  first: DraftUsage | undefined,
  second: DraftUsage | undefined,
): DraftUsage | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  // Null means "the provider did not report it" and must stay null: adding it
  // to a number would report a total we know to be short.
  const add = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : a + b;
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

/** The outcome as the reviewer should see it: flagged, with the findings attached. */
function flagged(outcome: DraftOutcome, validation: DraftValidation): DraftOutcome {
  return {
    ...outcome,
    requiresReview: true,
    missingInformation: [...new Set([...outcome.missingInformation, ...validation.notes])],
  };
}

function check(outcome: DraftOutcome, request: DraftRequest): DraftValidation {
  return validateDraftAccuracy({
    reply: outcome.result.draft_reply,
    facts: request.facts,
    messages: request.messages,
    tracking: request.tracking,
    bundle: request.bundle,
    knowledgeAvailable: outcome.knowledgeAvailable,
  });
}

export function withDraftValidation(provider: DraftProvider): DraftProvider {
  return {
    name: provider.name,
    model: provider.model,

    async generate(request: DraftRequest): Promise<DraftOutcome> {
      const first = await provider.generate(request);
      const firstCheck = check(first, request);
      if (firstCheck.passed) return first;

      /*
       * A SECOND CALL IS BOUGHT, NOT TRIGGERED.
       *
       * Regeneration costs the same again — the same instructions, the same
       * retrieval, the same reasoning — so it is spent only on findings that
       * make the reply WRONG. A reply that is true but incomplete goes to the
       * reviewer with the gap written down, which is what they were going to
       * read anyway, at no model cost. This is the difference between the
       * accuracy layer costing a call on most conversations and costing one
       * on the few that are actually broken.
       */
      if (!firstCheck.regenerationWarranted) {
        console.info(
          `[draft] accuracy check found ${firstCheck.findings.length} minor finding(s); flagging for review without regenerating`,
        );
        return flagged(first, firstCheck);
      }

      console.info(
        `[draft] accuracy check rejected the draft (${firstCheck.findings.length} finding(s)); regenerating: ${firstCheck.findings
          .filter((finding) => finding.severity === "critical")
          .map((finding) => finding.issue)
          .join(", ")}`,
      );

      let second: DraftOutcome | undefined;
      try {
        second = await provider.generate({
          ...request,
          corrections: firstCheck.corrections,
          // Sent so the retry mends its own text instead of starting over.
          rejectedDraft: first.result.draft_reply,
        });
      } catch (cause) {
        // A failed second call must not cost the reviewer the draft that
        // already exists. Logged, flagged, handed over.
        console.error("[draft] regeneration failed; keeping the first draft", cause);
      }

      if (second === undefined) return flagged(first, firstCheck);

      const merged: DraftOutcome = { ...second, usage: combineUsage(first.usage, second.usage) };
      const secondCheck = check(merged, request);

      if (secondCheck.passed) {
        console.info("[draft] regenerated draft passed the accuracy check");
        return merged;
      }

      /*
       * Both attempts failed. Keep the better one, and prefer the corrected
       * attempt on a tie: it was written knowing what was wrong, so an equal
       * count is more likely to be this layer being over-strict than the model
       * having learned nothing.
       *
       * COMPARED ON CRITICAL FINDINGS. A retry that fixed a contradiction and
       * picked up two coverage gaps is better than the draft that stated
       * something false, and counting every finding equally would have thrown
       * it away.
       */
      const criticalCount = (validation: DraftValidation): number =>
        validation.findings.filter((finding) => finding.severity === "critical").length;

      console.info(
        `[draft] regenerated draft still has ${criticalCount(secondCheck)} critical finding(s); flagging for review`,
      );
      return criticalCount(secondCheck) <= criticalCount(firstCheck)
        ? flagged(merged, secondCheck)
        : flagged({ ...first, usage: merged.usage }, firstCheck);
    },
  };
}
