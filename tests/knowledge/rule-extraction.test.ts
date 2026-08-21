import { describe, expect, it } from "vitest";

import {
  CATEGORY_BY_FILE,
  EXCLUDED_FILES,
  checksumOf,
  deduplicate,
  extractWorkbook,
} from "@/lib/knowledge/rule-extraction";
import type { SheetGrid, Workbook } from "@/lib/knowledge/workbook-reader";

/**
 * Extraction is pure, so these tests use synthetic grids rather than
 * spreadsheets. Every string here is invented for the test — no content is
 * copied out of the business's documents, and no customer data appears.
 */

const FILE = "ADMIN.xlsx"; // mapped to the "Admin" category

function workbook(sheets: Record<string, string[][]>): Workbook {
  return new Map<string, SheetGrid>(Object.entries(sheets));
}

/** A scenario sheet: title row, advisory row, header row, then data. */
function scenarioSheet(rows: string[][]): string[][] {
  return [
    ["A — SOMETHING", "", "", "", "", "", ""],
    ["  Advisory line that is not a header.", "", "", "", "", "", ""],
    [
      "SCENARIO_ID",
      "Situation — What the Agent Sees",
      "INTERNAL: Decision Flow",
      "Escalate?",
      "REPLY TEMPLATES",
      "AI TRIGGER KEYWORDS",
      "Category /\nKey Rule",
    ],
    ...rows,
  ];
}

describe("scenario sheets", () => {
  const result = extractWorkbook(
    FILE,
    workbook({
      "A — INVOICE": scenarioSheet([
        [
          "AQ1",
          "Customer asks for a VAT invoice",
          "STEP 1: check the account.\nSTEP 2: reply.",
          "No",
          "Dear customer, here is your invoice.",
          "vat invoice | need an invoice\ncan i have a receipt",
          "Invoices are system generated",
        ],
        [
          "AQ2",
          "Customer reports a burning smell",
          "STOP. Contact the team head immediately.",
          "Yes — immediately",
          "Dear customer, please stop using the item.",
          "burning smell | sparks",
          "Safety first",
        ],
      ]),
    }),
  );

  it("finds the header below the title and advisory rows", () => {
    expect(result.rules).toHaveLength(2);
  });

  it("maps the analysed columns onto the schema's fields", () => {
    const rule = result.rules[0]!;
    expect(rule.ruleName).toBe("AQ1");
    expect(rule.categoryName).toBe("Admin");
    expect(rule.subcategory).toBe("A — INVOICE");
    expect(rule.ruleType).toBe("scenario");
    expect(rule.ruleRequirement).toBe("Customer asks for a VAT invoice");
    expect(rule.agentAction).toContain("STEP 1");
    expect(rule.keyRule).toBe("Invoices are system generated");
  });

  it("records the source row as a human would count it", () => {
    // Title, advisory, header, then the first data row: row 4.
    expect(result.rules[0]!.sourceFile).toBe(FILE);
    expect(result.rules[0]!.sourceSheet).toBe("A — INVOICE");
    expect(result.rules[0]!.sourceRow).toBe(4);
    expect(result.rules[1]!.sourceRow).toBe(5);
  });

  it("splits a keyword cell on both separators and newlines", () => {
    expect(result.rules[0]!.triggers.map((t) => t.text)).toEqual([
      "vat invoice",
      "need an invoice",
      "can i have a receipt",
    ]);
  });

  it("reads Escalate? as a decision, not as text", () => {
    expect(result.rules[0]!.escalationRequired).toBe(false);
    expect(result.rules[1]!.escalationRequired).toBe(true);
  });

  it("turns a reply template into an example, not into the rule body", () => {
    const [example] = result.rules[0]!.examples;
    expect(example?.expectedResponse).toBe("Dear customer, here is your invoice.");
    expect(result.rules[0]!.ruleRequirement).not.toContain("Dear customer");
  });
});

describe("escalation instructions", () => {
  // No cst_rule_escalations table exists, so these land on cst_rules with
  // escalation_required set. The action, the target and the response time all
  // have to survive that move.
  const result = extractWorkbook(
    FILE,
    workbook({
      "13 — ESCALATION MATRIX": [
        ["ESCALATION MATRIX", "", "", "", ""],
        ["#", "Trigger Condition", "Required Action", "Escalate To", "Response Time"],
        ["1", "Customer threatens legal action", "Stop replying. Hand over.", "Team Head", "Within 1 hour"],
      ],
    }),
  );

  it("marks every escalation row as requiring escalation", () => {
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.escalationRequired).toBe(true);
    expect(result.rules[0]!.ruleType).toBe("escalation");
  });

  it("keeps the target and the response time with the action", () => {
    const action = result.rules[0]!.agentAction ?? "";
    expect(action).toContain("Stop replying");
    expect(action).toContain("Escalate to: Team Head");
    expect(action).toContain("Response time: Within 1 hour");
  });

  it("sorts escalations ahead of ordinary guidance", () => {
    expect(result.rules[0]!.priority).toBeLessThan(100);
  });
});

describe("banned phrases and their replacements", () => {
  const result = extractWorkbook(
    FILE,
    workbook({
      "8 — BANNED": [
        ["BANNED PHRASES", "", "", "", ""],
        ["#", "Category", "❌ Banned Phrase / Word / Response", "Why It's Banned", "✅ Use This Instead"],
        ["1", "Cases", "open a case", "Affects account health", "Let us sort this out for you"],
      ],
    }),
  );

  it("pairs the banned wording with its replacement", () => {
    const rule = result.rules[0]!;
    expect(rule.bannedPhrase).toBe("open a case");
    expect(rule.replacementInstruction).toBe("Let us sort this out for you");
    expect(rule.dontInstruction).toContain("open a case");
  });

  it("never sets replacement wording without a banned phrase", () => {
    // The schema's ck_cst_rules_replacement_needs_banned_phrase would reject it.
    for (const rule of result.rules) {
      if (rule.replacementInstruction !== null) expect(rule.bannedPhrase).not.toBeNull();
    }
  });
});

describe("do and don't rules", () => {
  const result = extractWorkbook(
    FILE,
    workbook({
      "1 — Universal": [
        ["UNIVERSAL RULES", "", "", ""],
        ["#", "Category", "Rule / Requirement", "DO or DON'T"],
        ["1", "Tone", "Reply within 24 hours", "🟢 DO"],
        ["2", "Tone", "Argue with the customer", "🔴 DON'T"],
      ],
    }),
  );

  it("routes each row to the matching instruction column", () => {
    expect(result.rules[0]!.doInstruction).toBe("Reply within 24 hours");
    expect(result.rules[0]!.dontInstruction).toBeNull();
    expect(result.rules[1]!.dontInstruction).toBe("Argue with the customer");
    expect(result.rules[1]!.doInstruction).toBeNull();
  });
});

describe("refusing to guess", () => {
  it("skips a sheet whose layout it does not recognise, and says so", () => {
    const result = extractWorkbook(
      FILE,
      workbook({
        "📖 DEFINITIONS": [
          ["DEFINITIONS", "", ""],
          ["Term", "Full Definition", "Used In"],
          ["TH", "Team Head", "All sheets"],
        ],
      }),
    );
    expect(result.rules).toHaveLength(0);
    expect(result.skipped[0]?.sourceSheet).toBe("📖 DEFINITIONS");
    expect(result.skipped[0]?.reason).toMatch(/no recognised rule-table layout/i);
  });

  it("imports nothing from a workbook with no category mapping", () => {
    const result = extractWorkbook("Some Other File.xlsx", workbook({ Sheet1: scenarioSheet([["X1", "A", "B", "No", "R", "k", "c"]]) }));
    expect(result.rules).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it("excludes the B2B account list by name, with a stated reason", () => {
    expect(EXCLUDED_FILES.get("B2B  customers .xlsx")).toMatch(/customer data/i);
    expect(CATEGORY_BY_FILE.has("B2B  customers .xlsx")).toBe(false);
  });

  it("ignores a section divider inside a table", () => {
    const result = extractWorkbook(
      FILE,
      workbook({
        "A — INVOICE": scenarioSheet([
          ["  ▸  A SECTION HEADING", "", "", "", "", "", ""],
          ["AQ1", "A situation", "A flow", "No", "A reply", "a keyword", "A rule"],
        ]),
      }),
    );
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.ruleName).toBe("AQ1");
  });
});

describe("customer data never enters the corpus", () => {
  it("drops a row carrying an email address or an order number", () => {
    const result = extractWorkbook(
      FILE,
      workbook({
        "A — INVOICE": scenarioSheet([
          ["AQ1", "Contact them at buyer@example.com", "Flow", "No", "Reply", "keyword", "Rule"],
          ["AQ2", "Order 12-34567-89012 was late", "Flow", "No", "Reply", "keyword", "Rule"],
          ["AQ3", "A situation with no customer data", "Flow", "No", "Reply", "keyword", "Rule"],
        ]),
      }),
    );
    expect(result.rules.map((r) => r.ruleName)).toEqual(["AQ3"]);
    expect(result.scrubbed).toBe(2);
  });
});

describe("idempotency inputs", () => {
  it("checksums row content, ignoring whitespace noise", () => {
    expect(checksumOf(["a", "b"])).toBe(checksumOf(["  a  ", "b"]));
    expect(checksumOf(["a", "b"])).not.toBe(checksumOf(["a", "c"]));
  });

  it("produces the same rules from the same grids", () => {
    const build = () =>
      extractWorkbook(FILE, workbook({ "A — INVOICE": scenarioSheet([["AQ1", "S", "F", "No", "R", "k", "c"]]) }));
    expect(build()).toEqual(build());
  });

  it("drops a rule that would collide on the database's unique key", () => {
    const one = extractWorkbook(FILE, workbook({ "A — INVOICE": scenarioSheet([["AQ1", "S", "F", "No", "R", "k", "c"]]) }))
      .rules[0]!;
    const { unique, duplicates } = deduplicate([one, one]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe("every rule satisfies the schema's constraints", () => {
  const result = extractWorkbook(
    FILE,
    workbook({
      "A — INVOICE": scenarioSheet([["AQ1", "A situation", "A flow", "Yes", "A reply", "a keyword", "A rule"]]),
      "13 — ESCALATION MATRIX": [
        ["ESC", "", "", "", ""],
        ["#", "Trigger Condition", "Required Action", "Escalate To", "Response Time"],
        ["1", "A condition", "An action", "Team Head", "1 hour"],
      ],
    }),
  );

  it("gives every rule a non-empty name and at least one instruction", () => {
    expect(result.rules.length).toBeGreaterThan(0);
    for (const rule of result.rules) {
      // ck_cst_rules_name_present
      expect(rule.ruleName.trim()).not.toBe("");
      // ck_cst_rules_has_instruction
      const instructions = [
        rule.ruleRequirement,
        rule.keyRule,
        rule.agentAction,
        rule.doInstruction,
        rule.dontInstruction,
        rule.bannedPhrase,
      ];
      expect(instructions.some((value) => (value ?? "").trim() !== "")).toBe(true);
      // ck_cst_rules_priority_positive and ck_cst_rules_type_present
      expect(rule.priority).toBeGreaterThanOrEqual(0);
      expect(rule.ruleType.trim()).not.toBe("");
      // ck_cst_rule_triggers_text_present
      for (const trigger of rule.triggers) expect(trigger.text.trim()).not.toBe("");
    }
  });
});
