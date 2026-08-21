import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Static review of the CST knowledge corpus migration.
 *
 * Reads the SQL as text — never connects to a database, and the migration is
 * never executed. Same approach as `cst-core-schema.test.ts`.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const UP = join(MIGRATIONS_DIR, "0005_cst_knowledge_base.up.sql");
const DOWN = join(MIGRATIONS_DIR, "0005_cst_knowledge_base.down.sql");

/** Strips SQL comments so header prose cannot satisfy or trip a check. */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * `code`, minus COMMENT ON statements.
 *
 * Those are documentation that happens to live in a string literal, so a table
 * comment saying "stores no SKU" would otherwise register as storing one.
 */
function ddl(sql: string): string {
  return code(sql).replace(/COMMENT\s+ON\s+[\s\S]*?;/gi, " ");
}

/** The body of one CREATE TABLE statement. */
function table(sql: string, name: string): string {
  const match = new RegExp(
    `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+cst_app\\.${name}\\s*\\([\\s\\S]*?\\n\\);`,
    "i",
  ).exec(sql);
  return match?.[0] ?? "";
}

const EXPECTED_TABLES = [
  "cst_knowledge_sources",
  "cst_rule_categories",
  "cst_rules",
  "cst_rule_examples",
  "cst_rule_triggers",
] as const;

let upRaw: string;
let up: string;
let down: string;

beforeAll(() => {
  upRaw = readFileSync(UP, "utf8");
  up = code(upRaw);
  down = code(readFileSync(DOWN, "utf8"));
});

describe("migration files", () => {
  it("has an up migration and a matching rollback", () => {
    expect(existsSync(UP)).toBe(true);
    expect(existsSync(DOWN)).toBe(true);
  });

  it("wraps each direction in a single transaction", () => {
    for (const sql of [up, down]) {
      expect(sql).toMatch(/\bBEGIN\s*;/i);
      expect(sql).toMatch(/\bCOMMIT\s*;/i);
    }
  });

  it("is re-runnable", () => {
    const creates = [...up.matchAll(/CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\s+([\s\S]{0,20}?)IF\s+NOT\s+EXISTS/gi)];
    const allCreates = [...up.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b/gi)];
    expect(creates.length).toBe(allCreates.length);
  });
});

describe("schema objects", () => {
  it("creates every expected table in cst_app", () => {
    for (const name of EXPECTED_TABLES) {
      expect(table(up, name), `${name} missing`).not.toBe("");
    }
  });

  it("creates no table outside cst_app, and no table beyond the five", () => {
    const creates = [...up.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi)];
    expect(creates.length).toBe(EXPECTED_TABLES.length);
    for (const [, name] of creates) expect(name.startsWith("cst_app.")).toBe(true);
  });

  it("qualifies every index to cst_app", () => {
    const indexes = [
      ...up.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+([\w.]+)/gi),
    ];
    expect(indexes.length).toBeGreaterThan(0);
    for (const [, target] of indexes) expect(target.startsWith("cst_app.")).toBe(true);
  });

  it("declares foreign keys only between the five knowledge tables", () => {
    const fks = [...up.matchAll(/REFERENCES\s+cst_app\.(\w+)/gi)];
    expect(fks.length).toBe(4);
    for (const [, target] of fks) {
      expect(EXPECTED_TABLES as readonly string[]).toContain(target);
    }
  });

  it("creates no functions or triggers", () => {
    expect(up).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(up).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(up).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE/i);
  });
});

describe("blast radius", () => {
  it("never touches another project's schema", () => {
    for (const schema of ["issue_tracking", "poc_listing", "public"]) {
      const ddl = new RegExp(`\\b(ALTER|DROP|TRUNCATE|GRANT|REVOKE)\\b[^;]*\\b${schema}\\b`, "i");
      expect(up).not.toMatch(ddl);
      expect(down).not.toMatch(ddl);
    }
  });

  it("alters and truncates nothing, so 0001-0004 are untouched", () => {
    expect(up).not.toMatch(/\bALTER\b/i);
    expect(up).not.toMatch(/\bTRUNCATE\b/i);
    expect(up).not.toMatch(/\bDROP\b/i);
  });

  it("rolls back exactly the five tables it created, and no schema", () => {
    const drops = [...down.matchAll(/DROP\s+TABLE\s+IF\s+EXISTS\s+cst_app\.(\w+)/gi)].map((m) => m[1]);
    expect(drops.sort()).toEqual([...EXPECTED_TABLES].sort());
    expect(down).not.toMatch(/DROP\s+SCHEMA/i);
    expect(down).not.toMatch(/CASCADE/i);
  });

  it("drops children before the tables they reference", () => {
    const order = [...down.matchAll(/DROP\s+TABLE\s+IF\s+EXISTS\s+cst_app\.(\w+)/gi)].map((m) => m[1]!);
    expect(order.indexOf("cst_rule_triggers")).toBeLessThan(order.indexOf("cst_rules"));
    expect(order.indexOf("cst_rule_examples")).toBeLessThan(order.indexOf("cst_rules"));
    expect(order.indexOf("cst_rules")).toBeLessThan(order.indexOf("cst_rule_categories"));
    expect(order.indexOf("cst_rules")).toBeLessThan(order.indexOf("cst_knowledge_sources"));
  });
});

describe("knowledge only — no operational data", () => {
  it("stores no customer, order, SKU or marketplace column", () => {
    // `customer_message_example` is rule-document wording, not captured traffic,
    // and is checked separately below.
    const columns = ddl(upRaw).replace(/customer_message_example/g, " ").toLowerCase();
    for (const forbidden of [
      "order_number",
      "order_id",
      "exact_sku",
      "sku ",
      "marketplace",
      "conversation_id",
      "buyer",
      "counterparty",
      "email",
      "tracking",
    ]) {
      expect(columns, `must not store ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("holds no foreign key into conversations, messages or drafts", () => {
    expect(up).not.toMatch(/REFERENCES\s+cst_app\.(conversations|conversation_messages|draft_\w+)/i);
  });

  it("marks the example table as rule-document wording, not real messages", () => {
    expect(upRaw).toMatch(/COMMENT\s+ON\s+TABLE\s+cst_app\.cst_rule_examples[\s\S]{0,200}NOT captured customer traffic/i);
  });
});

describe("governance constraints", () => {
  it("constrains source status to the four governance states", () => {
    const clause = /ck_cst_knowledge_sources_status[\s\S]{0,200}/.exec(up)?.[0] ?? "";
    for (const status of ["draft", "reviewed", "approved", "retired"]) {
      expect(clause).toContain(`'${status}'`);
    }
  });

  it("lets nothing become live without a sign-off", () => {
    expect(up).toMatch(
      /ck_cst_knowledge_sources_active_requires_approval[\s\S]{0,120}CHECK\s*\(\s*NOT\s+active\s+OR\s+status\s*=\s*'approved'\s*\)/i,
    );
  });

  it("requires a date whenever something is signed off", () => {
    expect(up).toMatch(
      /ck_cst_knowledge_sources_approval_pair[\s\S]{0,150}approved_at\s+IS\s+NOT\s+NULL/i,
    );
  });

  it("permits only one live version of a source row", () => {
    expect(up).toMatch(
      /CREATE\s+UNIQUE\s+INDEX[^;]*uq_cst_knowledge_sources_one_active[\s\S]*?WHERE\s+active/i,
    );
  });

  it("keeps superseded versions rather than overwriting them", () => {
    // Identity includes the version, so a re-import adds a row.
    expect(up).toMatch(/uq_cst_knowledge_sources_identity[\s\S]{0,200}version\s*\)/i);
  });

  it("refuses to delete a source or category out from under its rules", () => {
    expect(up).toMatch(/fk_cst_rules_source[\s\S]{0,160}ON\s+DELETE\s+RESTRICT/i);
    expect(up).toMatch(/fk_cst_rules_category[\s\S]{0,160}ON\s+DELETE\s+RESTRICT/i);
  });
});

describe("rule content constraints", () => {
  it("rejects a rule that instructs nothing", () => {
    expect(up).toMatch(/ck_cst_rules_has_instruction/i);
  });

  it("keeps the analysed rule structure as distinct columns", () => {
    const rules = table(up, "cst_rules");
    for (const column of [
      "rule_requirement",
      "key_rule",
      "agent_action",
      "do_instruction",
      "dont_instruction",
      "banned_phrase",
      "replacement_instruction",
      "escalation_required",
      "priority",
      "subcategory",
      "rule_type",
    ]) {
      expect(rules, `cst_rules.${column} missing`).toContain(column);
    }
  });

  it("does not accept replacement wording without a banned phrase", () => {
    expect(up).toMatch(/ck_cst_rules_replacement_needs_banned_phrase/i);
  });

  it("constrains trigger types to a matchable vocabulary", () => {
    const clause = /ck_cst_rule_triggers_type[\s\S]{0,160}/.exec(up)?.[0] ?? "";
    for (const type of ["keyword", "phrase", "regex", "intent"]) {
      expect(clause).toContain(`'${type}'`);
    }
  });

  it("uses timestamptz for every application-generated timestamp", () => {
    const naive = [...up.matchAll(/\b(created_at|updated_at|approved_at)\s+timestamp\b(?!tz)/gi)];
    expect(naive.map((m) => m[0])).toEqual([]);
  });
});

describe("adds no send capability", () => {
  it("introduces no workflow state and no outbound structure", () => {
    const lower = ddl(upRaw).toLowerCase();
    for (const term of ["workflow_state", "send_queue", "outbound", "sent_at", "recipient", "dispatch"]) {
      expect(lower, `must not contain ${term}`).not.toContain(term);
    }
  });
});
