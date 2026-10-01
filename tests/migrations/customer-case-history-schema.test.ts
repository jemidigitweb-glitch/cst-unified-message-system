import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Static review of 0021 customer_case_history.
 *
 * Reads the SQL as text and NEVER connects to a database — the approach
 * `cst-core-schema.test.ts` established and the reason this suite runs
 * anywhere. 0021 has NOT been executed, and there is deliberately no test here
 * that would require it to have been; the one test about its applied status
 * asserts the opposite.
 *
 * WHAT THIS SUITE IS GUARDING. 0021 is storage for a one-time import out of
 * MySQL `message_app`, whose source tables carry a customer's case
 * correspondence, their postal location and their free-text dispute reasons
 * alongside the few structured facts that are wanted. The risks that matter
 * are not "does the SQL parse" — they are:
 *
 *   * a free-text or postal column copied across because it was adjacent to a
 *     wanted one
 *   * the per-event log stored one row per event, so one customer's single
 *     claim reports as four
 *   * an order reference invented for the two source tables that have none
 *   * a biconditional CHECK that is exactly right on paper and breaks on the
 *     real data, as 0011's did
 *   * this migration quietly becoming a scheduled sync
 *
 * Each has a test below.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

const NUMBER = "0021";
const SLUG = "customer_case_history";
const TABLE = "cst_app.customer_case_history";

/**
 * Strips SQL comments so prose in the header cannot satisfy or trip a check.
 * 0021's header discusses `return_address`, `buyer_note`, CASCADE, DROP and a
 * customer's email at length, explaining why none of them is here; read as
 * code, every one of those explanations would fail the test it exists to
 * justify. String literals are preserved — the vocabulary under test lives
 * inside them.
 *
 * Same helper, same reasoning, as `mysql-source-schema.test.ts`.
 */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Executable statements only, with two further removals — both of which were
 * real false positives on the earlier MySQL-source migrations.
 *
 * `COMMENT ON ... IS '...'` is documentation inside a string literal, and this
 * migration uses it to say what it deliberately does NOT hold ("no contact
 * detail", "not a route to a person"). Read as code, a comment saying a thing
 * is absent reads as the thing being present.
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

let upRaw = "";
let up = "";
let down = "";

beforeAll(() => {
  upRaw = readFileSync(pathFor("up"), "utf8");
  up = code(upRaw);
  down = code(readFileSync(pathFor("down"), "utf8"));
});

describe("the migration pair", () => {
  it("has an up migration and a matching rollback", () => {
    expect(existsSync(pathFor("up"))).toBe(true);
    expect(existsSync(pathFor("down"))).toBe(true);
  });

  /**
   * NUMBERING. `follow-up-reminders.test.ts` added this check after two
   * branches both shipped a `0012`. Re-asserted over the whole directory here
   * because 0021 arrives on a feature branch while other work is in flight.
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
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(up.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g)?.length).toBe(2);
  });
});

describe("additive only — existing data is preserved", () => {
  it("alters no existing table", () => {
    expect(up).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("drops nothing", () => {
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
   * 0021 is storage for a repeat-contact signal, and the instinct when adding
   * one is to hang a flag on the conversation. That would be a schema change to
   * a table 21,969 rows deep and read on every inbox load.
   */
  it("does not touch conversations, context_snapshots or agent_activity", () => {
    const executable = statements(upRaw);
    expect(executable).not.toMatch(/ALTER\s+TABLE\s+cst_app\.conversations/i);
    expect(executable).not.toMatch(/ALTER\s+TABLE\s+cst_app\.context_snapshots/i);
    expect(executable).not.toMatch(/ALTER\s+TABLE\s+cst_app\.agent_activity/i);
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
   * MySQL and the marketplace PostgreSQL source are strictly read-only. No
   * migration may create, alter or write an object in either — the connection
   * details exist for a reader, and a migration is not one.
   */
  it("creates nothing in a source database", () => {
    for (const sql of [statements(upRaw), down]) {
      expect(sql).not.toMatch(/\bmessage_app\./i);
      expect(sql).not.toMatch(/\border_management\./i);
      expect(sql).not.toMatch(/\bledsone\./i);
      expect(sql).not.toMatch(/\bcustomer_service\./i);
      expect(sql).not.toMatch(/\blisting_management\./i);
    }
  });
});

describe("no customer content is copied", () => {
  /**
   * THE COLUMNS THAT EXIST AT SOURCE AND MUST NOT ARRIVE HERE.
   *
   * `inquiries`, `cases` and `payment_disputes` carry, between them,
   * `comments` (1,000 chars of case correspondence), `buyer_req`, `buyer_note`,
   * `esc_reason`, `evi_seller_note` and `return_address` — a customer's postal
   * location, in a longtext. A column that is not here cannot leak, so the test
   * is that these names never appear in an executable statement at all.
   *
   * The generic credential and contact words come from
   * `mysql-source-schema.test.ts` and are kept identical on purpose: 0021 reads
   * a different set of MySQL tables through the same account, and the standard
   * should not be looser because the table is new.
   */
  const FORBIDDEN_SOURCE_COLUMNS = [
    "comments", "buyer_req", "buyer_note", "esc_reason", "evi_seller_note",
    "return_address", "tracking_url", "tracking_no", "tracking_status",
    "claim_amount", "repeat_msg_ids",
  ];

  const FORBIDDEN_GENERIC = [
    "password", "passwd", "pwd", "hash", "salt", "token",
    "verification_code", "fcm", "secret", "credential",
    "email", "contact", "phone", "gender", "address", "user_image",
  ];

  it("copies no free-text, correspondence or postal column from the source", () => {
    const executable = statements(upRaw).toLowerCase();
    for (const word of FORBIDDEN_SOURCE_COLUMNS) {
      expect(executable).not.toContain(word);
    }
  });

  it("copies no credential or contact field", () => {
    const executable = statements(upRaw).toLowerCase();
    for (const word of FORBIDDEN_GENERIC) {
      expect(executable).not.toContain(word);
    }
  });

  /**
   * No raw payload, in any form. `payment_disputes.return_address` is a
   * longtext and the row-level data is wide; the temptation on an import like
   * this is to keep a JSON copy "just in case", which is how the rejected
   * columns arrive anyway.
   */
  it("stores no raw payload", () => {
    expect(up).not.toMatch(/\bjsonb?\b/i);
    expect(up).not.toMatch(/\bpayload\b/i);
    expect(up).not.toMatch(/\braw\b/i);
    expect(up).not.toMatch(/\bbytea\b/i);
    expect(up).not.toMatch(/\bblob\b/i);
  });

  /**
   * The one customer-identifying value that IS stored, and the reason it is
   * acceptable: it is the same opaque marketplace handle
   * `conversations.counterparty_ref` already holds, named identically because
   * it exists to be joined to it. A differently-named column here would invite
   * a second notion of customer identity.
   */
  it("stores the buyer only as counterparty_ref, matching conversations", () => {
    expect(up).toMatch(/counterparty_ref\s+text\s+NOT NULL/);
    expect(statements(upRaw)).not.toMatch(/\bbuyer\s+(text|varchar)/i);
    expect(statements(upRaw)).not.toMatch(/\bbuyer_name\b/i);
  });
});

describe("no sending capability is introduced", () => {
  it("adds no transport structure", () => {
    const lower = up.toLowerCase();
    for (const word of ["smtp", "outbound_queue", "recipient", "scheduled_send", "transport"]) {
      expect(lower).not.toContain(word);
    }
  });
});

describe("no automatic synchronisation is introduced", () => {
  /**
   * The import this table serves is one-time and explicitly approved. A
   * trigger, a function or a sync_state row would each make it something that
   * happens on its own — and `sync_state` in particular is the mechanism the
   * incremental feeds use, so a row there is the difference between a snapshot
   * and a running sync.
   */
  it("creates no trigger, function or rule", () => {
    const executable = statements(upRaw);
    expect(executable).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
    expect(executable).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
    expect(executable).not.toMatch(/\bCREATE\s+RULE\b/i);
    expect(executable).not.toMatch(/\bCREATE\s+EVENT\b/i);
  });

  it("registers no sync feed", () => {
    expect(statements(upRaw)).not.toMatch(/sync_state/i);
    expect(statements(upRaw)).not.toMatch(/watermark/i);
  });

  /**
   * A snapshot has to be able to say how stale it is, and `imported_at` is the
   * only thing that can. It must not be confused with the source's own
   * timestamp, which is why both exist.
   */
  it("records when the snapshot was taken, separately from when the case was raised", () => {
    expect(up).toMatch(/imported_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/);
    expect(up).toMatch(/event_at\s+timestamp\s+NOT NULL/);
  });
});

describe("source identity and duplicate prevention", () => {
  /**
   * THE KEY IS THE CASE, NOT THE SOURCE ROW, AND THAT IS THE WHOLE DEFENCE
   * AGAINST DOUBLE COUNTING.
   *
   * Measured on the source: `inquiries` holds 8,052 event rows for 1,062 cases
   * and `cases` 1,038 for 127. Keyed on the row id — the shape 0016 and 0017
   * use, because their sources are genuinely one row per thing — this table
   * would report a customer who filed one claim as having filed four.
   *
   * `source_table` is inside the key because `cases.case_id` and
   * `payment_disputes.case_id` are separate eBay id spaces; the same reasoning
   * as uq_agent_directory_source_identity.
   */
  it("is keyed on (source_database, source_table, source_case_id)", () => {
    expect(up).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_case_history_source_identity",
    );
    const at = up.indexOf("uq_customer_case_history_source_identity");
    expect(up.slice(at, at + 220)).toMatch(
      /\(\s*source_database\s*,\s*source_table\s*,\s*source_case_id\s*\)/,
    );
  });

  it("is not keyed on a per-event source row id", () => {
    expect(up).not.toMatch(/source_pk/);
    expect(up).not.toMatch(/res_his_order/);
  });

  it("records which source database and table a row came from", () => {
    expect(up).toMatch(/source_database\s+text\s+NOT NULL/);
    expect(up).toMatch(/source_table\s+text\s+NOT NULL/);
    expect(up).toMatch(
      /ck_customer_case_history_source_database[\s\S]{0,120}source_database = 'message_app'/,
    );
    expect(up).toMatch(
      /ck_customer_case_history_source_table[\s\S]{0,200}'inquiries'[\s\S]{0,40}'cases'[\s\S]{0,40}'payment_disputes'/,
    );
  });

  /**
   * The count of folded events, kept so a report can separate "how many cases"
   * from "how many recorded events" — the split the root cause feature needed a
   * child table for. Without it the collapse is lossy in the one way that
   * matters to a duplicate-risk review.
   */
  it("keeps the number of source events it collapsed", () => {
    expect(up).toMatch(/source_row_count\s+integer\s+NOT NULL/);
    expect(up).toMatch(
      /ck_customer_case_history_source_row_count_positive[\s\S]{0,120}source_row_count >= 1/,
    );
  });

  /**
   * bigint(20) at source, selected as text. A JavaScript number rounds a large
   * bigint, and a rounded id is a case nobody can find again — the convention
   * `documentation/ai-coding-context.md` states for every id in this schema.
   */
  it("stores the source case id as text, not a number", () => {
    expect(up).toMatch(/source_case_id\s+text\s+NOT NULL/);
    expect(up).not.toMatch(/source_case_id\s+(bigint|integer|numeric)/i);
  });
});

describe("constraints", () => {
  it("uses the same marketplace vocabulary as sync_state and agent_activity", () => {
    const at = up.indexOf("ck_customer_case_history_marketplace");
    const clause = up.slice(at, at + 300);
    for (const mk of ["ebay", "amazon", "shopify", "bandq", "temu"]) {
      expect(clause).toContain(`'${mk}'`);
    }
  });

  /**
   * NOT NULL, unlike agent_activity.marketplace. Every one of the 14 sub_source
   * values on these three tables resolves to sub_source.source_id = 2, so the
   * platform is verifiable for every row; a NULL would mean the importer stored
   * a row it could not verify, and it should reject that row instead.
   */
  it("requires a verified marketplace rather than permitting an unknown one", () => {
    expect(up).toMatch(/marketplace\s+text\s+NOT NULL/);
    expect(up).toMatch(/sub_source_id\s+integer\s+NOT NULL/);
  });

  it("constrains event_type to the three measured values", () => {
    expect(up).toMatch(
      /ck_customer_case_history_event_type[\s\S]{0,200}'ITEM_NOT_RECEIVED'[\s\S]{0,40}'RETURN'[\s\S]{0,40}'PAYMENT_DISPUTE'/,
    );
  });

  /**
   * DELIBERATELY NOT CONSTRAINED. The status vocabulary is eBay's — CLOSED,
   * CS_CLOSED, OPEN, WAITING_BUYER_RESPONSE, WAITING_SELLER_RESPONSE — and it
   * changes without telling us. A CHECK here would turn a new eBay status into
   * a failed import rather than a row an operator can see, which is the same
   * call 0017 made for `action`.
   */
  it("leaves event_status unconstrained, and nullable, and never blank", () => {
    expect(up).toMatch(/event_status\s+text\s*,/);
    expect(up).not.toMatch(/ck_customer_case_history_event_status\s+CHECK\s*\(\s*event_status IN/);
    expect(up).toMatch(
      /ck_customer_case_history_event_status_present[\s\S]{0,160}event_status IS NULL OR length\(btrim\(event_status\)\) > 0/,
    );
  });

  /**
   * THE STATUS TRAP MUST STAY WRITTEN DOWN.
   *
   * `status` is NULL on the newest row of all 1,062 inquiry cases while
   * existing somewhere in 1,061 of them, so the obvious "latest row wins"
   * collapse silently imports NULL for every case and looks successful. The
   * schema cannot enforce the latest-non-null rule — it sees a row, not how the
   * row was chosen — so the migration documents it and the importer owns it.
   * This test fails if that admission is removed.
   */
  it("documents that the importer owns the latest-non-null status rule", () => {
    expect(upRaw).toMatch(/THE STATUS TRAP/);
    expect(upRaw).toMatch(/latest NON-NULL/);
  });

  /**
   * Three states, not a boolean. Only `inquiries` records escalation;
   * `cases.esc_reason` is NULL on all 1,038 of its rows and `payment_disputes`
   * has no escalation concept. A boolean would answer `false` to "the source
   * never recorded one", which is the guessed value rule 2.4 exists to stop.
   */
  it("models escalation as three states, never a boolean", () => {
    expect(up).toMatch(
      /ck_customer_case_history_escalation[\s\S]{0,200}'escalated'[\s\S]{0,40}'not_escalated'[\s\S]{0,40}'not_recorded'/,
    );
    expect(up).not.toMatch(/escalat\w*\s+boolean/i);
    expect(up).not.toMatch(/is_escalated/i);
  });

  it("requires a buyer handle and a case id that are not blank", () => {
    expect(up).toMatch(
      /ck_customer_case_history_counterparty_present[\s\S]{0,140}length\(btrim\(counterparty_ref\)\) > 0/,
    );
    expect(up).toMatch(
      /ck_customer_case_history_source_case_id_present[\s\S]{0,140}length\(btrim\(source_case_id\)\) > 0/,
    );
  });

  /**
   * AN ORDER REFERENCE CANNOT BE INVENTED FOR A TABLE THAT HAS NONE.
   *
   * `inquiries` and `cases` carry `item_id` + `transaction_id` and no order id
   * at all; only `payment_disputes` records one. Deriving an order from an item
   * and a buyer is what `resolve-order-context.ts` does, and it returns
   * `ambiguous` on real data — so an order_ref filled in here would be a guess
   * in a column a reviewer reads as verified.
   */
  it("permits an order reference only on a payment dispute", () => {
    expect(up).toMatch(
      /ck_customer_case_history_order_ref_dispute_only[\s\S]{0,600}order_ref IS NULL OR source_table = 'payment_disputes'/,
    );
  });

  /**
   * THESE TESTS EXIST BECAUSE OF 0013.
   *
   * The natural way to write either pairing is a biconditional — order_ref IS
   * NOT NULL exactly when the row is a dispute; escalation <> 'not_recorded'
   * exactly when it came from `inquiries`. Both are wrong on measured data: 1
   * of 37 dispute rows has no order_id, and most `inquiries` cases record no
   * escalation. A biconditional would reject legitimate rows, which is exactly
   * how `ck_automation_items_cancel_pair` broke Undo Cancel in 0011 and why
   * 0013 had to relax it. The implications must run one way only.
   */
  it("pairs both cross-column rules with one-way implications, never biconditionals", () => {
    expect(up).toMatch(
      /ck_customer_case_history_escalation_source[\s\S]{0,400}escalation = 'not_recorded' OR source_table = 'inquiries'/,
    );
    expect(up).not.toMatch(
      /\(\s*order_ref IS NOT NULL\s*\)\s*=\s*\(\s*source_table = 'payment_disputes'\s*\)/,
    );
    expect(up).not.toMatch(
      /\(\s*escalation\s*<>\s*'not_recorded'\s*\)\s*=\s*\(\s*source_table = 'inquiries'\s*\)/,
    );
    expect(upRaw).toMatch(/ONE-WAY IMPLICATIONS, AND 0013 IS WHY/);
  });

  /**
   * The source's `req_date` is a naive MySQL datetime. The convention is
   * timestamptz for anything this application generates, naive timestamp only
   * where a source value is preserved byte-for-byte — and `imported_at` is the
   * former while `event_at` is the latter. Storing `event_at` as timestamptz
   * would stamp it with the server's zone and imply a precision the source does
   * not have.
   */
  it("keeps the source datetime naive and the application timestamp zoned", () => {
    expect(up).toMatch(/event_at\s+timestamp\s+NOT NULL/);
    expect(up).not.toMatch(/event_at\s+timestamptz/);
    expect(up).toMatch(/imported_at\s+timestamptz/);
  });
});

describe("relationships to existing tables", () => {
  /**
   * NO FOREIGN KEY TO `conversations`, AND THAT IS THE DESIGN RATHER THAN AN
   * OMISSION.
   *
   * A buyer's case history earns its place exactly when they come back and
   * message again — so at import time the matching conversation usually does
   * not exist, and an FK would make the only rows worth having unstorable.
   * Measured: 80 of 1,000 inquiry buyers match a CST eBay conversation today.
   * The other 920 are the forward-looking part, not junk.
   *
   * Matching is a read-time join on `counterparty_ref` instead, which is what
   * the second index is sized for.
   */
  it("holds no foreign key at all", () => {
    expect(up).not.toMatch(/FOREIGN KEY/i);
    expect(up).not.toMatch(/REFERENCES\s+cst_app\./i);
  });

  it("documents why the conversation link is absent", () => {
    expect(upRaw).toMatch(/NO FOREIGN KEY TO `conversations`, DELIBERATELY/);
  });

  /**
   * The repeat-contact read is "has this buyer had a case before", and
   * `counterparty_ref` is only unique within one marketplace — an eBay handle
   * and a Shopify handle may be the same string and are not the same person.
   */
  it("indexes the repeat-contact lookup by marketplace and buyer", () => {
    expect(up).toContain("CREATE INDEX IF NOT EXISTS ix_customer_case_history_counterparty");
    const at = up.indexOf("ix_customer_case_history_counterparty");
    expect(up.slice(at, at + 200)).toMatch(/\(\s*marketplace\s*,\s*counterparty_ref\s*\)/);
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
    expect(down).not.toMatch(/\bDELETE\b/i);
    expect(down).not.toMatch(/\bTRUNCATE\b/i);
    expect(down).not.toMatch(/\bUPDATE\b/i);
  });

  /** Rolling this back must not disturb the tables the application reads today. */
  it("leaves conversations and agent_activity intact", () => {
    expect(down).not.toMatch(/conversations/i);
    expect(down).not.toMatch(/agent_activity/i);
    expect(down).not.toMatch(/context_snapshots/i);
  });
});

describe("applied status is declared", () => {
  /**
   * This repository has no migrations ledger — the README says so plainly — so
   * the header IS the history, and a reader of the SQL alone must be able to
   * tell whether it has run. 0007's header still read NOT EXECUTED while its
   * column was live and populated, which is the confusion this check exists to
   * prevent recurring in either direction.
   *
   * 0021 was applied to varmen_db.cst_app on 2026-10-01, taking the base-table
   * count from 32 to 33 with no existing row touched. This test was the
   * NOT EXECUTED assertion until then, and was flipped as part of applying it
   * rather than afterwards — the header and this test move together or the
   * ledger lies.
   */
  it("records when and where it was applied", () => {
    expect(upRaw).toMatch(/STATUS:\s+APPLIED 2026-10-01 to varmen_db, schema cst_app/);
    expect(upRaw).not.toMatch(/STATUS:\s+NOT EXECUTED/);
  });

  /**
   * The migration created the table EMPTY. The 1,098 rows arrived afterwards
   * from a separate, explicitly approved one-time importer — and that
   * distinction has to survive in the record, because a migration that both
   * creates and populates is one a reviewer cannot roll back with confidence.
   */
  it("records that the migration itself imported no data", () => {
    expect(upRaw).toMatch(/deployed EMPTY/);
    expect(upRaw).toMatch(/imported nothing/);
  });

  /**
   * The blast radius, stated as a measurement rather than a promise. An exact
   * row census of all 32 pre-existing tables was taken before and after.
   */
  it("records the measured blast radius", () => {
    expect(upRaw).toMatch(/32 -> 33/);
    expect(upRaw).toMatch(/no\s*--\s*existing table gained, lost or changed a row/);
  });

  /**
   * The two facts a reviewer of this migration most needs, and both are
   * inferences or limits rather than measurements — so they must stay stated
   * rather than become folklore: `cases` has been dead since 2025-05-31
   * (supersession by `inquiries` is NOT verified), and the eBay-only finding
   * comes from sub_source.source_id rather than from the table names.
   */
  it("states the cases table is historical and that supersession is unverified", () => {
    expect(upRaw).toMatch(/2025-05-31/);
    expect(upRaw).toMatch(/Supersession is the obvious reading and is NOT verified/);
  });

  it("states that the eBay-only finding was verified, and how", () => {
    expect(upRaw).toMatch(/ALL THREE TABLES ARE EBAY-ONLY/);
    expect(upRaw).toMatch(/sub_source\.source_id = 2|source_id = 2/);
  });
});
