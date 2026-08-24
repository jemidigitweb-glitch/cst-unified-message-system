import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRAFT_TIERS,
  TIER_MODEL_VARS,
  assessComplexity,
  modelForTier,
  tieredModelsConfigured,
} from "@/lib/ai/model-selection";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * Choosing a model for the conversation in front of it.
 *
 * The claim under test is narrow and worth stating: this picks a TIER from what
 * the conversation looks like, and configuration decides which model serves a
 * tier. So these tests assert tiers and fallbacks, never model names — a test
 * naming a vendor's model would break the moment the team changed one, which is
 * the change this whole layer exists to make cheap.
 *
 * The one asymmetric failure is escalating too little. A safety or legal case
 * given a weaker model is the outcome that actually costs something, so those
 * assertions are the strict ones.
 *
 * Synthetic message text throughout.
 */

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

const ENV_KEYS = Object.values(TIER_MODEL_VARS);
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("scoring a conversation", () => {
  it("calls a short single-issue message simple", () => {
    const result = assessComplexity({ messages: [message()] });
    expect(result.tier).toBe("simple");
    expect(result.escalated).toBe(false);
    expect(result.reasons).toContain("short single-issue conversation");
  });

  it("moves to standard once a thread carries history and a second issue", () => {
    const messages = [
      message({ id: "1", bodyText: "Where is my order?" }),
      message({ id: "2", direction: "outbound", bodyText: "Let me check." }),
      message({ id: "3", bodyText: "Tracking has not moved, and I now want a refund." }),
    ];
    // Three messages (+1) and two distinct issues (+1) reaches the boundary. A
    // three-message thread about ONE thing stays simple, deliberately: length
    // alone is not difficulty.
    expect(assessComplexity({ messages }).tier).toBe("standard");
  });

  it("moves to complex when several issues and a long thread combine", () => {
    const messages = [
      message({ id: "1", bodyText: "The item arrived damaged and cracked." }),
      message({ id: "2", direction: "outbound", bodyText: "Sorry to hear that." }),
      message({ id: "3", bodyText: "I also need a VAT invoice for it." }),
      message({ id: "4", direction: "outbound", bodyText: "Noted." }),
      message({ id: "5", bodyText: "And the quantity was wrong quantity too." }),
      message({ id: "6", bodyText: "Please send a replacement." }),
    ];
    const result = assessComplexity({ messages });
    expect(result.tier).toBe("complex");
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  it("counts verified facts and attachments toward the score", () => {
    const withEvidence = assessComplexity({
      messages: [
        message({
          attachments: [{ url: "https://x.example.com/a.jpg", kind: "image", label: "a.jpg" }],
        }),
      ],
    });
    expect(withEvidence.reasons).toContain("customer sent attachments");
  });

  it("counts a message it could not read, because that is when guessing starts", () => {
    const result = assessComplexity({
      messages: [message({ bodyText: null, bodyDecodeStatus: "failed" })],
    });
    expect(result.reasons.some((reason) => reason.includes("could not be decoded"))).toBe(true);
  });
});

/**
 * The one that matters. A weaker model on a case that could reach a regulator
 * is the only failure here with a real cost, so escalation is unconditional.
 */
describe("safety, legal and escalation always take the top tier", () => {
  const cases = [
    "The heater caught fire in my kitchen.",
    "My child was injured by the broken edge.",
    "I have contacted my solicitor about this.",
    "I am reporting this to trading standards.",
    "I will raise a chargeback with my bank.",
    "This is a formal complaint.",
  ];

  for (const body of cases) {
    it(`escalates: ${body}`, () => {
      const result = assessComplexity({ messages: [message({ bodyText: body })] });
      expect(result.tier).toBe("complex");
      expect(result.escalated).toBe(true);
    });
  }

  it("escalates however short the message is", () => {
    // Nine words, and a score that would otherwise be `simple`.
    const result = assessComplexity({ messages: [message({ bodyText: "It caught fire." })] });
    expect(result.score).toBeLessThan(2);
    expect(result.tier).toBe("complex");
  });

  it("says why, so the decision can be checked", () => {
    const result = assessComplexity({
      messages: [message({ bodyText: "I have spoken to my solicitor." })],
    });
    expect(result.reasons.some((reason) => reason.includes("solicitor"))).toBe(true);
  });

  it("reads the customer, not our own reply", () => {
    const result = assessComplexity({
      messages: [
        message({ bodyText: "Has my parcel shipped?" }),
        message({
          id: "2",
          direction: "outbound",
          bodyText: "If unresolved you may escalate to the ombudsman.",
        }),
      ],
    });
    expect(result.escalated).toBe(false);
  });
});

describe("which model serves a tier", () => {
  it("uses the configured model for the tier", () => {
    process.env[TIER_MODEL_VARS.simple] = "model-s";
    process.env[TIER_MODEL_VARS.standard] = "model-m";
    process.env[TIER_MODEL_VARS.complex] = "model-l";

    expect(modelForTier("simple", "fallback")).toBe("model-s");
    expect(modelForTier("standard", "fallback")).toBe("model-m");
    expect(modelForTier("complex", "fallback")).toBe("model-l");
  });

  /**
   * Falling UP, never down. A half-configured environment should over-serve a
   * simple case; under-serving a complex one is the failure that costs.
   */
  it("falls upward when a tier is unset", () => {
    process.env[TIER_MODEL_VARS.complex] = "model-l";
    expect(modelForTier("simple", "fallback")).toBe("model-l");
    expect(modelForTier("standard", "fallback")).toBe("model-l");
  });

  it("never falls downward from complex", () => {
    process.env[TIER_MODEL_VARS.simple] = "model-s";
    expect(modelForTier("complex", "fallback")).toBe("fallback");
  });

  it("keeps the existing single-model setup working untouched", () => {
    expect(tieredModelsConfigured()).toBe(false);
    for (const tier of DRAFT_TIERS) {
      expect(modelForTier(tier, "OPENAI_MODEL-value")).toBe("OPENAI_MODEL-value");
    }
  });

  it("ignores a blank variable rather than selecting an empty model", () => {
    process.env[TIER_MODEL_VARS.simple] = "   ";
    process.env[TIER_MODEL_VARS.standard] = "model-m";
    expect(modelForTier("simple", "fallback")).toBe("model-m");
  });

  it("re-reads configuration on every call, so a change needs no restart", () => {
    process.env[TIER_MODEL_VARS.standard] = "before";
    expect(modelForTier("standard", "fallback")).toBe("before");
    process.env[TIER_MODEL_VARS.standard] = "after";
    expect(modelForTier("standard", "fallback")).toBe("after");
  });
});

describe("no model is hard-coded", () => {
  it("names no vendor model anywhere in the selector", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "ai", "model-selection.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/gpt-|gemini-|claude-|luna/i);
  });
});
