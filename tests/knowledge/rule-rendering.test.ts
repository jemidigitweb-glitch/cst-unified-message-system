import { describe, expect, it } from "vitest";

import type { ExtractedRule } from "@/lib/knowledge/rule-extraction";
import { renderRuleText } from "@/lib/knowledge/rule-scoping";

/**
 * How one rule reaches the model.
 *
 * The workbooks routinely hold the same sentence in more than one column: 458
 * of 1,377 rules have `keyRule` and `agentAction` identical. Printing both cost
 * ~11,400 tokens per request and, worse, presented one instruction to the model
 * as though it were two independent ones.
 *
 * These tests pin the merging. Rule text itself is synthetic here — no document
 * content is copied into the repo.
 */

function rule(overrides: Partial<ExtractedRule> = {}): ExtractedRule {
  return {
    categoryName: "Damage",
    sourceFile: "x.xlsx",
    sourceSheet: "1",
    sourceRow: 1,
    contentChecksum: "x",
    ruleName: "R1",
    subcategory: null,
    ruleType: "scenario",
    ruleRequirement: null,
    keyRule: null,
    agentAction: null,
    doInstruction: null,
    dontInstruction: null,
    bannedPhrase: null,
    replacementInstruction: null,
    escalationRequired: false,
    priority: 100,
    triggers: [],
    examples: [],
    ...overrides,
  };
}

describe("merging fields that repeat each other", () => {
  it("prints an identical key rule and action once, under both labels", () => {
    const text = renderRuleText(
      rule({ keyRule: "Stop and escalate.", agentAction: "Stop and escalate." }),
    );
    expect(text).toBe("KEY RULE / ACTION: Stop and escalate.");
    // The sentence appears exactly once.
    expect(text.match(/Stop and escalate\./g)).toHaveLength(1);
  });

  it("ignores casing and whitespace when deciding they are the same", () => {
    const text = renderRuleText(
      rule({ keyRule: "Stop  and\nescalate.", agentAction: "stop and escalate. " }),
    );
    expect(text.startsWith("KEY RULE / ACTION:")).toBe(true);
    expect(text).not.toContain("\nACTION:");
  });

  it("keeps both when they genuinely differ", () => {
    const text = renderRuleText(
      rule({ keyRule: "Refunds need approval.", agentAction: "Ask the customer for photos." }),
    );
    expect(text).toContain("KEY RULE: Refunds need approval.");
    expect(text).toContain("ACTION: Ask the customer for photos.");
  });

  it("does not drop a field merely because the other contains it", () => {
    // Deciding which of two overlapping instructions to discard is a judgement
    // about rule content. Both are printed rather than guessing.
    const text = renderRuleText(
      rule({ keyRule: "Escalate.", agentAction: "Escalate. Then log the case." }),
    );
    expect(text).toContain("KEY RULE: Escalate.");
    expect(text).toContain("ACTION: Escalate. Then log the case.");
  });

  it("still suppresses a key rule that only repeats the requirement", () => {
    const text = renderRuleText(
      rule({ ruleRequirement: "Item arrived broken.", keyRule: "Item arrived broken." }),
    );
    expect(text).toBe("Item arrived broken.");
  });

  it("collapses all three when the workbook repeated the sentence everywhere", () => {
    const text = renderRuleText(
      rule({
        ruleRequirement: "Item arrived broken.",
        keyRule: "Item arrived broken.",
        agentAction: "Item arrived broken.",
      }),
    );
    expect(text).toBe("Item arrived broken.");
  });

  it("leaves the distinct instruction kinds alone", () => {
    const text = renderRuleText(
      rule({
        doInstruction: "Apologise once.",
        dontInstruction: "Promise a refund.",
        bannedPhrase: "It is our policy.",
        replacementInstruction: "Here is what we can do.",
        escalationRequired: true,
      }),
    );
    expect(text).toContain("DO: Apologise once.");
    expect(text).toContain("DO NOT: Promise a refund.");
    expect(text).toContain("NEVER SAY: It is our policy.");
    expect(text).toContain("SAY INSTEAD: Here is what we can do.");
    expect(text).toContain("ESCALATE.");
  });
});
