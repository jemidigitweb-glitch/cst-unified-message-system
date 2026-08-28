import { describe, expect, it } from "vitest";

import { buildDraftInput } from "@/lib/ai/draft-assembly";
import type { DraftOutcome, DraftProvider, DraftRequest } from "@/lib/ai/provider";
import { MAX_REGENERATIONS, withDraftValidation } from "@/lib/ai/validated-draft-provider";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * The accuracy gate as the route sees it: one draft in, one draft out.
 *
 * WHAT IS PINNED HERE, and each of these is a way the layer could do harm
 * rather than good:
 *
 *   - a good draft is not paid for twice
 *   - a bad draft is regenerated ONCE, never in a loop
 *   - the regeneration is told specifically what was wrong
 *   - a draft is never lost, whatever happens on the second call
 *   - a still-failing draft reaches a human, flagged, rather than being hidden
 *
 * The provider is a fake. No network, no key, no vendor.
 */

const MESSAGE: ConversationMessageView = {
  id: "1",
  direction: "inbound",
  sourceTimestamp: "2026-08-01 09:00:00",
  bodyText: "I purchased these by mistake. Could I cancel the order and get a refund please.",
  bodyDecodeStatus: "decoded",
  attachments: [],
};

const REQUEST: DraftRequest = {
  messages: [MESSAGE],
  marketplace: "ebay",
  listingItemRef: "123456789012",
  facts: [
    { name: "order_number", value: "12-34567-89012" },
    { name: "order_status", value: "New" },
  ],
};

/** A draft that contradicts the verified dispatch status. */
const BAD_REPLY = "Thank you for getting in touch. We will check the dispatch status and cancel if possible.";

/** A draft that uses it. */
const GOOD_REPLY =
  "Sorry to hear that. Your order has not left us yet, so we have raised the cancellation and the refund will go back to your original payment method.";

function outcome(reply: string, overrides: Partial<DraftOutcome> = {}): DraftOutcome {
  return {
    result: {
      draft_reply: reply,
      sources_used: [{ kind: "cst_document", ref: "CAN-1", label: null }],
      missing_information: [],
      requires_review: false,
    },
    requiresReview: false,
    missingInformation: [],
    model: "test-model",
    provider: "openai",
    knowledgeAvailable: true,
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    ...overrides,
  };
}

/** Records every request it is handed, and answers from a script. */
function fakeProvider(
  replies: readonly (string | Error)[],
  overrides: Partial<DraftOutcome> = {},
): DraftProvider & { calls: DraftRequest[] } {
  const calls: DraftRequest[] = [];
  return {
    name: "openai",
    model: "test-model",
    calls,
    async generate(request: DraftRequest): Promise<DraftOutcome> {
      calls.push(request);
      const next = replies[calls.length - 1];
      if (next === undefined) throw new Error("the gate asked for more drafts than it should");
      if (next instanceof Error) throw next;
      return outcome(next, overrides);
    },
  };
}

describe("the gate around a provider", () => {
  it("reports the wrapped provider's identity unchanged", () => {
    const gated = withDraftValidation(fakeProvider([GOOD_REPLY]));
    expect(gated.name).toBe("openai");
    expect(gated.model).toBe("test-model");
  });

  it("returns an accurate draft as it is, with one model call", async () => {
    const provider = fakeProvider([GOOD_REPLY]);
    const result = await withDraftValidation(provider).generate(REQUEST);

    expect(provider.calls).toHaveLength(1);
    expect(result.result.draft_reply).toBe(GOOD_REPLY);
    expect(result.requiresReview).toBe(false);
    expect(result.missingInformation).toEqual([]);
  });

  it("regenerates once, carrying what was wrong", async () => {
    const provider = fakeProvider([BAD_REPLY, GOOD_REPLY]);
    const result = await withDraftValidation(provider).generate(REQUEST);

    expect(provider.calls).toHaveLength(1 + MAX_REGENERATIONS);
    // The first attempt is asked for plainly; only the retry carries corrections.
    expect(provider.calls[0]!.corrections).toBeUndefined();
    expect(provider.calls[1]!.corrections?.join(" ")).toMatch(/NOT DISPATCHED/);
    // Everything else about the request is untouched.
    expect(provider.calls[1]!.messages).toEqual(REQUEST.messages);
    expect(provider.calls[1]!.facts).toEqual(REQUEST.facts);

    expect(result.result.draft_reply).toBe(GOOD_REPLY);
    // A corrected draft that now passes is not punished for having been retried.
    expect(result.requiresReview).toBe(false);
  });

  it("never regenerates more than once", async () => {
    const provider = fakeProvider([BAD_REPLY, BAD_REPLY]);
    const result = await withDraftValidation(provider).generate(REQUEST);

    expect(provider.calls).toHaveLength(2);
    expect(result.requiresReview).toBe(true);
  });

  it("hands a still-failing draft to a human with the findings attached", async () => {
    const provider = fakeProvider([BAD_REPLY, BAD_REPLY]);
    const result = await withDraftValidation(provider).generate(REQUEST);

    expect(result.result.draft_reply).toBe(BAD_REPLY);
    expect(result.requiresReview).toBe(true);
    expect(result.missingInformation.join("\n")).toMatch(/Accuracy check/);
    expect(result.missingInformation.join("\n")).toMatch(/order_status = New/);
  });

  /**
   * A draft that exists is worth more than a draft that might have been better.
   * Losing the first one because the second call fell over would turn a flawed
   * reply into no reply for the person waiting on it.
   */
  it("keeps the first draft when the regeneration cannot be made", async () => {
    const provider = fakeProvider([BAD_REPLY, new Error("provider fell over")]);
    const result = await withDraftValidation(provider).generate(REQUEST);

    expect(result.result.draft_reply).toBe(BAD_REPLY);
    expect(result.requiresReview).toBe(true);
    expect(result.missingInformation.join("\n")).toMatch(/Accuracy check/);
  });

  it("adds up what both attempts cost", async () => {
    const provider = fakeProvider([BAD_REPLY, GOOD_REPLY]);
    const result = await withDraftValidation(provider).generate(REQUEST);
    // A regeneration that vanished from the accounting would understate every
    // rejected draft in ai_usage_log.
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20, totalTokens: 220 });
  });

  it("leaves an unreported token count unreported rather than guessing", async () => {
    const provider = fakeProvider([BAD_REPLY, GOOD_REPLY], {
      usage: { inputTokens: null, outputTokens: 10, totalTokens: null },
    });
    const result = await withDraftValidation(provider).generate(REQUEST);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: 20, totalTokens: null });
  });

  /**
   * A restricted draft states no policy by instruction, so it is not graded on
   * rules or intent — and must not be regenerated for failing a test it was
   * told to fail.
   */
  it("does not regenerate a restricted draft over rules it was told not to state", async () => {
    const provider = fakeProvider([
      "Thank you for getting in touch. Could you tell us a little more so that we can help?",
    ], { knowledgeAvailable: false });
    const result = await withDraftValidation(provider).generate(REQUEST);

    expect(provider.calls).toHaveLength(1);
    expect(result.requiresReview).toBe(false);
  });
});

describe("the correction block in the prompt", () => {
  it("is absent from a first attempt", () => {
    expect(buildDraftInput(REQUEST)).not.toMatch(/CORRECTION/);
  });

  it("appears last, naming each point, on a regeneration", () => {
    const input = buildDraftInput({ ...REQUEST, corrections: ["Fix the dispatch status."] });
    expect(input).toMatch(/CORRECTION/);
    expect(input).toContain("1. Fix the dispatch status.");
    expect(input.indexOf("CORRECTION")).toBeGreaterThan(input.indexOf("CONVERSATION"));
  });

  it("is absent when the correction list is empty", () => {
    expect(buildDraftInput({ ...REQUEST, corrections: [] })).not.toMatch(/CORRECTION/);
  });
});
