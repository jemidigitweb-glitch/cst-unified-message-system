import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { INTERNAL_NOTE_CATEGORIES } from "@/lib/domain/internal-note";

/**
 * Static review of the internal-notes migration. These tests read the SQL as
 * text — they never connect to a database, and the migration is never executed
 * here. Same discipline as `cst-core-schema.test.ts`.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const UP = join(MIGRATIONS_DIR, "0012_internal_notes.up.sql");
const DOWN = join(MIGRATIONS_DIR, "0012_internal_notes.down.sql");

/**
 * Strips SQL comments so prose in a header block cannot satisfy or trip a
 * check. String literals are preserved deliberately — the CHECK vocabulary
 * under test lives inside them.
 */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

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
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS/i);
    expect(down).toMatch(/DROP TABLE IF EXISTS/i);
  });

  /** RESTRICT, never CASCADE — the convention 0011's rollback establishes. */
  it("rolls back without cascading", () => {
    expect(down).toMatch(/RESTRICT/);
    expect(down).not.toMatch(/CASCADE/);
  });

  it("drops only the table it created", () => {
    const drops = down.match(/DROP\s+\w+\s+IF EXISTS\s+[\w.]+/gi) ?? [];
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatch(/cst_app\.internal_notes/);
  });
});

describe("cst_app.internal_notes", () => {
  it("creates exactly one table, in cst_app", () => {
    const tables = up.match(/CREATE TABLE IF NOT EXISTS\s+([\w.]+)/gi) ?? [];
    expect(tables).toHaveLength(1);
    expect(tables[0]).toContain("cst_app.internal_notes");
  });

  it("follows the project's primary key convention", () => {
    expect(up).toMatch(/id\s+bigint\s+GENERATED ALWAYS AS IDENTITY PRIMARY KEY/i);
  });

  it("belongs to a conversation, and goes when the conversation does", () => {
    expect(up).toMatch(
      /fk_internal_notes_conversation[\s\S]{0,160}REFERENCES cst_app\.conversations \(id\) ON DELETE CASCADE/,
    );
  });

  it("references an author without requiring one", () => {
    expect(up).toMatch(/author_user_id\s+bigint\s*,/);
    expect(up).toMatch(
      /fk_internal_notes_author[\s\S]{0,160}REFERENCES cst_app\.app_users \(id\) ON DELETE SET NULL/,
    );
    // Nullable: this application has no interactive agent identity yet.
    expect(up).not.toMatch(/author_user_id\s+bigint\s+NOT NULL/i);
  });

  it("carries both timestamps, in the project's form", () => {
    for (const column of ["created_at", "updated_at"]) {
      expect(up).toMatch(new RegExp(`${column}\\s+timestamptz\\s+NOT NULL DEFAULT now\\(\\)`, "i"));
    }
  });

  it("constrains the category to exactly the declared set", () => {
    // The clause itself, bounded by its own closing bracket — a fixed-width
    // window ran on into `ck_internal_notes_visibility` and counted its value
    // as a sixth category.
    const start = up.indexOf("ck_internal_notes_category");
    expect(start).toBeGreaterThan(-1);
    const clause = up.slice(start, up.indexOf("))", start) + 2);

    for (const category of INTERNAL_NOTE_CATEGORIES) {
      expect(clause).toContain(`'${category}'`);
    }
    // Nothing beyond the declared set may be storable.
    const listed = clause.match(/'[a-z_]+'/g) ?? [];
    expect(new Set(listed)).toEqual(new Set(INTERNAL_NOTE_CATEGORIES.map((c) => `'${c}'`)));
  });

  it("refuses a blank or whitespace-only note", () => {
    expect(up).toMatch(
      /ck_internal_notes_text_present[\s\S]{0,120}CHECK \(length\(btrim\(note_text\)\) > 0\)/,
    );
  });

  it("permits exactly one visibility, and it is internal", () => {
    expect(up).toMatch(
      /ck_internal_notes_visibility[\s\S]{0,120}CHECK \(visibility IN \('internal'\)\)/,
    );
    expect(up).toMatch(/visibility\s+text\s+NOT NULL DEFAULT 'internal'/);
  });

  it("indexes the one read this feature performs", () => {
    expect(up).toMatch(
      /ix_internal_notes_conversation[\s\S]{0,140}\(conversation_id, created_at DESC, id DESC\)/,
    );
  });

  it("documents the table and the columns that carry a rule", () => {
    expect(upRaw).toMatch(/COMMENT ON TABLE cst_app\.internal_notes/);
    expect(upRaw).toMatch(/COMMENT ON COLUMN cst_app\.internal_notes\.visibility/);
    expect(upRaw).toMatch(/COMMENT ON COLUMN cst_app\.internal_notes\.author_user_id/);
  });
});

describe("the source database is not touched", () => {
  /**
   * The order reference is a PLAIN COLUMN, which is the rule 0011 states for
   * the same situation: the order lives in a different, read-only database
   * that this schema may not couple itself to.
   */
  it("holds a source order id with no foreign key behind it", () => {
    expect(up).toMatch(/source_order_id\s+bigint/);
    for (const schema of ["order_management", "customers", "customer_service", "listings", "staff"]) {
      expect(up).not.toMatch(new RegExp(`REFERENCES\\s+${schema}\\.`, "i"));
    }
  });

  it("creates and alters nothing outside cst_app", () => {
    const statements = up.match(/(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA)[^;]*/gi) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/cst_app\./);
    }
    for (const schema of ["issue_tracking", "poc_listing", "review", "sku360", "public."]) {
      expect(up).not.toContain(schema);
    }
  });

  it("adds no trigger and no function, like every migration before it", () => {
    expect(up).not.toMatch(/CREATE\s+(OR REPLACE\s+)?(FUNCTION|TRIGGER)/i);
  });

  it("alters nothing that already existed", () => {
    expect(up).not.toMatch(/\bALTER TABLE\b/i);
    expect(up).not.toMatch(/\bDROP\b/i);
  });
});
