import { describe, expect, it } from "vitest";

import {
  type InternalNoteDraft,
  STORED_INTERNAL_NOTE_CATEGORY,
} from "@/lib/domain/internal-note";
import {
  type Writable,
  addInternalNote,
  deleteInternalNote,
  isUnknownConversation,
  updateInternalNote,
} from "@/lib/sync/internal-note-writer";

/**
 * Writing one internal note.
 *
 * The note text here was written for the test. Nothing in this file touches a
 * real conversation, a real order, or a database of any kind.
 */

function fake(rows: unknown[]) {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  const client: Writable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

function failing(cause: unknown): Writable {
  return {
    query: async () => {
      throw cause;
    },
  };
}

const draft: InternalNoteDraft = {
  noteText: "Supervisor asked us to offer a replacement.",
  sourceOrderId: null,
};

function written(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "11",
    conversation_id: "32103",
    note_category: STORED_INTERNAL_NOTE_CATEGORY,
    note_text: "Supervisor asked us to offer a replacement.",
    source_order_id: null,
    author_user_id: null,
    created_at: "2026-09-22 10:00:00+00",
    updated_at: "2026-09-22 10:00:00+00",
    ...overrides,
  };
}

describe("addInternalNote", () => {
  it("writes the application table in the application database", async () => {
    const { calls, client } = fake([written()]);
    await addInternalNote(client, "32103", draft);

    const sql = calls[0]!.text;
    expect(sql).toContain("cst_app.internal_notes");
    // The source database holds no internal notes and is read-only for this
    // project. A write must never name one of its schemas.
    for (const sourceSchema of ["order_management", "customer_service", "customers.", "staff."]) {
      expect(sql).not.toContain(sourceSchema);
    }
  });

  it("passes the conversation and text as parameters, never inline", async () => {
    const { calls, client } = fake([written()]);
    await addInternalNote(client, "32103", draft);

    expect(calls[0]!.values).toEqual([
      "32103",
      STORED_INTERNAL_NOTE_CATEGORY,
      "Supervisor asked us to offer a replacement.",
      null,
    ]);
    expect(calls[0]!.text).not.toContain("Supervisor asked us");
  });

  /**
   * The category is the application's constant, not the caller's. Nobody is
   * asked for one and a request cannot carry one, so the writer supplying it
   * is what satisfies the NOT NULL column.
   */
  it("supplies the stored category itself", async () => {
    const { calls, client } = fake([written()]);
    await addInternalNote(client, "32103", draft);
    expect(calls[0]!.values?.[1]).toBe(STORED_INTERNAL_NOTE_CATEGORY);
  });

  it("stores a source order id when the note carries one", async () => {
    const { calls, client } = fake([written({ source_order_id: "778812" })]);
    const note = await addInternalNote(client, "32103", { ...draft, sourceOrderId: "778812" });

    expect(calls[0]!.values?.[3]).toBe("778812");
    expect(note.sourceOrderId).toBe("778812");
  });

  /**
   * Visibility and authorship are the schema's business, not this writer's.
   * `visibility` defaults to 'internal' under a CHECK that permits nothing
   * else; `author_user_id` defaults to NULL because there is no sign-in yet.
   * Naming either here would be this writer's chance to get them wrong.
   */
  it("writes neither a visibility nor an author", async () => {
    const { calls, client } = fake([written()]);
    await addInternalNote(client, "32103", draft);

    const sql = calls[0]!.text;
    const columns = sql.slice(sql.indexOf("("), sql.indexOf(")"));
    expect(columns).not.toContain("visibility");
    expect(columns).not.toContain("author_user_id");
  });

  it("returns the row the database wrote, not the draft it was given", async () => {
    const { client } = fake([written({ id: "11", created_at: "2026-09-22 10:00:00+00" })]);
    const note = await addInternalNote(client, "32103", draft);

    expect(note).toEqual({
      id: "11",
      conversationId: "32103",
      category: STORED_INTERNAL_NOTE_CATEGORY,
      noteText: "Supervisor asked us to offer a replacement.",
      sourceOrderId: null,
      authorUserId: null,
      createdAt: "2026-09-22 10:00:00+00",
      updatedAt: "2026-09-22 10:00:00+00",
    });
  });

  it("records no author, because there is no agent identity to record", async () => {
    const { client } = fake([written()]);
    expect((await addInternalNote(client, "32103", draft)).authorUserId).toBeNull();
  });

  it("updates nothing and deletes nothing", async () => {
    const { calls, client } = fake([written()]);
    await addInternalNote(client, "32103", draft);

    const sql = calls[0]!.text.toUpperCase();
    expect(sql).toContain("INSERT INTO");
    for (const statement of ["UPDATE ", "DELETE ", "TRUNCATE", "ALTER ", "DROP "]) {
      expect(sql).not.toContain(statement);
    }
  });

  /**
   * The departure from `rule-analysis-writer.ts`, pinned.
   *
   * That writer swallows a failure because it records something derivable.
   * This one records what a person typed, which exists nowhere else — an
   * agent told "saved" over a note that was not saved has been misled about
   * the case record, so the failure has to reach them.
   */
  it("raises a write failure rather than swallowing it", async () => {
    await expect(
      addInternalNote(failing(new Error("synthetic connection failure")), "32103", draft),
    ).rejects.toThrow(/synthetic connection failure/);
  });

  it("raises when the write returned no row", async () => {
    const { client } = fake([]);
    await expect(addInternalNote(client, "32103", draft)).rejects.toThrow(/no row/);
  });

  it("raises rather than rendering a category it cannot name", async () => {
    const { client } = fake([written({ note_category: "something_later" })]);
    await expect(addInternalNote(client, "32103", draft)).rejects.toThrow(/unknown category/);
  });
});

describe("updateInternalNote", () => {
  const edit = { noteText: "Courier now says Tuesday." };

  /**
   * THE ACCESS CONTROL, AND IT IS IN THE STATEMENT.
   *
   * Both ids are bound, so a note id borrowed from another conversation
   * matches no row. There is no separate ownership check a route could forget
   * to call, because there is nothing to call — the WHERE clause is it.
   */
  it("matches on the note AND the conversation", async () => {
    const { calls, client } = fake([written({ note_text: edit.noteText })]);
    await updateInternalNote(client, "32103", "11", edit);

    const sql = calls[0]!.text;
    expect(sql).toMatch(/WHERE id = \$1::bigint\s+AND conversation_id = \$2::bigint/);
    expect(calls[0]!.values).toEqual(["11", "32103", "Courier now says Tuesday."]);
  });

  it("reports nothing changed when the note is on another conversation", async () => {
    // The scoped statement matched no row, which is what the database returns
    // when the note exists but belongs elsewhere.
    const { client } = fake([]);
    expect(await updateInternalNote(client, "99999", "11", edit)).toBeUndefined();
  });

  it("reports nothing changed when there is no such note", async () => {
    const { client } = fake([]);
    expect(await updateInternalNote(client, "32103", "424242", edit)).toBeUndefined();
  });

  /**
   * Four columns an edit must not touch. Each would undo something: ownership
   * moves the note to another case, visibility is the whole guarantee,
   * category was never asked about, and created_at is when it was written —
   * not when it was corrected.
   */
  it("sets the text and updated_at, and nothing else", async () => {
    const { calls, client } = fake([written()]);
    await updateInternalNote(client, "32103", "11", edit);

    const sql = calls[0]!.text;
    const setClause = sql.slice(sql.indexOf("SET"), sql.indexOf("WHERE"));
    expect(setClause).toContain("note_text");
    expect(setClause).toContain("updated_at = now()");
    for (const column of ["conversation_id", "visibility", "note_category", "created_at"]) {
      expect(setClause, `an edit must not set ${column}`).not.toContain(column);
    }
  });

  it("returns the row the database wrote", async () => {
    const { client } = fake([
      written({ note_text: edit.noteText, updated_at: "2026-09-22 12:00:00+00" }),
    ]);
    const note = await updateInternalNote(client, "32103", "11", edit);

    expect(note?.noteText).toBe(edit.noteText);
    expect(note?.updatedAt).toBe("2026-09-22 12:00:00+00");
    expect(note?.conversationId).toBe("32103");
  });

  it("raises a write failure rather than swallowing it", async () => {
    await expect(
      updateInternalNote(failing(new Error("synthetic connection failure")), "32103", "11", edit),
    ).rejects.toThrow(/synthetic connection failure/);
  });
});

describe("deleteInternalNote", () => {
  it("matches on the note AND the conversation", async () => {
    const { calls, client } = fake([{ id: "11" }]);
    await deleteInternalNote(client, "32103", "11");

    const sql = calls[0]!.text;
    expect(sql).toMatch(/WHERE id = \$1::bigint\s+AND conversation_id = \$2::bigint/);
    expect(calls[0]!.values).toEqual(["11", "32103"]);
  });

  it("confirms the removal when a row matched", async () => {
    const { client } = fake([{ id: "11" }]);
    expect(await deleteInternalNote(client, "32103", "11")).toBe(true);
  });

  it("refuses to report a removal when the note is on another conversation", async () => {
    const { client } = fake([]);
    expect(await deleteInternalNote(client, "99999", "11")).toBe(false);
  });

  it("refuses to report a removal when there is no such note", async () => {
    const { client } = fake([]);
    expect(await deleteInternalNote(client, "32103", "424242")).toBe(false);
  });

  /** A real delete. This project uses no soft deletes anywhere. */
  it("removes the row rather than flagging it", async () => {
    const { calls, client } = fake([{ id: "11" }]);
    await deleteInternalNote(client, "32103", "11");

    const sql = calls[0]!.text.toUpperCase();
    expect(sql).toContain("DELETE FROM CST_APP.INTERNAL_NOTES");
    expect(sql).not.toMatch(/\bUPDATE\s+CST_APP\b/);
    expect(sql).not.toContain("DELETED_AT");
  });

  it("raises a write failure rather than swallowing it", async () => {
    await expect(
      deleteInternalNote(failing(new Error("synthetic connection failure")), "32103", "11"),
    ).rejects.toThrow(/synthetic connection failure/);
  });
});

describe("isUnknownConversation", () => {
  it("recognises the foreign-key violation, so a route can answer 404", () => {
    expect(isUnknownConversation({ code: "23503" })).toBe(true);
  });

  it("does not claim any other failure is a missing conversation", () => {
    for (const cause of [{ code: "42P01" }, { code: "23514" }, new Error("boom"), null]) {
      expect(isUnknownConversation(cause)).toBe(false);
    }
  });
});
