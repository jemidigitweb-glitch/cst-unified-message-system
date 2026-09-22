import { z } from "zod";

/**
 * Internal notes — what a CST AGENT wrote about a case, for other CST staff.
 *
 * NOT A MESSAGE, AND THE DISTINCTION IS THE WHOLE FEATURE. A conversation
 * message was exchanged with a customer. A note was not: it is an agent's own
 * short record of where the case stands — a courier update, an instruction
 * from a supervisor, a fault found in a listing, or what happened last time
 * this customer wrote in. Nobody outside CST ever sees one.
 *
 * DELIBERATELY SEPARATE FROM `customer-note.ts`, which it must not be confused
 * with. That module reads BUYER notes from the read-only source database and
 * writes nothing. This one is the application's own writable store in
 * `cst_app.internal_notes`. They share a word and nothing else: one is what a
 * customer said, the other is what we said about the customer's case.
 *
 * WHERE THE TEXT MUST NEVER GO. Not into `ConversationDetail`, not into the AI
 * draft input (`lib/ai/draft-assembly.ts`), not into the conversation export,
 * not into an automation's rendered body. `tests/guards/internal-note-
 * visibility.test.ts` fails the build if any of those start importing this.
 *
 * PURE. No database, no network, no `server-only` — the interface imports the
 * labels and the validation from here, and the same validation runs again on
 * the server so the two cannot drift.
 */

/**
 * The stored categories.
 *
 * CATEGORY IS NO LONGER PART OF THE EXPERIENCE, and this list survives for the
 * READ path only. The first version of this feature made an agent pick one of
 * five before they could write a sentence; in practice a note is a short
 * summary of where the case stands, and the picker was a question asked before
 * every note that the reader of that note did not need answered.
 *
 * The column stays — `ck_internal_notes_category` still constrains it, and a
 * migration to drop a working column for a UI change would be destructive for
 * no gain. Every note written now stores `STORED_INTERNAL_NOTE_CATEGORY`.
 * Anything already stored under one of the other four still reads back, which
 * is the whole reason the set is still declared.
 */
export const INTERNAL_NOTE_CATEGORIES = [
  "courier_update",
  "supervisor_instruction",
  "listing_issue",
  "case_history",
  "general",
] as const;

export type InternalNoteCategory = (typeof INTERNAL_NOTE_CATEGORIES)[number];

/**
 * The one category this application writes.
 *
 * NOT A DEFAULT A CALLER MAY OVERRIDE. The category is not asked for, is not
 * read from a request, and cannot be set through the API — see
 * `parseInternalNoteRequest`. The writer supplies this constant so the NOT NULL
 * column is satisfied without a client ever naming a value.
 */
export const STORED_INTERNAL_NOTE_CATEGORY: InternalNoteCategory = "general";

/**
 * The only visibility a note may have, mirroring `ck_internal_notes_visibility`
 * in migration 0012.
 *
 * Declared here as well as in the schema so the application states the same
 * rule the database enforces, and so a guard test can assert there is exactly
 * one value rather than trusting that nobody added a second.
 */
export const INTERNAL_NOTE_VISIBILITY = "internal";

/**
 * A ceiling on the text, and it is a ceiling rather than a target.
 *
 * A note is a short record of where a case stands. 2,000 characters is far
 * more than any of the examples this was specified with and still small enough
 * that a runaway paste cannot fill the panel or the column. The database does
 * not constrain length — `note_text` is `text` — so this is the application
 * saying what it considers a note, which is a judgement, not an invariant.
 */
export const INTERNAL_NOTE_MAX_LENGTH = 2_000;

/** One stored note, as the interface reads it. */
export type InternalNote = {
  readonly id: string;
  /** `cst_app.conversations.id` — the conversation this note is about. */
  readonly conversationId: string;
  readonly category: InternalNoteCategory;
  readonly noteText: string;
  /**
   * `order_management.orders.id` in the read-only source database, when the
   * note is about one order. A plain id, never resolved into order data here.
   */
  readonly sourceOrderId: string | null;
  /**
   * ALWAYS NULL TODAY. This application has no interactive sign-in, so there
   * is no agent identity to record. Absent authorship is the honest answer;
   * see migration 0012 for why a fabricated one would be worse.
   */
  readonly authorUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type InternalNoteFeed = {
  readonly notes: readonly InternalNote[];
  /** True when the conversation has more notes than the page that was read. */
  readonly hasMore: boolean;
};

/** The panel's own title, so the UI and its tests cannot disagree. */
export const INTERNAL_NOTES_TITLE = "Internal Notes";

/*
 * THERE IS DELIBERATELY NO EMPTY-STATE STRING.
 *
 * Two were tried and both were removed. "No internal notes for this
 * conversation yet" restated the section's own heading and the open
 * conversation back at the reader to report an absence; "No notes yet." was
 * the same claim, shorter. A section headed Internal Notes with nothing under
 * it but the add-a-note box has already said it, and a sentence there is one
 * more line to read on a column that is mostly read by scanning.
 *
 * A constant is not kept for a string nothing renders — see the note in
 * `tests/guards/draft-workflow.test.ts` about allowlists that keep entries for
 * deleted features.
 */

/**
 * Why a submitted note was refused.
 *
 * A CLOSED SET, for the same reason `NOTE_RESOLUTION_FAILURES` is one in
 * `customer-note.ts`: each is shown to an agent as a sentence, and "invalid
 * request" is not a sentence anybody can act on.
 *
 * THERE IS NO CATEGORY REJECTION, because there is no category to get wrong —
 * a request cannot set one. See `parseInternalNoteRequest`.
 */
export const INTERNAL_NOTE_REJECTIONS = ["blank_text", "text_too_long"] as const;

export type InternalNoteRejection = (typeof INTERNAL_NOTE_REJECTIONS)[number];

/** What the agent is told. Never a code, and never the raw input back. */
export const INTERNAL_NOTE_REJECTION_MESSAGE: Readonly<Record<InternalNoteRejection, string>> = {
  blank_text: "Write the note before saving it.",
  text_too_long: `A note can be at most ${INTERNAL_NOTE_MAX_LENGTH} characters.`,
};

/** A stored category, or null. The single place the membership test lives. */
export function parseInternalNoteCategory(raw: unknown): InternalNoteCategory | null {
  return INTERNAL_NOTE_CATEGORIES.find((candidate) => candidate === raw) ?? null;
}

/**
 * What a client may send. Deliberately narrow, and narrower than it was.
 *
 * FOUR THINGS A REQUEST CANNOT SET, each for its own reason:
 *
 *   visibility       letting a caller name it would make the one guarantee
 *                    this feature offers a client-supplied value
 *   category         no longer part of the experience; the writer supplies
 *                    `STORED_INTERNAL_NOTE_CATEGORY` and a category in the
 *                    body is ignored rather than honoured
 *   conversation_id  comes from the route path, so a note cannot be moved to
 *                    another conversation by editing a body
 *   author_user_id   there is no sign-in; a client-named author would be a
 *                    fabricated one
 *
 * Unknown keys are ignored rather than rejected — a caller sending one gets
 * the note they asked for, stored the way this application stores notes.
 */
const requestSchema = z.object({
  noteText: z.unknown(),
  sourceOrderId: z.unknown().optional(),
});

export type InternalNoteDraft = {
  /** Trimmed. What is stored is what the agent meant, without the stray edges. */
  readonly noteText: string;
  readonly sourceOrderId: string | null;
};

export type InternalNoteParse =
  | { readonly ok: true; readonly draft: InternalNoteDraft }
  | { readonly ok: false; readonly reason: InternalNoteRejection };

/**
 * Validates a submitted note.
 *
 * RUNS IN BOTH PLACES. The panel calls it so an agent is told what is wrong
 * before a request is made; the route calls it again on whatever actually
 * arrives, because the first call is a convenience and the second is the rule.
 * One function, so the two can never disagree about what a valid note is.
 *
 * BLANK IS WHITESPACE TOO. `   ` is not a note, and the database agrees —
 * `ck_internal_notes_text_present` checks `length(btrim(note_text)) > 0`. This
 * refuses it first, with a sentence, rather than letting it arrive as a
 * constraint violation nobody can read.
 */
export function parseInternalNoteRequest(body: unknown): InternalNoteParse {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "blank_text" };

  const text = parseNoteText(parsed.data.noteText);
  if (typeof text !== "string") return { ok: false, reason: text.reason };

  return {
    ok: true,
    draft: { noteText: text, sourceOrderId: parseSourceOrderId(parsed.data.sourceOrderId) },
  };
}

/**
 * An edit. The text, and nothing else.
 *
 * SEPARATE FROM `parseInternalNoteRequest` RATHER THAN SHARED, because the two
 * accept different things and always will: a new note may name the order it is
 * about, an edit may not re-point an existing one. Sharing a parser would mean
 * one permissive schema covering both, which is how an edit quietly acquires
 * the ability to change something it was never meant to.
 */
export type InternalNoteEdit = { readonly noteText: string };

export type InternalNoteEditParse =
  | { readonly ok: true; readonly edit: InternalNoteEdit }
  | { readonly ok: false; readonly reason: InternalNoteRejection };

export function parseInternalNoteUpdate(body: unknown): InternalNoteEditParse {
  const parsed = z.object({ noteText: z.unknown() }).safeParse(body);
  if (!parsed.success) return { ok: false, reason: "blank_text" };

  const text = parseNoteText(parsed.data.noteText);
  if (typeof text !== "string") return { ok: false, reason: text.reason };

  return { ok: true, edit: { noteText: text } };
}

/** The text rules, in one place, so a new note and an edit cannot diverge. */
function parseNoteText(raw: unknown): string | { readonly reason: InternalNoteRejection } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { reason: "blank_text" };
  if (text.length > INTERNAL_NOTE_MAX_LENGTH) return { reason: "text_too_long" };
  return text;
}

/**
 * A note id from a URL path, or null.
 *
 * Same shape as `parseConversationId`: digits only, no leading zero, within
 * bigint range. A path segment that is not a positive integer is not an id,
 * and it is refused before it can reach a query.
 */
export function parseInternalNoteId(raw: string): string | null {
  return /^[1-9][0-9]{0,18}$/.test(raw) ? raw : null;
}

/**
 * An optional source order id, or null.
 *
 * DIGITS ONLY, and never coerced from anything else. This ends up in a
 * `bigint` column naming a row in the read-only source database; a value that
 * is not a plain positive integer is not an order id, and guessing what a
 * caller meant by one is how a note gets filed against somebody else's order.
 * Anything unusable is dropped to null rather than rejecting the whole note —
 * the note is the thing worth keeping, and the order link is optional.
 */
function parseSourceOrderId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return String(raw);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^[1-9][0-9]{0,18}$/.test(trimmed) ? trimmed : null;
}

/**
 * Which note is the pinned one.
 *
 * THE NEWEST, AND THERE IS NO STORED PIN. Nothing marks a note as pinned —
 * no flag, no column, no second row — so "pinned" is a question answered
 * from the list every time it is asked. That is what makes the behaviour
 * everyone expects fall out for free: adding a note promotes it, deleting
 * the newest promotes the one behind it, and deleting the last leaves
 * nothing to pin.
 *
 * PURE, and separate from the component that renders it, so the rule can be
 * tested without a DOM — this project runs none.
 *
 * `orderInternalNotes` rather than trusting the caller's order: the feed
 * arrives newest-first from the database, but a locally prepended note or an
 * edited one must not be able to change which note is pinned by arriving in
 * a different position.
 */
export function pinnedInternalNote(
  notes: readonly InternalNote[] | null,
): InternalNote | undefined {
  if (notes === null || notes.length === 0) return undefined;
  return orderInternalNotes(notes)[0];
}

/** The notes not currently pinned. Shown in the details column, not above the thread. */
export function unpinnedInternalNotes(
  notes: readonly InternalNote[] | null,
): readonly InternalNote[] {
  if (notes === null || notes.length === 0) return [];
  return orderInternalNotes(notes).slice(1);
}

/**
 * Notes for one conversation, newest first.
 *
 * NEWEST FIRST, matching `findCustomerNotes` and the notification feed rather
 * than the message thread above it. A note is a progress record: what somebody
 * needs on opening a case is the latest position, and reading down from it is
 * how the history is then read. The thread is oldest-first because a
 * conversation only makes sense read forwards; a stack of notes does not.
 *
 * PURE, so the SQL ordering and the rendered order cannot drift apart.
 */
export function orderInternalNotes(notes: readonly InternalNote[]): readonly InternalNote[] {
  return [...notes].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    return Number(right.id) - Number(left.id);
  });
}
