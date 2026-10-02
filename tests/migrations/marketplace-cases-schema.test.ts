import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Static review of 0022 marketplace_cases and case_import_runs.
 *
 * Reads the SQL as text and NEVER connects to a database — the approach
 * `cst-core-schema.test.ts` established and the reason this suite runs
 * anywhere. 0022 has NOT been executed, and there is deliberately no test here
 * that would require it to have been.
 *
 * WHAT THIS SUITE IS GUARDING. 0022 is storage for a case snapshot imported out
 * of MySQL `message_app`, whose nine case stores carry a customer's case
 * correspondence, their postal location, their email address and their
 * free-text dispute notes alongside the structured facts that are wanted. The
 * risks that matter are not "does the SQL parse" — they are:
 *
 *   * a free-text, postal or contact column copied across because it was
 *     adjacent to a wanted one
 *   * the per-event logs stored one row per event, so one customer's single
 *     claim reports as four
 *   * `lifecycle` and `source_status` collapsed into one column, which would
 *     force a choice between two source values that measurably disagree
 *   * a warehouse disposition landing anywhere a screen could render it as the
 *     customer's case status
 *   * a dry run writing a row, so a rehearsal changes the database
 *   * a PARTIALLY FAILED import becoming readable as a complete snapshot
 *   * freshness answered from the newest timestamp rather than from a published
 *     run and the stores it actually covered
 *   * 0021's table, or the Repeat-Customer Warning behind it, altered in passing
 *   * a biconditional CHECK that is exactly right on paper and breaks on real
 *     data, as 0011's did
 *   * this migration quietly becoming a scheduled sync
 *
 * Each has a test below.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

const NUMBER = "0022";
const SLUG = "marketplace_cases";
const CASES = "cst_app.marketplace_cases";
const RUNS = "cst_app.case_import_runs";

/**
 * Strips SQL comments so prose in the header cannot satisfy or trip a check.
 * 0022's header discusses `buyer_note`, `return_address`, a customer's email,
 * CASCADE, ALTER and DROP at length, explaining why none of them is here; read
 * as code, every one of those explanations would fail the test it exists to
 * justify. String literals are preserved — the vocabulary under test lives
 * inside them.
 *
 * Same helper, same reasoning, as `customer-case-history-schema.test.ts`.
 */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Executable statements only, with two further removals — both real false
 * positives on the earlier MySQL-source migrations.
 *
 * `COMMENT ON ... IS '...'` is documentation inside a string literal, and this
 * migration uses it to say what it deliberately does NOT hold ("no contact
 * detail", "no case correspondence"). Read as code, a comment saying a thing is
 * absent reads as the thing being present.
 *
 * `ON DELETE RESTRICT` and friends are referential actions, not DML.
 */
function statements(sql: string): string {
  return code(sql)
    .replace(/COMMENT\s+ON\s+[\s\S]*?;/gi, " ")
    .replace(/ON\s+(DELETE|UPDATE)\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+(NULL|DEFAULT))/gi, " ");
}

function pathFor(dir: "up" | "down"): string {
  return join(MIGRATIONS_DIR, `${NUMBER}_${SLUG}.${dir}.sql`);
}

/**
 * Whether a forbidden word appears as a WORD, with `_` treated as a separator.
 *
 * A plain substring search is wrong here, and the first run of this suite
 * proved it: `sent` matched inside `ck_marketplace_cases_order_ref_present`,
 * failing the no-transport test on a constraint name about blankness. That is
 * the same false positive `order-source.ts` guards against when it refuses to
 * read a table called `order_update` as an UPDATE privilege.
 *
 * `\b` alone would not do: `_` is a word character in JavaScript regex, so
 * `\bsent\b` would miss a column genuinely named `message_sent` — which is
 * precisely the thing being looked for. This treats any non-alphanumeric as a
 * boundary, so `present` is ignored and `message_sent` is caught.
 */
function mentions(haystack: string, term: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${term}(?:[^a-z0-9]|$)`, "i").test(haystack);
}

/** The slice of the up migration that defines one table, body only. */
function tableBody(sql: string, qualified: string): string {
  const at = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${qualified}`);
  expect(at, `${qualified} is not created`).toBeGreaterThan(-1);
  const end = sql.indexOf("\n);", at);
  expect(end, `${qualified} has no closing paren`).toBeGreaterThan(at);
  return sql.slice(at, end);
}

let upRaw = "";
let up = "";
let downRaw = "";
let down = "";
let casesBody = "";
let runsBody = "";

beforeAll(() => {
  upRaw = readFileSync(pathFor("up"), "utf8");
  up = code(upRaw);
  downRaw = readFileSync(pathFor("down"), "utf8");
  down = code(downRaw);
  casesBody = tableBody(up, CASES);
  runsBody = tableBody(up, RUNS);
});

// ===========================================================================
describe("the migration pair", () => {
  it("has an up migration and a matching rollback", () => {
    expect(existsSync(pathFor("up"))).toBe(true);
    expect(existsSync(pathFor("down"))).toBe(true);
  });

  /**
   * NUMBERING. `follow-up-reminders.test.ts` added this check after two
   * branches both shipped a `0012`. Re-asserted over the whole directory here
   * because 0022 arrives on a feature branch while other work is in flight.
   */
  it("no two migrations in the repository share a number", () => {
    const numbers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".up.sql"))
      .map((f) => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("is wrapped in a single transaction, both directions", () => {
    for (const sql of [up, down]) {
      expect(sql).toMatch(/\bBEGIN\b/);
      expect(sql).toMatch(/\bCOMMIT\b/);
    }
  });

  it("is re-runnable", () => {
    expect(up.match(/CREATE TABLE IF NOT EXISTS/g)?.length).toBe(2);
    expect(up.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g)?.length).toBe(6);
    expect(up.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g)?.length).toBe(2);
    expect(down.match(/DROP TABLE IF EXISTS/g)?.length).toBe(2);
  });
});

// ===========================================================================
describe("both required tables are defined", () => {
  it("creates the case snapshot and the run ledger, in cst_app", () => {
    expect(up).toContain(`CREATE TABLE IF NOT EXISTS ${CASES}`);
    expect(up).toContain(`CREATE TABLE IF NOT EXISTS ${RUNS}`);
  });

  /**
   * The ledger is created FIRST because the case table's foreign key points at
   * it. In one transaction PostgreSQL would reject the other order outright, so
   * this is really a readability guarantee — but it is also what the rollback
   * order mirrors, and the two must not drift apart.
   */
  it("creates the ledger before the table that references it", () => {
    expect(up.indexOf(`CREATE TABLE IF NOT EXISTS ${RUNS}`)).toBeLessThan(
      up.indexOf(`CREATE TABLE IF NOT EXISTS ${CASES}`),
    );
  });

  it("links a case to the run that confirmed it, and never loses that link", () => {
    expect(casesBody).toMatch(/import_run_id\s+bigint\s+NOT NULL/);
    expect(casesBody).toMatch(
      /REFERENCES\s+cst_app\.case_import_runs\s*\(\s*id\s*\)\s+ON DELETE RESTRICT/,
    );
  });

  /**
   * The ONLY foreign key, and it stays inside cst_app. A cross-schema one would
   * couple this schema to another project's lifecycle, and a link to
   * `conversations` would defeat the feature for 0021's reason — a case is most
   * useful before the next conversation exists.
   */
  it("holds exactly one foreign key, inside cst_app and not to conversations", () => {
    expect(statements(upRaw).match(/REFERENCES/g)?.length).toBe(1);
    expect(up).not.toMatch(/REFERENCES\s+cst_app\.conversations/i);
    expect(up).not.toMatch(/REFERENCES\s+cst_app\.customer_case_history/i);
  });
});

// ===========================================================================
describe("exact source identifiers are preserved", () => {
  /**
   * 20-digit integers at source, past what a JavaScript number holds exactly.
   * A rounded identifier is a case nobody can find again — the convention
   * `documentation/ai-coding-context.md` states for every id in this schema.
   */
  it("stores every source identifier as text, never as a number", () => {
    for (const column of [
      "source_case_id",
      "order_ref",
      "order_line_item_ref",
      "order_txn_ref",
      "counterparty_ref",
    ]) {
      expect(casesBody, `${column} must be text`).toMatch(
        new RegExp(`${column}\\s+text`),
      );
      expect(casesBody, `${column} must not be numeric`).not.toMatch(
        new RegExp(`${column}\\s+(bigint|integer|numeric|double)`, "i"),
      );
    }
  });

  it("requires a case id that is present and not blank", () => {
    expect(casesBody).toMatch(/source_case_id\s+text\s+NOT NULL/);
    expect(up).toMatch(
      /ck_marketplace_cases_source_case_id_present[\s\S]{0,140}length\(btrim\(source_case_id\)\) > 0/,
    );
  });

  /**
   * An empty string would read as a value that was recorded and happens to be
   * empty, which is a different claim from none being recorded. 0021 applied
   * this to `event_status`; here it covers every preserved source vocabulary
   * and every identifier.
   */
  it("admits no blank identifier or blank source value", () => {
    expect(up).toMatch(/ck_marketplace_cases_order_ref_present/);
    expect(up).toMatch(/ck_marketplace_cases_counterparty_present/);
    expect(up).toMatch(
      /ck_marketplace_cases_source_values_present[\s\S]{0,700}source_reason_family/,
    );
  });

  it("records which source database and store a row came from", () => {
    expect(casesBody).toMatch(/source_database\s+text\s+NOT NULL/);
    expect(casesBody).toMatch(/source_table\s+text\s+NOT NULL/);
    expect(up).toMatch(
      /ck_marketplace_cases_source_database[\s\S]{0,140}source_database = 'message_app'/,
    );
  });

  /** The nine reviewed stores, named. A tenth must fail the import. */
  it("constrains the source store to the nine reviewed ones", () => {
    const at = up.indexOf("ck_marketplace_cases_source_table");
    const clause = up.slice(at, at + 420);
    for (const store of [
      "ebay_returns",
      "amazon_returns",
      "cancellation",
      "amz_cancellations",
      "shopify_returns",
      "shopify_cancellations",
      "inquiries",
      "cases",
      "payment_disputes",
    ]) {
      expect(clause, `${store} is not in the store vocabulary`).toContain(`'${store}'`);
    }
  });
});

// ===========================================================================
describe("case identity uniqueness is enforced", () => {
  /**
   * THE KEY IS THE CASE, NOT THE SOURCE ROW, AND THAT IS THE WHOLE DEFENCE
   * AGAINST DOUBLE COUNTING.
   *
   * Measured: the eBay return store holds 42,931 event rows for 4,082 cases and
   * the eBay cancellation store 4,623 for 1,263. Keyed on the row id — the
   * shape 0016 and 0017 use, because their sources are genuinely one row per
   * thing — this table would report a customer who filed one claim as having
   * filed four.
   *
   * `source_table` is inside the key because the identifier spaces overlap: the
   * formal-case and dispute stores use separate marketplace spaces, and 69
   * identifiers appear in both inquiry logs for the same real case.
   */
  it("is keyed on (source_database, source_table, source_case_id)", () => {
    expect(up).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_cases_source_identity",
    );
    const at = up.indexOf("uq_marketplace_cases_source_identity");
    expect(up.slice(at, at + 260)).toMatch(
      /\(\s*source_database\s*,\s*source_table\s*,\s*source_case_id\s*\)/,
    );
  });

  it("is not keyed on a per-event source row id", () => {
    expect(up).not.toMatch(/source_pk/);
    expect(up).not.toMatch(/res_his_order/);
    expect(up).not.toMatch(/\brevision\s+(integer|bigint)/i);
  });

  /**
   * The count of folded events, kept so a report can separate "how many cases"
   * from "how many recorded events". Without it the collapse is lossy in the
   * one way a duplicate-risk review cares about.
   */
  it("keeps the number of source events it collapsed", () => {
    expect(casesBody).toMatch(/source_row_count\s+integer\s+NOT NULL/);
    expect(up).toMatch(
      /ck_marketplace_cases_source_row_count_positive[\s\S]{0,140}source_row_count >= 1/,
    );
  });

  /**
   * A plain column list is the upsert's conflict target, and that is correct
   * ONLY because all three key columns are NOT NULL. `sla-policy-writer.ts`
   * needs a coalesce in its target because one of its key columns is nullable
   * and PostgreSQL treats NULLs as distinct, which lets the same row insert
   * twice forever.
   */
  it("keeps every key column NOT NULL, so the conflict target needs no coalesce", () => {
    for (const column of ["source_database", "source_table", "source_case_id"]) {
      expect(casesBody).toMatch(new RegExp(`${column}\\s+text\\s+NOT NULL`));
    }
  });
});

// ===========================================================================
describe("source status and lifecycle remain separate", () => {
  /**
   * They are not two names for one fact, and the source proves it: all 150
   * eBay returns whose status is ESCALATED carry current_state CLOSED, and 6
   * carry status READY_FOR_SHIPPING against current_state ITEM_DELIVERED.
   * Collapsing them would force a choice between two values the source never
   * reconciled.
   */
  it("stores CST's own lifecycle and the source's own status as different columns", () => {
    expect(casesBody).toMatch(/lifecycle\s+text\s+NOT NULL/);
    expect(casesBody).toMatch(/source_status\s+text\s*,/);
    expect(casesBody).toMatch(/source_state\s+text\s*,/);
  });

  /** Three values, never a boolean: `unknown` is a measured answer. */
  it("gives lifecycle three states rather than a boolean", () => {
    expect(up).toMatch(
      /ck_marketplace_cases_lifecycle[\s\S]{0,180}'active'[\s\S]{0,40}'closed'[\s\S]{0,40}'unknown'/,
    );
    expect(casesBody).not.toMatch(/\bis_closed\b|\bis_active\b|\bclosed\s+boolean/i);
  });

  /**
   * The source vocabularies belong to eBay, Amazon and Shopify and change
   * without telling us. A CHECK on them would turn a new marketplace status
   * into a failed import — the trade 0021 made on `event_status` for the same
   * reason.
   */
  it("leaves every preserved source vocabulary unconstrained", () => {
    for (const column of [
      "source_status",
      "source_state",
      "source_disposition",
      "source_resolution",
      "source_reason",
      "source_reason_family",
    ]) {
      expect(up, `${column} must not be CHECK-constrained to a list`).not.toMatch(
        new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(`, "i"),
      );
    }
  });

  /**
   * A WAREHOUSE DISPOSITION IS NOT A CASE STATUS. The Amazon return store puts
   * both vocabularies in one column, split by fulfilment channel: 13,343
   * merchant-fulfilled rows carry a case status, and 2,577 Amazon-fulfilled rows
   * carry a stockroom outcome (sellable, customer-damaged, reimbursed...).
   * Reading the second into `source_status` would show a reviewer a stockroom
   * outcome labelled as the customer's case status.
   */
  it("keeps the warehouse disposition in its own column, and only for Amazon", () => {
    expect(casesBody).toMatch(/source_disposition\s+text\s*,/);
    expect(up).toMatch(
      /ck_marketplace_cases_disposition_source[\s\S]{0,200}source_disposition IS NULL OR source_table = 'amazon_returns'/,
    );
  });
});

// ===========================================================================
describe("constraints", () => {
  it("uses the same marketplace vocabulary as sync_state and agent_activity", () => {
    const at = up.indexOf("ck_marketplace_cases_marketplace");
    const clause = up.slice(at, at + 220);
    for (const marketplace of ["ebay", "amazon", "shopify", "bandq", "temu"]) {
      expect(clause).toContain(`'${marketplace}'`);
    }
    expect(casesBody).toMatch(/marketplace\s+text\s+NOT NULL/);
    expect(casesBody).toMatch(/sub_source_id\s+integer\s+NOT NULL/);
  });

  /**
   * FIVE case types, and the fifth is the interesting one. The Shopify store
   * records a REFUND and not a return case: seven columns holding a date, an
   * order, an amount and a currency, with no status, no reason and no
   * lifecycle. Calling those 2,019 rows RETURN would assert a case the source
   * does not record.
   */
  it("constrains case_type to the five measured values", () => {
    const at = up.indexOf("ck_marketplace_cases_case_type");
    const clause = up.slice(at, at + 300);
    for (const type of [
      "RETURN",
      "CANCELLATION",
      "ITEM_NOT_RECEIVED",
      "PAYMENT_DISPUTE",
      "REFUND",
    ]) {
      expect(clause).toContain(`'${type}'`);
    }
  });

  /**
   * DAMAGE IS A FLAG, NOT A CASE TYPE. A full census of all fourteen
   * case-related source tables found no damage table, no damage status and no
   * damage case identifier: damage is the REASON on a return, one value on eBay
   * and four on Amazon. A DAMAGE type would need an identity the source does
   * not issue.
   */
  it("records damage as a flag beside its reason, never as a case type", () => {
    expect(casesBody).toMatch(/damage_reported\s+boolean\s+NOT NULL/);
    expect(up).not.toMatch(/'DAMAGE'/);
    expect(up).not.toMatch(/'DAMAGE_CLAIM'/);
    expect(casesBody).toMatch(/source_reason\s+text\s*,/);
  });

  /**
   * REPLACEMENT IS CONFIRMABLE ON ONE STORE, and the near-miss is why this
   * CHECK exists. The source holds a 36-value return-action vocabulary
   * including "seller marked replacement shipped", attached to 51 returns —
   * but that table is an AVAILABLE-ACTIONS snapshot, not history: the action
   * "external claim opened" is attached to 4,076 of 4,082 returns there and
   * appears as an actual activity on ZERO. So eBay has no confirmed replacement
   * on record, and this constraint makes those 51 near-misses unstorable as
   * confirmations by a later edit.
   */
  it("permits a confirmed replacement only from the one store that confirms one", () => {
    expect(casesBody).toMatch(/replacement_confirmed\s+boolean\s+NOT NULL/);
    expect(up).toMatch(
      /ck_marketplace_cases_replacement_source[\s\S]{0,220}replacement_confirmed = false OR source_table = 'amazon_returns'/,
    );
  });

  /**
   * Three states, not a boolean, exactly as in 0021: `not_recorded` means the
   * source store has NO escalation signal at all, which is a different fact
   * from a signal meaning no. Six of the nine stores have no such column.
   *
   * ONE-WAY implication, like ck_customer_case_history_escalation_source: a row
   * from one of the three recording stores may still be `not_recorded`.
   */
  it("models escalation as three states and ties it one-way to its sources", () => {
    expect(casesBody).toMatch(/escalation\s+text\s+NOT NULL/);
    // Matched as a whole constraint rather than by indexOf: the name is a
    // prefix of ck_marketplace_cases_escalation_source, so a positional search
    // for one finds the other.
    expect(up).toMatch(
      /ck_marketplace_cases_escalation\s+CHECK\s*\(\s*escalation IN \('escalated', 'not_escalated', 'not_recorded'\)\s*\)/,
    );
    const src = up.indexOf("ck_marketplace_cases_escalation_source");
    const clause = up.slice(src, src + 260);
    expect(clause).toMatch(/escalation = 'not_recorded'\s*OR\s*source_table IN/);
    // NOT the converse: a recording store may legitimately record nothing.
    expect(clause).not.toMatch(/source_table IN[\s\S]{0,160}OR\s+escalation/);
  });

  /**
   * FOUR ORDER-MATCH STATES, because they are four different claims. A
   * source-recorded order id that resolves to a real order is not the same as
   * one that does not (the Amazon return store has 16% of the latter), and
   * neither is the same as a reference this application derived from the
   * marketplace item and transaction identifiers — measured at 1,182 of 1,189
   * cases resolving to exactly one order, 0 ambiguous. `unmatched` is stored
   * rather than left as a NULL reading as "not checked".
   */
  it("records how the order reference was established, as four states", () => {
    expect(casesBody).toMatch(/order_match_method\s+text\s+NOT NULL/);
    const at = up.indexOf("ck_marketplace_cases_order_match_method");
    const clause = up.slice(at, at + 320);
    for (const method of [
      "source_order_id_verified",
      "source_order_id_unverified",
      "item_transaction",
      "unmatched",
    ]) {
      expect(clause).toContain(`'${method}'`);
    }
  });

  /**
   * THE ONE BICONDITIONAL, AND THE TEST THAT PINS IT AS DELIBERATE.
   *
   * 0011 shipped a biconditional that broke Undo Cancel and 0013 had to undo
   * it, because there a state transition legitimately moved one side without
   * the other. There is no such transition here: `unmatched` IS DEFINED as "no
   * reference", and a case row is only ever written whole by an upsert that
   * sets both columns from the same incoming record.
   *
   * The two one-way implications elsewhere in this migration are asserted as
   * one-way above and below, so this suite would catch the two being confused.
   */
  it("pairs order_ref with its method as a biconditional, on purpose", () => {
    expect(up).toMatch(
      /ck_marketplace_cases_order_ref_method[\s\S]{0,200}\(order_match_method = 'unmatched'\)\s*=\s*\(order_ref IS NULL\)/,
    );
  });

  /**
   * The convention is timestamptz for anything this application generates and
   * naive timestamp only where a source value is kept byte-for-byte. The first
   * dry run of 0021's importer proved the cost of confusing them: the driver
   * parsed a naive datetime into a local Date and silently gave it an offset it
   * never had.
   */
  it("keeps source datetimes naive and application timestamps zoned", () => {
    expect(casesBody).toMatch(/opened_at\s+timestamp\s+NOT NULL/);
    expect(casesBody).toMatch(/closed_at\s+timestamp\s*,/);
    expect(casesBody).toMatch(/source_updated_at\s+timestamp\s*,/);
    expect(casesBody).toMatch(/seller_action_due_at\s+timestamp\s*,/);
    expect(casesBody).toMatch(/imported_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/);
    for (const column of ["opened_at", "closed_at", "source_updated_at"]) {
      expect(casesBody, `${column} must not be timestamptz`).not.toMatch(
        new RegExp(`${column}\\s+timestamptz`),
      );
    }
  });

  it("refuses a refund amount with no currency", () => {
    expect(up).toMatch(/ck_marketplace_cases_refund_pair[\s\S]{0,200}refund_currency/);
  });
});

// ===========================================================================
describe("a dry run writes nothing", () => {
  /**
   * An earlier draft of this design recorded `mode = 'dry_run'` on the ledger
   * so a rehearsal was visible. That was wrong twice over: it made a read-only
   * rehearsal perform a write, and it put a row in the one table whose purpose
   * is to say when real data was last published.
   *
   * The ledger has no mode column and no dry-run state, so "a rehearsal
   * changes no database" is a property of the schema rather than a promise in a
   * script. There is nothing for a dry run to write.
   */
  it("gives the ledger no mode column and no dry-run state", () => {
    expect(runsBody).not.toMatch(/\bmode\b/i);
    expect(up).not.toMatch(/dry_run/i);
    expect(up).not.toMatch(/'rehearsal'/i);
  });

  it("gives the ledger no column a rehearsal would need to fill", () => {
    // Every column is either defaulted, nullable, or supplied by a real run.
    expect(runsBody).toMatch(/started_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/);
  });
});

// ===========================================================================
describe("import publication and failure states can be distinguished", () => {
  /**
   * THREE STATES, AND THE MIDDLE ONE IS THE WHOLE POINT. `published` is the
   * only state CST may read data behind.
   */
  it("gives a run three states, including an explicit published one", () => {
    expect(runsBody).toMatch(/status\s+text\s+NOT NULL/);
    const at = up.indexOf("ck_case_import_runs_status");
    expect(up.slice(at, at + 220)).toMatch(
      /'in_progress'[\s\S]{0,40}'published'[\s\S]{0,40}'failed'/,
    );
  });

  /**
   * Publication implies a publication time. ONE-WAY, and 0013 is why: the
   * converse would make retracting a bad run impossible, because moving it to
   * `failed` while keeping the timestamp as history would violate a
   * biconditional.
   */
  it("requires a published run to carry a publication time, one-way", () => {
    expect(runsBody).toMatch(/published_at\s+timestamptz\s*,/);
    const at = up.indexOf("ck_case_import_runs_published_has_time");
    const clause = up.slice(at, at + 200);
    expect(clause).toMatch(/status <> 'published' OR published_at IS NOT NULL/);
    // Not the converse: a retracted run keeps published_at as history.
    expect(clause).not.toMatch(/published_at IS NOT NULL\s*(=|AND\s+status\s*=)/);
  });

  /**
   * A HALF-FINISHED RUN CANNOT BE READABLE AS CURRENT, and this is the
   * direction that enforces it rather than merely documenting it.
   */
  it("forbids an in-progress run from carrying a publication time", () => {
    expect(up).toMatch(
      /ck_case_import_runs_in_progress_unpublished[\s\S]{0,200}status <> 'in_progress' OR published_at IS NULL/,
    );
  });

  it("requires a failure to say what failed", () => {
    expect(runsBody).toMatch(/error\s+text\s*,?/);
    expect(up).toMatch(
      /ck_case_import_runs_failed_has_error[\s\S]{0,200}status <> 'failed' OR error IS NOT NULL/,
    );
  });

  /**
   * A published run must report its own numbers. Without this a run could be
   * published with no counts at all, and "published" would stop meaning
   * "finished and accounted for".
   */
  it("requires a published run to report its own counts", () => {
    for (const column of [
      "cases_read",
      "cases_inserted",
      "cases_updated",
      "cases_rejected",
    ]) {
      expect(runsBody).toMatch(new RegExp(`${column}\\s+integer`));
    }
    const at = up.indexOf("ck_case_import_runs_published_has_counts");
    const clause = up.slice(at, at + 420);
    expect(clause).toMatch(/status <> 'published'/);
    for (const column of [
      "cases_read",
      "cases_inserted",
      "cases_updated",
      "cases_rejected",
    ]) {
      expect(clause).toContain(`${column} IS NOT NULL`);
    }
  });

  /**
   * AT MOST ONE IN-PROGRESS RUN. A partial unique index on a column whose every
   * matching row holds the same value is how PostgreSQL expresses "at most one
   * row satisfying this predicate", so a second concurrent import fails at its
   * first statement rather than part-way through the data.
   *
   * It must stay PARTIAL: an unconditional unique index on `status` would admit
   * only one published run in the entire table.
   */
  it("permits at most one in-progress run at a time", () => {
    expect(up).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_case_import_runs_single_in_progress",
    );
    const at = up.indexOf("uq_case_import_runs_single_in_progress");
    const clause = up.slice(at, at + 240);
    expect(clause).toMatch(/ON cst_app\.case_import_runs\s*\(status\)/);
    expect(clause).toMatch(/WHERE status = 'in_progress'/);
  });

  /**
   * The chain that makes "a failed import cannot expose a partial record set"
   * checkable rather than merely asserted. If this block ever disappears, the
   * property has lost its only written home in the schema.
   */
  it("documents why a failed import can expose no partial record", () => {
    expect(upRaw).toMatch(/A FAILED IMPORT CANNOT EXPOSE A PARTIAL RECORD SET/);
    expect(upRaw).toMatch(/NOTHING IS COMMITTED UNTIL EVERYTHING IS/);
    expect(upRaw).toMatch(/A RUN CANNOT BE COMMITTED AND FAILED AT THE SAME TIME/);
    expect(upRaw).toMatch(/AN UNPUBLISHED RUN IS UNREADABLE BY CONSTRUCTION/);
  });

  it("requires a finished run to say when it finished", () => {
    expect(up).toMatch(
      /ck_case_import_runs_finished[\s\S]{0,200}status = 'in_progress' OR finished_at IS NOT NULL/,
    );
  });

  /** Unmappable cases are tallied by reason, never repaired with a default. */
  it("keeps a record of what was dropped and why", () => {
    expect(runsBody).toMatch(/rejection_summary\s+jsonb\s*,/);
  });
});

// ===========================================================================
describe("freshness is tied to publication and to actual coverage", () => {
  /**
   * A run may be asked for a subset of the stores and must not then be readable
   * as a whole-snapshot refresh. A published run covering only the inquiry log
   * says nothing about how current the return stores are.
   */
  it("records which stores a run actually covered", () => {
    expect(runsBody).toMatch(/source_tables\s+text\[\]\s+NOT NULL/);
    expect(up).toMatch(
      /ck_case_import_runs_source_tables_present[\s\S]{0,260}cardinality\(source_tables\) >= 1/,
    );
    expect(up).toMatch(
      /ck_case_import_runs_source_tables_present[\s\S]{0,260}array_position\(source_tables, NULL\) IS NULL/,
    );
  });

  /** A run cannot claim coverage of a store that does not exist. */
  it("constrains claimed coverage to the nine known stores", () => {
    const at = up.indexOf("ck_case_import_runs_source_tables_known");
    const clause = up.slice(at, at + 460);
    expect(clause).toMatch(/source_tables <@ ARRAY\[/);
    for (const store of [
      "ebay_returns",
      "amazon_returns",
      "cancellation",
      "amz_cancellations",
      "shopify_returns",
      "shopify_cancellations",
      "inquiries",
      "cases",
      "payment_disputes",
    ]) {
      expect(clause, `${store} is not in the coverage vocabulary`).toContain(`'${store}'`);
    }
  });

  /**
   * The freshness index is PARTIAL on `published`, which is the structural
   * statement that an unpublished run is never a freshness answer. A plain
   * index ordered by the newest timestamp is precisely the thing this design
   * was corrected away from.
   */
  it("indexes freshness on published runs only", () => {
    expect(up).toContain("CREATE INDEX IF NOT EXISTS ix_case_import_runs_published");
    const at = up.indexOf("ix_case_import_runs_published");
    expect(up.slice(at, at + 220)).toMatch(/WHERE status = 'published'/);
  });

  /**
   * `imported_at` is a PER-ROW "last confirmed" and must not be mistaken for
   * the freshness answer: a row carries one even when the run that wrote it was
   * never published. The column comment says so, and this pins the comment.
   */
  it("documents that the per-row timestamp is not the freshness answer", () => {
    expect(upRaw).toMatch(
      /COMMENT ON COLUMN cst_app\.marketplace_cases\.imported_at IS[\s\S]{0,320}NOT the freshness answer/,
    );
    expect(upRaw).toMatch(
      /COMMENT ON COLUMN cst_app\.case_import_runs\.published_at IS[\s\S]{0,320}authoritative freshness/,
    );
  });

  /**
   * The publication gate is a read-path rule no schema can enforce, so the
   * migration states it and the index that makes it cheap exists. If this
   * comment ever disappears, the rule has lost its only written home in the
   * schema.
   */
  it("states the publication gate and indexes the join it needs", () => {
    expect(upRaw).toMatch(/READ-PATH GATE/);
    expect(up).toContain("CREATE INDEX IF NOT EXISTS ix_marketplace_cases_run");
  });

  /**
   * The functional index 0021 deliberately did without. 0021 accepted a
   * sequential scan over 1,098 rows and recorded that a functional index on
   * lower(counterparty_ref) would need a migration if the table grew by orders
   * of magnitude. This table is expected to hold about twenty times as many
   * rows, so that migration is this one.
   */
  it("indexes the customer lookup functionally, unlike 0021", () => {
    expect(up).toContain("CREATE INDEX IF NOT EXISTS ix_marketplace_cases_counterparty");
    const at = up.indexOf("ix_marketplace_cases_counterparty");
    const clause = up.slice(at, at + 260);
    expect(clause).toMatch(/lower\(counterparty_ref\)/);
    expect(clause).toMatch(/WHERE counterparty_ref IS NOT NULL/);
  });

  it("indexes the order lookup, partially", () => {
    expect(up).toContain("CREATE INDEX IF NOT EXISTS ix_marketplace_cases_order");
    const at = up.indexOf("ix_marketplace_cases_order\n");
    const clause = up.slice(at, at + 240);
    expect(clause).toMatch(/\(marketplace, sub_source_id, order_ref\)/);
    expect(clause).toMatch(/WHERE order_ref IS NOT NULL/);
  });
});

// ===========================================================================
describe("existing tables are not altered", () => {
  it("alters nothing and drops nothing", () => {
    expect(up).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(up).not.toMatch(/\bALTER\s+INDEX\b/i);
    expect(up).not.toMatch(/\bDROP\b/i);
  });

  it("writes no rows — this migration imports nothing", () => {
    const executable = statements(upRaw);
    expect(executable).not.toMatch(/\bINSERT\b/i);
    expect(executable).not.toMatch(/\bUPDATE\b/i);
    expect(executable).not.toMatch(/\bDELETE\b/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b/i);
    expect(executable).not.toMatch(/\bCOPY\b/i);
  });

  /**
   * 0021's TABLE AND THE WARNING BEHIND IT ARE UNTOUCHED, and this is the
   * assertion that matters most to a reviewer: about 1,225 cases will exist in
   * both tables once the importer runs, and the temptation is to "tidy" 0021 or
   * repoint its reads. Either would change a shipped feature's numbers.
   */
  it("does not alter, populate, index or re-comment customer_case_history", () => {
    const executable = statements(upRaw);
    expect(executable).not.toMatch(/ALTER\s+TABLE\s+cst_app\.customer_case_history/i);
    expect(executable).not.toMatch(/INDEX[\s\S]{0,80}ON\s+cst_app\.customer_case_history/i);
    expect(code(upRaw)).not.toMatch(
      /COMMENT\s+ON\s+(TABLE|COLUMN)\s+cst_app\.customer_case_history/i,
    );
    expect(statements(downRaw)).not.toMatch(/customer_case_history/i);
  });

  it("does not touch conversations, context_snapshots, agent_activity or sync_state", () => {
    const executable = statements(upRaw);
    for (const table of [
      "conversations",
      "context_snapshots",
      "agent_activity",
      "sync_state",
      "conversation_messages",
      "internal_notes",
    ]) {
      expect(executable, `${table} must not be altered`).not.toMatch(
        new RegExp(`ALTER\\s+TABLE\\s+cst_app\\.${table}`, "i"),
      );
    }
  });
});

// ===========================================================================
describe("cst_app is the only target", () => {
  it("names no other project's schema", () => {
    for (const sql of [up, down]) {
      expect(sql).not.toMatch(/\bissue_tracking\./i);
      expect(sql).not.toMatch(/\bpoc_listing\./i);
      expect(sql).not.toMatch(/\bpublic\./i);
      expect(sql).not.toMatch(/\breview\./i);
      expect(sql).not.toMatch(/\bsku360\./i);
      expect(sql).not.toMatch(/\binventory_control\./i);
    }
  });

  /**
   * MySQL and the marketplace PostgreSQL source are strictly read-only. No
   * migration may create, alter or write an object in either — the connection
   * details exist for a reader, and a migration is not one.
   */
  it("creates nothing in a source database", () => {
    for (const sql of [statements(upRaw), statements(downRaw)]) {
      expect(sql).not.toMatch(/\bmessage_app\./i);
      expect(sql).not.toMatch(/\border_management\./i);
      expect(sql).not.toMatch(/\bledsone\./i);
      expect(sql).not.toMatch(/\bcustomer_service\./i);
      expect(sql).not.toMatch(/\blistings\./i);
      expect(sql).not.toMatch(/\blisting_management\./i);
      expect(sql).not.toMatch(/\bcustomers\./i);
    }
  });

  it("every created object is schema-qualified to cst_app", () => {
    for (const match of up.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\./g)) {
      expect(match[1]).toBe("cst_app");
    }
    for (const match of up.matchAll(/\bON\s+([a-z_]+)\.[a-z_]+\s*(\(|$)/gm)) {
      expect(match[1]).toBe("cst_app");
    }
  });
});

// ===========================================================================
describe("no customer content is copied", () => {
  /**
   * THE COLUMNS THAT EXIST AT SOURCE AND MUST NOT ARRIVE HERE.
   *
   * Between them the nine stores carry `comments` (up to 2,000 chars of case
   * correspondence), `buyer_req`, `buyer_note`, `esc_reason`, `evi_seller_note`,
   * `return_address` (a customer's postal location, in a longtext),
   * `refund_payload` (a raw marketplace blob), `img` (return photographs),
   * `customer_email`, `customer_name`, `shipping_city` and `shipping_country`.
   *
   * None is here. A column that is not here cannot leak — the same reasoning
   * 0017 and 0018 applied to the credential columns in the source user table,
   * and 0021 applied to this very family of tables.
   */
  it("copies no free-text, correspondence or postal column from the source", () => {
    const executable = statements(upRaw);
    for (const column of [
      "comments",
      "buyer_req",
      "buyer_note",
      "esc_reason",
      "evi_seller_note",
      "return_address",
      "refund_payload",
      "detailed_disposition",
      "merchant_rma_id",
      "invoice_number",
    ]) {
      expect(mentions(executable, column), `${column} must not be stored`).toBe(false);
    }
  });

  it("copies no contact, name or address field", () => {
    const executable = statements(upRaw);
    for (const column of [
      "customer_email",
      "customer_name",
      "shipping_city",
      "shipping_country",
      "first_name",
      "last_name",
      "address_name",
      "email",
      "phone",
      "postcode",
    ]) {
      expect(mentions(executable, column), `${column} must not be stored`).toBe(false);
    }
  });

  /** No image, no blob, no raw payload. Return photographs stay at source. */
  it("stores no image, raw payload or file bytes", () => {
    const executable = statements(upRaw);
    for (const term of ["img", "image_url", "bytea", "raw", "payload", "jsonb_raw"]) {
      expect(mentions(executable, term), `${term} must not appear`).toBe(false);
    }
  });

  /**
   * The buyer handle is the only customer-identifying value stored, and it is
   * stored because it IS `conversations.counterparty_ref` and exists to be
   * compared with it. Nullable here, unlike 0021, because four of the nine
   * stores record no customer at all — and that NULL means the source holds
   * none, not that the import failed to read one.
   */
  it("stores the buyer only as counterparty_ref, and permits its absence", () => {
    expect(casesBody).toMatch(/counterparty_ref\s+text\s*,/);
    expect(casesBody).not.toMatch(/counterparty_ref\s+text\s+NOT NULL/);
    expect(statements(upRaw)).not.toMatch(/\bbuyer\b/i);
  });
});

// ===========================================================================
describe("no marketplace outbound functionality is introduced", () => {
  /**
   * `reviewed` is a terminal state and this application has no transport. No
   * column here could be read by one: no recipient, no channel, no template, no
   * body, no address, no status meaning sent, and no outbound queue.
   */
  it("adds no transport, recipient, channel or outbound structure", () => {
    const executable = statements(upRaw);
    for (const term of [
      "recipient",
      "send",
      "sent",
      "outbound",
      "transmit",
      "transport",
      "channel",
      "template",
      "smtp",
      "webhook",
      "endpoint",
      "api_key",
      "credential",
      "token",
      "password",
    ]) {
      expect(
        mentions(executable, term),
        `${term} must not appear in an executable statement`,
      ).toBe(false);
    }
  });

  it("adds no workflow state, so the workflow still terminates at reviewed", () => {
    const executable = statements(upRaw);
    for (const term of ["workflow", "pending_review", "reviewed", "drafting"]) {
      expect(mentions(executable, term), `${term} must not appear`).toBe(false);
    }
  });

  it("adds no marketplace write or callback surface", () => {
    const executable = statements(upRaw);
    for (const term of ["http", "url", "callback", "notify"]) {
      expect(mentions(executable, term), `${term} must not appear`).toBe(false);
    }
  });
});

// ===========================================================================
describe("no automatic synchronisation is introduced", () => {
  /**
   * The import is a manual, separately-approved action. 0021 made the same
   * promise and this migration must keep it: nothing here schedules, wakes or
   * triggers anything, and no feed is registered.
   */
  it("creates no trigger, function, rule or schedule", () => {
    for (const sql of [up, down]) {
      expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
      expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
      expect(sql).not.toMatch(/CREATE\s+RULE/i);
      expect(sql).not.toMatch(/pg_notify/i);
      expect(sql).not.toMatch(/LISTEN|NOTIFY/i);
    }
  });

  it("registers no sync feed and stores no watermark", () => {
    const executable = statements(upRaw);
    for (const term of ["sync_state", "watermark", "feed_key", "cron", "interval"]) {
      expect(mentions(executable, term), `${term} must not appear`).toBe(false);
    }
  });

  /**
   * The run ledger is a record of a manual action, NOT a feed. The distinction
   * is why it carries `published_at` and the stores it covered rather than a
   * watermark and a next-run time.
   */
  it("gives the ledger no scheduling column", () => {
    for (const term of ["next_run", "scheduled", "last_run_at", "enabled", "active"]) {
      expect(
        mentions(runsBody, term),
        `${term} must not appear on the ledger`,
      ).toBe(false);
    }
  });
});

// ===========================================================================
describe("rollback targets only the newly created objects", () => {
  it("drops exactly the two tables it created, and nothing else", () => {
    expect(down).toContain(`DROP TABLE IF EXISTS ${CASES} RESTRICT`);
    expect(down).toContain(`DROP TABLE IF EXISTS ${RUNS} RESTRICT`);
    expect(down.match(/DROP\s+TABLE/gi)?.length).toBe(2);
    expect(down).not.toMatch(/DROP\s+(SCHEMA|INDEX|COLUMN|CONSTRAINT|TYPE|FUNCTION)/i);
    expect(down).not.toMatch(/\bALTER\b/i);
  });

  /**
   * CHILD FIRST. `marketplace_cases.import_run_id` references the ledger, so
   * dropping the ledger first would fail under RESTRICT while any case row
   * survived. This is the first rollback in the repository where drop order
   * matters, and it mirrors the creation order asserted above.
   */
  it("drops the child before the table it references", () => {
    expect(down.indexOf(CASES)).toBeLessThan(down.indexOf(RUNS));
  });

  /**
   * RESTRICT, NEVER CASCADE. If a drop ever fails, something has taken a
   * dependency on these tables and the right outcome is a failed rollback a
   * person looks at — not a CASCADE quietly removing whatever that was.
   */
  it("rolls back with RESTRICT, never CASCADE", () => {
    expect(down).not.toMatch(/\bCASCADE\b/i);
    expect(down.match(/\bRESTRICT\b/g)?.length).toBe(2);
  });

  it("deletes no row from another table", () => {
    const executable = statements(downRaw);
    expect(executable).not.toMatch(/\bDELETE\b/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b/i);
    expect(executable).not.toMatch(/\bUPDATE\b/i);
    expect(executable).not.toMatch(/\bINSERT\b/i);
  });

  it("leaves customer_case_history and the warning's reads intact", () => {
    expect(statements(downRaw)).not.toMatch(/customer_case_history/i);
    expect(statements(downRaw)).not.toMatch(/conversations/i);
  });
});

// ===========================================================================
describe("applied status is declared", () => {
  /**
   * Which migrations are live in a given environment cannot be determined from
   * this repository, so the file says what it knows: when and where it was
   * applied. An APPLIED migration may not be edited — the next change is the
   * next number — so this test is also the marker that makes editing it in place
   * a visible mistake.
   */
  it("records when and where it was applied", () => {
    expect(upRaw).toMatch(/STATUS:\s+APPLIED 2026-10-02 to varmen_db, schema cst_app/);
    expect(upRaw).toMatch(/imported nothing/);
    expect(upRaw).toMatch(/deployed EMPTY/);
  });

  /**
   * The measured blast radius, which is the evidence a reviewer checks rather
   * than the assurance they are given.
   */
  it("records the measured blast radius", () => {
    expect(upRaw).toMatch(/base-table count went 33 -> 35/);
    expect(upRaw).toMatch(/NO existing table gained, lost or changed a row/);
    expect(upRaw).toMatch(/1,098 rows before and 1,098 after/);
    expect(upRaw).toMatch(/No object was created outside cst_app/);
  });

  /**
   * The rehearsal, and why the obvious method is not one. The file carries its
   * own BEGIN and COMMIT, so handing it to a client that has already issued
   * BEGIN does not give a rollback-safe trial — the file's own COMMIT makes it
   * permanent. Recorded so the next person does not discover that by applying a
   * migration they meant to rehearse.
   */
  it("records how it was rehearsed before being applied", () => {
    expect(upRaw).toMatch(/ROLLED BACK/);
    expect(upRaw).toMatch(/is NOT a\s*\n?--\s*rehearsal/);
  });

  /**
   * The reason a second table was needed at all. If this ever stops being
   * written down, the next reviewer will reasonably ask why 0021 was not simply
   * extended — and the answer is a measured impossibility, not a preference.
   */
  it("states why 0021's table could not be extended", () => {
    expect(upRaw).toMatch(/counterparty_ref` is NOT NULL/);
    expect(upRaw).toMatch(/FOUR of the nine\s*\n?--\s*source stores carry no buyer column/);
  });

  /** The overlap is declared rather than discovered later by a reviewer. */
  it("declares the overlap with 0021 and where it is recorded", () => {
    expect(upRaw).toMatch(/1,225 cases will exist/);
    expect(upRaw).toMatch(/duplicate-risk-reports/);
  });

  /** The publication protocol is the correction this migration exists to carry. */
  it("documents the atomic publication protocol", () => {
    expect(upRaw).toMatch(/ATOMIC PUBLICATION/);
    expect(upRaw).toMatch(/TRANSACTION 1/);
    expect(upRaw).toMatch(/TRANSACTION 2/);
    expect(upRaw).toMatch(/TRANSACTION 3/);
    expect(upRaw).toMatch(/RESUMABILITY IS TRADED FOR ATOMICITY/);
  });

  /** And the per-store freshness rule, with the query that answers it. */
  it("documents that freshness is per source store", () => {
    expect(upRaw).toMatch(/FRESHNESS IS PER SOURCE STORE/);
    expect(upRaw).toMatch(/unnest\(r\.source_tables\)/);
    expect(upRaw).toMatch(/never imported/);
  });
});
