import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { WORKFLOW_STATES } from "@/lib/domain/workflow";
import { CONTEXT_RESOLUTIONS } from "@/lib/domain/order";

/**
 * Static review of the CST core schema migration. These tests read the SQL as
 * text — they never connect to a database, and the migration is never executed.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const UP = join(MIGRATIONS_DIR, "0001_cst_core_schema.up.sql");
const DOWN = join(MIGRATIONS_DIR, "0001_cst_core_schema.down.sql");

/**
 * Strips SQL comments so prose in a header block cannot satisfy or trip a check.
 * String literals are preserved deliberately — the CHECK vocabularies under test
 * (workflow states, resolutions, audit actions) live inside them.
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

const EXPECTED_TABLES = [
  "app_users",
  "conversations",
  "conversation_messages",
  "sync_state",
  "context_snapshots",
  "context_order_candidates",
  "context_items",
  "audit_log",
] as const;

let upRaw: string;
let downRaw: string;
let up: string;
let down: string;

beforeAll(() => {
  upRaw = readFileSync(UP, "utf8");
  downRaw = readFileSync(DOWN, "utf8");
  up = code(upRaw);
  down = code(downRaw);
});

describe("migration files", () => {
  it("has an up migration and a matching rollback", () => {
    expect(existsSync(UP)).toBe(true);
    expect(existsSync(DOWN)).toBe(true);
  });

  it("pairs every numbered up migration with a down migration", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const ups = files.filter((f) => f.endsWith(".up.sql"));
    expect(ups.length).toBeGreaterThan(0);
    for (const upFile of ups) {
      expect(files).toContain(upFile.replace(".up.sql", ".down.sql"));
    }
  });

  it("wraps each direction in a single transaction", () => {
    for (const sql of [up, down]) {
      expect(sql).toMatch(/\bBEGIN\s*;/i);
      expect(sql).toMatch(/\bCOMMIT\s*;/i);
    }
  });
});

describe("schema objects", () => {
  it("creates the cst_app schema idempotently", () => {
    expect(up).toMatch(/CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+cst_app/i);
  });

  it("creates every expected core table in cst_app", () => {
    for (const table of EXPECTED_TABLES) {
      expect(up).toMatch(
        new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+cst_app\\.${table}\\b`, "i"),
      );
    }
  });

  it("creates no table outside cst_app", () => {
    const creates = [...up.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi)];
    expect(creates.length).toBe(EXPECTED_TABLES.length);
    for (const [, name] of creates) {
      expect(name.startsWith("cst_app.")).toBe(true);
    }
  });

  it("qualifies every created index to cst_app", () => {
    const indexes = [...up.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+([\w.]+)/gi)];
    expect(indexes.length).toBeGreaterThan(0);
    for (const [, target] of indexes) {
      expect(target.startsWith("cst_app.")).toBe(true);
    }
  });

  it("declares foreign keys only between cst_app tables", () => {
    const fks = [...up.matchAll(/REFERENCES\s+([\w.]+)/gi)];
    expect(fks.length).toBeGreaterThan(0);
    for (const [, target] of fks) {
      expect(target.startsWith("cst_app.")).toBe(true);
    }
  });
});

describe("blast radius", () => {
  it("never alters, drops, or truncates another project's schema", () => {
    for (const schema of ["issue_tracking", "poc_listing", "public"]) {
      const ddl = new RegExp(
        `\\b(ALTER|DROP|TRUNCATE|GRANT|REVOKE)\\b[^;]*\\b${schema}\\b`,
        "i",
      );
      expect(up).not.toMatch(ddl);
      expect(down).not.toMatch(ddl);
    }
  });

  it("creates no cross-schema foreign key into issue_tracking", () => {
    expect(up).not.toMatch(/REFERENCES\s+issue_tracking\./i);
  });

  it("keeps the management user link as a plain nullable column", () => {
    expect(up).toMatch(/management_user_id\s+bigint\s*,/i);
  });

  it("uses no ALTER or TRUNCATE at all", () => {
    expect(up).not.toMatch(/\bALTER\b/i);
    expect(up).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("rolls back only cst_app objects, and drops the schema with RESTRICT", () => {
    const drops = [...down.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w.]+)/gi)];
    expect(drops.length).toBe(EXPECTED_TABLES.length);
    for (const [, name] of drops) {
      expect(name.startsWith("cst_app.")).toBe(true);
    }
    expect(down).toMatch(/DROP\s+SCHEMA\s+IF\s+EXISTS\s+cst_app\s+RESTRICT/i);
    expect(down).not.toMatch(/CASCADE/i);
  });
});

describe("idempotent source-message identity", () => {
  it("makes the full source identity unique so re-sync cannot duplicate a row", () => {
    expect(up).toMatch(
      /CREATE\s+UNIQUE\s+INDEX[^;]*ON\s+cst_app\.conversation_messages\s*\(\s*source_database\s*,\s*source_schema\s*,\s*source_table\s*,\s*source_pk\s*\)/i,
    );
  });

  it("does not rely on external_message_id for identity", () => {
    expect(up).toMatch(/external_message_id\s+text\s*,/i);
    expect(up).not.toMatch(/UNIQUE\s+INDEX[^;]*\(\s*external_message_id\s*\)/i);
  });

  it("gives each derived thread a rule-versioned unique key", () => {
    expect(up).toMatch(
      /CREATE\s+UNIQUE\s+INDEX[^;]*ON\s+cst_app\.conversations\s*\(\s*threading_rule_version\s*,\s*thread_key\s*\)/i,
    );
  });

  it("keeps one sync cursor per marketplace feed", () => {
    expect(up).toMatch(
      /CREATE\s+UNIQUE\s+INDEX[^;]*ON\s+cst_app\.sync_state\s*\(\s*marketplace\s*,\s*feed_key\s*\)/i,
    );
  });
});

describe("timestamp preservation", () => {
  it("stores source timestamps as naive timestamp, not timestamptz", () => {
    expect(up).toMatch(/source_ts\s+timestamp\s+NOT\s+NULL/i);
    expect(up).not.toMatch(/source_ts\s+timestamptz/i);
    expect(up).toMatch(/first_source_ts\s+timestamp\s+NOT\s+NULL/i);
    expect(up).toMatch(/last_source_ts\s+timestamp\s+NOT\s+NULL/i);
    expect(up).toMatch(/watermark_source_ts\s+timestamp\b/i);
  });

  it("keeps a nullable normalised column for later, paired with its zone", () => {
    expect(up).toMatch(/source_ts_utc\s+timestamptz\s*,/i);
    expect(up).toMatch(/source_ts_zone\s+text\s*,/i);
    expect(up).toMatch(/\(\s*source_ts_utc\s+IS\s+NULL\s*\)\s*=\s*\(\s*source_ts_zone\s+IS\s+NULL\s*\)/i);
  });

  it("performs no timezone conversion in the migration", () => {
    expect(up).not.toMatch(/AT\s+TIME\s+ZONE/i);
    expect(up).not.toMatch(/::\s*timestamptz/i);
  });

  it("uses timestamptz for application-generated timestamps", () => {
    expect(up).toMatch(/created_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i);
  });
});

describe("workflow states", () => {
  it("constrains conversations to exactly the four Phase 1 states", () => {
    const clause = constraintClause(up, "ck_conversations_workflow_state");
    expect(clause).not.toBe("");
    for (const state of WORKFLOW_STATES) {
      expect(clause).toContain(`'${state}'`);
    }
    for (const forbidden of ["approved", "sending", "sent", "manual_handoff"]) {
      expect(clause).not.toContain(`'${forbidden}'`);
    }
  });

  it("declares no post-review state anywhere in the migration", () => {
    // Word-bounded: `sent` must not match inside identifiers such as `_present`.
    for (const forbidden of ["approved", "sending", "sent", "manual_handoff"]) {
      const asWord = new RegExp(`\\b${forbidden}\\b`, "i");
      expect(up).not.toMatch(asWord);
      expect(down).not.toMatch(asWord);
    }
  });

  it("restricts audited workflow states to the same four", () => {
    expect(up).toMatch(/ck_audit_log_workflow_states/i);
  });
});

describe("Phase 2 prohibition", () => {
  const FORBIDDEN = [
    "send_queue",
    "send_attempt",
    "send_retry",
    "outbound_message",
    "outbound_connector",
    "marketplace_credential",
    "copy_reply",
    "open_marketplace",
    "transmit",
  ];

  it("creates no send or outbound structure", () => {
    for (const term of FORBIDDEN) {
      expect(upRaw.toLowerCase()).not.toContain(term);
      expect(downRaw.toLowerCase()).not.toContain(term);
    }
  });

  it("creates no functions or triggers of any kind", () => {
    expect(up).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(up).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(up).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE/i);
  });

  it("audits no sending action", () => {
    const clause = constraintClause(up, "ck_audit_log_action");
    expect(clause).not.toBe("");
    expect(clause.toLowerCase()).not.toMatch(/send|dispatch|transmit|outbound/);
  });
});

describe("exact SKU preservation", () => {
  it("stores the SKU as plain text with no transformation", () => {
    expect(up).toMatch(/exact_sku\s+text\s+NOT\s+NULL/i);
  });

  it("applies no normalising function to the SKU column", () => {
    const skuStatements = up.match(/exact_sku[^,\n]*/gi) ?? [];
    expect(skuStatements.length).toBeGreaterThan(0);
    for (const statement of skuStatements) {
      expect(statement).not.toMatch(/\b(btrim|trim|ltrim|rtrim|upper|lower|replace|split_part|regexp_replace|normalize)\s*\(/i);
    }
  });

  it("checks only that the SKU is non-empty, never that it is trimmed", () => {
    expect(up).toMatch(/CHECK\s*\(\s*length\(exact_sku\)\s*>\s*0\s*\)/i);
    expect(up).not.toMatch(/exact_sku\s*=\s*btrim\s*\(/i);
  });

  it("has no generated or default column deriving from the SKU", () => {
    expect(up).not.toMatch(/exact_sku[^,]*GENERATED\s+ALWAYS\s+AS\s*\(/i);
  });
});

describe("logical order modelling", () => {
  it("keys resolved context on (sub_source_id, order_number), not a physical row id", () => {
    expect(up).toMatch(/order_number\s+text\s*,/i);
    expect(up).toMatch(/ix_context_snapshots_logical_order[\s\S]*?\(\s*sub_source_id\s*,\s*order_number\s*\)/i);
  });

  it("keeps physical order row ids as a traceability array only", () => {
    expect(up).toMatch(/source_order_row_ids\s+bigint\[\]\s+NOT\s+NULL\s+DEFAULT/i);
  });

  it("supports every context resolution the domain defines", () => {
    const clause = constraintClause(up, "ck_context_snapshots_resolution");
    expect(clause).not.toBe("");
    for (const resolution of CONTEXT_RESOLUTIONS) {
      expect(clause).toContain(`'${resolution}'`);
    }
  });

  it("forbids an unresolved context from carrying an order", () => {
    expect(up).toMatch(/ck_context_snapshots_unresolved_has_no_order/i);
  });

  it("gives candidates no selected flag, so none can be auto-chosen", () => {
    const candidates = up.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+cst_app\.context_order_candidates[\s\S]*?\n\);/i);
    expect(candidates).not.toBeNull();
    expect(candidates![0]).not.toMatch(/\bis_selected\b|\bselected\b|\bis_default\b|\bpreferred\b/i);
  });

  it("requires a named user whenever context was user-confirmed", () => {
    expect(up).toMatch(/ck_context_snapshots_confirmation_pair/i);
  });

  it("does not force an order onto a conversation", () => {
    const conversations = up.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+cst_app\.conversations[\s\S]*?\n\);/i);
    expect(conversations).not.toBeNull();
    expect(conversations![0]).not.toMatch(/order_number\s+text\s+NOT\s+NULL/i);
    expect(conversations![0]).toMatch(/listing_item_ref\s+text\s*,/i);
  });
});

describe("marketplace neutrality", () => {
  it("embeds no eBay table, column, or encoding in the schema", () => {
    for (const term of ["folder_id", "ebay_message_headers", "ebay_messages", "receive_date", "ext_message_id", "customer_service"]) {
      expect(up.toLowerCase()).not.toContain(term);
    }
  });

  it("models marketplace as a constrained column rather than assuming eBay", () => {
    expect(up).toMatch(/marketplace\s+text\s+NOT\s+NULL/i);
    expect(up).toMatch(/ck_conversations_marketplace[\s\S]*?ebay[\s\S]*?amazon/i);
  });
});
