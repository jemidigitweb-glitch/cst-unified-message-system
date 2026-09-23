import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Static review of 0019 response_sla_policy.
 *
 * Reads the SQL as text and NEVER connects to a database, the approach
 * `cst-core-schema.test.ts` established. 0019 has NOT been executed anywhere,
 * and there is deliberately no test here that would require it to have been.
 *
 * It lives in its own file rather than joining `mysql-source-schema.test.ts`
 * because that suite asserts `STATUS: APPLIED 2026-09-23` on every migration it
 * covers. 0019 is awaiting review, so adding it there would either fail or
 * force that assertion to be loosened for all four.
 *
 * WHAT THIS SUITE IS GUARDING. 0019 copies a policy out of a MySQL database
 * owned by another project, and the risks that matter are specific:
 *
 *   * that the 1,039 per-case escalation rows, which carry customer message ids
 *     and quoted customer wording, acquire somewhere to land;
 *   * that the import stops being idempotent because Amazon's NULL account slips
 *     past a unique index;
 *   * that storing a target quietly becomes applying one, changing a number on
 *     a dashboard while a business decision is still open;
 *   * that an uncovered seller account acquires a default it was never given.
 *
 * Each has a test below.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const NUMBER = "0019";
const SLUG = "response_sla_policy";
const TABLE = "cst_app.response_sla_policy";

/**
 * Strips SQL comments so prose in the header cannot satisfy or trip a check.
 * That header discusses `key_value`, `reason`, urgent rows and DROP at length;
 * without this, every assertion below would fail on the explanation of why the
 * thing is not being done.
 */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Executable statements only. `COMMENT ON ... IS '...'` is documentation that
 * happens to live in a string literal, and this migration uses it to say what
 * it deliberately does NOT do ("holds no customer message content"). Read as
 * code, a comment saying a thing is absent reads as the thing being present.
 */
function statements(sql: string): string {
  return code(sql).replace(/COMMENT\s+ON\s+[\s\S]*?;/gi, " ");
}

let upRaw = "";
let up = "";
let down = "";

beforeAll(() => {
  upRaw = readFileSync(join(MIGRATIONS_DIR, `${NUMBER}_${SLUG}.up.sql`), "utf8");
  up = code(upRaw);
  down = code(readFileSync(join(MIGRATIONS_DIR, `${NUMBER}_${SLUG}.down.sql`), "utf8"));
});

describe("the migration pair", () => {
  it("has an up migration and a matching rollback", () => {
    expect(existsSync(join(MIGRATIONS_DIR, `${NUMBER}_${SLUG}.up.sql`))).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, `${NUMBER}_${SLUG}.down.sql`))).toBe(true);
  });

  /** Re-asserted over the whole directory: two branches once both shipped a 0012. */
  it("no two migrations in the repository share a number", () => {
    const numbers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".up.sql"))
      .map((f) => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("is wrapped in a single transaction", () => {
    for (const sql of [up, down]) {
      expect(sql).toMatch(/\bBEGIN\b/);
      expect(sql).toMatch(/\bCOMMIT\b/);
    }
  });

  it("is re-runnable", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(up).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(up).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });
});

describe("additive only — existing data is preserved", () => {
  it("alters no existing table", () => {
    expect(up).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("drops nothing", () => {
    expect(up).not.toMatch(/\bDROP\b/i);
  });

  /**
   * The table is deployed EMPTY. The importer is a separate script, dry-run by
   * default, so applying the migration cannot import a policy as a side effect.
   */
  it("writes no rows", () => {
    const executable = statements(upRaw);
    for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      expect(executable).not.toMatch(new RegExp(`\\b${verb}\\b`, "i"));
    }
  });

  /**
   * The conversation tables are matched logically at read time, with no foreign
   * key, so that neither this migration nor its rollback can reach a message.
   */
  it("does not touch conversations or conversation_messages", () => {
    const executable = statements(upRaw);
    expect(executable).not.toMatch(/ALTER\s+TABLE\s+cst_app\.conversation/i);
    expect(executable).not.toMatch(/REFERENCES\s+cst_app\.conversation/i);
  });
});

describe("cst_app is the only target", () => {
  it("creates its table inside cst_app", () => {
    expect(up).toContain(`CREATE TABLE IF NOT EXISTS ${TABLE}`);
  });

  it("names no other project's schema", () => {
    for (const sql of [up, down]) {
      expect(sql).not.toMatch(/\bissue_tracking\./i);
      expect(sql).not.toMatch(/\bpoc_listing\./i);
      expect(sql).not.toMatch(/\bpublic\./i);
    }
  });

  /**
   * MySQL is strictly a read-only source. The connection details exist for a
   * reader, and a migration is not one. `message_app` and `sla_configs` appear
   * only as DEFAULT string literals recording where a row came from, which is
   * provenance rather than a reference — hence the check is on qualified names.
   */
  it("creates nothing in a source database", () => {
    for (const sql of [statements(upRaw), down]) {
      expect(sql).not.toMatch(/\bmessage_app\.\w/i);
      expect(sql).not.toMatch(/\border_management\./i);
      expect(sql).not.toMatch(/\bledsone\./i);
      expect(sql).not.toMatch(/\bcustomer_service\./i);
    }
  });
});

describe("no customer data and no credential is copied", () => {
  /**
   * THE CENTRAL RISK OF THIS MIGRATION. `sla_configs` holds 1,039 per-case
   * escalation rows whose `key_value` is a customer's marketplace message id
   * and whose `reason` quotes phrases from their conversation. If no column can
   * hold either, no importer bug can store them.
   */
  it("has no column that could hold a message id or quoted customer wording", () => {
    const executable = statements(upRaw).toLowerCase();
    expect(executable).not.toContain("key_value");
    expect(executable).not.toContain("reason");
    expect(executable).not.toContain("situation");
    expect(executable).not.toContain("body_text");
    expect(executable).not.toContain("message_content");
    expect(executable).not.toContain("external_message_id");
  });

  /** `mails` holds env_pw, smtp_* and a mailbox address. None may land here. */
  it("copies no credential, address or transport field", () => {
    const executable = statements(upRaw).toLowerCase();
    for (const word of [
      "password", "passwd", "pwd", "hash", "salt", "token", "secret", "credential",
      "email", "contact", "phone", "smtp", "env_pw",
    ]) {
      expect(executable).not.toContain(word);
    }
  });

  it("adds no transport structure", () => {
    const lower = up.toLowerCase();
    for (const word of ["smtp", "outbound_queue", "recipient", "scheduled_send", "transport"]) {
      expect(lower).not.toContain(word);
    }
  });
});

describe("it stores a target and never applies one", () => {
  /**
   * The migration must not acquire a column that turns a stored target into a
   * computed outcome. Which target governs is an open business decision
   * (handover A1) worth up to 30 percentage points, and a schema must not
   * settle it by arriving.
   */
  it("has no column that evaluates compliance", () => {
    const executable = statements(upRaw).toLowerCase();
    for (const word of ["met", "breach", "compliance", "percentage", "elapsed", "due_at", "measured"]) {
      expect(executable).not.toContain(word);
    }
  });

  /** CST's own rule is application code and must not be duplicated into a table. */
  it("does not restate CST's own SLA rule", () => {
    expect(statements(upRaw)).not.toMatch(/response_sla_minutes/i);
    expect(statements(upRaw)).not.toMatch(/before_shipment/i);
  });

  /**
   * An uncovered seller account — five on Shopify, all of B&Q, all of Temu —
   * must resolve to NO policy, not to a borrowed one. A DEFAULT on target_hours
   * would manufacture a promise nobody made.
   */
  it("gives target_hours no default", () => {
    expect(up).toMatch(/target_hours\s+integer\s+NOT NULL\s*,/);
    expect(up).not.toMatch(/target_hours[^,]*DEFAULT/i);
  });
});

describe("constraints", () => {
  it("uses the same marketplace vocabulary as agent_activity and sync_state", () => {
    const at = up.indexOf("ck_response_sla_policy_marketplace");
    const clause = up.slice(at, at + 300);
    for (const mk of ["ebay", "amazon", "shopify", "bandq", "temu"]) {
      expect(clause).toContain(`'${mk}'`);
    }
  });

  /** Source vocabulary, verbatim. 'weekday' would need translating everywhere. */
  it("constrains week_scope to the source's own two words", () => {
    const at = up.indexOf("ck_response_sla_policy_week_scope");
    const clause = up.slice(at, at + 200);
    expect(clause).toContain("'week'");
    expect(clause).toContain("'weekend'");
    expect(clause).not.toContain("'weekday'");
  });

  it("refuses a non-positive target", () => {
    expect(up).toMatch(/ck_response_sla_policy_target_positive[\s\S]{0,140}target_hours > 0/);
  });

  /**
   * -1 is the sentinel the unique index coalesces NULL to. A real account id of
   * -1 would collide with the channel-wide row, so negatives are refused.
   */
  it("refuses an account id that could collide with the channel-wide sentinel", () => {
    expect(up).toMatch(
      /ck_response_sla_policy_sub_source_positive[\s\S]{0,180}sub_source_id IS NULL OR sub_source_id > 0/,
    );
  });

  it("keeps sub_source_id nullable, because a channel-wide target is real", () => {
    expect(up).toMatch(/sub_source_id\s+integer\s*,/);
    expect(up).not.toMatch(/sub_source_id\s+integer\s+NOT NULL/);
  });
});

describe("identity and idempotency", () => {
  /**
   * THE `coalesce` IS WHAT MAKES THE IMPORT IDEMPOTENT. PostgreSQL treats NULLs
   * as distinct in a unique index, so a plain column list would admit two
   * ('amazon', NULL, 'week') rows and every re-run would append another pair.
   */
  it("keys the policy on scope, coalescing the nullable account", () => {
    expect(up).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_response_sla_policy_scope");
    const at = up.indexOf("uq_response_sla_policy_scope");
    expect(up.slice(at, at + 220)).toMatch(
      /\(\s*marketplace\s*,\s*coalesce\(\s*sub_source_id\s*,\s*-1\s*\)\s*,\s*week_scope\s*\)/,
    );
  });

  /**
   * A DELIBERATE DEPARTURE from 0016/0017/0018, and the data is why. Three
   * Shopify mailboxes resolve to one seller account, so the mapping from source
   * row to policy row is MANY-TO-ONE. A unique index on source_pk would assert
   * a one-to-one relationship the source does not have.
   */
  it("indexes source provenance without claiming it is unique", () => {
    expect(up).toContain("CREATE INDEX IF NOT EXISTS ix_response_sla_policy_source");
    expect(up).not.toMatch(/CREATE UNIQUE INDEX[^;]*source_pk/i);
  });

  it("records which source database and table a row came from", () => {
    expect(up).toMatch(/source_database\s+text\s+NOT NULL/);
    expect(up).toMatch(/source_table\s+text\s+NOT NULL/);
    expect(up).toMatch(/source_pk\s+text\s+NOT NULL/);
  });

  /** Without it, a reader cannot tell a single-source target from a 3-way agreement. */
  it("records how many source rows collapsed into a policy row", () => {
    expect(up).toMatch(/source_rows\s+integer\s+NOT NULL DEFAULT 1/);
    expect(up).toMatch(/ck_response_sla_policy_source_rows_positive[\s\S]{0,140}source_rows > 0/);
  });

  /** The mailbox a Shopify or Amazon account was resolved through, for local re-check. */
  it("keeps the mailbox the account was resolved through", () => {
    expect(up).toMatch(/source_mail_id\s+integer\s*,/);
  });
});

describe("rollback safety", () => {
  it("rolls back with RESTRICT, never CASCADE", () => {
    expect(down).toContain(`DROP TABLE IF EXISTS ${TABLE} RESTRICT`);
    expect(down).not.toMatch(/CASCADE/i);
  });

  it("drops exactly one table and nothing else", () => {
    expect(down.match(/DROP TABLE/gi)?.length).toBe(1);
    expect(down).not.toMatch(/DROP INDEX/i);
    expect(down).not.toMatch(/DROP SCHEMA/i);
    expect(down).not.toMatch(/DROP COLUMN/i);
    expect(down).not.toMatch(/\bALTER\b/i);
  });

  it("deletes no row from another table", () => {
    for (const verb of ["DELETE", "TRUNCATE", "UPDATE"]) {
      expect(down).not.toMatch(new RegExp(`\\b${verb}\\b`, "i"));
    }
  });

  /** Rolling back the policy copy must not reach a conversation or a message. */
  it("leaves the conversation tables intact", () => {
    expect(down).not.toMatch(/DROP TABLE IF EXISTS cst_app\.conversation/i);
    expect(down).not.toMatch(/DROP TABLE IF EXISTS cst_app\.agent_/i);
  });
});

describe("applied status is declared", () => {
  /**
   * This repository has no migrations ledger — the README says so plainly — so
   * the header IS the history, and a reader of the SQL alone must be able to
   * tell whether it has run. 0007's header still read NOT EXECUTED while its
   * column was live, which is the confusion this prevents recurring.
   *
   * 0019 has NOT been applied. When it is, this assertion is the thing that
   * must be updated, deliberately, in the same change.
   */
  it("records that it has not been executed", () => {
    expect(upRaw).toMatch(/STATUS:\s+WRITTEN, NOT EXECUTED — awaiting review/);
    expect(upRaw).not.toMatch(/STATUS:\s+APPLIED/);
  });

  it("records that no row was imported by the migration itself", () => {
    expect(upRaw).toMatch(/table is created EMPTY/i);
  });

  /**
   * The migration must not read as though it settles which target governs. The
   * header carries that disclaimer, and losing it would leave a future reader
   * assuming the 16/24 policy is the one CST measures against.
   */
  it("records that storing a target is not choosing one", () => {
    expect(upRaw).toMatch(/does NOT decide that this is the target CST measures against/);
    expect(upRaw).toMatch(/commits to nothing about which policy GOVERNS/);
  });

  /** The departure from the source-identity convention must stay explained. */
  it("explains why source identity is not unique here", () => {
    expect(upRaw).toMatch(/MANY-TO-\s*--?\s*ONE|MANY-TO-ONE/);
    expect(upRaw).toMatch(/PROVENANCE, not identity/);
  });
});
