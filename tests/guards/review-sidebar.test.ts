import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MARKETPLACE_TAB_ORDER } from "@/lib/domain/marketplace-capabilities";

/**
 * Standing guard on the review sidebar.
 *
 * ONE SIDEBAR, FIVE MARKETPLACES. Status, Context, AI usage, Matched CST rules,
 * in that order, whichever tab the reviewer is on. A per-marketplace layout is
 * the failure this guards against: it would mean a reviewer moving from eBay to
 * Temu has to relearn where to look, and it would let a marketplace quietly
 * lose a section nobody noticed was missing.
 *
 * This is asserted against the component SOURCE, matching how the rest of this
 * suite guards the interface — no DOM environment is configured, and the
 * properties that matter here are structural rather than visual. Live
 * click-through is covered by the local smoke run.
 */

const ROOT = join(__dirname, "..", "..");
const COMPONENTS = join(ROOT, "components");

function read(name: string): string {
  return readFileSync(join(COMPONENTS, name), "utf8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const workspace = stripComments(read("workspace.tsx"));
const context = stripComments(read("context-panel.tsx"));
const evidence = stripComments(read("draft-evidence-panel.tsx"));
const exportButton = stripComments(read("conversation-export-button.tsx"));

describe("every marketplace gets the same sidebar", () => {
  it("renders one sidebar, not one per marketplace", () => {
    // Exactly one mount of each pane in the whole workspace.
    expect(workspace.match(/<ContextPanel/g)).toHaveLength(1);
    expect(workspace.match(/<DraftEvidencePanel/g)).toHaveLength(1);
  });

  /**
   * No marketplace is named anywhere in either sidebar pane.
   *
   * Not a style rule. A single `marketplace === "ebay"` is all it takes for the
   * layouts to diverge, and the divergence is invisible until someone opens the
   * other four tabs.
   */
  it("names no marketplace in any sidebar pane", () => {
    for (const pane of [context, evidence, exportButton]) {
      for (const marketplace of MARKETPLACE_TAB_ORDER) {
        expect(pane).not.toContain(`"${marketplace}"`);
      }
    }
    for (const label of ["eBay", "Amazon", "Shopify", "B&Q", "Temu"]) {
      expect(evidence).not.toContain(label);
      expect(exportButton).not.toContain(label);
    }
  });

  it("gates the sidebar on the selection kind, never on the marketplace", () => {
    const aside = workspace.slice(workspace.lastIndexOf("<aside"));
    expect(aside).toContain('selectedKind !== "message"');
    expect(aside).not.toMatch(/marketplace\s*===/);
  });

  it("orders the sections Human action needed, Context, AI Usage, CST Rules Used", () => {
    // Human action needed and Context come from the context pane, in that
    // order. Wording changed (was "Status") to say what a non-technical
    // reviewer should do, not the raw workflow state name; the guarantee this
    // test protects — one order, every marketplace — is unchanged.
    expect(context.indexOf("Human action needed")).toBeGreaterThan(-1);
    expect(context.indexOf("Human action needed")).toBeLessThan(context.indexOf(">Context<"));
    // ...and the evidence pane follows it, AI usage before the rules.
    expect(workspace.indexOf("<ContextPanel")).toBeLessThan(
      workspace.indexOf("<DraftEvidencePanel"),
    );
    expect(evidence.indexOf("AI Usage")).toBeLessThan(evidence.indexOf("CST Rules Used"));
  });
});

describe("AI usage is read back, never recomputed", () => {
  it("reads the stored usage row rather than counting tokens again", () => {
    expect(evidence).toContain("/draft/evidence");
    // No second tally: nothing here adds, estimates or multiplies a token count.
    expect(evidence).not.toMatch(/input_tokens\s*[+*]/);
    expect(evidence).not.toMatch(/tokens\s*\*/);
    expect(evidence).not.toMatch(/RATES|pricePer|costPer/i);
  });

  it("shows provider, model and all three counts", () => {
    for (const label of [">Provider<", ">Model<", ">Input<", ">Output<", ">Total<"]) {
      expect(evidence).toContain(label);
    }
    expect(evidence).toContain("data.usage.provider");
    expect(evidence).toContain("data.usage.model");
    expect(evidence).toContain("data.usage.input_tokens");
    expect(evidence).toContain("data.usage.output_tokens");
    expect(evidence).toContain("data.usage.total_tokens");
  });

  /**
   * A missing price is a gap, not a zero. A confident $0.0000 beside a real
   * token count is harder to notice than an absent row.
   */
  it("omits the cost when the model has no local price", () => {
    expect(evidence).toContain("data.usage.estimated_cost_usd !== null");
  });
});

describe("all applicable rules are shown, and no internal keys", () => {
  /**
   * Several CST areas frequently govern one reply — Admin and Message Handling
   * and Returns together. Showing the first would misrepresent what the draft
   * was written against, so the cited list is mapped whole.
   */
  it("caps nothing", () => {
    expect(evidence).toContain("cited.map(");
    expect(evidence).not.toMatch(/cited\s*\.\s*slice/);
    expect(evidence).not.toMatch(/cited\s*\.\s*filter/);
    expect(evidence).not.toMatch(/\.slice\(0,\s*\d/);
  });

  it("renders the readable title and the CST area, not the raw record", () => {
    expect(evidence).toContain("rule.displayTitle");
    expect(evidence).toContain("rule.category");
    // `ref` is a React key only. Removed before the check, so the one
    // legitimate use cannot mask a second one that renders it.
    expect(evidence).toContain("key={rule.ref}");
    expect(evidence.replace("key={rule.ref}", "")).not.toMatch(/\{rule\.ref\}/);
    expect(evidence).not.toMatch(/\{rule\.title\}/);
    expect(evidence).not.toMatch(/rule\.source(File|Sheet|Row)/);
  });

  it("shows the matched evidence from the shared helper", () => {
    expect(evidence).toContain("matchReasonOf");
    expect(evidence).toContain("Matched: ");
  });
});

describe("the rules section adds no export", () => {
  it("offers no rule download of any kind", () => {
    expect(evidence).not.toMatch(/Export relevant CST rules/i);
    expect(evidence).not.toMatch(/export.*rules/i);
    expect(evidence).not.toContain("cst-rules-conversation");
    expect(evidence).not.toContain("application/json");
  });

  it("flags the no-rule case instead", () => {
    expect(evidence).toContain("<NoRuleFlag");
  });
});

/**
 * The no-rule case must not read as a successful draft.
 *
 * The failure mode here is quiet: a fluent, confident, entirely ungrounded
 * reply looks exactly like a good one. The flag says what happened, names the
 * case type from the customer's own words, and offers the export — in the same
 * component on the draft card and in the sidebar, so the two cannot drift.
 */
describe("the no-rule flag", () => {
  const flag = stripComments(read("no-rule-flag.tsx"));
  const draft = stripComments(read("draft-panel.tsx"));

  it("states the heading, the reason and the action", () => {
    expect(flag).toContain("NO CST RULE / TEMPLATE AVAILABLE");
    expect(flag).toContain("no applicable CST rule or approved template was found");
    expect(flag).toContain(">Message type<");
    expect(flag).toContain(">Reason<");
    expect(flag).toContain(">Action<");
  });

  it("names the case type from the conversation, never from the model", () => {
    expect(flag).toContain("classifyCaseType");
    expect(flag).not.toMatch(/fetch\(|useEffect|useState/);
  });

  it("is the same component on the draft card and in the sidebar", () => {
    expect(draft).toContain("<NoRuleFlag");
    expect(evidence).toContain("<NoRuleFlag");
  });

  it("creates no rule and edits no rule file", () => {
    for (const source of [flag, exportButton]) {
      expect(source).not.toMatch(/writeRule|createRule|updateRule|\.xlsx/i);
      expect(source).not.toMatch(/method:\s*["'](POST|PUT|PATCH)/);
    }
  });
});

describe("the export belongs to the no-rule case", () => {
  it("is offered inside the flag, and nowhere else", () => {
    const start = evidence.indexOf("cited.length === 0 ?");
    const otherwise = evidence.indexOf(") : (", start);
    expect(evidence.slice(start, otherwise)).toContain("<ConversationExportButton");
    expect(evidence.slice(otherwise)).not.toContain("<ConversationExportButton");
    expect(workspace).not.toContain("ConversationExportButton");
  });

  it("reads nothing and fetches nothing", () => {
    expect(exportButton).not.toMatch(/useEffect|useState|fetch\(/);
    expect(exportButton).toContain("buildConversationTextExport");
  });
});
