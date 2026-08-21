import "server-only";

import { DRAFT_RESULT_JSON_SCHEMA } from "@/lib/domain/draft";
import { renderRulesForPrompt } from "@/lib/domain/knowledge";
import { loadRulesForConversation } from "@/lib/knowledge/cst-rules-files";

import { buildDraftInput, validateDraft } from "./draft-assembly";
import { getDraftModelClient } from "./gemini-client";
import { cstInstructions, restrictedInstructions } from "./instructions";
import {
  type DraftOutcome,
  type DraftProvider,
  type DraftRequest,
  DraftServiceUnavailable,
} from "./provider";

/**
 * Gemini draft provider — the FALLBACK path.
 *
 * Kept because Gemini has no retrieval service we can point at, so the only way
 * it can see CST policy is to be handed the whole corpus: ~127,000 tokens of
 * rules on every request. That is what capped drafting at roughly one per
 * minute on the free tier, and it is why OpenAI + File Search is now the
 * primary provider.
 *
 * IT IS NOT DEAD CODE, and should not be deleted on sight. It is the working
 * answer to "what if OpenAI is unreachable, or the vector store is empty, or
 * the migration has to be rolled back". It also remains the only path that
 * gives the model every rule with no retrieval step in between, which is the
 * higher-coverage option when accuracy matters more than throughput.
 *
 * It is asked for the SAME behaviour as the OpenAI provider — same
 * instructions, same output shape, same validation. The only difference is how
 * the knowledge arrives.
 */
export function getGeminiProvider(): DraftProvider | undefined {
  const client = getDraftModelClient();
  if (client === undefined) return undefined;

  return {
    name: "gemini",
    model: client.model,

    async generate(request: DraftRequest): Promise<DraftOutcome> {
      if (request.messages.length === 0) {
        throw new DraftServiceUnavailable("This conversation has no messages to reply to.");
      }

      // Read per generation. The cache keys on each workbook's mtime, so an
      // edited rule file takes effect on the next draft without a restart.
      const { knowledge } = loadRulesForConversation(request.marketplace);
      const available = knowledge.state === "available";
      const knowledgeReason = available ? undefined : knowledge.reason;

      const rendered = available ? renderRulesForPrompt(knowledge.rules) : undefined;

      const response = await client.generate({
        instructions: available
          ? cstInstructions(request.marketplace)
          : restrictedInstructions(request.marketplace),
        input: buildDraftInput(request, rendered),
        responseSchema: DRAFT_RESULT_JSON_SCHEMA,
      });

      // Gemini KNOWS what it was given, so an invented reference can be dropped
      // outright — the strongest form of this check, and the reason `knownRefs`
      // is optional rather than absent from the shared validator.
      const knownRefs = available ? new Set(knowledge.rules.map((rule) => rule.ref)) : new Set<string>();
      const validated = validateDraft(response.text, request, knownRefs);

      const missing = available
        ? validated.missingInformation
        : [...new Set([...validated.missingInformation, knowledgeReason!])];

      return {
        result: validated.result,
        requiresReview: !available || validated.requiresReview,
        missingInformation: missing,
        model: client.model,
        provider: "gemini",
        knowledgeAvailable: available,
        knowledgeReason,
      };
    },
  };
}
