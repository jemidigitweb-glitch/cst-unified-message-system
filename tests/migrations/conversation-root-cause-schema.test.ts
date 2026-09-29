import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Static review of the conversation root cause migration (0020).
 *
 * READS THE SQL AS TEXT AND NEVER CONNECTS, the approach
 * `cst-core-schema.test.ts` established and the reason this suite runs
 * anywhere. What a static read cannot prove — that the migration applies, that
 * the CHECKs really reject a bad courier, that the rollback really removes only
 * this table — is verified against the application database when it is applied
 * by hand, inside a transaction that is rolled back.
 *
 * ---------------------------------------------------------------------------
 * WHY THE VOCABULARY LISTS ARE ASSERTED HERE, LABEL BY LABEL
 * ---------------------------------------------------------------------------
 * `courier` and `courier_issue_type` are the REPORTING DIMENSIONS — the whole
 * feature exists so somebody can ask which courier causes the most problems and
 * get a number they can act on. Those two CHECK lists and the option lists the
 * screen offers have to be the same list, or a selection a CST agent can make
 * becomes a save that fails, and a courier the database will accept becomes one
 * no agent can ever choose.
 *
 * So the ten couriers and ten issue types are pinned in BOTH places: here
 * against the SQL, and in `tests/domain/root-cause-vocabulary.test.ts` against
 * the TypeScript the screen renders from. Editing one list without the other
 * fails a test rather than shipping a form that half-works.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const UP = join(MIGRATIONS_DIR, "0020_conversation_root_cause.up.sql");
const DOWN = join(MIGRATIONS_DIR, "0020_conversation_root_cause.down.sql");

const TABLE = "cst_app.conversation_root_causes";

/**
 * Strips SQL comments so prose in a header block cannot satisfy or trip a
 * check. String literals are preserved deliberately — the two vocabularies
 * under test live inside them.
 */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Text of a named CONSTRAINT clause, for asserting on its contents.
 *
 * THE NAME IS MATCHED WHOLE, not as a prefix. Two constraints here start with
 * `ck_conversation_root_causes_issue_type`, and a plain `indexOf` handed the
 * issue-type VOCABULARY test the text of the issue-type-needs-courier
 * constraint instead — a passing-looking lookup that was reading the wrong
 * clause.
 *
 * IT ALSO ENDS WHERE THE CONSTRAINT ENDS rather than after a fixed number of
 * characters. A fixed window ran past the end of the courier list into the
 * issue-type list, and past the end of that one into a COMMENT — so the
 * vocabulary tests were asserting on labels from the next clause along.
 */
function constraintClause(sql: string, name: string): string {
  const at = new RegExp(`CONSTRAINT\\s+${name}(?![\\w])`).exec(sql)?.index;
  if (at === undefined) return "";
  const rest = sql.slice(at);
  const end = /[\s\S]+?(?=\n\s*CONSTRAINT\b|\bCOMMENT\s+ON\b|\bCREATE\s+INDEX\b|$)/.exec(rest);
  return end?.[0] ?? rest;
}

let upRaw: string;
let up: string;
let down: string;

/**
 * Just the parent `CREATE TABLE` block.
 *
 * ADDED WHEN THE CHILD TABLE ARRIVED, because assertions written against the
 * whole file silently started reading both tables at once — "every column" and
 * "every constraint" quietly became "every column in either table", and the
 * duplicate-name check began comparing `root_cause` against itself.
 */
function parentTable(): string {
  const start = up.indexOf(`CREATE TABLE IF NOT EXISTS ${TABLE}`);
  const end = up.indexOf("CREATE TABLE", start + 20);
  return up.slice(start, end === -1 ? undefined : end);
}

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

  it("gives every migration its own sequence number", () => {
    const ups = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql"));
    const numbers = ups.map((f) => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("is the only 0020", () => {
    const ups = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql"));
    expect(ups.filter((f) => f.startsWith("0020_"))).toHaveLength(1);
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
  it("creates its two tables in cst_app, and nothing else anywhere", () => {
    const creates = [...up.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi)];
    expect(creates.map(([, name]) => name)).toEqual([
      TABLE,
      "cst_app.conversation_root_cause_labels",
    ]);
  });

  /**
   * THE HEADER CARRIES NO LABEL OF ITS OWN. Every selected cause is a row in
   * the child table, and they are peers — so a `root_cause` column here would
   * be a primary in all but name, and a report would have to invent a meaning
   * for the distinction.
   */
  it("carries no root cause label column", () => {
    expect(parentTable()).not.toMatch(/^\s{2}root_cause\s+text/im);
    expect(parentTable()).not.toMatch(/is_primary/i);
  });

  it("carries exactly the agreed columns", () => {
    for (const column of [
      /id\s+bigint\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/i,
      /conversation_id\s+bigint\s+NOT\s+NULL/i,
      /custom_root_cause\s+text\s*,/i,
      /courier\s+text\s*,/i,
      /courier_issue_type\s+text\s*,/i,
      /issue_note\s+text\s*,/i,
      /vocabulary_version\s+integer\s+NOT\s+NULL/i,
      /recorded_by_user_id\s+bigint\s*,/i,
      /recorded_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i,
    ]) {
      expect(up).toMatch(column);
    }
  });

  /**
   * APPEND-ONLY MEANS NO ROW EVER CHANGES, so there is nothing for an
   * `updated_at` to record and nothing for a soft-delete flag to hide. A column
   * of either kind would be the first sign this table had started overwriting
   * its own history, which is the one behaviour of the message application's
   * that this deliberately does not copy.
   */
  it("carries no column that implies a row is ever edited or hidden", () => {
    for (const forbidden of [
      /updated_at/i,
      /deleted_at/i,
      /is_deleted/i,
      /\bactive\b/i,
      /superseded/i,
      /\bstatus\b/i,
    ]) {
      expect(up).not.toMatch(forbidden);
    }
  });

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
    expect(constraintClause(up, "fk_conversation_root_causes_conversation")).toMatch(
      /FOREIGN\s+KEY\s*\(\s*conversation_id\s*\)\s*REFERENCES\s+cst_app\.conversations\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i,
    );
  });

  /**
   * SET NULL on the author, matching `internal_notes` and `draft_revisions`.
   * Removing a person from the user table must not remove the decision they
   * recorded about a case — a courier report with rows missing is worse than
   * one with an unnamed author.
   */
  it("keeps a recorded decision when its author is removed", () => {
    expect(constraintClause(up, "fk_conversation_root_causes_user")).toMatch(
      /FOREIGN\s+KEY\s*\(\s*recorded_by_user_id\s*\)\s*REFERENCES\s+cst_app\.app_users\s*\(\s*id\s*\)\s*ON\s+DELETE\s+SET\s+NULL/i,
    );
  });

  it("declares foreign keys only between cst_app tables", () => {
    const fks = [...up.matchAll(/REFERENCES\s+([\w.]+)/gi)];
    // Two on the parent (conversation, author) and one on the child (parent).
    expect(fks.length).toBe(3);
    for (const [, target] of fks) {
      expect(target.startsWith("cst_app.")).toBe(true);
    }
  });

  it("treats a blank label as no label", () => {
    expect(constraintClause(up, "ck_conversation_root_cause_labels_present")).toMatch(
      /CHECK\s*\(\s*length\s*\(\s*btrim\s*\(\s*root_cause\s*\)\s*\)\s*>\s*0\s*\)/i,
    );
  });

  /**
   * THE OTHER <-> EXPLANATION RULE IS NOT IN THIS SCHEMA, AND THAT IS
   * DELIBERATE RATHER THAN FORGOTTEN.
   *
   * `OTHER` is now one of the labels in the CHILD table while the explanation
   * lives on the PARENT, so the rule is a condition across two tables.
   * PostgreSQL can express that only with a trigger or a deferred constraint,
   * and this migration adds neither — a trigger firing on every label insert is
   * a fragile thing to own for a rule the writer already guarantees.
   *
   * `readRootCauseSelection` refuses either half before a write, and the
   * repository writes both tables in one transaction so no partial state is
   * observable. This test pins the ABSENCE so nobody later reads the schema and
   * assumes the database is checking.
   */
  it("does not try to enforce the OTHER pairing in SQL, and says so", () => {
    expect(up).not.toContain("ck_conversation_root_causes_other_pair");
    expect(up).not.toContain("ck_conversation_root_causes_other_explained");
    expect(up).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(up).not.toMatch(/DEFERRABLE/i);
    // The file must tell a reader where the rule actually lives.
    expect(upRaw).toMatch(/root-cause-selection\.ts/);
  });

  /**
   * AND `OTHER` IS AN ORDINARY LABEL. It may be selected alongside any other
   * cause, so nothing in the schema may forbid it — an earlier draft did, back
   * when OTHER was primary-only.
   */
  it("admits OTHER as a label like any other", () => {
    expect(up).not.toMatch(/root_cause\s*\)\s*\)\s*<>\s*'OTHER'/i);
    expect(up).not.toContain("ck_conversation_root_cause_labels_not_other");
  });

  /** An explanation of nothing is not an explanation. Whitespace is nothing. */
  it("treats a blank typed cause as no typed cause", () => {
    expect(constraintClause(up, "ck_conversation_root_causes_custom_present")).toMatch(
      /CHECK\s*\(\s*custom_root_cause\s+IS\s+NULL\s+OR\s+length\s*\(\s*btrim\s*\(\s*custom_root_cause\s*\)\s*\)\s*>\s*0\s*\)/i,
    );
  });

  /**
   * TWO SEPARATE COLUMNS, AND THE REPORT DEPENDS ON IT. A future export must be
   * able to put "Root Cause" and "Custom Root Cause" in different columns, and
   * neither may be the issue note.
   */
  it("keeps the typed cause and the note as separate parent columns, with labels elsewhere", () => {
    const parent = parentTable();
    for (const column of [/\bcustom_root_cause\b/, /\bissue_note\b/]) {
      expect(parent).toMatch(column);
    }
    // The labels are NOT on the parent; they are rows in the child table.
    expect(parent).not.toMatch(/^\s{2}root_cause\s+text/im);
    expect(up).toMatch(
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+cst_app\.conversation_root_cause_labels/i,
    );

    const declared = [...parent.matchAll(/^\s{2}(\w+)\s+text\b/gim)].map(([, n]) => n);
    expect(declared).toEqual(["custom_root_cause", "courier", "courier_issue_type", "issue_note"]);
  });
  /**
   * ONE-WAY ON PURPOSE. An issue type describes a courier's conduct, so it
   * cannot be recorded without naming the courier; the reverse is legitimate,
   * because which courier carried it is often known before the kind of problem
   * has been established. A biconditional here would block that honest
   * half-record and push an agent into guessing an issue type.
   */
  it("requires a courier before an issue type, and not the other way round", () => {
    const clause = constraintClause(up, "ck_conversation_root_causes_issue_type_needs_courier");
    expect(clause).toMatch(
      /CHECK\s*\(\s*courier_issue_type\s+IS\s+NULL\s+OR\s+courier\s+IS\s+NOT\s+NULL\s*\)/i,
    );
    expect(clause).not.toMatch(/courier\s+IS\s+NULL\s+OR\s+courier_issue_type\s+IS\s+NOT\s+NULL/i);
  });

  it("treats an empty note as no note", () => {
    expect(constraintClause(up, "ck_conversation_root_causes_note_present")).toMatch(
      /CHECK\s*\(\s*issue_note\s+IS\s+NULL\s+OR\s+length\s*\(\s*btrim\s*\(\s*issue_note\s*\)\s*\)\s*>\s*0\s*\)/i,
    );
  });

  /**
   * THE TEN COURIERS, VERBATIM AND IN ORDER.
   *
   * Pinned label by label rather than by count, because a count passes when one
   * spelling is quietly changed — and a changed spelling is exactly the failure
   * this CHECK exists to prevent. `EVRI` reading `Evri` tomorrow would split one
   * courier across two rows of the report and understate both.
   */
  it("admits exactly the ten agreed couriers", () => {
    const clause = constraintClause(up, "ck_conversation_root_causes_courier");
    expect(clause).toMatch(/CHECK\s*\(\s*courier\s+IS\s+NULL\s+OR\s+courier\s+IN\s*\(/i);
    const listed = [...clause.matchAll(/'([^']+)'/g)].map(([, label]) => label);
    expect(listed).toEqual([
      "Royal Mail",
      "EVRI",
      "DHL",
      "DPD",
      "GLS",
      "Amazon Shipping",
      "USPS",
      "Intelcom",
      "Smart Track",
      "Other",
    ]);
  });

  /**
   * The ten issue types, on the same terms and for the same reason — and with
   * one extra: THE CASING AND THE SLASHES ARE THE APPROVED ONES.
   *
   * Item 1 is capitalised and items 2-10 are not. That irregularity is the
   * business's specification, not a mistake to normalise, and an earlier draft
   * of this migration did normalise it — sentence case throughout, with `or`
   * written for `/`. It was corrected before this file was ever applied.
   *
   * Asserted as exact strings so re-tidying them fails here rather than in a
   * report six months from now, where one courier issue would appear on two
   * lines and understate both.
   */
  it("admits exactly the ten approved courier issue types, verbatim", () => {
    const clause = constraintClause(up, "ck_conversation_root_causes_issue_type");
    expect(clause).toMatch(
      /CHECK\s*\(\s*courier_issue_type\s+IS\s+NULL\s+OR\s+courier_issue_type\s+IN\s*\(/i,
    );
    const listed = [...clause.matchAll(/'([^']+)'/g)].map(([, label]) => label);
    expect(listed).toEqual([
      "Lost parcel",
      "transit damage",
      "parcel damaged by courier",
      "delivered to wrong address",
      "false/incorrect delivery scan",
      "delayed delivery",
      "no tracking update",
      "returned to sender",
      "collection/drop-off issue",
      "other",
    ]);
  });

  /**
   * The two separators the tidy-up removed, pinned on their own.
   *
   * A list assertion catches this too, but it fails with a twenty-line diff. A
   * named test says what actually went wrong: somebody wrote the word "or"
   * where the approved value has a slash.
   */
  it("keeps the slash in the two values that carry one", () => {
    const clause = constraintClause(up, "ck_conversation_root_causes_issue_type");
    expect(clause).toContain("'false/incorrect delivery scan'");
    expect(clause).toContain("'collection/drop-off issue'");
    expect(clause).not.toContain("false or incorrect");
    expect(clause).not.toContain("collection or drop-off");
  });

  /**
   * AND `root_cause` IS DELIBERATELY NOT CONSTRAINED. It holds a label from a
   * vocabulary that lives outside this schema and changes without telling us,
   * and — through the OTHER flow — an agent's own prose. A CHECK here would turn
   * a new label into a failed save rather than a row an operator can see.
   *
   * The only CHECK naming `root_cause` is the emptiness one and the OTHER one;
   * neither enumerates a value.
   */
  it("leaves the root cause label itself unconstrained", () => {
    const checks = [...parentTable().matchAll(/CONSTRAINT\s+(\w+)\s+CHECK/gi)].map(
      ([, name]) => name,
    );
    expect(checks).toEqual([
      "ck_conversation_root_causes_custom_present",
      "ck_conversation_root_causes_issue_type_needs_courier",
      "ck_conversation_root_causes_note_present",
      "ck_conversation_root_causes_courier",
      "ck_conversation_root_causes_issue_type",
    ]);
    expect(up).not.toMatch(/root_cause\s+IN\s*\(/i);
    // And the typed cause is equally unenumerated: it is an agent's own words.
    expect(up).not.toMatch(/custom_root_cause\s+IN\s*\(/i);
  });
});

describe("the additional-causes child table", () => {
  const CHILD = "cst_app.conversation_root_cause_labels";

  it("creates the child table alongside the parent, and nothing else", () => {
    const creates = [...up.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi)];
    expect(creates.map(([, name]) => name)).toEqual([TABLE, CHILD]);
  });

  it("carries exactly the agreed columns", () => {
    for (const column of [
      /id\s+bigint\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/i,
      /conversation_root_cause_id\s+bigint\s+NOT\s+NULL/i,
      /root_cause\s+text\s+NOT\s+NULL/i,
      /recorded_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i,
    ]) {
      expect(up).toMatch(column);
    }
  });

  /**
   * THE FOREIGN KEY POINTS AT A REVISION, NOT A CONVERSATION, and this is the
   * load-bearing decision in the whole child table.
   *
   * Recording a changed selection inserts a new parent and a fresh set of
   * children against it. Had these hung off the conversation, every revision's
   * labels would pile up together and a cause an agent had REMOVED would keep
   * being reported.
   */
  it("belongs to one parent revision, cascading", () => {
    expect(
      constraintClause(up, "fk_conversation_root_cause_labels_revision"),
    ).toMatch(
      /FOREIGN\s+KEY\s*\(\s*conversation_root_cause_id\s*\)\s*REFERENCES\s+cst_app\.conversation_root_causes\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i,
    );
    // Never the conversation directly.
    expect(up).not.toMatch(
      /fk_conversation_root_cause_labels[\s\S]{0,200}REFERENCES\s+cst_app\.conversations/i,
    );
  });

  /** One mention of a label per revision; a duplicate would double its count. */
  it("prevents the same label twice within one revision", () => {
    expect(constraintClause(up, "uq_conversation_root_cause_labels")).toMatch(
      /UNIQUE\s*\(\s*conversation_root_cause_id\s*,\s*root_cause\s*\)/i,
    );
  });

  /**
   * AND THE UNIQUENESS IS PER REVISION, NOT PER CONVERSATION. A conversation
   * whose cause is corrected twice legitimately carries the same additional
   * label on each revision.
   */
  it("does not make a label unique across a conversation's whole history", () => {
    const clause = constraintClause(up, "uq_conversation_root_cause_labels");
    expect(clause).not.toMatch(/conversation_id/i);
  });

  it("treats a blank additional label as no label", () => {
    expect(constraintClause(up, "ck_conversation_root_cause_labels_present")).toMatch(
      /CHECK\s*\(\s*length\s*\(\s*btrim\s*\(\s*root_cause\s*\)\s*\)\s*>\s*0\s*\)/i,
    );
  });

  /** There is no second vocabulary and no free text here. */
  it("holds no typed-cause column of its own", () => {
    const clause = /CREATE\s+TABLE[^;]*conversation_root_cause_labels[\s\S]*?\n\);/i.exec(
      up,
    )?.[0];
    expect(clause).toBeDefined();
    expect(clause).not.toMatch(/custom_root_cause/i);
    expect(clause).not.toMatch(/issue_note/i);
    expect(clause).not.toMatch(/courier/i);
  });

  /**
   * THE RULE THE DATABASE CANNOT ENFORCE, stated in the migration so nobody
   * assumes it does. An additional label must not repeat the parent's own
   * `root_cause`, which is a comparison against another row — invisible to a
   * CHECK, and 0020 adds no triggers.
   */
  it("says in the file that the primary-repeat rule lives in the domain", () => {
    expect(upRaw).toMatch(/root-cause-selection\.ts/);
    expect(up).not.toMatch(/CREATE\s+TRIGGER/i);
  });

  /** Mention counting is a different question from case counting. */
  it("indexes the label for mention counts", () => {
    expect(up).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+ix_conversation_root_cause_labels_label\s+ON\s+cst_app\.conversation_root_cause_labels\s*\(\s*root_cause\s*,\s*recorded_at\s+DESC\s*\)/i,
    );
  });
});

describe("indexes", () => {
  it("answers 'what is this conversation's current root cause' newest first", () => {
    expect(up).toMatch(
      new RegExp(
        `CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+ix_conversation_root_causes_conversation\\s+ON\\s+${TABLE.replace(".", "\\.")}\\s*\\(\\s*conversation_id\\s*,\\s*recorded_at\\s+DESC\\s*,\\s*id\\s+DESC\\s*\\)`,
        "i",
      ),
    );
  });

  /**
   * The courier index is PARTIAL, and that is the point of it: a row with no
   * courier can never satisfy a courier comparison, and most rows will have
   * none. Indexing them would pay for entries the report can never read.
   */
  it("indexes the courier comparison over courier rows only", () => {
    const clause = /ix_conversation_root_causes_courier[\s\S]{0,220}/.exec(up)?.[0] ?? "";
    expect(clause).toMatch(/\(\s*courier\s*,\s*courier_issue_type\s*,\s*recorded_at\s+DESC\s*\)/i);
    expect(clause).toMatch(/WHERE\s+courier\s+IS\s+NOT\s+NULL/i);
  });

  it("indexes the date-range read", () => {
    expect(up).toMatch(/ix_conversation_root_causes_recorded_at[\s\S]{0,120}\(\s*recorded_at\s+DESC/i);
  });

  it("qualifies every created index to cst_app", () => {
    const indexes = [
      ...up.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+([\w.]+)/gi),
    ];
    expect(indexes.length).toBe(4);
    for (const [, target] of indexes) {
      expect(target.startsWith("cst_app.")).toBe(true);
    }
  });

  /**
   * NO UNIQUE INDEX ON THE CONVERSATION. Append-only means many rows per
   * conversation is the normal case, not a duplicate — a unique constraint here
   * would make changing a root cause impossible and is the single most likely
   * well-meant edit to this file.
   */
  it("does not make a conversation's root cause unique", () => {
    expect(up).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    expect(up).not.toMatch(/UNIQUE\s*\(\s*conversation_id/i);
  });
});

describe("blast radius", () => {
  it("never alters, drops, or truncates another project's schema", () => {
    for (const schema of ["issue_tracking", "poc_listing", "review", "sku360", "public"]) {
      const ddl = new RegExp(`\\b(ALTER|DROP|TRUNCATE|GRANT|REVOKE)\\b[^;]*\\b${schema}\\b`, "i");
      expect(up).not.toMatch(ddl);
      expect(down).not.toMatch(ddl);
    }
  });

  /**
   * The source marketplace database is strictly read-only and must not appear
   * in a migration in any form. The header names `message_app` in prose to
   * explain WHY this table exists; the executable SQL must not.
   */
  it("names no source-database object in executable SQL", () => {
    expect(upRaw.toLowerCase()).toContain("message_app"); // the prose that says why
    for (const source of [
      /\bmessage_app\b/i,
      /\border_management\b/i,
      /\bcustomer_service\b/i,
      /\bmessages_headers\b/i,
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
    expect(up).not.toMatch(/\bUPDATE\s+cst_app/i);
  });

  it("adds no function or trigger", () => {
    expect(up).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(up).not.toMatch(/CREATE\s+TRIGGER/i);
  });
});

describe("the rollback", () => {
  /**
   * CHILD FIRST, AND THE ORDER IS NOT COSMETIC.
   *
   * The child holds a foreign key into the parent. Under RESTRICT, dropping the
   * parent while the child exists FAILS — correct, and exactly why CASCADE is
   * not used, but it would also make the rollback unrunnable the other way
   * round. This pins the order so a tidy-up cannot reverse it.
   */
  it("drops the child before its parent, with RESTRICT and never CASCADE", () => {
    const drops = [...down.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w.]+)\s+(\w+)/gi)];
    expect(drops).toHaveLength(2);
    expect(drops.map(([, name]) => name)).toEqual([
      "cst_app.conversation_root_cause_labels",
      TABLE,
    ]);
    for (const drop of drops) {
      expect(drop[2]!.toUpperCase()).toBe("RESTRICT");
    }
    expect(down).not.toMatch(/CASCADE/i);
  });

  it("drops no schema and no other object", () => {
    expect(down).not.toMatch(/DROP\s+SCHEMA/i);
    expect(down).not.toMatch(/DROP\s+INDEX/i);
    expect([...down.matchAll(/\bDROP\b/gi)]).toHaveLength(2);
  });

  /**
   * THE ROLLBACK DESTROYS HAND-RECORDED WORK, and unlike most down migrations
   * here that is not a formality: CST cannot write back to the message
   * application, so there is no upstream copy of these decisions to re-import.
   * The file has to say so where somebody about to run it will read it.
   */
  it("warns that it destroys work with no upstream copy", () => {
    const raw = readFileSync(DOWN, "utf8").toLowerCase();
    expect(raw).toMatch(/dump/);
    expect(raw).toMatch(/destroys/);
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

  /**
   * `address` and `delivered` would normally be on this list. They cannot be:
   * `Delivered to wrong address` is one of the ten issue types, and it is a
   * DESCRIPTION OF WHAT WENT WRONG, not a destination or a transport state. The
   * columns are checked by name instead of the file by keyword, which is the
   * stronger check anyway — a transport needs a column to read.
   */
  it("has no column a transport could read", () => {
    const columns = [
      ...parentTable().matchAll(/^\s{2}(\w+)\s+(?:bigint|text|integer|timestamptz)\b/gim),
    ].map(([, name]) => name);
    expect(columns).toEqual([
      "id",
      "conversation_id",
      "custom_root_cause",
      "courier",
      "courier_issue_type",
      "issue_note",
      "vocabulary_version",
      "recorded_by_user_id",
      "recorded_at",
    ]);
    for (const forbidden of ["recipient", "channel", "rendered_body", "template", "email", "phone"]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  /** And it stores no customer text: a note is an agent's own account. */
  it("stores no customer message, identity or address column", () => {
    for (const column of [
      /customer_name/i,
      /buyer_/i,
      /message_body/i,
      /\bsubject\b/i,
      /postcode/i,
      /shipping_address/i,
    ]) {
      expect(up).not.toMatch(column);
    }
  });
});
