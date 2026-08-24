import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CstRule } from "@/lib/domain/knowledge";
import {
  NO_APPLICABLE_RULE_CODE,
  citationsAreValid,
  coverageFor,
} from "@/lib/knowledge/rule-coverage";

/**
 * The gate that stops an ungrounded draft existing.
 *
 * THE BUG. One conversation could show "NO CST RULE / TEMPLATE AVAILABLE" and
 * "DRAFT REPLY — REVISION 1" at once. Both statements were true and they
 * contradict each other: a customer-facing reply had been written, and nothing
 * in the rule base authorised a word of it. The cause was ordering — the draft
 * was generated first and its citations judged afterwards, so the judgement had
 * nowhere to go but a warning label.
 *
 * These tests are about ORDER, not about wording. What they pin down is that a
 * draft cannot come into existence without a rule that resolves today.
 *
 * Synthetic rules throughout.
 */

function rule(overrides: Partial<CstRule> = {}): CstRule {
  return {
    ref: "DAM-ABC-12",
    title: "Cracked glass on arrival",
    text: "Ask for photographs before offering anything.",
    category: "Damage",
    sourceFile: "DAMAGE RULES.xlsx",
    sourceSheet: "2 - Damage Decisions",
    sourceRow: 12,
    ...overrides,
  };
}

describe("the gate before the model call", () => {
  it("allows generation when an approved corpus is loaded", () => {
    const coverage = coverageFor({ state: "available", rules: [rule(), rule({ ref: "DEL-X-1" })] });
    expect(coverage.covered).toBe(true);
    expect(coverage.reason).toBeNull();
    expect(coverage.rulesAvailable).toBe(2);
  });

  it("refuses when the corpus is empty", () => {
    const coverage = coverageFor({ state: "available", rules: [] });
    expect(coverage.covered).toBe(false);
    expect(coverage.reason).toBe("No applicable CST rule or approved template was found.");
  });

  /**
   * An unreadable corpus and an empty one are the same outcome. Both mean there
   * is nothing to ground in, and a model called anyway would write policy out
   * of general knowledge of retail.
   */
  it("refuses when the corpus could not be read", () => {
    expect(coverageFor({ state: "unavailable" }).covered).toBe(false);
    expect(coverageFor({ state: "error", rules: [rule()] }).covered).toBe(false);
  });

  /**
   * It gates, it does not filter. Choosing which rules are relevant before the
   * model reads anything is the rule-selection layer this project removed on
   * purpose — retrieval belongs to File Search.
   */
  it("does not decide which rules are relevant", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "knowledge", "rule-coverage.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/relevan(t|ce)Score|selectRules|rankRules|filterRules/);
    // Coverage is decided by the corpus alone; the conversation is not consulted.
    expect(coverageFor({ state: "available", rules: [rule()] }).covered).toBe(true);
  });
});

describe("the gate before the draft is saved", () => {
  const corpus = [rule({ ref: "DAM-ABC-12" }), rule({ ref: "DEL-XY-3" })];

  it("accepts a citation that resolves against the current corpus", () => {
    expect(citationsAreValid(corpus, ["DEL-XY-3"])).toBe(true);
  });

  it("resolves a ref stored with brackets, as the evidence endpoint does", () => {
    expect(citationsAreValid(corpus, ["[DAM-ABC-12]"])).toBe(true);
  });

  /** The whole point: none of these is a valid rule. */
  it("rejects a citation the documents no longer contain", () => {
    expect(citationsAreValid(corpus, ["GONE-999-1"])).toBe(false);
  });

  it("rejects a legacy-format reference", () => {
    expect(citationsAreValid(corpus, ["MESHAN-43-VATINVOI"])).toBe(false);
  });

  it("rejects a reply that cited nothing at all", () => {
    expect(citationsAreValid(corpus, [])).toBe(false);
  });

  it("rejects everything when the corpus is empty", () => {
    expect(citationsAreValid([], ["DAM-ABC-12"])).toBe(false);
  });

  it("accepts when at least one of several citations resolves", () => {
    expect(citationsAreValid(corpus, ["GONE-999-1", "DAM-ABC-12"])).toBe(true);
  });
});

/**
 * The route is what actually enforces the order, so it is read directly. A
 * pure function that returns `false` proves nothing on its own if the caller
 * generates first and asks afterwards.
 */
describe("the route refuses before it calls the model", () => {
  const route = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "app",
      "api",
      "conversations",
      "[conversationId]",
      "draft",
      "route.ts",
    ),
    "utf8",
  );

  it("checks coverage before provider.generate", () => {
    const gate = route.indexOf("coverageFor(knowledge)");
    const call = route.indexOf("provider.generate(");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(call);
  });

  it("returns without generating when coverage fails", () => {
    const gate = route.indexOf("if (!coverage.covered)");
    const call = route.indexOf("provider.generate(");
    expect(route.slice(gate, call)).toContain("return NextResponse.json");
    // Returned as the shared constant, not a literal, so the client branches on
    // the same string the server sends.
    expect(route.slice(gate, call)).toContain("NO_APPLICABLE_RULE_CODE");
    expect(NO_APPLICABLE_RULE_CODE).toBe("no_applicable_rule");
  });

  /**
   * The second gate. The corpus existed, the model ran, and it cited nothing
   * that resolves — so the revision is not saved. Not saved and flagged; not
   * saved at all, which is what makes the contradiction impossible to render.
   */
  it("discards rather than saves a draft with no valid citation", () => {
    const check = route.indexOf("if (!citationsAreValid(");
    const save = route.indexOf("saveRevision(");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(save);
    expect(route.slice(check, save)).toContain("return NextResponse.json");
  });

  it("still records the spend of a discarded call", () => {
    const check = route.indexOf("if (!citationsAreValid(");
    const save = route.indexOf("saveRevision(");
    const block = route.slice(check, save);
    expect(block).toContain("recordUsage");
    // No revision id, and an outcome that keeps it out of every success reading.
    expect(block).toContain("draftRevisionId: null");
    expect(block).toContain("discarded_no_valid_rule");
  });

  it("writes no fallback reply of its own", () => {
    expect(route).not.toMatch(/fallbackReply|genericReply|defaultDraft/i);
  });
});
