import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Static review of the MySQL-source migrations: 0016 conversation_message_media,
 * 0017 agent_activity, 0018 agent_directory.
 *
 * These tests read the SQL as text and NEVER connect to a database, which is the
 * approach `cst-core-schema.test.ts` established and the reason the suite runs
 * anywhere. None of these migrations has been executed; there is deliberately no
 * test here that would require them to have been.
 *
 * WHAT THIS SUITE IS GUARDING. Three of these migrations read from MySQL
 * databases owned by other projects. The risks that matter are not "does the SQL
 * parse" — they are: a credential copied out of a user table, a customer's
 * message text duplicated into an activity log, an existing column altered by a
 * migration that claimed to be additive, and a rollback that takes a neighbour
 * with it. Each has a test below.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

const MIGRATIONS = [
  { number: "0016", slug: "conversation_message_media", table: "cst_app.conversation_message_media" },
  { number: "0017", slug: "agent_activity", table: "cst_app.agent_activity" },
  { number: "0018", slug: "agent_directory", table: "cst_app.agent_directory" },
] as const;

/**
 * Strips SQL comments so prose in a header block cannot satisfy or trip a check.
 * These headers discuss passwords, `issue_tracking`, CASCADE and DROP at length;
 * without this every assertion below would fail on the explanation of why the
 * thing is not being done. String literals are preserved deliberately — the
 * vocabulary under test lives inside them.
 */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Executable statements only, with two further things removed.
 *
 * `COMMENT ON ... IS '...'` is documentation that happens to live in a string
 * literal, and these migrations use it to say what they deliberately do NOT do
 * ("not related to cst_app.app_users", "holds no credential"). Read as code, a
 * table comment saying a thing is absent reads as the thing being present.
 *
 * `ON DELETE CASCADE` / `ON DELETE SET NULL` are referential actions, not DML.
 * Left in, a foreign key declaration reads as a row deletion.
 *
 * Both were false positives in the first run of this suite, on migrations that
 * were correct.
 */
function statements(sql: string): string {
  return code(sql)
    .replace(/COMMENT\s+ON\s+[\s\S]*?;/gi, " ")
    .replace(/ON\s+(DELETE|UPDATE)\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+(NULL|DEFAULT))/gi, " ");
}

type Loaded = { up: string; down: string; upRaw: string };
const loaded = new Map<string, Loaded>();

function pathFor(number: string, slug: string, dir: "up" | "down"): string {
  return join(MIGRATIONS_DIR, `${number}_${slug}.${dir}.sql`);
}

beforeAll(() => {
  for (const m of MIGRATIONS) {
    const upRaw = readFileSync(pathFor(m.number, m.slug, "up"), "utf8");
    loaded.set(m.number, {
      upRaw,
      up: code(upRaw),
      down: code(readFileSync(pathFor(m.number, m.slug, "down"), "utf8")),
    });
  }
});

describe("the migration pairs", () => {
  it.each(MIGRATIONS)("$number has an up migration and a matching rollback", (m) => {
    expect(existsSync(pathFor(m.number, m.slug, "up"))).toBe(true);
    expect(existsSync(pathFor(m.number, m.slug, "down"))).toBe(true);
  });

  /**
   * NUMBERING. `follow-up-reminders.test.ts` added this after two branches both
   * shipped a `0012`; three new migrations arriving together is exactly the
   * situation that caused it, so it is re-asserted over the whole directory.
   */
  it("no two migrations in the repository share a number", () => {
    const numbers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".up.sql"))
      .map((f) => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it.each(MIGRATIONS)("$number is wrapped in a single transaction", (m) => {
    const { up, down } = loaded.get(m.number)!;
    for (const sql of [up, down]) {
      expect(sql).toMatch(/\bBEGIN\b/);
      expect(sql).toMatch(/\bCOMMIT\b/);
    }
  });

  it.each(MIGRATIONS)("$number is re-runnable", (m) => {
    expect(loaded.get(m.number)!.up).toMatch(/CREATE TABLE IF NOT EXISTS/);
  });
});

describe("additive only — existing data is preserved", () => {
  /**
   * The strongest guarantee these migrations make. A purely additive migration
   * cannot lose a row, so the way to keep that promise is to make the
   * statements that could lose one absent rather than reviewed.
   */
  it.each(MIGRATIONS)("$number alters no existing table", (m) => {
    expect(loaded.get(m.number)!.up).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it.each(MIGRATIONS)("$number drops nothing", (m) => {
    expect(loaded.get(m.number)!.up).not.toMatch(/\bDROP\b/i);
  });

  it.each(MIGRATIONS)("$number writes no rows", (m) => {
    const up = statements(loaded.get(m.number)!.upRaw);
    expect(up).not.toMatch(/\bINSERT\b/i);
    expect(up).not.toMatch(/\bUPDATE\b/i);
    expect(up).not.toMatch(/\bDELETE\b/i);
    expect(up).not.toMatch(/\bTRUNCATE\b/i);
  });

  /**
   * 0007's column carries Shopify (561 in / 224 out) and B&Q (63) attachments
   * today. 0016 adds eBay media alongside it and must not touch it.
   */
  it("0016 leaves conversation_messages.attachments alone", () => {
    const up = loaded.get("0016")!.up;
    expect(up).not.toMatch(/attachments/i);
    expect(up).not.toMatch(/ALTER\s+TABLE\s+cst_app\.conversation_messages/i);
  });

  /**
   * The central decision of 0018: app_users belongs to a different authority
   * (issue_tracking) whose ids collide with order_management's and name
   * different people. The migration must not reach for it.
   */
  it("0018 does not alter, populate or re-comment app_users", () => {
    const raw = loaded.get("0018")!.upRaw;
    // No executable statement touches it...
    expect(statements(raw)).not.toMatch(/app_users/i);
    // ...and no COMMENT ON is retargeted at it either. The table's own comment
    // may still *mention* app_users to say the two are unrelated, which is the
    // point of the migration rather than a violation of it.
    expect(code(raw)).not.toMatch(/COMMENT\s+ON\s+(TABLE|COLUMN)\s+cst_app\.app_users/i);
  });
});

describe("cst_app is the only target", () => {
  it.each(MIGRATIONS)("$number creates its table inside cst_app", (m) => {
    expect(loaded.get(m.number)!.up).toContain(`CREATE TABLE IF NOT EXISTS ${m.table}`);
  });

  it.each(MIGRATIONS)("$number names no other project's schema", (m) => {
    const { up, down } = loaded.get(m.number)!;
    for (const sql of [up, down]) {
      expect(sql).not.toMatch(/\bissue_tracking\./i);
      expect(sql).not.toMatch(/\bpoc_listing\./i);
      expect(sql).not.toMatch(/\bpublic\./i);
    }
  });

  /**
   * MySQL is strictly a read-only source. No migration may create, alter or
   * write any object in it — the connection details exist for a reader, and a
   * migration is not one.
   */
  it.each(MIGRATIONS)("$number creates nothing in a source database", (m) => {
    const { upRaw, down } = loaded.get(m.number)!;
    for (const sql of [statements(upRaw), down]) {
      expect(sql).not.toMatch(/\bmessage_app\./i);
      expect(sql).not.toMatch(/\border_management\./i);
      expect(sql).not.toMatch(/\bledsone\./i);
      expect(sql).not.toMatch(/\bcustomer_service\./i);
    }
  });
});

describe("no credential or personal data is copied", () => {
  /**
   * `order_management.user` holds user_password, token, verification_code and
   * fcm_token alongside the name. A column that is not here cannot leak, so the
   * test is that the names never appear in a CREATE TABLE at all.
   */
  const FORBIDDEN = [
    "password", "passwd", "pwd", "hash", "salt", "token",
    "verification_code", "fcm", "secret", "credential",
    "email", "contact", "phone", "gender", "address", "user_image",
  ];

  it.each(MIGRATIONS)("$number copies no credential or contact field", (m) => {
    const up = statements(loaded.get(m.number)!.upRaw).toLowerCase();
    for (const word of FORBIDDEN) {
      expect(up).not.toContain(word);
    }
  });

  /**
   * The activity log's `data` column is a JSON blob containing the full text of
   * the reply that was sent and the customer's email address. Only the one
   * identifier needed for the join is lifted out; the payload must not be
   * stored, and neither must a second copy of any message content.
   */
  it("0017 stores no message payload and no customer text", () => {
    const up = loaded.get("0017")!.up;
    expect(up).not.toMatch(/\bbody_text\b/i);
    expect(up).not.toMatch(/\bmessage_content\b/i);
    expect(up).not.toMatch(/\breplied_message_text\b/i);
    expect(up).not.toMatch(/\bsubject\b/i);
    expect(up).not.toMatch(/\bjsonb\b/i);
    expect(up).not.toMatch(/\bpayload\b/i);
  });

  /** 0016 records where an image is, never the image. */
  it("0016 stores no file bytes", () => {
    const up = loaded.get("0016")!.up;
    expect(up).not.toMatch(/\bbytea\b/i);
    expect(up).not.toMatch(/\bblob\b/i);
  });
});

describe("no sending capability is introduced", () => {
  it.each(MIGRATIONS)("$number adds no transport structure", (m) => {
    const up = loaded.get(m.number)!.up.toLowerCase();
    for (const word of ["smtp", "outbound_queue", "recipient", "scheduled_send", "transport"]) {
      expect(up).not.toContain(word);
    }
  });
});

describe("source identity and idempotency", () => {
  /**
   * The unique key on source identity is what makes a re-run an upsert instead
   * of a duplicate, and it is what the sync's correctness rests on rather than
   * the watermark being right — the same reasoning as
   * `uq_conversation_messages_source_identity`.
   */
  it.each([
    { number: "0016", index: "uq_conversation_message_media_source_identity" },
    { number: "0017", index: "uq_agent_activity_source_identity" },
  ])("$number has a unique index on (source_database, source_table, source_pk)", (c) => {
    const up = loaded.get(c.number)!.up;
    expect(up).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${c.index}`);
    const at = up.indexOf(c.index);
    expect(up.slice(at, at + 200)).toMatch(
      /\(\s*source_database\s*,\s*source_table\s*,\s*source_pk\s*\)/,
    );
  });

  /**
   * 0018's key is compound on purpose: it makes a collision between two source
   * directories a constraint violation rather than a misattributed agent.
   */
  it("0018 keys the directory by (source_system, source_user_id)", () => {
    const up = loaded.get("0018")!.up;
    expect(up).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_directory_source_identity");
    const at = up.indexOf("uq_agent_directory_source_identity");
    expect(up.slice(at, at + 200)).toMatch(/\(\s*source_system\s*,\s*source_user_id\s*\)/);
  });

  it.each(MIGRATIONS)("$number records which source database a row came from", (m) => {
    const up = loaded.get(m.number)!.up;
    expect(up).toMatch(/source_(database|system)\s+text\s+NOT NULL/);
  });

  /**
   * `files.ref_id` is kept so reconciliation is a local join. Without it,
   * re-checking one row walks back through two databases —
   * conversation_message_id -> external_message_id -> message_id ->
   * ext_message_id -> ref_id — against an account capped at 50 MySQL
   * connections per hour.
   *
   * bigint, not text: the reconciliation join is against
   * `ebay_message_headers.ext_message_id`, which is a bigint, and a type
   * mismatch there would silently disable the index.
   */
  it("0016 keeps the source join key it matched on", () => {
    const up = loaded.get("0016")!.up;
    expect(up).toMatch(/source_ref_id\s+bigint\s+NOT NULL/);
    expect(up).toContain("CREATE INDEX IF NOT EXISTS ix_conversation_message_media_source_ref");
    const at = up.indexOf("ix_conversation_message_media_source_ref");
    expect(up.slice(at, at + 160)).toMatch(/\(\s*source_ref_id\s*\)/);
  });
});

describe("relationships to existing tables", () => {
  it("0016 requires the message to exist, and cascades from it", () => {
    const up = loaded.get("0016")!.up;
    expect(up).toMatch(/conversation_message_id\s+bigint\s+NOT NULL/);
    expect(up).toMatch(
      /FOREIGN KEY \(conversation_message_id\)\s*REFERENCES cst_app\.conversation_messages \(id\) ON DELETE CASCADE/,
    );
  });

  /**
   * SET NULL, not CASCADE: losing the link to a removed conversation is
   * acceptable, losing the record that an agent did the work is not.
   */
  it("0017 keeps the activity record when a conversation is removed", () => {
    const up = loaded.get("0017")!.up;
    expect(up).toMatch(
      /FOREIGN KEY \(conversation_id\)\s*REFERENCES cst_app\.conversations \(id\) ON DELETE SET NULL/,
    );
  });

  /**
   * The activity table must not gain a foreign key into the directory, so that
   * rolling 0018 back cannot take the activity record with it, and so 0017 can
   * be applied while 0018 is still under review.
   */
  it("0017 holds no foreign key to the directory", () => {
    expect(loaded.get("0017")!.up).not.toMatch(/REFERENCES cst_app\.agent_directory/i);
  });
});

describe("constraints", () => {
  it("0016 refuses an empty or non-https media url", () => {
    const up = loaded.get("0016")!.up;
    expect(up).toMatch(/ck_conversation_message_media_url_present[\s\S]{0,120}length\(btrim\(media_url\)\) > 0/);
    expect(up).toMatch(/ck_conversation_message_media_url_https[\s\S]{0,120}media_url LIKE 'https:\/\/%'/);
  });

  it("0017 constrains match_status to the three real outcomes", () => {
    const up = loaded.get("0017")!.up;
    expect(up).toMatch(
      /ck_agent_activity_match_status[\s\S]{0,160}'matched'[\s\S]{0,40}'unmatched'[\s\S]{0,40}'no_reference'/,
    );
  });

  /**
   * THIS TEST EXISTS BECAUSE OF 0013, AND IT CAUGHT A REAL BUG IN 0017'S FIRST
   * DRAFT.
   *
   * The natural way to write the matched/conversation pairing is a
   * biconditional — `(match_status = 'matched') = (conversation_id IS NOT
   * NULL)`. Combined with the `ON DELETE SET NULL` above, deleting a
   * conversation would set the column to NULL on rows still reading 'matched'
   * and the biconditional would reject the delete with 23514. That is precisely
   * how `ck_automation_items_cancel_pair` broke Undo Cancel in 0011, and why
   * 0013 had to relax it.
   *
   * The implication must therefore run one way only.
   */
  it("0017 pairs matched/conversation with a one-way implication, never a biconditional", () => {
    const up = loaded.get("0017")!.up;
    expect(up).toMatch(
      /ck_agent_activity_conversation_implies_matched[\s\S]{0,600}conversation_id IS NULL OR match_status = 'matched'/,
    );
    expect(up).not.toMatch(/\(match_status = 'matched'\)\s*=\s*\(conversation_id IS NOT NULL\)/);
  });

  /**
   * THE PRICE OF THAT ONE-WAY FORM, recorded so it is not rediscovered as a bug.
   *
   * Verified against PostgreSQL in a rolled-back transaction: the constraint
   * ACCEPTS `INSERT (match_status='matched', conversation_id=NULL)`. A CHECK
   * sees a row, not whether it arrived by INSERT or by the ON DELETE SET NULL
   * cascade, so the looseness that keeps a conversation delete working is the
   * same looseness an importer bug could walk through.
   *
   * The alternatives are worse — a biconditional breaks the delete with 23514
   * (0013), RESTRICT blocks deleting a conversation somebody once worked on,
   * and a trigger would be the only non-declarative constraint in this schema
   * outside 0015. So the importer owns it, and the migration says so in the
   * constraint's own comment. This test fails if that admission is ever
   * removed.
   */
  it("0017 documents that the importer, not the schema, owns the matched/NULL insert", () => {
    const raw = loaded.get("0017")!.upRaw;
    expect(raw).toMatch(/WHAT THIS DELIBERATELY DOES NOT CATCH/);
    expect(raw).toMatch(/importer must never write 'matched' without a\s*--\s*conversation id/);
  });

  it("0017 uses the same marketplace vocabulary as sync_state", () => {
    const up = loaded.get("0017")!.up;
    const at = up.indexOf("ck_agent_activity_marketplace");
    const clause = up.slice(at, at + 300);
    for (const mk of ["ebay", "amazon", "shopify", "bandq", "temu"]) {
      expect(clause).toContain(`'${mk}'`);
    }
  });

  it("0017 stores the source's DATE as a date, implying no precision it lacks", () => {
    expect(loaded.get("0017")!.up).toMatch(/action_date\s+date\s+NOT NULL/);
  });

  it("0018 refuses a nameless agent and an unknown directory", () => {
    const up = loaded.get("0018")!.up;
    expect(up).toMatch(/ck_agent_directory_display_name_present[\s\S]{0,140}length\(btrim\(display_name\)\) > 0/);
    expect(up).toMatch(/ck_agent_directory_source_system[\s\S]{0,140}'order_management'/);
  });
});

describe("rollback safety", () => {
  it.each(MIGRATIONS)("$number rolls back with RESTRICT, never CASCADE", (m) => {
    const down = loaded.get(m.number)!.down;
    expect(down).toContain(`DROP TABLE IF EXISTS ${m.table} RESTRICT`);
    expect(down).not.toMatch(/CASCADE/i);
  });

  it.each(MIGRATIONS)("$number drops exactly one table and nothing else", (m) => {
    const down = loaded.get(m.number)!.down;
    expect(down.match(/DROP TABLE/gi)?.length).toBe(1);
    expect(down).not.toMatch(/DROP INDEX/i);
    expect(down).not.toMatch(/DROP SCHEMA/i);
    expect(down).not.toMatch(/DROP COLUMN/i);
    expect(down).not.toMatch(/\bALTER\b/i);
  });

  it.each(MIGRATIONS)("$number's rollback deletes no row from another table", (m) => {
    const down = loaded.get(m.number)!.down;
    expect(down).not.toMatch(/\bDELETE\b/i);
    expect(down).not.toMatch(/\bTRUNCATE\b/i);
    expect(down).not.toMatch(/\bUPDATE\b/i);
  });

  /** Rolling back eBay media must not disturb the marketplaces already working. */
  it("0016's rollback leaves the attachments column intact", () => {
    expect(loaded.get("0016")!.down).not.toMatch(/attachments/i);
  });

  /** Rolling back the directory must not take the activity record with it. */
  it("0018's rollback leaves agent_activity intact", () => {
    const down = loaded.get("0018")!.down;
    expect(down).not.toMatch(/DROP TABLE IF EXISTS cst_app\.agent_activity/i);
    expect(down).not.toMatch(/app_users/i);
  });
});

describe("applied status is declared", () => {
  /**
   * All three were applied to varmen_db.cst_app on 2026-09-23, taking the
   * base-table count from 27 to 30 with no existing row touched and no data
   * imported.
   *
   * This repository has no migrations ledger table — the README says so
   * plainly ("No migration framework") — so the header IS the history, and a
   * reader of the SQL alone must be able to tell whether it has run. 0007's
   * header still reads NOT EXECUTED while its column is live and populated,
   * which is exactly the confusion this test exists to prevent recurring.
   */
  it.each(MIGRATIONS)("$number records when and where it was applied", (m) => {
    const raw = loaded.get(m.number)!.upRaw;
    expect(raw).toMatch(/STATUS:\s+APPLIED 2026-09-23 to varmen_db, schema cst_app/);
    expect(raw).not.toMatch(/STATUS:\s+NOT EXECUTED/);
  });

  it.each(MIGRATIONS)("$number records that it imported no data", (m) => {
    expect(loaded.get(m.number)!.upRaw).toMatch(/deployed\s*--?\s*empty|table was deployed\s+empty/);
  });

  /**
   * The decision 0018 was blocked on — whether these ids belong in app_users —
   * was resolved in favour of a separate table. The header must record that it
   * was decided, not still leave a reader waiting for it.
   */
  it("0018 records that the app_users decision was made, not still pending", () => {
    const raw = loaded.get("0018")!.upRaw;
    expect(raw).toMatch(/was reviewed and the separate directory was approved/);
    expect(raw).not.toMatch(/BLOCKED ON REVIEW/);
  });
});
