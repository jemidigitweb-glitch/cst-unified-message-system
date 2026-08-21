import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderRulesForPrompt } from "@/lib/domain/knowledge";
import { loadCorpus, loadRulesForConversation, resetCorpusCacheForTests } from "@/lib/knowledge/cst-rules-files";

/**
 * The local rule corpus, against the real workbooks.
 *
 * `Knowledge-source/` is gitignored — the business owns those documents and
 * they are not committed — so this suite skips when the folder is absent rather
 * than failing a clean checkout. When the folder IS there, these are the tests
 * that prove the right documents reach the model.
 *
 * What "right" means changed. There used to be a keyword layer here choosing
 * ~140 rules, and these tests asserted that a damage message routed to the
 * damage sheet. There is no routing any more: every rule goes, so the tests
 * assert COVERAGE — nothing is withheld — instead of selection accuracy.
 *
 * No rule text is asserted verbatim; only shape, coverage and size. Copying rule
 * content into a test would put document content in the repo.
 */

const DIRECTORY = join(__dirname, "..", "..", "Knowledge-source");
const present =
  existsSync(DIRECTORY) && readdirSync(DIRECTORY).some((name) => name.endsWith(".xlsx"));

describe.skipIf(!present)("loading the corpus from local files", () => {
  it("parses every workbook into rules", () => {
    resetCorpusCacheForTests();
    const corpus = loadCorpus();
    expect(corpus.files).toBeGreaterThanOrEqual(10);
    expect(corpus.rules.length).toBeGreaterThan(500);
    expect(corpus.cached).toBe(false);
  });

  it("serves the second read from cache", () => {
    resetCorpusCacheForTests();
    const first = loadCorpus();
    const second = loadCorpus();

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    // Identity, not elapsed time: the same array back means the workbooks were
    // genuinely not re-parsed. An earlier version asserted a millisecond bound
    // and failed whenever the machine was busy, which tested the machine.
    expect(second.rules).toBe(first.rules);
  });

  it("covers every CST area named in the task", () => {
    const categories = new Set(loadCorpus().rules.map((rule) => rule.categoryName));
    for (const area of [
      "Message Handling",
      "Delivery",
      "Returns & Refunds",
      "Damage",
      "Defective",
      "Wrong Item Sent",
      "Wrong Description",
      "Wrong Quantity",
      "Missing Parts",
      "Pre-Sales",
      "Admin",
    ]) {
      expect(categories, `missing area: ${area}`).toContain(area);
    }
  });
});

describe.skipIf(!present)("what one conversation is given", () => {
  const AREAS = [
    "Message Handling",
    "Delivery",
    "Returns & Refunds",
    "Damage",
    "Defective",
    "Wrong Item Sent",
    "Wrong Description",
    "Wrong Quantity",
    "Missing Parts",
    "Pre-Sales",
    "Admin",
  ];

  it("gives every area to every conversation, whatever it is about", () => {
    // The point of the rewrite. A VAT invoice question used to receive Admin and
    // Message Handling only; if the customer also mentioned a cracked shade
    // halfway down, the damage rules were simply not in the prompt.
    for (const marketplace of ["ebay", "amazon"]) {
      const { corpus } = loadRulesForConversation(marketplace);
      for (const area of AREAS) {
        expect(corpus!.categories, `${marketplace} missing ${area}`).toContain(area);
      }
    }
  });

  it("does not vary with the conversation, because it no longer reads one", () => {
    const first = loadRulesForConversation("ebay");
    const second = loadRulesForConversation("ebay");
    expect(second.corpus!.rules.length).toBe(first.corpus!.rules.length);
    expect(second.corpus!.categories).toEqual(first.corpus!.categories);
  });

  it("withholds only other marketplaces' rules", () => {
    const all = loadCorpus().rules.length;
    const { corpus } = loadRulesForConversation("ebay");
    expect(corpus!.rules.length + corpus!.droppedForMarketplace).toBe(all);
    // Scoping is a correctness boundary, not a filter: it should be taking a
    // small slice off the top, not most of the corpus.
    expect(corpus!.droppedForMarketplace / all).toBeLessThan(0.15);
  });

  it("fits the prompt inside the model's context window", () => {
    const { knowledge } = loadRulesForConversation("ebay");
    if (knowledge.state !== "available") throw new Error("expected rules");
    // ~4 chars per token, against gemini-3.6-flash's 1,048,576-token input
    // limit. The whole corpus is a fraction of it; this fails loudly if the
    // documents grow to the point where that stops being true.
    const tokens = renderRulesForPrompt(knowledge.rules).length / 4;
    expect(tokens).toBeLessThan(400_000);
  });

  it("names each area once as a heading, not twice on every rule", () => {
    const { knowledge, corpus } = loadRulesForConversation("ebay");
    if (knowledge.state !== "available") throw new Error("expected rules");
    const prompt = renderRulesForPrompt(knowledge.rules);

    for (const area of corpus!.categories) {
      expect(prompt).toContain(`## ${area}`);
    }

    // Assert on the header lines WE emit, not on the whole prompt: the
    // documents' own wording contains parentheses and area words of its own,
    // and this test must not police rule content.
    const headers = prompt.split("\n").filter((line) => /^\[[A-Z0-9-]+\] /.test(line));
    expect(headers.length).toBe(knowledge.rules.length);
    for (const header of headers) {
      for (const area of corpus!.categories) {
        expect(header, "area repeated as a suffix").not.toContain(` (${area})`);
        expect(header, "area repeated as a title prefix").not.toContain(`] ${area} · `);
      }
    }
  });

  it("gives every rule a distinct citable reference", () => {
    const { knowledge } = loadRulesForConversation("ebay");
    if (knowledge.state !== "available") throw new Error("expected rules");
    const refs = knowledge.rules.map((rule) => rule.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe("degrading when the files are not there", () => {
  it("reports not_configured instead of throwing", () => {
    const previous = process.env.CST_RULES_DIR;
    process.env.CST_RULES_DIR = "no-such-rule-folder";
    resetCorpusCacheForTests();
    try {
      const { knowledge } = loadRulesForConversation("ebay");
      expect(knowledge.state).toBe("not_configured");
      if (knowledge.state !== "not_configured") throw new Error("unreachable");
      expect(knowledge.reason).toMatch(/could not be read|no CST rules/i);
    } finally {
      if (previous === undefined) delete process.env.CST_RULES_DIR;
      else process.env.CST_RULES_DIR = previous;
      resetCorpusCacheForTests();
    }
  });
});
