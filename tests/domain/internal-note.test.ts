import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INTERNAL_NOTES_TITLE,
  INTERNAL_NOTE_CATEGORIES,
  INTERNAL_NOTE_MAX_LENGTH,
  INTERNAL_NOTE_REJECTIONS,
  INTERNAL_NOTE_REJECTION_MESSAGE,
  INTERNAL_NOTE_VISIBILITY,
  type InternalNote,
  STORED_INTERNAL_NOTE_CATEGORY,
  orderInternalNotes,
  parseInternalNoteCategory,
  parseInternalNoteId,
  parseInternalNoteRequest,
  parseInternalNoteUpdate,
  pinnedInternalNote,
  unpinnedInternalNotes,
} from "@/lib/domain/internal-note";

/**
 * The internal-note rules, tested where they live.
 *
 * Every assertion here is about a note a CST agent typed. Nothing in this file
 * uses a real order number, customer name or message body — the notes are
 * written for the test, which is the same rule the rest of the suite follows.
 */

describe("the stored category", () => {
  /**
   * The category is no longer part of the experience. The set survives for the
   * READ path — a note already stored under one of the other four must still
   * come back — and the application writes exactly one value.
   */
  it("still reads every value the column can hold", () => {
    expect(INTERNAL_NOTE_CATEGORIES).toEqual([
      "courier_update",
      "supervisor_instruction",
      "listing_issue",
      "case_history",
      "general",
    ]);
    for (const category of INTERNAL_NOTE_CATEGORIES) {
      expect(parseInternalNoteCategory(category)).toBe(category);
    }
  });

  it("writes exactly one category, which the column permits", () => {
    expect(STORED_INTERNAL_NOTE_CATEGORY).toBe("general");
    expect(INTERNAL_NOTE_CATEGORIES).toContain(STORED_INTERNAL_NOTE_CATEGORY);
  });

  it("rejects a value the column does not permit", () => {
    for (const candidate of ["", "Courier Update", "customer_visible", "escalation", null, 7, {}]) {
      expect(parseInternalNoteCategory(candidate)).toBeNull();
    }
  });
});

describe("the wording the panel shows", () => {
  /**
   * The section names itself and nothing else does. No caption explaining
   * what an internal note is, and no empty-state sentence — a heading with
   * nothing under it has already reported the absence.
   */
  it("names the section and offers no prose beyond it", () => {
    expect(INTERNAL_NOTES_TITLE).toBe("Internal Notes");

    const domain = readFileSync(
      join(__dirname, "..", "..", "lib", "domain", "internal-note.ts"),
      "utf8",
    );
    for (const removed of ["INTERNAL_NOTES_EMPTY", "INTERNAL_NOTES_STAFF_ONLY_NOTICE"]) {
      expect(domain).not.toMatch(new RegExp(`export const ${removed}\\b`));
    }
  });

  it("offers no rejection for a category, because none can be submitted", () => {
    expect(INTERNAL_NOTE_REJECTIONS).toEqual(["blank_text", "text_too_long"]);
  });
});

describe("the visibility rule", () => {
  /**
   * The application's copy of `ck_internal_notes_visibility`. One value, and a
   * second one appearing here would mean a note could be marked something
   * other than internal without anybody altering the database constraint.
   */
  it("names exactly one visibility, and it is internal", () => {
    expect(INTERNAL_NOTE_VISIBILITY).toBe("internal");
  });
});

describe("validating a new note", () => {
  it("accepts a note with nothing but its text", () => {
    const parsed = parseInternalNoteRequest({ noteText: "Chased the courier." });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.draft.noteText).toBe("Chased the courier.");
  });

  it("trims the stored text without changing what the agent wrote", () => {
    const parsed = parseInternalNoteRequest({ noteText: "  Offer a replacement.  " });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.draft.noteText).toBe("Offer a replacement.");
  });

  it("keeps the agent's own line breaks", () => {
    const parsed = parseInternalNoteRequest({ noteText: "Contacted before.\nSame fault." });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.draft.noteText).toBe("Contacted before.\nSame fault.");
  });

  it("rejects a blank note", () => {
    expect(parseInternalNoteRequest({ noteText: "" })).toEqual({
      ok: false,
      reason: "blank_text",
    });
  });

  it("rejects a whitespace-only note, which the database would also refuse", () => {
    for (const blank of ["   ", "\n", "\t  \n "]) {
      expect(parseInternalNoteRequest({ noteText: blank })).toEqual({
        ok: false,
        reason: "blank_text",
      });
    }
  });

  it("rejects a note that is not text at all", () => {
    for (const notText of [null, undefined, 42, {}, ["a note"]]) {
      expect(parseInternalNoteRequest({ noteText: notText })).toEqual({
        ok: false,
        reason: "blank_text",
      });
    }
  });

  it("rejects a body that is not an object", () => {
    for (const body of [null, "note", 5]) {
      expect(parseInternalNoteRequest(body).ok).toBe(false);
    }
  });

  it("accepts a note at the length ceiling and refuses one past it", () => {
    const atLimit = "n".repeat(INTERNAL_NOTE_MAX_LENGTH);
    expect(parseInternalNoteRequest({ noteText: atLimit }).ok).toBe(true);
    expect(parseInternalNoteRequest({ noteText: `${atLimit}n` })).toEqual({
      ok: false,
      reason: "text_too_long",
    });
  });

  /**
   * The four things a caller cannot set. Each would undo something the feature
   * guarantees: visibility is the whole promise, category is no longer asked
   * about, conversation ownership comes from the path, and there is no
   * identity to name an author with.
   */
  it("ignores anything a caller sends beyond the text and the order id", () => {
    const parsed = parseInternalNoteRequest({
      noteText: "A note.",
      visibility: "customer",
      category: "supervisor_instruction",
      conversationId: "999",
      authorUserId: "3",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.keys(parsed.draft)).toEqual(["noteText", "sourceOrderId"]);
  });

  it("keeps a usable source order id and drops anything that is not one", () => {
    const kept = parseInternalNoteRequest({
      noteText: "Parcel scanned.",
      sourceOrderId: "409912",
    });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.draft.sourceOrderId).toBe("409912");

    for (const unusable of ["", "0", "-4", "12a", "1e5", true, {}, null]) {
      const parsed = parseInternalNoteRequest({
        noteText: "Parcel scanned.",
        sourceOrderId: unusable,
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.draft.sourceOrderId).toBeNull();
    }
  });

  it("gives every rejection a sentence an agent can act on", () => {
    for (const message of Object.values(INTERNAL_NOTE_REJECTION_MESSAGE)) {
      expect(message.trim()).not.toBe("");
      expect(message).not.toMatch(/error|invalid request/i);
    }
  });
});

describe("validating an edit", () => {
  it("accepts replacement text and trims it", () => {
    const parsed = parseInternalNoteUpdate({ noteText: "  Corrected.  " });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.edit.noteText).toBe("Corrected.");
  });

  it("applies the same text rules a new note gets", () => {
    for (const blank of ["", "   ", "\n"]) {
      expect(parseInternalNoteUpdate({ noteText: blank })).toEqual({
        ok: false,
        reason: "blank_text",
      });
    }
    const tooLong = "n".repeat(INTERNAL_NOTE_MAX_LENGTH + 1);
    expect(parseInternalNoteUpdate({ noteText: tooLong })).toEqual({
      ok: false,
      reason: "text_too_long",
    });
  });

  it("rejects a body that is not an object", () => {
    for (const body of [null, "note", 5, undefined]) {
      expect(parseInternalNoteUpdate(body).ok).toBe(false);
    }
  });

  /**
   * AN EDIT CARRIES TEXT AND NOTHING ELSE. Accepting any of these would let a
   * note be moved to another case, made customer-visible, reclassified, or
   * back-dated through a field nobody meant to expose.
   */
  it("carries text and nothing else, whatever the caller sends", () => {
    const parsed = parseInternalNoteUpdate({
      noteText: "Corrected.",
      conversationId: "999",
      visibility: "customer",
      category: "listing_issue",
      createdAt: "2020-01-01",
      sourceOrderId: "5",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.keys(parsed.edit)).toEqual(["noteText"]);
  });
});

describe("parsing a note id from a path", () => {
  it("accepts a positive integer id", () => {
    for (const id of ["1", "42", "9223372036854775"]) {
      expect(parseInternalNoteId(id)).toBe(id);
    }
  });

  /**
   * A path segment that is not an id is refused before it reaches a query —
   * the same rule `parseConversationId` applies to the other half of the path.
   */
  it("refuses anything that is not one", () => {
    for (const id of ["", "0", "01", "-1", "1.5", "12a", " 3", "abc", "1;DROP", "1e5"]) {
      expect(parseInternalNoteId(id)).toBeNull();
    }
  });
});

describe("the order notes are read in", () => {
  const note = (id: string, createdAt: string): InternalNote => ({
    id,
    conversationId: "1",
    category: "general",
    noteText: `note ${id}`,
    sourceOrderId: null,
    authorUserId: null,
    createdAt,
    updatedAt: createdAt,
  });

  it("puts the newest note first", () => {
    const ordered = orderInternalNotes([
      note("1", "2026-09-01 09:00:00+00"),
      note("3", "2026-09-03 09:00:00+00"),
      note("2", "2026-09-02 09:00:00+00"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["3", "2", "1"]);
  });

  it("breaks a tie on id, so two notes in the same second have a stable order", () => {
    const ordered = orderInternalNotes([
      note("7", "2026-09-01 09:00:00+00"),
      note("9", "2026-09-01 09:00:00+00"),
      note("8", "2026-09-01 09:00:00+00"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["9", "8", "7"]);
  });

  it("does not mutate the list it was given", () => {
    const input = [note("1", "2026-09-01 09:00:00+00"), note("2", "2026-09-02 09:00:00+00")];
    orderInternalNotes(input);
    expect(input.map((entry) => entry.id)).toEqual(["1", "2"]);
  });
});

/**
 * Which note is pinned.
 *
 * There is no stored pin — no flag, no column, no second row — so the whole
 * behaviour is this one function answering "which is newest" every time it is
 * asked. Adding, editing and deleting all fall out of that, which is why they
 * can be tested here without a browser.
 */
describe("the pinned internal note", () => {
  const note = (id: string, createdAt: string, text = `note ${id}`): InternalNote => ({
    id,
    conversationId: "1",
    category: "general",
    noteText: text,
    sourceOrderId: null,
    authorUserId: null,
    createdAt,
    updatedAt: createdAt,
  });

  const first = note("1", "2026-09-01 09:00:00+00");
  const second = note("2", "2026-09-02 09:00:00+00");
  const third = note("3", "2026-09-03 09:00:00+00");

  it("is the newest note", () => {
    expect(pinnedInternalNote([third, second, first])?.id).toBe("3");
  });

  it("is the newest whatever order the list arrives in", () => {
    // A locally prepended or edited note must not change which one is pinned
    // by arriving in a different position.
    expect(pinnedInternalNote([first, third, second])?.id).toBe("3");
  });

  it("is the only note when there is one", () => {
    expect(pinnedInternalNote([first])?.id).toBe("1");
  });

  it("is nothing when there are no notes", () => {
    expect(pinnedInternalNote([])).toBeUndefined();
    expect(pinnedInternalNote(null)).toBeUndefined();
  });

  it("changes to the new note when one is added", () => {
    // Adding prepends, which is what the hook does with the stored row.
    expect(pinnedInternalNote([third, second, first])?.id).toBe("3");
  });

  it("keeps the same note, with new text, when that note is edited", () => {
    const edited = { ...third, noteText: "corrected", updatedAt: "2026-09-04 09:00:00+00" };
    const pinned = pinnedInternalNote([edited, second, first]);
    expect(pinned?.id).toBe("3");
    expect(pinned?.noteText).toBe("corrected");
  });

  /** Deleting the pinned note promotes the one behind it. No pin state to update. */
  it("promotes the next newest when the pinned note is deleted", () => {
    const remaining = [third, second, first].filter((entry) => entry.id !== "3");
    expect(pinnedInternalNote(remaining)?.id).toBe("2");
  });

  it("disappears when the last note is deleted", () => {
    const remaining = [first].filter((entry) => entry.id !== "1");
    expect(pinnedInternalNote(remaining)).toBeUndefined();
  });

  it("leaves every other note to the details column, newest first", () => {
    expect(unpinnedInternalNotes([third, second, first]).map((entry) => entry.id)).toEqual([
      "2",
      "1",
    ]);
    expect(unpinnedInternalNotes([first])).toEqual([]);
    expect(unpinnedInternalNotes(null)).toEqual([]);
  });

  /** The pinned note is one of the notes, never a copy of one. */
  it("returns the stored note itself rather than a duplicate", () => {
    const list = [third, second, first];
    expect(pinnedInternalNote(list)).toBe(third);
    expect(list).toHaveLength(3);
  });
});
