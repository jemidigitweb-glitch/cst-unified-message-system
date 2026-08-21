import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { MARKETPLACES } from "@/lib/domain/marketplace";

/**
 * Static review of the unresolved-message storage migration. These tests read
 * the SQL as text — they never connect to a database, and the migration is
 * never executed by the suite.
 *
 * The point of this migration is what it does NOT contain, so most of what
 * follows is a check that a direction, counterparty or thread column has not
 * appeared. Those absences are the whole safety property: without a direction
 * column there is nothing to guess into.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const UP = join(MIGRATIONS_DIR, "0002_unresolved_marketplace_messages.up.sql");
const DOWN = join(MIGRATIONS_DIR, "0002_unresolved_marketplace_messages.down.sql");
const TABLE = "cst_app.unresolved_marketplace_messages";

/** Strips SQL comments so header prose cannot satisfy or trip a check. */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Additionally strips string literals, for the checks that assert a column does
 * NOT exist. A COMMENT ON that explains why there is no direction column would
 * otherwise read as one.
 */
function structure(sql: string): string {
  return code(sql).replace(/'[^']*'/g, "''");
}

let up: string;
let down: string;
let upStructure: string;

beforeAll(() => {
  const raw = readFileSync(UP, "utf8");
  up = code(raw);
  upStructure = structure(raw);
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
    for (const index of [...up.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(IF NOT EXISTS)?/gi)]) {
      expect(index[2]).toBeDefined();
    }
  });
});

describe("nothing is guessed", () => {
  it("declares no direction column", () => {
    expect(upStructure).not.toMatch(/^\s*direction\b/mi);
    expect(up).not.toMatch(/["']inbound["']|["']outbound["']/);
  });

  it("declares no counterparty or customer identity column", () => {
    expect(upStructure).not.toMatch(/counterparty/i);
    expect(upStructure).not.toMatch(/customer_ref|sender|recipient|from_msg|to_msg/i);
  });

  it("declares no conversation or thread column", () => {
    expect(upStructure).not.toMatch(/conversation_id/i);
    expect(upStructure).not.toMatch(/thread_key|threading_rule_version|threading_strategy/i);
  });

  it("declares no workflow state", () => {
    // An unverified message is not review work yet, so it has no workflow.
    expect(upStructure).not.toMatch(/workflow_state/i);
  });
});

describe("schema object", () => {
  it("creates exactly one table, inside cst_app", () => {
    const creates = [...up.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([\w.]+)/gi)].map(
      ([, name]) => name,
    );
    expect(creates).toEqual([TABLE]);
  });

  it("carries the full source identity", () => {
    for (const column of ["source_database", "source_schema", "source_table", "source_pk"]) {
      expect(up).toMatch(new RegExp(`\\b${column}\\s+text\\s+NOT NULL`, "i"));
    }
  });

  it("makes that identity unique, so a repeated import cannot duplicate a row", () => {
    expect(up).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*?\(source_database, source_schema, source_table, source_pk\)/i,
    );
  });

  it("constrains the marketplace to the declared set", () => {
    const clause = up.slice(up.indexOf("ck_unresolved_messages_marketplace"));
    for (const marketplace of MARKETPLACES) {
      expect(clause.slice(0, 300)).toContain(`'${marketplace}'`);
    }
  });

  it("indexes the feed by marketplace, so a tab reads only its own data", () => {
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS[\s\S]*?\(marketplace, source_ts DESC/i);
  });
});

describe("timestamp preservation", () => {
  it("stores the source timestamp as naive and never as timestamptz", () => {
    expect(up).toMatch(/\bsource_ts\s+timestamp\b(?!tz)/i);
  });

  it("keeps the normalised pair honest and unpopulated", () => {
    expect(up).toMatch(/\bsource_ts_utc\s+timestamptz\b/i);
    expect(up).toMatch(/\bsource_ts_zone\s+text\b/i);
    expect(up).toMatch(/\(source_ts_utc IS NULL\) = \(source_ts_zone IS NULL\)/i);
  });

  it("names no timezone anywhere in the DDL", () => {
    expect(up).not.toMatch(/\bUTC\b|\bBST\b|Europe\/Berlin/);
  });
});

describe("blast radius", () => {
  it("is purely additive: it alters nothing that already exists", () => {
    expect(up).not.toMatch(/\bALTER\b/i);
    expect(up).not.toMatch(/\bTRUNCATE\b/i);
    expect(up).not.toMatch(/\bDROP\b/i);
  });

  it("touches no table created by the core schema migration", () => {
    for (const table of ["conversations", "conversation_messages", "context_", "audit_log"]) {
      expect(up).not.toContain(`cst_app.${table}`);
    }
  });

  it("never references another project's schema", () => {
    for (const schema of ["issue_tracking", "poc_listing", "public."]) {
      expect(up).not.toContain(schema);
      expect(down).not.toContain(schema);
    }
  });

  it("never references the read-only source database", () => {
    for (const source of ["ledsone", "customer_service"]) {
      expect(up).not.toContain(source);
      expect(down).not.toContain(source);
    }
  });

  it("rolls back only its own table, leaving the schema and core tables intact", () => {
    const drops = [...down.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w.]+)/gi)].map(
      ([, name]) => name,
    );
    expect(drops).toEqual([TABLE]);
    expect(down).not.toMatch(/DROP\s+SCHEMA/i);
    expect(down).not.toMatch(/CASCADE/i);
  });
});

describe("Phase 2 prohibition", () => {
  it("introduces no post-review state or transmission structure", () => {
    for (const forbidden of [
      "'approved'",
      "'sending'",
      "'sent'",
      "'manual_handoff'",
      "send_",
      "outbound_queue",
      "retry",
    ]) {
      expect(up.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("creates no function or trigger", () => {
    expect(up).not.toMatch(/CREATE\s+(OR REPLACE\s+)?FUNCTION/i);
    expect(up).not.toMatch(/CREATE\s+TRIGGER/i);
  });
});
