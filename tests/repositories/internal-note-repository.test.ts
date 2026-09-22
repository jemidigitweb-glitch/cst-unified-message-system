import { describe, expect, it } from "vitest";

import {
  INTERNAL_NOTE_PAGE_LIMIT,
  type Queryable,
  findInternalNotes,
  isInternalNoteStoreMissing,
} from "@/lib/repositories/internal-note-repository";

/**
 * Reading one conversation's internal notes.
 *
 * Synthetic rows throughout — the note text here was written for the test.
 */

function fake(rows: unknown[]) {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "1",
    conversation_id: "32103",
    note_category: "courier_update",
    note_text: "Courier says delivered; customer says not received.",
    source_order_id: null,
    author_user_id: null,
    created_at: "2026-09-22 09:15:00+00",
    updated_at: "2026-09-22 09:15:00+00",
    ...overrides,
  };
}

describe("findInternalNotes", () => {
  it("scopes the read to the requested conversation", async () => {
    const { calls, client } = fake([]);
    await findInternalNotes(client, "32103");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.text).toMatch(/WHERE\s+n\.conversation_id\s*=\s*\$1::bigint/);
    expect(call!.values?.[0]).toBe("32103");
  });

  it("reads the application table and never a source-database one", async () => {
    const { calls, client } = fake([]);
    await findInternalNotes(client, "32103");

    const sql = calls[0]!.text;
    expect(sql).toContain("cst_app.internal_notes");
    for (const sourceTable of ["order_management", "customer_service", "customers.", "listings."]) {
      expect(sql).not.toContain(sourceTable);
    }
  });

  it("asks the database for newest first", async () => {
    const { calls, client } = fake([]);
    await findInternalNotes(client, "32103");
    expect(calls[0]!.text).toMatch(/ORDER BY\s+n\.created_at DESC,\s*n\.id DESC/);
  });

  it("returns the stored notes, newest first", async () => {
    const { client } = fake([
      row({ id: "9", created_at: "2026-09-22 11:00:00+00" }),
      row({ id: "4", created_at: "2026-09-20 08:00:00+00" }),
    ]);
    const feed = await findInternalNotes(client, "32103");

    expect(feed.notes.map((note) => note.id)).toEqual(["9", "4"]);
    expect(feed.notes[0]).toEqual({
      id: "9",
      conversationId: "32103",
      category: "courier_update",
      noteText: "Courier says delivered; customer says not received.",
      sourceOrderId: null,
      authorUserId: null,
      createdAt: "2026-09-22 11:00:00+00",
      updatedAt: "2026-09-22 09:15:00+00",
    });
    expect(feed.hasMore).toBe(false);
  });

  it("returns an empty feed for a conversation with no notes", async () => {
    const { client } = fake([]);
    expect(await findInternalNotes(client, "32103")).toEqual({ notes: [], hasMore: false });
  });

  it("reports more notes without returning the extra row it fetched", async () => {
    const { calls, client } = fake([row({ id: "3" }), row({ id: "2" }), row({ id: "1" })]);
    const feed = await findInternalNotes(client, "32103", { limit: 2 });

    // limit + 1 is asked for, so "is there more" needs no second query.
    expect(calls[0]!.values?.[1]).toBe(3);
    expect(feed.notes).toHaveLength(2);
    expect(feed.hasMore).toBe(true);
  });

  it("clamps a limit that would ask for everything", async () => {
    const { calls, client } = fake([]);
    await findInternalNotes(client, "32103", { limit: 10_000 });
    expect(calls[0]!.values?.[1]).toBe(INTERNAL_NOTE_PAGE_LIMIT + 1);
  });

  it("clamps a limit of zero or less to one note", async () => {
    const { calls, client } = fake([]);
    await findInternalNotes(client, "32103", { limit: 0 });
    expect(calls[0]!.values?.[1]).toBe(2);
  });

  it("carries a source order id through as a plain id", async () => {
    const { client } = fake([row({ source_order_id: "778812" })]);
    const feed = await findInternalNotes(client, "32103");
    expect(feed.notes[0]!.sourceOrderId).toBe("778812");
  });

  /**
   * A category the database holds and this application has no label for is
   * dropped rather than rendered. The CHECK constraint makes it unreachable
   * today; the filter is what keeps it unreachable if the two ever diverge.
   */
  it("drops a row whose category this application cannot name", async () => {
    const { client } = fake([row({ id: "5", note_category: "something_later" }), row({ id: "4" })]);
    const feed = await findInternalNotes(client, "32103");
    expect(feed.notes.map((note) => note.id)).toEqual(["4"]);
  });

  it("performs no write of any kind", async () => {
    const { calls, client } = fake([row()]);
    await findInternalNotes(client, "32103");

    // Statement-shaped, not bare words: the selected `updated_at` column
    // legitimately contains "UPDATE", and a guard that cannot tell a column
    // name from a statement is one somebody eventually deletes.
    const sql = calls[0]!.text.toUpperCase();
    for (const statement of [
      /\bINSERT\s+INTO\b/,
      /\bUPDATE\s+CST_APP\b/,
      /\bDELETE\s+FROM\b/,
      /\bTRUNCATE\b/,
      /\bALTER\s+TABLE\b/,
      /\bDROP\s+TABLE\b/,
    ]) {
      expect(sql).not.toMatch(statement);
    }
  });
});

describe("isInternalNoteStoreMissing", () => {
  it("recognises the undefined_table code, so a route can say the migration is pending", () => {
    expect(isInternalNoteStoreMissing({ code: "42P01" })).toBe(true);
  });

  it("does not claim any other failure is a missing table", () => {
    for (const cause of [{ code: "23503" }, { code: "57014" }, new Error("boom"), null, undefined]) {
      expect(isInternalNoteStoreMissing(cause)).toBe(false);
    }
  });
});
