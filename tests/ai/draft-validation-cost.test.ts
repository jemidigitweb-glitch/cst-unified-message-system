import { describe, expect, it } from "vitest";

import { buildDraftInput } from "@/lib/ai/draft-assembly";
import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import { cstInstructions } from "@/lib/ai/instructions";
import { MAX_SEARCH_RESULTS_VAR, maxSearchResults } from "@/lib/ai/openai-client";
import type { DraftOutcome, DraftProvider, DraftRequest } from "@/lib/ai/provider";
import { withDraftValidation } from "@/lib/ai/validated-draft-provider";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * What the accuracy layer costs.
 *
 * THE MEASUREMENT THAT MATTERS, and it is not the one it is easy to assume.
 * Validation makes NO model call — it is a pure function over the draft, the
 * verified facts and the customer's own words. Its token cost is zero and its
 * wall-clock cost is well under a millisecond. The only way this layer can be
 * expensive is by buying a SECOND generation, so that is what these tests
 * count: how often a regeneration happens, and what a request carries when one
 * does.
 *
 * The two conversations below are the ones the team asked to compare on: a
 * cancellation before dispatch, and a missing part.
 */

const message = (text: string): ConversationMessageView => ({
  id: "1",
  direction: "inbound",
  sourceTimestamp: "2026-08-01 09:00:00",
  bodyText: text,
  bodyDecodeStatus: "decoded",
  attachments: [],
});

const CANCELLATION = "I purchased these by mistake. Could I cancel the order and get a refund please.";
const MISSING_PART = "The parcel arrived but the fixing screws are missing.";

/**
 * The expensive conversation, for the size guard below.
 *
 * A delivery query is the only case that carries tracking guidance, so it is
 * the only one whose prompt size the cap really needs to bound.
 */
const WHERE_IS_IT = "Where is my parcel? It was supposed to be here by now.";

/** A pre-sale question: no order, no tracking, the cheapest path. */
const PRE_SALE = "Could you tell me the weight of this lampshade please?";

const UNDISPATCHED: VerifiedFact[] = [
  { name: "order_number", value: "AA-11111-11111" },
  { name: "order_status", value: "New" },
];

/**
 * An order with a verified tracking number that no carrier result accompanies —
 * an unsupported courier, an unrecognised one, or a lookup that failed. It is
 * the second-dearest path, and the one the "no carrier update" block serves.
 */
const DISPATCHED_NO_UPDATE: VerifiedFact[] = [
  { name: "order_number", value: "AA-11111-11111" },
  { name: "order_status", value: "Dispatched" },
  { name: "tracking_number", value: "AB123456789GB" },
  { name: "delivery_courier", value: "Royal Mail" },
];

function request(text: string, facts: VerifiedFact[] = []): DraftRequest {
  return { messages: [message(text)], marketplace: "ebay", listingItemRef: "123456789012", facts };
}

function outcome(reply: string): DraftOutcome {
  return {
    result: {
      draft_reply: reply,
      sources_used: [{ kind: "cst_document", ref: "R-1", label: null }],
      missing_information: [],
      requires_review: false,
    },
    requiresReview: false,
    missingInformation: [],
    model: "test-model",
    provider: "openai",
    knowledgeAvailable: true,
    usage: { inputTokens: 71_911, outputTokens: 2_295, totalTokens: 74_206 },
  };
}

function fakeProvider(replies: readonly string[]): DraftProvider & { calls: DraftRequest[] } {
  const calls: DraftRequest[] = [];
  return {
    name: "openai",
    model: "test-model",
    calls,
    async generate(req: DraftRequest): Promise<DraftOutcome> {
      calls.push(req);
      const next = replies[calls.length - 1];
      if (next === undefined) throw new Error("more calls than the gate should make");
      return outcome(next);
    },
  };
}

/* ------------------------------------------------------------------ */

describe("validation costs no tokens and no time", () => {
  /**
   * The claim is worth a test rather than a comment, because "we added a
   * validation step" reads like "we added a call" and the difference is the
   * whole cost model of this layer.
   */
  it("reaches a verdict without a model, a network or a corpus", () => {
    const before = performance.now();
    const result = validateDraftAccuracy({
      reply: "We will check the dispatch status and cancel if possible.",
      facts: UNDISPATCHED,
      messages: [message(CANCELLATION)],
      knowledgeAvailable: true,
    });
    const elapsed = performance.now() - before;

    expect(result.passed).toBe(false);
    // Generous by three orders of magnitude against the 45-second generation it
    // is judging. It exists to fail if this ever becomes a call.
    expect(elapsed).toBeLessThan(50);
  });

  it("sees only the draft, the facts and the customer's words", () => {
    // The whole input to the validator, stated as a type. There is no corpus
    // parameter, no retrieval parameter and no marketplace parameter, so no
    // amount of CST knowledge can be resent to it by mistake.
    const input = {
      reply: "x",
      facts: UNDISPATCHED,
      messages: [message(CANCELLATION)],
      knowledgeAvailable: true,
    };
    expect(Object.keys(input).sort()).toEqual([
      "facts",
      "knowledgeAvailable",
      "messages",
      "reply",
    ]);
    expect(validateDraftAccuracy(input)).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */

describe("how often a second call is bought", () => {
  /** An accurate draft: one call, as before the layer existed. */
  it("spends nothing extra on a good cancellation draft", async () => {
    const provider = fakeProvider([
      "Your order has not left us yet, so we have raised the cancellation and the refund will go back to your original payment method.",
    ]);
    const result = await withDraftValidation(provider).generate(request(CANCELLATION, UNDISPATCHED));

    expect(provider.calls).toHaveLength(1);
    expect(result.usage?.totalTokens).toBe(74_206);
  });

  it("spends nothing extra on a good missing-part draft", async () => {
    const provider = fakeProvider([
      "I am sorry a part was missing. Please confirm which piece is absent and we will send the missing part out to you.",
    ]);
    const result = await withDraftValidation(provider).generate(request(MISSING_PART));

    expect(provider.calls).toHaveLength(1);
    expect(result.usage?.totalTokens).toBe(74_206);
  });

  /**
   * The saving. This draft says nothing false — the order genuinely has not
   * gone out and it genuinely can still be stopped — but it never mentions the
   * money the customer asked about. Before severity that bought a second
   * 74,206-token call. Now it costs a line in the reviewer's notes.
   */
  it("does not buy a call for a draft that is true but incomplete", async () => {
    const provider = fakeProvider([
      "Sorry to hear that. Your order has not gone out yet, so we can still stop it before it is picked.",
    ]);
    const result = await withDraftValidation(provider).generate(request(CANCELLATION, UNDISPATCHED));

    expect(provider.calls).toHaveLength(1);
    expect(result.usage?.totalTokens).toBe(74_206);
    // The reviewer still sees it. Nothing is hidden to save a call.
    expect(result.requiresReview).toBe(true);
    expect(result.missingInformation.join("\n")).toMatch(/\[minor\]/);
    expect(result.missingInformation.join("\n")).toMatch(/refund/i);
    expect(result.missingInformation.join("\n")).not.toMatch(/\[critical\]/);
  });

  /**
   * The boundary, and it is a fine one worth pinning. "We can still stop it" is
   * a promise about the future and is minor when incomplete. "We have
   * cancelled it" is a claim that an action is DONE, and the verified order
   * still reads New — so it is an unsupported claim, and unsupported claims buy
   * a call. Saying a thing is finished when the system does not record it as
   * finished is the failure mode this whole layer exists for.
   */
  it("treats an asserted cancellation the order does not record as critical", async () => {
    const provider = fakeProvider([
      "Sorry to hear that. Your order has not gone out yet, so we have cancelled it and refunded you.",
      "Sorry to hear that. Your order has not gone out yet, so we can stop it and the refund will follow.",
    ]);
    await withDraftValidation(provider).generate(request(CANCELLATION, UNDISPATCHED));

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.corrections?.join(" ")).toMatch(/cancelled/i);
  });

  /** The spend that is still worth making: the draft says something false. */
  it("still buys a call when the draft contradicts a verified fact", async () => {
    const provider = fakeProvider([
      "Thank you for getting in touch. We will check the dispatch status and cancel if possible.",
      "Your order has not left us yet, so we have raised the cancellation and the refund will follow.",
    ]);
    const result = await withDraftValidation(provider).generate(request(CANCELLATION, UNDISPATCHED));

    expect(provider.calls).toHaveLength(2);
    expect(result.usage?.totalTokens).toBe(148_412);
  });

  /** And when the reply is about the wrong subject entirely. */
  it("still buys a call when the reply answers nothing that was asked", async () => {
    const provider = fakeProvider([
      "Thank you for your message. Please could you confirm your delivery postcode.",
      "I am sorry a part was missing. Please tell us which piece is absent and we will send it out.",
    ]);
    await withDraftValidation(provider).generate(request(MISSING_PART));

    expect(provider.calls).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */

describe("what a regeneration carries", () => {
  it("adds the corrections and the rejected draft, and nothing else", () => {
    const base = request(CANCELLATION, UNDISPATCHED);
    const rejected = "We will check the dispatch status and cancel if possible.";
    const check = validateDraftAccuracy({
      reply: rejected,
      facts: base.facts,
      messages: base.messages,
      knowledgeAvailable: true,
    });

    const first = buildDraftInput(base);
    const retry = buildDraftInput({
      ...base,
      corrections: check.corrections,
      rejectedDraft: rejected,
    });

    // Everything the first attempt sent is still there, byte for byte, and the
    // retry is that plus one block. Retrieval and the corpus are untouched.
    expect(retry.startsWith(first)).toBe(true);

    const added = retry.slice(first.length);
    expect(added).toMatch(/CORRECTION/);
    expect(added).toContain(rejected);
    expect(added).toMatch(/NOT DISPATCHED/);

    // A few hundred tokens against a request measured in tens of thousands.
    expect(added.length / 4).toBeLessThan(500);
  });

  it("tells the retry to mend rather than start over", () => {
    const retry = buildDraftInput({
      ...request(CANCELLATION, UNDISPATCHED),
      corrections: ["Fix the dispatch status."],
      rejectedDraft: "The previous attempt.",
    });
    expect(retry).toContain("This is what you wrote:");
    expect(retry).toMatch(/correction, not a fresh start/i);
  });

  it("carries only the critical points, not the minor ones", () => {
    // A draft with one of each: a contradicted fact and an uncovered route.
    const check = validateDraftAccuracy({
      reply: "We will check the dispatch status for you.",
      facts: UNDISPATCHED,
      messages: [message(CANCELLATION)],
      knowledgeAvailable: true,
    });

    expect(check.findings.some((f) => f.severity === "critical")).toBe(true);
    expect(check.findings.some((f) => f.severity === "minor")).toBe(true);
    // Corrections are the critical ones only — rewriting the acceptable parts
    // spends output tokens and risks breaking what already worked.
    expect(check.corrections).toHaveLength(
      check.findings.filter((f) => f.severity === "critical").length,
    );
    // The reviewer still gets every finding.
    expect(check.notes.length).toBe(check.findings.length);
  });
});

/* ------------------------------------------------------------------ */

describe("the dominant cost of a draft is retrieval, not our text", () => {
  /**
   * A recorded generation on this path used 71,911 input tokens. Everything
   * this application writes and sends measures about two thousand. The rest is
   * retrieved chunks and the File Search tool loop.
   *
   * This pins the part we control, so a change that quietly starts sending the
   * corpus inline on the retrieval path fails here rather than on a bill.
   *
   * IT USED TO MEASURE ONE FIXTURE, AND THAT WAS THE DEFECT. The cap was 2,000
   * and the only conversation measured was a cancellation — which carries no
   * tracking block at all. So the guard was blind to the most expensive path in
   * the application: a delivery query, where the tracking guidance lives. A
   * change could push the real prompt well past the cap while this stayed green,
   * which is precisely what the tracking-absence work did.
   *
   * EVERY PATH IS MEASURED NOW, and the cap is set against the dearest of them
   * rather than the cheapest. The margin is deliberately modest — this is a
   * ratchet, not a ceiling to grow into.
   */
  const COMPOSED_TOKEN_CAP = 2_300;

  /**
   * The paths, cheapest first. A delivery query is the expensive one because it
   * is the only case that carries tracking guidance — either the verified block
   * or, since the tracking-absence fix, the block that says there is none.
   */
  const COST_PATHS = [
    { label: "pre-sale enquiry", request: () => request(PRE_SALE) },
    { label: "cancellation before dispatch", request: () => request(CANCELLATION, UNDISPATCHED) },
    { label: "missing part", request: () => request(MISSING_PART) },
    {
      label: "delivery query, no shipment data",
      request: () => request(WHERE_IS_IT, UNDISPATCHED),
    },
    {
      label: "delivery query, tracking number but no carrier update",
      request: () => request(WHERE_IS_IT, DISPATCHED_NO_UPDATE),
    },
  ] as const;

  it.each(COST_PATHS.map((path) => [path.label, path.request] as const))(
    "keeps the composed input for %s inside the cap",
    (_label, build) => {
      const composed = cstInstructions("ebay") + buildDraftInput(build());
      expect(composed.length / 4).toBeLessThan(COMPOSED_TOKEN_CAP);
    },
  );

  /**
   * THE FIXTURE HAS TO ACTUALLY CARRY THE EXPENSIVE BLOCK.
   *
   * Without this the delivery fixtures could stop exercising the tracking
   * guidance — a renamed heading, a changed category gate — and the guard would
   * go on passing while measuring nothing. That is the exact way the old
   * single-fixture version failed, so it is asserted rather than assumed.
   */
  it("measures a delivery path that really does carry tracking guidance", () => {
    expect(buildDraftInput(request(WHERE_IS_IT, UNDISPATCHED))).toContain(
      "NO SHIPMENT TRACKING FOR THIS ORDER",
    );
    expect(buildDraftInput(request(WHERE_IS_IT, DISPATCHED_NO_UPDATE))).toContain(
      "NO CARRIER UPDATE FOR THIS SHIPMENT",
    );
  });

  /**
   * The cheap paths must stay cheap. A delivery query pays for tracking
   * guidance; a pre-sale question and a cancellation must not start paying for
   * it too, because the block is gated on the category and a regression in that
   * gate would be invisible to the cap above.
   */
  it.each([
    ["pre-sale enquiry", PRE_SALE],
    ["cancellation before dispatch", CANCELLATION],
    ["missing part", MISSING_PART],
  ])("keeps tracking guidance out of %s entirely", (_label, text) => {
    const input = buildDraftInput(request(text, UNDISPATCHED));
    expect(input).not.toContain("NO SHIPMENT TRACKING FOR THIS ORDER");
    expect(input).not.toContain("NO CARRIER UPDATE FOR THIS SHIPMENT");
    expect(input).not.toContain("VERIFIED TRACKING INFORMATION:");
    // And they stay under the OLD cap, so raising it bought headroom for the
    // delivery path only rather than for everything.
    expect((cstInstructions("ebay") + input).length / 4).toBeLessThan(2_000);
  });

  it("makes the retrieval budget adjustable without a deploy", () => {
    const saved = process.env[MAX_SEARCH_RESULTS_VAR];
    try {
      delete process.env[MAX_SEARCH_RESULTS_VAR];
      // The default is deliberately unchanged: how few chunks still answer a
      // multi-area case is an accuracy question, not a guess.
      expect(maxSearchResults()).toBe(20);

      process.env[MAX_SEARCH_RESULTS_VAR] = "8";
      expect(maxSearchResults()).toBe(8);

      // A typo in a cost knob must not take draft generation down.
      for (const bad of ["nonsense", "0", "-3", "500", ""]) {
        process.env[MAX_SEARCH_RESULTS_VAR] = bad;
        expect(maxSearchResults()).toBe(20);
      }
    } finally {
      if (saved === undefined) delete process.env[MAX_SEARCH_RESULTS_VAR];
      else process.env[MAX_SEARCH_RESULTS_VAR] = saved;
    }
  });
});
