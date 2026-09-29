import { describe, expect, it } from "vitest";

import type { RootCauseRecord } from "@/lib/domain/root-cause-selection";
import {
  getCurrentRootCause,
  getRootCauseHistory,
  isRejectedByConstraint,
  isRootCauseStoreMissing,
  isUnknownConversation,
  type Queryable,
  type Transactable,
  recordRootCause,
  ROOT_CAUSE_STATEMENTS,
} from "@/lib/repositories/conversation-root-cause-repository";

/**
 * The writer, against a recording fake. No database is touched.
 *
 * Synthetic identities only: conversation ids are invented numbers and every
 * root cause is a business classification, never customer content.
 */

type Call = { text: string; values?: unknown[] };

/**
 * A client answering every statement with the same rows, recording calls.
 *
 * `transactable` is the same fake wearing a pool's clothes, so the write tests
 * can keep using one helper. Transaction control lands in `calls` alongside
 * everything else, which is what makes the ordering assertions readable.
 */
function client(rows: unknown[]): {
  calls: Call[];
  queryable: Queryable;
  transactable: Transactable;
} {
  const calls: Call[] = [];
  const query = async (config: { text: string; values?: unknown[] }) => {
    calls.push(config);
    // Transaction control returns nothing; everything else gets the fixture.
    return { rows: /^(BEGIN|COMMIT|ROLLBACK)$/i.test(config.text.trim()) ? [] : rows };
  };
  return {
    calls,
    queryable: { query },
    transactable: { query, connect: async () => ({ query, release: () => {} }) },
  };
}

/**
 * A pool whose connection records every statement in order.
 *
 * THE ORDER IS THE POINT. Atomicity is not something a fake can prove by
 * itself, but the SHAPE of the exchange can be: BEGIN, insert, insert, COMMIT
 * on one connection, and a ROLLBACK plus a release when anything throws.
 *
 * `answers` maps a fragment of a statement to the rows it returns; `fails`
 * makes a matching statement throw, which is how the child-insert failure is
 * simulated.
 */
function pool(options: {
  answers?: { match: string; rows: unknown[] }[];
  fails?: { match: string; code?: string };
}): { calls: Call[]; released: number; transactable: Transactable } {
  const calls: Call[] = [];
  const state = { released: 0 };
  const transactable: Transactable = {
    query: async (config) => {
      calls.push(config);
      return { rows: [] };
    },
    connect: async () => ({
      query: async (config: { text: string; values?: unknown[] }) => {
        calls.push(config);
        if (options.fails && config.text.includes(options.fails.match)) {
          throw Object.assign(new Error("boom"), { code: options.fails.code ?? "23505" });
        }
        const answer = options.answers?.find((a) => config.text.includes(a.match));
        return { rows: answer?.rows ?? [] };
      },
      release: () => {
        state.released += 1;
      },
    }),
  };
  return {
    calls,
    get released() {
      return state.released;
    },
    transactable,
  };
}

/**
 * A read-only fake that answers the parent and label statements separately.
 *
 * NEEDED ONCE THE READS BECAME TWO STATEMENTS. A fake that returns the same
 * rows for everything would hand parent rows back to the label query, and the
 * grouping assertions would pass on nonsense.
 */
function reader(
  parents: unknown[],
  labels: { parent_id: string; root_cause: string }[] = [],
): { calls: Call[]; queryable: Queryable } {
  const calls: Call[] = [];
  return {
    calls,
    queryable: {
      query: async (config) => {
        calls.push(config);
        return {
          rows: config.text.includes("conversation_root_cause_labels") ? labels : parents,
        };
      },
    },
  };
}

/** The statement verbs issued, in order — BEGIN, INSERT, COMMIT and so on. */
function verbs(calls: Call[]): string[] {
  return calls.map((call) => {
    const text = call.text.trim();
    if (/^BEGIN$/i.test(text)) return "BEGIN";
    if (/^COMMIT$/i.test(text)) return "COMMIT";
    if (/^ROLLBACK$/i.test(text)) return "ROLLBACK";
    if (text.includes("INSERT INTO cst_app.conversation_root_cause_labels")) {
      return "INSERT children";
    }
    if (text.includes("INSERT INTO cst_app.conversation_root_causes")) return "INSERT parent";
    if (text.includes("FROM cst_app.conversation_root_cause_labels")) {
      return "SELECT children";
    }
    return "SELECT parent";
  });
}

/** A client that fails the way Postgres fails, with a code and nothing useful. */
function failing(code: string): Transactable {
  const query = async () => {
    throw Object.assign(new Error("boom"), { code });
  };
  // Fails on BEGIN, which is the earliest a broken connection shows itself.
  return { query, connect: async () => ({ query, release: () => {} }) };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "9001",
    custom_root_cause: null,
    courier: "EVRI",
    courier_issue_type: "Lost parcel",
    issue_note: "Scanned as delivered, customer has nothing.",
    vocabulary_version: 1,
    recorded_at: new Date("2026-09-29T08:00:00.000Z"),
    ...overrides,
  };
}

const RECORD: RootCauseRecord = {
  rootCauses: ["Delivery Issue"],
  customRootCause: null,
  courier: "EVRI",
  courierIssueType: "Lost parcel",
  issueNote: "Scanned as delivered, customer has nothing.",
  vocabularyVersion: 1,
};

describe("recording a selection", () => {
  it("inserts one row into one table and returns what the database stored", async () => {
    const app = client([row()]);

    const stored = await recordRootCause(app.transactable, "77", RECORD);

    // BEGIN, the insert, COMMIT - one transaction on one connection.
    expect(verbs(app.calls)).toEqual(["BEGIN", "INSERT parent", "INSERT children", "COMMIT"]);
    expect(stored).toEqual({
      id: "9001",
      rootCauses: ["Delivery Issue"],
      customRootCause: null,
      courier: "EVRI",
      courierIssueType: "Lost parcel",
      issueNote: "Scanned as delivered, customer has nothing.",
      vocabularyVersion: 1,
      recordedAt: "2026-09-29T08:00:00.000Z",
    });
  });

  it("binds every value, and interpolates none of them", async () => {
    const app = client([row()]);
    await recordRootCause(app.transactable, "77", RECORD);

    expect(app.calls[1]!.values).toEqual([
      "77",
      null,
      "EVRI",
      "Lost parcel",
      "Scanned as delivered, customer has nothing.",
      1,
    ]);
    // Nothing a caller supplied appears in the statement text itself.
    for (const value of ["77", "EVRI", "Delivery Issue", "Lost parcel"]) {
      expect(app.calls[1]!.text).not.toContain(value);
    }
  });

  it("stores an absent courier, issue type and note as nulls", async () => {
    const app = client([row({ courier: null, courier_issue_type: null, issue_note: null })]);

    const stored = await recordRootCause(app.transactable, "77", {
      rootCauses: ["OUT OF STOCK"],
      customRootCause: null,
      courier: null,
      courierIssueType: null,
      issueNote: null,
      vocabularyVersion: 1,
    });

    expect(app.calls[1]!.values).toEqual(["77", null, null, null, null, 1]);
    expect(stored.courier).toBeNull();
    expect(stored.courierIssueType).toBeNull();
    expect(stored.issueNote).toBeNull();
  });

  /**
   * THE AUTHOR COLUMN IS NOT IN THE STATEMENT AT ALL, rather than sent as NULL.
   * CST has no interactive sign-in, and a writer that cannot name an author is
   * better than one holding a parameter slot waiting for a caller to guess at
   * one — a courier report naming a person is read as fact about them.
   */
  it("names no author, and holds no slot for a guessed one", () => {
    expect(ROOT_CAUSE_STATEMENTS.insert).not.toContain("recorded_by_user_id");
    expect(ROOT_CAUSE_STATEMENTS.insert.match(/\$\d+/g)).toEqual([
      "$1",
      "$2",
      "$3",
      "$4",
      "$5",
      "$6",
    ]);
  });

  /**
   * BOTH HALVES OF AN `OTHER` ARE PERSISTED, IN SEPARATE COLUMNS.
   *
   * The label says the case was filed as OTHER; the typed text says what it
   * actually was. Writing the prose into `root_cause` — which is what the first
   * version did, copying the message application — would lose the first fact
   * entirely and make "how often does nothing fit" unanswerable.
   */
  it("stores the OTHER label and the typed cause in different columns", async () => {
    const typed = "Customer requested an unusual packaging change after dispatch";
    const app = client([
      row({
        root_cause: "OTHER",
        custom_root_cause: typed,
        courier: null,
        courier_issue_type: null,
        issue_note: "Warehouse had already packed the order.",
      }),
    ]);

    const stored = await recordRootCause(app.transactable, "77", {
      rootCauses: ["OTHER"],
      customRootCause: typed,
      courier: null,
      courierIssueType: null,
      issueNote: "Warehouse had already packed the order.",
      vocabularyVersion: 1,
    });

    // Bound in order: conversation, label, typed cause, courier, issue type, note, version.
    expect(app.calls[1]!.values).toEqual([
      "77",
      typed,
      null,
      null,
      "Warehouse had already packed the order.",
      1,
    ]);
    expect(ROOT_CAUSE_STATEMENTS.insert).toContain("custom_root_cause");

    // Read back as two distinct fields, and the note as a third.
    expect(stored.rootCauses).toEqual(["OTHER"]);
    expect(stored.customRootCause).toBe(typed);
    expect(stored.issueNote).toBe("Warehouse had already packed the order.");
    expect(stored.customRootCause).not.toBe(stored.issueNote);
  });

  /** And the column is read back, not dropped, on every statement. */
  it("selects the typed cause on every parent read", () => {
    // The child statements have no business with it: the typed cause belongs to
    // the primary OTHER, which lives on the parent row.
    for (const statement of [
      ROOT_CAUSE_STATEMENTS.insert,
      ROOT_CAUSE_STATEMENTS.current,
      ROOT_CAUSE_STATEMENTS.history,
    ]) {
      expect(statement).toContain("custom_root_cause");
    }
  });

  /**
   * IT RETURNS THE STORED ROW, NOT THE INPUT. `recorded_at` is the database's
   * own clock, so a caller reporting "recorded at" is reporting when the row was
   * really written rather than when a request happened to be assembled.
   */
  it("reports the database's instant, not the caller's", async () => {
    const app = client([row({ recorded_at: new Date("2026-09-29T09:30:00.000Z") })]);
    const stored = await recordRootCause(app.transactable, "77", RECORD);
    expect(stored.recordedAt).toBe("2026-09-29T09:30:00.000Z");
    expect(ROOT_CAUSE_STATEMENTS.insert).toContain("RETURNING");
  });

  it("raises rather than inventing a row when the insert returns none", async () => {
    const app = client([]);
    await expect(recordRootCause(app.transactable, "77", RECORD)).rejects.toThrow(/returned no row/);
  });
});

describe("recording a revision with additional causes", () => {
  const WITH_EXTRAS = { ...RECORD, rootCauses: ["PRODUCT_QUALITY", "PARTS MISSING"] };

  /**
   * ONE TRANSACTION, ONE CONNECTION, IN THIS ORDER.
   *
   * The parent revision and its labels are one recorded decision. Issued on the
   * pool directly they could land on different connections, and a failing child
   * would leave a parent claiming the agent chose nothing extra — a silently
   * wrong record, worse than a failed save because nobody would look again.
   */
  it("writes parent then children inside one transaction", async () => {
    const db = pool({ answers: [{ match: "INSERT INTO cst_app.conversation_root_causes", rows: [row()] }] });

    await recordRootCause(db.transactable, "77", WITH_EXTRAS);

    expect(verbs(db.calls)).toEqual(["BEGIN", "INSERT parent", "INSERT children", "COMMIT"]);
    expect(db.released).toBe(1);
  });

  /** The labels are bound as an array against the parent's own id. */
  it("binds the labels to the parent id the insert returned", async () => {
    const db = pool({
      answers: [{ match: "INSERT INTO cst_app.conversation_root_causes", rows: [row({ id: "9100" })] }],
    });

    await recordRootCause(db.transactable, "77", WITH_EXTRAS);

    const children = db.calls.find((c) => c.text.includes("labels"))!;
    expect(children.values).toEqual(["9100", ["PRODUCT_QUALITY", "PARTS MISSING"]]);
    // Nothing a caller supplied is interpolated into the statement.
    for (const value of ["PRODUCT_QUALITY", "PARTS MISSING", "9100"]) {
      expect(children.text).not.toContain(value);
    }
  });

  /** No labels, no second statement — and still one transaction. */
  /**
   * A FAILING CHILD ROLLS THE WHOLE REVISION BACK. There is no such thing as a
   * half-recorded decision: either the parent and every label are there, or
   * nothing is.
   */
  it("rolls back the parent when a child insert fails", async () => {
    const db = pool({
      answers: [{ match: "INSERT INTO cst_app.conversation_root_causes", rows: [row()] }],
      fails: { match: "labels", code: "23505" },
    });

    await expect(recordRootCause(db.transactable, "77", WITH_EXTRAS)).rejects.toThrow();

    expect(verbs(db.calls)).toEqual(["BEGIN", "INSERT parent", "INSERT children", "ROLLBACK"]);
    expect(verbs(db.calls)).not.toContain("COMMIT");
    // The connection goes back to the pool on the failing path too. `max: 2`
    // means one leaked client would starve the application.
    expect(db.released).toBe(1);
  });

  /** And the original error survives — the rollback must not replace it. */
  it("reports why the revision failed, not that the rollback happened", async () => {
    const db = pool({
      answers: [{ match: "INSERT INTO cst_app.conversation_root_causes", rows: [row()] }],
      fails: { match: "labels", code: "23514" },
    });

    await expect(recordRootCause(db.transactable, "77", WITH_EXTRAS)).rejects.toSatisfy(
      isRejectedByConstraint,
    );
  });

  /** A parent that returns no row aborts before any child is attempted. */
  it("does not attempt children when the parent insert returns nothing", async () => {
    const db = pool({ answers: [] });

    await expect(recordRootCause(db.transactable, "77", WITH_EXTRAS)).rejects.toThrow(
      /returned no row/,
    );

    expect(verbs(db.calls)).toEqual(["BEGIN", "INSERT parent", "ROLLBACK"]);
    expect(db.released).toBe(1);
  });

  it("returns the labels it recorded, against the stored parent", async () => {
    const db = pool({
      answers: [{ match: "INSERT INTO cst_app.conversation_root_causes", rows: [row()] }],
    });

    const stored = await recordRootCause(db.transactable, "77", WITH_EXTRAS);

    expect(stored.rootCauses).toEqual(["PRODUCT_QUALITY", "PARTS MISSING"]);
  });

  /**
   * APPEND-ONLY SURVIVES THE CHILD TABLE. Nothing in this module updates or
   * deletes anything — a revised selection is a new parent with a fresh set of
   * children, and older revisions keep theirs.
   */
  it("never updates or deletes, in either table", () => {
    const all = Object.values(ROOT_CAUSE_STATEMENTS).join("\n");
    expect(all.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+\S+/g)).toEqual([
      "INSERT INTO cst_app.conversation_root_causes",
      "INSERT INTO cst_app.conversation_root_cause_labels",
    ]);
  });
});

describe("the current value", () => {
  /**
   * APPEND-ONLY MEANS THE CURRENT VALUE IS A READ, not a column. The newest row
   * wins, and the identity column breaks the tie — two rows can share an instant
   * when a selection is corrected immediately, and `recorded_at` alone is not a
   * total order.
   */
  it("takes the newest row, tie-broken by identity", async () => {
    const app = client([row()]);
    await getCurrentRootCause(app.queryable, "77");

    expect(app.calls[0]!.text).toContain("ORDER BY recorded_at DESC, id DESC");
    expect(app.calls[0]!.text).toContain("LIMIT 1");
    expect(app.calls[0]!.values).toEqual(["77"]);

    // Then its children, asked for BY PARENT ID — never by conversation, which
    // would pile every revision's labels together.
    expect(verbs(app.calls)).toEqual(["SELECT parent", "SELECT children"]);
    expect(app.calls[1]!.values).toEqual([["9001"]]);
  });

  /** Nothing recorded is not an error; most conversations will never have one. */
  it("answers null when nothing has been recorded", async () => {
    const app = client([]);
    expect(await getCurrentRootCause(app.queryable, "77")).toBeNull();
  });

  /**
   * VERBATIM, IN BOTH TEXT COLUMNS. Never re-cased and never mapped to a
   * canonical spelling: a value on screen must be findable
   * character-for-character in what was stored — the label, and the agent's own
   * wording alike.
   */
  it("returns the labels and typed cause exactly as the columns hold them", async () => {
    const typed = "Customer's  SECOND request — re-pack w/ bubble wrap (urgent!)";
    const app = reader(
      [row({ custom_root_cause: typed, courier: null, courier_issue_type: null })],
      [
        { parent_id: "9001", root_cause: "PARTS MISSING" },
        { parent_id: "9001", root_cause: "OTHER" },
      ],
    );
    const stored = await getCurrentRootCause(app.queryable, "77");
    expect(stored!.rootCauses).toEqual(["PARTS MISSING", "OTHER"]);
    expect(stored!.customRootCause).toBe(typed);
  });

  /** A selection without OTHER reads back with no typed cause beside it. */
  it("returns a null typed cause when OTHER is not among the labels", async () => {
    const app = reader(
      [row({ custom_root_cause: null })],
      [{ parent_id: "9001", root_cause: "RETURN" }],
    );
    const stored = await getCurrentRootCause(app.queryable, "77");
    expect(stored!.rootCauses).toEqual(["RETURN"]);
    expect(stored!.customRootCause).toBeNull();
  });

  /**
   * ONLY THIS REVISION'S LABELS. The labels query is asked BY PARENT ID, so a
   * label belonging to an older revision cannot leak into the current answer —
   * which is what makes a deselected cause actually disappear.
   */
  it("returns no label belonging to another revision", async () => {
    const app = reader(
      [row()],
      [
        { parent_id: "9001", root_cause: "RETURN" },
        // An older revision's label, returned by a careless query.
        { parent_id: "8000", root_cause: "DISCOUNT" },
      ],
    );
    const stored = await getCurrentRootCause(app.queryable, "77");
    expect(stored!.rootCauses).toEqual(["RETURN"]);
    expect(stored!.rootCauses).not.toContain("DISCOUNT");
  });

  it("normalises the instant whether the driver hands back a Date or a string", async () => {
    const asDate = client([row({ recorded_at: new Date("2026-09-29T08:00:00.000Z") })]);
    const asText = client([row({ recorded_at: "2026-09-29T08:00:00.000Z" })]);

    expect((await getCurrentRootCause(asDate.queryable, "77"))!.recordedAt).toBe(
      "2026-09-29T08:00:00.000Z",
    );
    expect((await getCurrentRootCause(asText.queryable, "77"))!.recordedAt).toBe(
      "2026-09-29T08:00:00.000Z",
    );
  });
});

describe("the history", () => {
  /**
   * THE APPEND-ONLY TABLE'S REASON FOR EXISTING, READABLE. The message
   * application overwrites its root cause and discards what was there before;
   * here, every selection a conversation has ever carried is still answerable.
   */
  /**
   * EACH REVISION KEEPS ITS OWN LABEL SET, and they are never pooled. A label
   * removed in a later revision still shows against the earlier one that
   * recorded it — which is the entire point of keeping this history.
   */
  it("returns every revision newest first, each with its own labels", async () => {
    const app = reader(
      [row({ id: "9002" }), row({ id: "9001" })],
      [
        { parent_id: "9002", root_cause: "PARTS MISSING" },
        { parent_id: "9002", root_cause: "Delivery Issue" },
        { parent_id: "9001", root_cause: "OUT OF STOCK" },
      ],
    );

    const history = await getRootCauseHistory(app.queryable, "77");

    expect(history.map((entry) => entry.id)).toEqual(["9002", "9001"]);
    expect(history[0]!.rootCauses).toEqual(["PARTS MISSING", "Delivery Issue"]);
    // The older revision keeps exactly what it recorded, and nothing newer.
    expect(history[1]!.rootCauses).toEqual(["OUT OF STOCK"]);
    expect(app.calls[0]!.text).toContain("ORDER BY recorded_at DESC, id DESC");
    expect(app.calls[0]!.text).toMatch(/LIMIT \d+/);
    // One statement for every revision's labels, asked by parent id.
    expect(app.calls[1]!.values).toEqual([["9002", "9001"]]);
  });

  it("answers an empty list rather than null when there is no history", async () => {
    const app = client([]);
    expect(await getRootCauseHistory(app.queryable, "77")).toEqual([]);
  });
});

describe("the statements", () => {
  /**
   * ONE WRITING STATEMENT, AND IT IS AN INSERT. No UPDATE and no DELETE exists
   * in this module and neither should be added: an UPDATE here would quietly
   * turn this table into the overwriting one it was built not to be.
   */
  /**
   * TWO INSERTS, AND NOTHING ELSE THAT WRITES. The child table is the second;
   * no UPDATE and no DELETE exists in this module against either table, which
   * is what keeps a revised selection an append rather than an overwrite.
   */
  it("writes with two INSERTs and nothing else", () => {
    const all = Object.values(ROOT_CAUSE_STATEMENTS).join("\n");
    expect(all.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+\S+/g)).toEqual([
      "INSERT INTO cst_app.conversation_root_causes",
      "INSERT INTO cst_app.conversation_root_cause_labels",
    ]);
  });

  it("reads and writes its own two tables only", () => {
    const allowed = new Set([
      "cst_app.conversation_root_causes",
      "cst_app.conversation_root_cause_labels",
      // `unnest(...)` is a set-returning function in the child insert's SELECT,
      // not a table — it carries no schema and reaches nothing.
      "unnest($2::text[])",
    ]);
    for (const statement of Object.values(ROOT_CAUSE_STATEMENTS)) {
      const tables = [...statement.matchAll(/\b(?:FROM|INTO)\s+([\w.$()[\]:]+)/g)].map(
        ([, name]) => name,
      );
      for (const table of tables) {
        expect(allowed.has(table), `unexpected table ${table}`).toBe(true);
      }
    }
  });

  /** Ids are bound and cast, never concatenated. */
  it("casts the conversation id rather than trusting the driver", () => {
    expect(ROOT_CAUSE_STATEMENTS.insert).toContain("$1::bigint");
    expect(ROOT_CAUSE_STATEMENTS.current).toContain("$1::bigint");
    expect(ROOT_CAUSE_STATEMENTS.history).toContain("$1::bigint");
  });

  /**
   * `id::text`, like every other repository here. A bigint identity outruns a
   * JavaScript number, and a silently rounded id is a row nobody can find
   * again.
   */
  it("hands back ids as text", () => {
    // Every statement that RETURNS an id casts it. The child insert returns
    // nothing, so it has none to cast.
    for (const statement of [
      ROOT_CAUSE_STATEMENTS.insert,
      ROOT_CAUSE_STATEMENTS.current,
      ROOT_CAUSE_STATEMENTS.history,
      ROOT_CAUSE_STATEMENTS.labels,
    ]) {
      expect(statement).toContain("id::text");
    }
    expect(ROOT_CAUSE_STATEMENTS.insertLabels).not.toContain("RETURNING");
  });
});

describe("what the database's own failures mean", () => {
  /**
   * 0020 IS APPLIED BY HAND, like every migration here, so a deployment that has
   * not run it yet is a real state rather than a broken one. Telling an agent
   * "recording is not available" is a different thing to telling them their
   * selection failed.
   */
  it("recognises an unapplied migration", async () => {
    await expect(recordRootCause(failing("42P01"), "77", RECORD)).rejects.toSatisfy(
      isRootCauseStoreMissing,
    );
  });

  /**
   * THE FOREIGN KEY IS WHAT DECIDES whether a conversation exists. Checking with
   * a SELECT first and inserting second is a race: the conversation can be
   * deleted between the two.
   */
  it("recognises an unknown conversation from the key, not from a prior read", async () => {
    await expect(recordRootCause(failing("23503"), "77", RECORD)).rejects.toSatisfy(
      isUnknownConversation,
    );
    // One statement, no look-before-you-leap SELECT.
    expect(ROOT_CAUSE_STATEMENTS.insert).not.toMatch(/SELECT/i);
  });

  /**
   * A CHECK firing should be unreachable — `readRootCauseSelection` enforces the
   * same rules first. If it happens, the two statements of the rules have
   * drifted, and that is a rejection to be reported rather than a 500.
   */
  it("recognises a CHECK rejection as its own outcome", async () => {
    await expect(recordRootCause(failing("23514"), "77", RECORD)).rejects.toSatisfy(
      isRejectedByConstraint,
    );
  });

  it("does not mistake one failure for another", () => {
    const missing = { code: "42P01" };
    const unknown = { code: "23503" };
    const checked = { code: "23514" };

    expect(isRootCauseStoreMissing(unknown)).toBe(false);
    expect(isUnknownConversation(missing)).toBe(false);
    expect(isRejectedByConstraint(missing)).toBe(false);
    expect(isRootCauseStoreMissing(checked)).toBe(false);

    for (const predicate of [isRootCauseStoreMissing, isUnknownConversation, isRejectedByConstraint]) {
      expect(predicate(null)).toBe(false);
      expect(predicate(undefined)).toBe(false);
      expect(predicate("42P01")).toBe(false);
      expect(predicate(new Error("no code"))).toBe(false);
    }
  });
});
