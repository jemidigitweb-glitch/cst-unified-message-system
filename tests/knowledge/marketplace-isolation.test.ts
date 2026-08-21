import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildConversationInput, marketplaceClause } from "@/lib/ai/draft-generator";
import { loadRulesForConversation } from "@/lib/knowledge/cst-rules-files";
import { platformsNamedIn, scopeFor } from "@/lib/knowledge/rule-scoping";
import type { ExtractedRule } from "@/lib/knowledge/rule-extraction";

/**
 * Marketplace isolation.
 *
 * THE BUG: an eBay conversation asking for a VAT invoice produced a draft
 * containing Amazon's invoice path. The rule cited was global — its text names
 * both platforms — so filtering on the sheet name let it through whole.
 *
 * These tests pin both halves of the fix: the wrong platform's rules do not
 * reach the prompt, and the rules that legitimately cover several platforms
 * arrive labelled with which branch applies.
 */

const DIRECTORY = join(__dirname, "..", "..", "Knowledge-source");
const present =
  existsSync(DIRECTORY) && readdirSync(DIRECTORY).some((name) => name.endsWith(".xlsx"));

function rule(overrides: Partial<ExtractedRule> = {}): ExtractedRule {
  return {
    categoryName: "Message Handling",
    sourceFile: "MESSAGE HANDLING RULES .xlsx",
    sourceSheet: "1 – Universal Rules",
    sourceRow: 4,
    contentChecksum: "x",
    ruleName: "U1",
    subcategory: null,
    ruleType: "scenario",
    ruleRequirement: "Something happens",
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

describe("classifying a rule by the platforms it names", () => {
  it("finds each platform by its own vocabulary", () => {
    expect(platformsNamedIn("Direct them to eBay Purchase History")).toEqual(["ebay"]);
    expect(platformsNamedIn("An A-to-Z claim appears in Seller Central")).toEqual(["amazon"]);
    expect(platformsNamedIn("eBay (Purchase History) or Amazon (Your Orders)")).toEqual([
      "ebay",
      "amazon",
    ]);
    expect(platformsNamedIn("Apologise once and ask for photographs")).toEqual([]);
  });
});

describe("scoping a rule to a conversation's marketplace", () => {
  it("keeps a rule that names no platform", () => {
    expect(scopeFor(rule(), "ebay")).toEqual({ keep: true, multiPlatform: false });
  });

  it("drops a rule that names only another platform", () => {
    const amazonOnly = rule({
      ruleName: "Amazon A-to-Z Guarantee Claim",
      ruleRequirement: "An A-to-Z claim appears in Seller Central.",
    });
    expect(scopeFor(amazonOnly, "ebay").keep).toBe(false);
    expect(scopeFor(amazonOnly, "amazon").keep).toBe(true);
  });

  it("keeps a rule covering several platforms, and marks it", () => {
    // This is the exact shape that caused the bug.
    const both = rule({
      ruleName: "VAT Invoice Request",
      agentAction: "Direct to eBay (Purchase History → Print Invoice) or Amazon (Your Orders).",
    });
    expect(scopeFor(both, "ebay")).toEqual({ keep: true, multiPlatform: true });
  });

  it("drops a whole per-platform sheet for the wrong marketplace", () => {
    const amazonSheet = rule({ sourceSheet: "📦 3 – Amazon Rules", ruleRequirement: "A rule." });
    expect(scopeFor(amazonSheet, "ebay").keep).toBe(false);
    expect(scopeFor(amazonSheet, "amazon").keep).toBe(true);
  });

  it("treats website and email as one channel shared by the non-marketplace sources", () => {
    // Shopify, B&Q and Temu are all "Website & Email" to CST. An earlier version
    // gave that sheet to Shopify alone and withheld it from B&Q and Temu.
    const websiteSheet = rule({ sourceSheet: "🌐 4 – Website & Email Rules", ruleRequirement: "A rule." });
    for (const marketplace of ["shopify", "bandq", "temu"]) {
      expect(scopeFor(websiteSheet, marketplace).keep, marketplace).toBe(true);
    }
    expect(scopeFor(websiteSheet, "ebay").keep).toBe(false);
    expect(scopeFor(websiteSheet, "amazon").keep).toBe(false);
  });

  it("keeps everything when the marketplace is unknown, still flagging the mixed ones", () => {
    const both = rule({ agentAction: "eBay does this, Amazon does that." });
    expect(scopeFor(both, null)).toEqual({ keep: true, multiPlatform: true });
  });
});

describe("the instruction the model is given", () => {
  it("names the marketplace and forbids the others", () => {
    const clause = marketplaceClause("ebay");
    expect(clause).toContain("EBAY");
    expect(clause).toMatch(/only/i);
    expect(clause).toMatch(/do not mention.*any other marketplace/i);
  });

  it("forbids naming any platform when the marketplace is unknown", () => {
    expect(marketplaceClause(null)).toMatch(/not known/i);
    expect(marketplaceClause(null)).toMatch(/do not name/i);
  });

  it("puts the marketplace and both context blocks in the input", () => {
    const input = buildConversationInput({
      messages: [
        {
          id: "1",
          direction: "inbound",
          sourceTimestamp: "2026-08-19 10:00:00",
          bodyText: "Where is my order?",
          bodyDecodeStatus: "decoded",
          attachments: [],
        },
      ],
      facts: [],
      knowledge: { state: "not_configured", reason: "none" },
      marketplace: "ebay",
      listingItemRef: "1234567890",
    });
    expect(input).toContain("CURRENT MARKETPLACE: EBAY");
    expect(input).toContain("ORDER CONTEXT:");
    expect(input).toContain("PRODUCT/SKU CONTEXT:");
    expect(input).toContain("CST RULES (the team's complete rule set");
    // A listing id is offered as exactly that, and never as a product.
    expect(input).toContain("1234567890");
    expect(input).toMatch(/NOT a SKU and NOT a product name/);
  });

  it("says plainly that no order was resolved rather than leaving it blank", () => {
    const input = buildConversationInput({
      messages: [
        {
          id: "1",
          direction: "inbound",
          sourceTimestamp: "2026-08-19 10:00:00",
          bodyText: "Where is my order?",
          bodyDecodeStatus: "decoded",
          attachments: [],
        },
      ],
      facts: [],
      knowledge: { state: "not_configured", reason: "none" },
      marketplace: "ebay",
    });
    expect(input).toMatch(/no order has been resolved and verified/i);
    expect(input).toMatch(/no product or SKU has been resolved and verified/i);
  });
});

describe.skipIf(!present)("against the real rule files", () => {
  // No conversation is passed any more: the whole corpus goes to every draft,
  // and the marketplace is the only thing that changes what is in it. That makes
  // these assertions stronger than they were — they now hold for EVERY eBay
  // conversation, not just for the invoice question that exposed the bug.

  it("sends an eBay conversation no Amazon-only rule", () => {
    const { knowledge } = loadRulesForConversation("ebay");
    if (knowledge.state !== "available") throw new Error("expected rules");

    for (const rule of knowledge.rules) {
      const named = platformsNamedIn(`${rule.title} ${rule.text.split("APPLIES TO SEVERAL")[0]}`);
      if (named.length === 0) continue;
      // Anything platform-specific that survived must include eBay.
      expect(named, `${rule.ref} is not for eBay: ${rule.title}`).toContain("ebay");
    }
  });

  it("labels the multi-platform invoice rule with the branch to follow", () => {
    const { knowledge, corpus } = loadRulesForConversation("ebay");
    if (knowledge.state !== "available") throw new Error("expected rules");

    // This is the rule the bad draft cited.
    const mixed = knowledge.rules.filter((rule) => rule.text.includes("APPLIES TO SEVERAL PLATFORMS"));
    expect(corpus!.multiPlatformCount).toBeGreaterThan(0);
    expect(mixed.length).toBe(corpus!.multiPlatformCount);
    for (const rule of mixed) {
      expect(rule.text).toContain("follow only the EBAY steps");
    }
  });

  it("drops the Amazon-only escalation rules that used to reach an eBay draft", () => {
    const { knowledge } = loadRulesForConversation("ebay");
    if (knowledge.state !== "available") throw new Error("expected rules");
    const titles = knowledge.rules.map((rule) => rule.title).join(" | ");
    // These three reached the leaked draft, and none is applicable to eBay.
    expect(titles).not.toMatch(/A-to-Z Guarantee/i);
    expect(titles).not.toMatch(/Amazon Account Health/i);
    expect(titles).not.toMatch(/Amazon ODR/i);
  });

  it("still gives an Amazon conversation its Amazon rules", () => {
    const { knowledge } = loadRulesForConversation("amazon");
    if (knowledge.state !== "available") throw new Error("expected rules");
    for (const rule of knowledge.rules) {
      const named = platformsNamedIn(`${rule.title} ${rule.text.split("APPLIES TO SEVERAL")[0]}`);
      if (named.length === 0) continue;
      expect(named, `${rule.ref} is not for Amazon: ${rule.title}`).toContain("amazon");
    }
  });

  it("keeps every marketplace isolated from every other", () => {
    const platforms = ["ebay", "amazon", "shopify", "bandq", "temu"];
    for (const marketplace of platforms) {
      const { knowledge } = loadRulesForConversation(marketplace);
      if (knowledge.state !== "available") continue;
      for (const rule of knowledge.rules) {
        const named = platformsNamedIn(`${rule.title} ${rule.text.split("APPLIES TO SEVERAL")[0]}`);
        if (named.length === 0) continue;
        expect(named, `${marketplace}: ${rule.ref} ${rule.title}`).toContain(marketplace);
      }
    }
  });

  it("does not alter the rule wording taken from the documents", () => {
    const { knowledge } = loadRulesForConversation("ebay");
    if (knowledge.state !== "available") throw new Error("expected rules");
    for (const rule of knowledge.rules) {
      // The only thing ever added is the appended warning; the document's own
      // text is passed through untouched ahead of it.
      const [body, ...appended] = rule.text.split("\nAPPLIES TO SEVERAL PLATFORMS:");
      expect(appended.length).toBeLessThanOrEqual(1);
      expect(body).not.toContain("APPLIES TO SEVERAL");
    }
  });
});

describe.skipIf(!present)("scoping takes a slice, not the corpus", () => {
  it("leaves every marketplace nearly the whole rule set", () => {
    for (const marketplace of ["ebay", "amazon", "shopify", "bandq", "temu"]) {
      const { knowledge, corpus } = loadRulesForConversation(marketplace);
      expect(knowledge.state, marketplace).toBe("available");
      // Isolation must not become filtering by the back door: if a marketplace
      // ever loses most of the corpus, that is a scoping bug, not policy.
      expect(corpus!.rules.length, marketplace).toBeGreaterThan(1_000);
    }
  });
});
