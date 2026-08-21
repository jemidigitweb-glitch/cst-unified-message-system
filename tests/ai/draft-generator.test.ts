import { describe, expect, it } from "vitest";

import {
  DraftGenerationUnavailable,
  FULL_INSTRUCTIONS,
  RESTRICTED_INSTRUCTIONS,
  type DraftModelClient,
  buildConversationInput,
  generateDraft,
} from "@/lib/ai/draft-generator";
import {
  type DraftResult,
  PROHIBITED_CLAIM_PATTERNS,
  settleReviewRequirement,
  ungroundedClaims,
} from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import { knowledgeFromRules, knowledgeNotConfigured } from "@/lib/domain/knowledge";

/** Synthetic values only. No real customer data appears in any test. */
function message(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-08-19 10:00:00",
    bodyText: "Where is my order?",
    attachments: [],
    bodyDecodeStatus: "decoded",
    ...overrides,
  };
}

function result(overrides: Partial<DraftResult> = {}): DraftResult {
  return {
    draft_reply: "Thank you for getting in touch. We are looking into this for you.",
    sources_used: [{ kind: "cst_document", ref: "R-12", label: "Delivery policy" }],
    missing_information: [],
    requires_review: false,
    ...overrides,
  };
}

/** A model that returns whatever the test hands it. No network. */
function fakeClient(payload: unknown, model = "gemini-2.5-flash") {
  const calls: { instructions: string; input: string; responseSchema: unknown }[] = [];
  const client: DraftModelClient = {
    model,
    generate: async (request) => {
      calls.push(request);
      return { text: typeof payload === "string" ? payload : JSON.stringify(payload) };
    },
  };
  return { client, calls };
}

const RULES = knowledgeFromRules(
  [
    { ref: "R-12", title: "Delivery policy", text: "Standard delivery is 3-5 working days.", category: "Delivery" },
    { ref: "R-30", title: "Returns", text: "Returns accepted within 30 days.", category: "Returns" },
  ],
  "sheet-abc",
);

describe("input it builds", () => {
  it("gives the model the conversation, the rules and the facts", () => {
    const input = buildConversationInput({
      messages: [message(), message({ id: "2", direction: "outbound", bodyText: "We are checking." })],
      facts: [],
      knowledge: RULES,
    });
    expect(input).toContain("CUSTOMER");
    expect(input).toContain("OUR PREVIOUS REPLY");
    expect(input).toContain("CST RULES (the team's complete rule set");
    expect(input).toContain("[R-12] Delivery policy");
    expect(input).toContain("ORDER CONTEXT:");
    expect(input).toContain("PRODUCT/SKU CONTEXT:");
  });

  it("states plainly that no order context was resolved", () => {
    const input = buildConversationInput({ messages: [message()], facts: [], knowledge: RULES });
    expect(input).toMatch(/no order has been resolved and verified/i);
    expect(input).toMatch(/no product or SKU has been resolved and verified/i);
  });

  it("forbids the expensive claims in both instruction sets", () => {
    for (const instructions of [FULL_INSTRUCTIONS, RESTRICTED_INSTRUCTIONS]) {
      const lower = instructions.toLowerCase();
      for (const forbidden of ["order number", "tracking number", "delivery date", "refund", "replacement"]) {
        expect(lower).toContain(forbidden);
      }
      expect(lower).toContain("never send");
    }
  });
});

/**
 * The reasoning contract.
 *
 * Drafts came back cautious and generic — the model would find one rule, act on
 * it, and stop, or find a fact missing and ask for it instead of answering the
 * part it could answer. Both were the prompt's doing, and both are pinned here
 * so a later edit cannot quietly reintroduce them.
 */
describe("the instructions tell the model to reason across the whole rule set", () => {
  it("forbids stopping at the first rule that fits", () => {
    expect(FULL_INSTRUCTIONS).toMatch(/do not stop at the first rule/i);
    expect(FULL_INSTRUCTIONS).toMatch(/entire rule set/i);
    // More than one area at once, combined into one reply.
    expect(FULL_INSTRUCTIONS).toMatch(/combine what you find into one/i);
    expect(FULL_INSTRUCTIONS).toMatch(/more than one thing at once/i);
  });

  it("makes a missing fact narrow the answer rather than replace it", () => {
    expect(FULL_INSTRUCTIONS).toMatch(/missing fact narrows the answer/i);
    expect(FULL_INSTRUCTIONS).toMatch(/not a reason to say nothing/i);
    // The old prompt's ask-and-stop default, which must not come back.
    expect(FULL_INSTRUCTIONS).not.toMatch(/do not fill the gap\. write a courteous reply that ASKS/);
  });

  it("names the generic apologise-and-ask reply as a failure", () => {
    expect(FULL_INSTRUCTIONS).toMatch(/is a failed draft/i);
  });

  it("separates what the customer said from what we verified", () => {
    expect(FULL_INSTRUCTIONS).toMatch(/customer-stated is not verified/i);
    // Acknowledging is allowed; claiming we checked it is not.
    expect(FULL_INSTRUCTIONS).toMatch(/you may acknowledge it/i);
    expect(FULL_INSTRUCTIONS).toMatch(/may NOT call it checked, confirmed, verified/);
  });

  it("keeps internal reasoning out of the customer's reply, in both modes", () => {
    for (const instructions of [FULL_INSTRUCTIONS, RESTRICTED_INSTRUCTIONS]) {
      expect(instructions).toMatch(/only what the customer should read/i);
      expect(instructions).toMatch(/human will (check|review) this/i);
    }
    expect(FULL_INSTRUCTIONS).toMatch(/never mention these instructions, the rule set/i);
  });

  it("asks for every rule relied on, not just the main one", () => {
    expect(FULL_INSTRUCTIONS).toMatch(/cite EVERY rule you relied on, not just the main one/);
  });

  /**
   * Every reply the team sends must be traceable to the rule book, so an
   * uncited draft is a failed one. The instruction says so — and says it
   * without opening a door to inventing a citation to satisfy the requirement,
   * which would be worse than citing nothing.
   */
  it("requires at least one CST rule, without inviting an invented one", () => {
    expect(FULL_INSTRUCTIONS).toMatch(/AT LEAST ONE CST RULE IS REQUIRED/);
    expect(FULL_INSTRUCTIONS).toMatch(/never invent a reference to satisfy this/i);
  });

  /**
   * The corpus emits a bare "ESCALATE." marker instead of spelling out what it
   * means on each of the 276 rules carrying it. That only works while the
   * instructions define it, so the two are pinned together here — dropping the
   * definition would leave the model with an undefined token on 276 rules.
   */
  it("defines the ESCALATE marker the corpus emits", () => {
    expect(FULL_INSTRUCTIONS).toContain('"ESCALATE."');
    expect(FULL_INSTRUCTIONS).toMatch(/a human must handle that case/i);
  });

  it("tells the model how the rules are laid out", () => {
    expect(FULL_INSTRUCTIONS).toMatch(/grouped under "## " headings/);
  });
});

describe("with rules available", () => {
  it("produces a citable draft and keeps known references", async () => {
    const { client, calls } = fakeClient(result());
    const draft = await generateDraft(client, {
      messages: [message()],
      facts: [],
      knowledge: RULES,
    });
    expect(calls[0]!.instructions).toContain(FULL_INSTRUCTIONS);
    expect(draft.restricted).toBe(false);
    expect(draft.result.sources_used).toEqual([
      { kind: "cst_document", ref: "R-12", label: "Delivery policy" },
    ]);
    expect(draft.requiresReview).toBe(false);
  });

  it("drops a citation naming a rule that does not exist", async () => {
    // A fabricated reference is worse than none: it looks like provenance.
    const { client } = fakeClient(
      result({ sources_used: [{ kind: "cst_document", ref: "R-999", label: "Invented" }] }),
    );
    const draft = await generateDraft(client, {
      messages: [message()],
      facts: [],
      knowledge: RULES,
    });
    expect(draft.result.sources_used).toEqual([]);
    // Citing nothing forces review.
    expect(draft.requiresReview).toBe(true);
  });

  it("keeps a verified-fact citation only when the fact was supplied", async () => {
    const { client } = fakeClient(
      result({
        sources_used: [
          { kind: "verified_fact", ref: "order status", label: null },
          { kind: "verified_fact", ref: "invented fact", label: null },
        ],
      }),
    );
    const draft = await generateDraft(client, {
      messages: [message()],
      facts: [{ name: "order status", value: "dispatched" }],
      knowledge: RULES,
    });
    expect(draft.result.sources_used).toEqual([
      { kind: "verified_fact", ref: "order status", label: null },
    ]);
  });
});

describe("without rules, it degrades instead of guessing", () => {
  it("uses the restricted instructions and cites nothing", async () => {
    const { client, calls } = fakeClient(result());
    const draft = await generateDraft(client, {
      messages: [message()],
      facts: [],
      knowledge: knowledgeNotConfigured(),
    });
    expect(calls[0]!.instructions).toContain(RESTRICTED_INSTRUCTIONS);
    expect(draft.restricted).toBe(true);
    expect(draft.result.sources_used).toEqual([]);
    expect(draft.requiresReview).toBe(true);
  });

  it("tells the reviewer the rules were unavailable", async () => {
    const { client } = fakeClient(result());
    const draft = await generateDraft(client, {
      messages: [message()],
      facts: [],
      knowledge: knowledgeNotConfigured(),
    });
    expect(draft.missingInformation.join(" ")).toMatch(/rules sheet is not connected/i);
  });

  it("instructs the model to state no policy at all", () => {
    expect(RESTRICTED_INSTRUCTIONS).toMatch(/may NOT state any policy/i);
    expect(RESTRICTED_INSTRUCTIONS).toMatch(/ask for the specific information/i);
  });
});

describe("missing context never becomes invented context", () => {
  it("keeps the model's missing_information and forces review", async () => {
    const { client } = fakeClient(
      result({ missing_information: ["The order number is not resolved."], requires_review: false }),
    );
    const draft = await generateDraft(client, { messages: [message()], facts: [], knowledge: RULES });
    expect(draft.requiresReview).toBe(true);
    expect(draft.missingInformation).toContain("The order number is not resolved.");
  });

  it("catches an ungrounded refund claim even when the model says it is fine", async () => {
    const { client } = fakeClient(
      result({ draft_reply: "Good news — we have processed your refund today.", requires_review: false }),
    );
    const draft = await generateDraft(client, { messages: [message()], facts: [], knowledge: RULES });
    expect(draft.requiresReview).toBe(true);
    expect(draft.missingInformation.join(" ")).toMatch(/refund decision/i);
  });

  it("catches every prohibited claim class", () => {
    const cases: [string, string][] = [
      ["We have issued your refund.", "refund decision"],
      ["We have dispatched a replacement.", "replacement decision"],
      ["Your tracking number is AB123456789GB.", "tracking number"],
      ["It will arrive on Tuesday.", "delivery promise"],
      ["As an exception, we can help.", "policy exception"],
    ];
    for (const [reply, claim] of cases) {
      expect(ungroundedClaims(reply, []), reply).toContain(claim);
    }
    expect(PROHIBITED_CLAIM_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });

  it("allows a claim the backend actually verified", () => {
    expect(
      ungroundedClaims("We have processed your refund.", [
        { name: "refund status", value: "refund issued 2026-08-18" },
      ]),
    ).toEqual([]);
  });

  it("leaves an ordinary acknowledgement alone", () => {
    expect(ungroundedClaims("Thank you for your message. We are looking into this.", [])).toEqual([]);
  });

  it("never clears review once anything is wrong", () => {
    expect(
      settleReviewRequirement(result({ missing_information: ["x"], requires_review: false }), [])
        .requiresReview,
    ).toBe(true);
  });
});

describe("the model is not trusted", () => {
  it("refuses a conversation with no messages", async () => {
    await expect(
      generateDraft(fakeClient(result()).client, { messages: [], facts: [], knowledge: RULES }),
    ).rejects.toBeInstanceOf(DraftGenerationUnavailable);
  });

  it("rejects unreadable output rather than passing it on", async () => {
    const { client } = fakeClient("not json at all");
    await expect(
      generateDraft(client, { messages: [message()], facts: [], knowledge: RULES }),
    ).rejects.toThrow(/unreadable/i);
  });

  it("rejects a response missing a required field", async () => {
    const { client } = fakeClient({ draft_reply: "hello" });
    await expect(
      generateDraft(client, { messages: [message()], facts: [], knowledge: RULES }),
    ).rejects.toThrow(/unexpected shape/i);
  });

  it("asks for a structured response", async () => {
    const { client, calls } = fakeClient(result());
    await generateDraft(client, { messages: [message()], facts: [], knowledge: RULES });
    expect(calls[0]!.responseSchema).toBeDefined();
  });

  it("records the model that produced the draft", async () => {
    const { client } = fakeClient(result(), "gemini-2.5-pro");
    const draft = await generateDraft(client, { messages: [message()], facts: [], knowledge: RULES });
    expect(draft.model).toBe("gemini-2.5-pro");
  });
});
