import { describe, expect, it } from "vitest";

import { TIER_MODEL_VARS, assessComplexity } from "@/lib/ai/model-selection";
import { getOpenAiProvider } from "@/lib/ai/openai-client";
import type { DraftRequest } from "@/lib/ai/provider";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * The tier configuration this deployment actually has, against the real API.
 *
 * OPT-IN via RUN_LIVE_ROUTING=1. It spends tokens — three drafts, each one a
 * full File Search request — so it is not part of the default suite.
 *
 *   RUN_LIVE_ROUTING=1 npx vitest run tests/ai/model-routing-live.test.ts
 *
 * WHAT ONLY A LIVE RUN CAN TELL YOU, and why this exists next to the stubbed
 * tests rather than instead of them. The stubbed tests prove the routing logic:
 * which tier a conversation scores, and that the request is identical whichever
 * model is chosen. They cannot prove that the three model ids in `.env` are real
 * ids this account may use — a tier pointing at a model that does not exist is
 * invisible until a customer's draft fails.
 *
 * IT WRITES NOTHING. No database, no revision, no message. It calls the
 * provider directly rather than through the accuracy gate, so it is exactly
 * three model calls and never a regeneration.
 */

loadEnvFile();

const ready =
  process.env.RUN_LIVE_ROUTING === "1" &&
  getOpenAiProvider() !== undefined &&
  Object.values(TIER_MODEL_VARS).every((name) => (process.env[name]?.trim() ?? "") !== "");

function message(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-08-01 09:00:00",
    bodyText: "Has my parcel shipped?",
    bodyDecodeStatus: "decoded",
    attachments: [],
    ...overrides,
  };
}

/** Synthetic conversations, one per tier. No real customer text. */
const CASES = [
  {
    tier: "simple" as const,
    request: {
      messages: [message({ bodyText: "Could you tell me when this was posted please?" })],
      marketplace: "ebay",
      listingItemRef: null,
      facts: [],
    } satisfies DraftRequest,
  },
  {
    tier: "standard" as const,
    request: {
      messages: [
        message({ id: "1", bodyText: "Where is my order?" }),
        message({ id: "2", direction: "outbound", bodyText: "Let me check that for you." }),
        message({ id: "3", bodyText: "Tracking has not moved and I now want a refund." }),
      ],
      marketplace: "ebay",
      listingItemRef: null,
      facts: [],
    } satisfies DraftRequest,
  },
  {
    tier: "complex" as const,
    request: {
      messages: [message({ bodyText: "The bulb caught fire and burnt the light fitting." })],
      marketplace: "ebay",
      listingItemRef: null,
      facts: [],
    } satisfies DraftRequest,
  },
];

describe.skipIf(!ready)("live tier routing", () => {
  for (const { tier, request } of CASES) {
    it(`routes a ${tier} conversation to ${TIER_MODEL_VARS[tier]} and the model answers`, async () => {
      // The scorer and the provider must agree on the tier, or the assertion
      // below would be checking configuration against itself.
      expect(assessComplexity(request).tier).toBe(tier);

      const outcome = await getOpenAiProvider()!.generate(request);

      expect(outcome.model).toBe(process.env[TIER_MODEL_VARS[tier]]);
      expect(outcome.provider).toBe("openai");
      // A real answer came back, grounded in the CST knowledge base.
      expect(outcome.result.draft_reply.trim()).not.toBe("");
      expect(outcome.knowledgeAvailable).toBe(true);

      console.info(
        `[live] ${tier} → ${outcome.model} | ` +
          `tokens in/out ${outcome.usage?.inputTokens}/${outcome.usage?.outputTokens}`,
      );
    }, 180_000);
  }
});
