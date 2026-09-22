import { afterAll, describe, expect, it } from "vitest";

import { closeAllPools, getAppPool } from "@/lib/db/pools";
import { findInternalNotes } from "@/lib/repositories/internal-note-repository";
import {
  addInternalNote,
  deleteInternalNote,
  updateInternalNote,
} from "@/lib/sync/internal-note-writer";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * Create, read, update and delete, end to end, against the real application
 * database.
 *
 * OPT-IN via RUN_LIVE_NOTES=1, like every other live test here. It WRITES to
 * `cst_app.internal_notes` and removes everything it wrote in afterAll, so a
 * repeated run does not accumulate notes.
 *
 *   RUN_LIVE_NOTES=1 npx vitest run tests/repositories/internal-note-live.test.ts
 *
 * IT TOUCHES THE APPLICATION DATABASE ONLY. `getAppPool()` is the sole pool
 * named; the read-only source database holds no internal notes and is not
 * opened by this test at all.
 *
 * The note text is written for the test. No customer data is read or stored.
 */

loadEnvFile();

const ready = process.env.RUN_LIVE_NOTES === "1" && process.env.APP_DB_HOST !== undefined;

const NOTE_TEXT = "Synthetic verification note; safe to remove.";
const EDITED_TEXT = "Synthetic verification note, corrected; safe to remove.";

/** Every note this file creates, so afterAll can remove them whatever failed. */
const created: string[] = [];

afterAll(async () => {
  for (const id of created) {
    await getAppPool()
      .query("DELETE FROM cst_app.internal_notes WHERE id = $1", [id])
      .catch(() => undefined);
  }
  await closeAllPools();
});

/**
 * Two different conversations, so the cross-conversation refusals below are
 * tested against a real second case rather than an invented id.
 */
async function pickConversations(): Promise<[string, string]> {
  const { rows } = await getAppPool().query(
    "SELECT id::text AS id FROM cst_app.conversations ORDER BY id LIMIT 2",
  );
  const ids = (rows as { id: string }[]).map((row) => String(row.id));
  return [ids[0]!, ids[1]!];
}

describe.skipIf(!ready)("an internal note, through its whole life", () => {
  it("creates, reads, updates and deletes one note", async () => {
    const [conversationId] = await pickConversations();

    // CREATE
    const note = await addInternalNote(getAppPool(), conversationId, {
      noteText: NOTE_TEXT,
      sourceOrderId: null,
    });
    created.push(note.id);

    expect(note.conversationId).toBe(conversationId);
    expect(note.noteText).toBe(NOTE_TEXT);
    // No sign-in exists, so nothing can be recorded here. See migration 0012.
    expect(note.authorUserId).toBeNull();
    // Nobody was asked for a category; the writer supplied the stored one.
    expect(note.category).toBe("general");

    // READ
    const feed = await findInternalNotes(getAppPool(), conversationId);
    expect(feed.notes[0]!.id).toBe(note.id);
    expect(feed.notes[0]!.noteText).toBe(NOTE_TEXT);

    // UPDATE
    const edited = await updateInternalNote(getAppPool(), conversationId, note.id, {
      noteText: EDITED_TEXT,
    });
    expect(edited?.noteText).toBe(EDITED_TEXT);
    expect(edited?.createdAt).toBe(note.createdAt);
    expect(edited?.updatedAt).not.toBe(note.updatedAt);

    const afterEdit = await findInternalNotes(getAppPool(), conversationId);
    expect(afterEdit.notes.find((entry) => entry.id === note.id)?.noteText).toBe(EDITED_TEXT);

    // DELETE
    expect(await deleteInternalNote(getAppPool(), conversationId, note.id)).toBe(true);

    const afterDelete = await findInternalNotes(getAppPool(), conversationId);
    expect(afterDelete.notes.map((entry) => entry.id)).not.toContain(note.id);

    // A second delete finds nothing, so the row is genuinely gone.
    expect(await deleteInternalNote(getAppPool(), conversationId, note.id)).toBe(false);
    created.pop();
  });

  /**
   * THE PROTECTION THAT MATTERS, against a real second conversation.
   *
   * A note id is not a capability. Knowing one must not let anybody edit or
   * delete it through a conversation it does not belong to.
   */
  it("refuses to edit or delete a note through another conversation", async () => {
    const [mine, other] = await pickConversations();
    expect(other).not.toBe(mine);

    const note = await addInternalNote(getAppPool(), mine, {
      noteText: NOTE_TEXT,
      sourceOrderId: null,
    });
    created.push(note.id);

    expect(
      await updateInternalNote(getAppPool(), other, note.id, { noteText: EDITED_TEXT }),
    ).toBeUndefined();
    expect(await deleteInternalNote(getAppPool(), other, note.id)).toBe(false);

    // Untouched, and still on its own conversation.
    const feed = await findInternalNotes(getAppPool(), mine);
    expect(feed.notes.find((entry) => entry.id === note.id)?.noteText).toBe(NOTE_TEXT);

    // And it does not appear on the other conversation's feed at all.
    const otherFeed = await findInternalNotes(getAppPool(), other);
    expect(otherFeed.notes.map((entry) => entry.id)).not.toContain(note.id);
  });

  /** The stored guarantee, read back from the row the database actually holds. */
  it("stores every note as internal, without the application naming a visibility", async () => {
    const [conversationId] = await pickConversations();
    const note = await addInternalNote(getAppPool(), conversationId, {
      noteText: NOTE_TEXT,
      sourceOrderId: null,
    });
    created.push(note.id);

    const { rows } = await getAppPool().query(
      "SELECT visibility FROM cst_app.internal_notes WHERE id = $1",
      [note.id],
    );
    expect((rows[0] as { visibility: string }).visibility).toBe("internal");
  });

  it("refuses a blank note at the database, not only in the application", async () => {
    const [conversationId] = await pickConversations();
    await expect(
      getAppPool().query(
        "INSERT INTO cst_app.internal_notes (conversation_id, note_category, note_text) VALUES ($1, 'general', '   ')",
        [conversationId],
      ),
    ).rejects.toThrow(/ck_internal_notes_text_present/);
  });

  it("refuses a note for a conversation that does not exist", async () => {
    await expect(
      addInternalNote(getAppPool(), "9223372036854775807", {
        noteText: NOTE_TEXT,
        sourceOrderId: null,
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
