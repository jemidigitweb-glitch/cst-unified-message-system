import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Static review of the follow-up reminder migration (0014).
 *
 * These tests read the SQL as text and NEVER connect to a database, which is
 * the approach `cst-core-schema.test.ts` established and the reason the suite
 * can run anywhere. The behaviour a static read cannot prove — that the
 * migration applies, that the CHECK really rejects a bad status, that the
 * rollback really removes only this table — was verified separately against the
 * application database inside a transaction that was rolled back, so nothing
 * was persisted. See the task report.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const UP = join(MIGRATIONS_DIR, "0014_follow_up_reminders.up.sql");
const DOWN = join(MIGRATIONS_DIR, "0014_follow_up_reminders.down.sql");

const TABLE = "cst_app.follow_up_reminders";

/**
 * Strips SQL comments so prose in a header block cannot satisfy or trip a
 * check. String literals are preserved deliberately — the status vocabulary
 * under test lives inside them.
 */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Text of a named CONSTRAINT clause, for asserting on its contents. */
function constraintClause(sql: string, name: string): string {
  const at = sql.indexOf(name);
  if (at === -1) return "";
  return sql.slice(at, at + 400);
}

let upRaw: string;
let up: string;
let down: string;

beforeAll(() => {
  upRaw = readFileSync(UP, "utf8");
  up = code(upRaw);
  down = code(readFileSync(DOWN, "utf8"));
});

describe("the migration pair", () => {
  it("has an up migration and a matching rollback", () => {
    expect(existsSync(UP)).toBe(true);
    expect(existsSync(DOWN)).toBe(true);
  });

  /**
   * NUMBERING, AND THIS CAUGHT A REAL COLLISION.
   *
   * It first asserted only that 0014 was unique and the highest. Two branches
   * then both shipped a `0012` — `0012_internal_notes` and the automation
   * worker's wake migration — and nothing failed, because neither was 0014.
   * The number is what ORDERS migrations, so a duplicate is not a tidiness
   * problem: a database that ran one `0012` cannot say which. The unapplied one
   * was renumbered to 0015, and this now guards every number rather than one.
   */
  it("gives every migration its own sequence number", () => {
    const ups = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql"));
    const numbers = ups.map((f) => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("is the only 0014", () => {
    const ups = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql"));
    expect(ups.filter((f) => f.startsWith("0014_"))).toHaveLength(1);
  });

  it("wraps each direction in a single transaction", () => {
    for (const sql of [up, down]) {
      expect(sql).toMatch(/\bBEGIN\s*;/i);
      expect(sql).toMatch(/\bCOMMIT\s*;/i);
    }
  });

  it("is re-runnable", () => {
    expect(up).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
    for (const index of [...up.matchAll(/CREATE\s+INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/gi)]) {
      expect(index[1]).toBeDefined();
    }
  });
});

describe("the table", () => {
  it("creates follow_up_reminders in cst_app, and nothing else anywhere", () => {
    const creates = [...up.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi)];
    expect(creates.map(([, name]) => name)).toEqual([TABLE]);
  });

  it("carries exactly the agreed columns", () => {
    for (const column of [
      /id\s+bigint\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/i,
      /conversation_id\s+bigint\s+NOT\s+NULL/i,
      /promised_due_at\s+timestamptz\s+NOT\s+NULL/i,
      /note\s+text\s*,/i,
      /status\s+text\s+NOT\s+NULL\s+DEFAULT\s+'scheduled'/i,
      /completed_at\s+timestamptz\s*,/i,
      /created_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i,
      /updated_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i,
    ]) {
      expect(up).toMatch(column);
    }
  });

  /**
   * THE SCOPE OF THIS TASK, PINNED. Ownership, assignment and identity are a
   * later migration and this one must not smuggle a column in ahead of them —
   * a nullable owner nothing can fill is worse than no owner at all.
   */
  it("carries no staff identity, assignment or ownership column", () => {
    for (const forbidden of [
      /assigned_user_id/i,
      /assignee/i,
      /created_by_user_id/i,
      /completed_by_user_id/i,
      /owner/i,
      /team_leader/i,
      /\bapp_users\b/i,
    ]) {
      expect(up).not.toMatch(forbidden);
    }
  });

  /** Application-generated times are timestamptz; nothing naive appears here. */
  it("uses timestamptz for every time it stores", () => {
    const columns = [...up.matchAll(/^\s*(\w+)\s+(timestamptz|timestamp)\b/gim)];
    expect(columns.length).toBeGreaterThan(0);
    for (const [, name, type] of columns) {
      expect(`${name}:${type}`).toBe(`${name}:timestamptz`);
    }
  });
});

describe("constraints", () => {
  it("links the conversation with the schema's established foreign key", () => {
    expect(constraintClause(up, "fk_follow_up_reminders_conversation")).toMatch(
      /FOREIGN\s+KEY\s*\(\s*conversation_id\s*\)\s*REFERENCES\s+cst_app\.conversations\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i,
    );
  });

  it("declares foreign keys only between cst_app tables", () => {
    const fks = [...up.matchAll(/REFERENCES\s+([\w.]+)/gi)];
    expect(fks.length).toBe(1);
    for (const [, target] of fks) {
      expect(target.startsWith("cst_app.")).toBe(true);
    }
  });

  /** The three stored states, and only those three. */
  it("admits scheduled, completed and cancelled", () => {
    const clause = constraintClause(up, "ck_follow_up_reminders_status");
    expect(clause).toMatch(
      /CHECK\s*\(\s*status\s+IN\s*\(\s*'scheduled'\s*,\s*'completed'\s*,\s*'cancelled'\s*\)\s*\)/i,
    );
  });

  /**
   * The derived readings must NOT be stored: a persisted `overdue` is wrong
   * from the moment it comes due until something remembers to update it.
   */
  it("stores no state that is really a reading of the clock", () => {
    for (const derived of [/'upcoming'/i, /'due_soon'/i, /'overdue'/i, /'due'/i]) {
      expect(up).not.toMatch(derived);
    }
  });

  it("requires a completed reminder to record when it was completed", () => {
    expect(constraintClause(up, "ck_follow_up_reminders_completed_pair")).toMatch(
      /CHECK\s*\(\s*status\s*<>\s*'completed'\s+OR\s+completed_at\s+IS\s+NOT\s+NULL\s*\)/i,
    );
  });

  /**
   * DELIBERATELY NOT A BICONDITIONAL, and 0013 is the precedent: the automation's
   * cancel pair shipped as one and had to be relaxed when a restored record
   * needed to keep its timestamp. A reopened reminder is the same shape, so the
   * reverse implication must not be present.
   */
  it("does not forbid a reopened reminder from keeping its completion time", () => {
    const clause = constraintClause(up, "ck_follow_up_reminders_completed_pair");
    expect(clause).not.toMatch(/completed_at\s+IS\s+NOT\s+NULL\s*\)\s*=\s*\(/i);
    expect(clause).not.toMatch(/completed_at\s+IS\s+NULL\s+OR\s+status\s*=/i);
  });

  it("treats an empty note as no note", () => {
    expect(constraintClause(up, "ck_follow_up_reminders_note_present")).toMatch(
      /CHECK\s*\(\s*note\s+IS\s+NULL\s+OR\s+length\s*\(\s*btrim\s*\(\s*note\s*\)\s*\)\s*>\s*0\s*\)/i,
    );
  });
});

describe("indexes", () => {
  it("answers 'which reminders are still live, soonest first' with a partial index", () => {
    expect(up).toMatch(
      new RegExp(
        `CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+ix_follow_up_reminders_due\\s+ON\\s+${TABLE.replace(".", "\\.")}\\s*\\(\\s*promised_due_at\\s*,\\s*id\\s*\\)\\s*WHERE\\s+status\\s*=\\s*'scheduled'`,
        "i",
      ),
    );
  });

  it("indexes a conversation's own reminders", () => {
    expect(up).toMatch(/ix_follow_up_reminders_conversation[\s\S]{0,120}\(\s*conversation_id\s*,/i);
  });

  it("qualifies every created index to cst_app", () => {
    const indexes = [
      ...up.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+([\w.]+)/gi),
    ];
    expect(indexes.length).toBe(2);
    for (const [, target] of indexes) {
      expect(target.startsWith("cst_app.")).toBe(true);
    }
  });
});

describe("blast radius", () => {
  /**
   * `cst_app.internal_notes` exists in the live database with no migration in
   * this repository and no runtime reader. It is not this migration's business
   * in either direction.
   */
  it("never mentions internal_notes", () => {
    expect(upRaw.toLowerCase()).toContain("internal_notes"); // only in the prose that says so
    expect(up).not.toMatch(/internal_notes/i); // never in executable SQL
    expect(down).not.toMatch(/internal_notes/i);
  });

  it("never alters, drops, or truncates another project's schema", () => {
    for (const schema of ["issue_tracking", "poc_listing", "public"]) {
      const ddl = new RegExp(`\\b(ALTER|DROP|TRUNCATE|GRANT|REVOKE)\\b[^;]*\\b${schema}\\b`, "i");
      expect(up).not.toMatch(ddl);
      expect(down).not.toMatch(ddl);
    }
  });

  /**
   * The source marketplace database is strictly read-only and must not appear
   * in a migration in any form — not as a schema, not as a table, not as a
   * foreign key.
   */
  it("names no source-database object", () => {
    for (const source of [
      /\border_management\b/i,
      /\bcustomer_service\b/i,
      /\bcustomers\./i,
      /\blistings\b/i,
      /\binventory\b/i,
      /\bledsone\b/i,
    ]) {
      expect(up).not.toMatch(source);
      expect(down).not.toMatch(source);
    }
  });

  it("alters and truncates nothing at all", () => {
    expect(up).not.toMatch(/\bALTER\b/i);
    expect(up).not.toMatch(/\bTRUNCATE\b/i);
    expect(down).not.toMatch(/\bALTER\b/i);
    expect(down).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("inserts no data", () => {
    expect(up).not.toMatch(/\bINSERT\b/i);
    expect(up).not.toMatch(/\bUPDATE\b/i);
  });

  it("adds no function or trigger", () => {
    expect(up).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(up).not.toMatch(/CREATE\s+TRIGGER/i);
  });
});

describe("the rollback", () => {
  it("drops the one table it created, with RESTRICT and never CASCADE", () => {
    const drops = [...down.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w.]+)\s+(\w+)/gi)];
    expect(drops).toHaveLength(1);
    expect(drops[0]![1]).toBe(TABLE);
    expect(drops[0]![2]!.toUpperCase()).toBe("RESTRICT");
    expect(down).not.toMatch(/CASCADE/i);
  });

  it("drops no schema and no other object", () => {
    expect(down).not.toMatch(/DROP\s+SCHEMA/i);
    expect(down).not.toMatch(/DROP\s+INDEX/i);
    const drops = [...down.matchAll(/\bDROP\b/gi)];
    expect(drops).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- *
 * NO CUSTOMER SENDING
 * ------------------------------------------------------------------------- */

describe("no send, outbound or transport capability was added", () => {
  it("has no status word that could mean a customer was contacted", () => {
    for (const status of [/'sent'/i, /'sending'/i, /'queued'/i, /'delivered'/i, /'notified'/i]) {
      expect(up).not.toMatch(status);
    }
  });

  it("has no column a transport could read", () => {
    for (const column of [
      /recipient/i,
      /\bchannel\b/i,
      /marketplace/i,
      /rendered_body/i,
      /template/i,
      /\bemail\b/i,
      /\bphone\b/i,
      /address/i,
      /\bsend\w*/i,
      /outbound/i,
      /transmit/i,
      /\bdraft\b/i,
      /\breply\b/i,
    ]) {
      expect(up).not.toMatch(column);
    }
  });
});
