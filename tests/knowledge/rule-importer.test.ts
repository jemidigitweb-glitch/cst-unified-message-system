import { describe, expect, it } from "vitest";

import type { ExtractedRule } from "@/lib/knowledge/rule-extraction";
import {
  type Queryable,
  assertApplicationDatabase,
  importRules,
} from "@/lib/knowledge/rule-importer";

/**
 * Import behaviour, against a fake connection.
 *
 * The point of these tests is what the importer SENDS: which tables it touches,
 * whether a second run repeats the first one's writes, and whether anything it
 * inserts could become live without a human. None of that needs a server.
 */

type Recorded = { text: string; values: readonly unknown[] };

/**
 * A fake Postgres that records statements and answers the ones that matter.
 *
 * The importer sends arrays and lets the server unnest them, so this has to
 * echo one result row per input element — returning a single row would make an
 * id-mapping bug look like a pass.
 */
function fakeDatabase(options: { existingChecksum?: string } = {}) {
  const statements: Recorded[] = [];
  let nextId = 1;

  const client: Queryable = {
    async query(text, values = []) {
      statements.push({ text, values });
      const sql = text.trim().toUpperCase();
      const array = (index: number): unknown[] => (values[index] as unknown[]) ?? [];

      if (sql.startsWith("SELECT CURRENT_DATABASE")) {
        return { rows: [{ database: "varmen_db", user: "varmen_user" }], rowCount: 1 };
      }
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO CST_APP.CST_RULE_CATEGORIES")) {
        const rows = array(0).map((name) => ({ id: nextId++, name, inserted: true }));
        return { rows, rowCount: rows.length };
      }
      // Existing-source lookup.
      if (sql.includes("FROM CST_APP.CST_KNOWLEDGE_SOURCES")) {
        if (options.existingChecksum === undefined) return { rows: [], rowCount: 0 };
        const rows = array(0).map((file, i) => ({
          id: 700 + i,
          source_file: file,
          source_sheet: array(1)[i],
          source_row: array(2)[i],
          content_checksum: options.existingChecksum,
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("INSERT INTO CST_APP.CST_KNOWLEDGE_SOURCES")) {
        const rows = array(0).map((file, i) => ({
          id: nextId++,
          source_file: file,
          source_sheet: array(1)[i],
          source_row: array(2)[i],
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("INSERT INTO CST_APP.CST_RULES")) {
        const rows = array(1).map((sourceId, i) => ({
          id: nextId++,
          source_id: sourceId,
          key: String(array(2)[i]).trim().toLowerCase(),
          inserted: true,
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("INSERT")) {
        return { rows: [], rowCount: array(0).length };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  return { client, statements };
}

function rule(overrides: Partial<ExtractedRule> = {}): ExtractedRule {
  return {
    categoryName: "Admin",
    sourceFile: "ADMIN.xlsx",
    sourceSheet: "A — INVOICE",
    sourceRow: 4,
    contentChecksum: "abc123",
    ruleName: "AQ1",
    subcategory: "A — INVOICE",
    ruleType: "scenario",
    ruleRequirement: "A situation",
    keyRule: null,
    agentAction: "A flow",
    doInstruction: null,
    dontInstruction: null,
    bannedPhrase: null,
    replacementInstruction: null,
    escalationRequired: false,
    priority: 100,
    triggers: [{ text: "a keyword", type: "phrase" }],
    examples: [{ customerMessage: "A situation", expectedResponse: "A reply" }],
    ...overrides,
  };
}

describe("database identity is confirmed before any write", () => {
  it("accepts the application database", async () => {
    const { client } = fakeDatabase();
    await expect(assertApplicationDatabase(client, "varmen_db")).resolves.toEqual({
      database: "varmen_db",
      user: "varmen_user",
    });
  });

  it("refuses to write to anything else", async () => {
    const client: Queryable = {
      async query() {
        return { rows: [{ database: "ledsone", user: "reader" }], rowCount: 1 };
      },
    };
    await expect(assertApplicationDatabase(client, "varmen_db")).rejects.toThrow(/Refusing to write/);
  });

  it("refuses to write before the knowledge migration has been applied", async () => {
    const client: Queryable = {
      async query(text) {
        if (text.toUpperCase().includes("INFORMATION_SCHEMA")) return { rows: [], rowCount: 0 };
        return { rows: [{ database: "varmen_db", user: "varmen_user" }], rowCount: 1 };
      },
    };
    await expect(assertApplicationDatabase(client, "varmen_db")).rejects.toThrow(/0005_cst_knowledge_base/);
  });
});

describe("writes stay inside cst_app", () => {
  it("names no table outside the five knowledge tables", async () => {
    const { client, statements } = fakeDatabase();
    await importRules(client, [rule()]);

    const KNOWLEDGE = [
      "cst_app.cst_knowledge_sources",
      "cst_app.cst_rule_categories",
      "cst_app.cst_rules",
      "cst_app.cst_rule_examples",
      "cst_app.cst_rule_triggers",
    ];
    for (const statement of statements) {
      // Skips the UPDATE in `ON CONFLICT ... DO UPDATE SET` and the `FROM
      // unnest(...)` that carries the batch — neither names a table.
      for (const [, table] of statement.text.matchAll(
        /\b(?:INTO|UPDATE|FROM)\s+((?!SET\b|unnest\b)[\w.]+)/gi,
      )) {
        if (table!.toLowerCase().startsWith("information_schema")) continue;
        expect(KNOWLEDGE, `unexpected table: ${table}`).toContain(table);
      }
    }
  });

  it("parameterises every value rather than interpolating it", async () => {
    const { client, statements } = fakeDatabase();
    await importRules(client, [rule({ ruleName: "O'Brien; DROP TABLE" })]);
    for (const statement of statements) {
      expect(statement.text).not.toContain("O'Brien");
    }
    // Values travel as array parameters, never inside the statement text.
    expect(
      statements.some((s) => s.values.some((v) => Array.isArray(v) && v.includes("O'Brien; DROP TABLE"))),
    ).toBe(true);
  });
});

describe("nothing imported becomes live on its own", () => {
  it("inserts sources as draft and inactive", async () => {
    const { client, statements } = fakeDatabase();
    await importRules(client, [rule()]);

    const insert = statements.find((s) => s.text.includes("INSERT INTO cst_app.cst_knowledge_sources"));
    expect(insert).toBeDefined();
    expect(insert!.text).toContain("'draft'");
    expect(insert!.text).toContain("false");
    // ck_cst_knowledge_sources_active_requires_approval makes this the only
    // legal combination for unreviewed content; the importer must not try it.
    expect(insert!.text).not.toMatch(/'approved'/);
  });

  it("never approves or activates a source", async () => {
    const { client, statements } = fakeDatabase();
    await importRules(client, [rule()]);
    for (const statement of statements) {
      expect(statement.text).not.toMatch(/SET[\s\S]*\bactive\s*=\s*true/i);
      expect(statement.text).not.toMatch(/approved_at/i);
    }
  });
});

describe("running twice does not duplicate", () => {
  it("skips a source whose content has not changed", async () => {
    const { client, statements } = fakeDatabase({ existingChecksum: "abc123" });
    const counts = await importRules(client, [rule({ contentChecksum: "abc123" })]);

    expect(counts.sourcesUnchanged).toBe(1);
    expect(counts.rulesCreated).toBe(0);
    expect(counts.rulesUpdated).toBe(0);
    // The whole row short-circuits: no rule, trigger or example work at all.
    expect(statements.some((s) => s.text.includes("cst_app.cst_rules"))).toBe(false);
    expect(statements.some((s) => s.text.includes("cst_app.cst_rule_triggers"))).toBe(false);
  });

  it("updates in place when the content did change", async () => {
    const { client, statements } = fakeDatabase({ existingChecksum: "older" });
    const counts = await importRules(client, [rule({ contentChecksum: "newer" })]);

    expect(counts.sourcesUpdated).toBe(1);
    expect(counts.sourcesCreated).toBe(0);
    expect(statements.some((s) => s.text.includes("UPDATE cst_app.cst_knowledge_sources"))).toBe(true);
  });

  it("upserts rules and triggers rather than inserting blindly", async () => {
    const { client, statements } = fakeDatabase();
    await importRules(client, [rule()]);

    const ruleInsert = statements.find((s) => s.text.includes("INSERT INTO cst_app.cst_rules"))!;
    expect(ruleInsert.text).toContain("ON CONFLICT (source_id, lower(btrim(rule_name))) DO UPDATE");

    const triggerInsert = statements.find((s) => s.text.includes("INSERT INTO cst_app.cst_rule_triggers"))!;
    expect(triggerInsert.text).toContain("DO NOTHING");
  });

  it("replaces a rule's examples instead of appending to them", async () => {
    // cst_rule_examples has no unique index to conflict against, so append
    // would grow the table on every run.
    const { client, statements } = fakeDatabase();
    await importRules(client, [rule()]);

    const order = statements.map((s) => s.text);
    const deleteAt = order.findIndex((t) => t.includes("DELETE FROM cst_app.cst_rule_examples"));
    const insertAt = order.findIndex((t) => t.includes("INSERT INTO cst_app.cst_rule_examples"));
    expect(deleteAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(deleteAt);
  });

  it("creates each category once, however many rules use it", async () => {
    const { client, statements } = fakeDatabase();
    await importRules(client, [rule({ sourceRow: 4 }), rule({ sourceRow: 5 }), rule({ sourceRow: 6 })]);
    const categoryWrites = statements.filter((s) => s.text.includes("cst_app.cst_rule_categories"));
    expect(categoryWrites).toHaveLength(1);
  });
});

describe("source provenance is preserved", () => {
  it("stores the file, sheet and row for every rule", async () => {
    const { client, statements } = fakeDatabase();
    await importRules(client, [rule({ sourceFile: "ADMIN.xlsx", sourceSheet: "A — INVOICE", sourceRow: 4 })]);

    // Batched: each parameter is a column-array, one element per row.
    const insert = statements.find((s) => s.text.includes("INSERT INTO cst_app.cst_knowledge_sources"))!;
    expect(insert.values.slice(0, 3)).toEqual([["ADMIN.xlsx"], ["A — INVOICE"], [4]]);
  });
});
