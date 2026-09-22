import {
  type InternalNote,
  type InternalNoteDraft,
  STORED_INTERNAL_NOTE_CATEGORY,
  parseInternalNoteCategory,
} from "@/lib/domain/internal-note";

/**
 * Writes one internal note to `cst_app.internal_notes`, in the APPLICATION
 * database (varmen_db) and nowhere else.
 *
 * NEVER THE SOURCE DATABASE. The live marketplace database is read-only for
 * this project — the role holds SELECT only and the pool pins
 * `default_transaction_read_only=on` — so an internal note has no home there
 * and this writer must never be handed that pool. The caller supplies the
 * client; `app/api/conversations/[conversationId]/notes/route.ts` supplies
 * `getAppPool()`, and `tests/guards/internal-note-visibility.test.ts` pins
 * that it is the only pool this feature names.
 *
 * IT THROWS, AND THAT IS A DELIBERATE DEPARTURE from `rule-analysis-writer.ts`
 * and `ai-usage-writer.ts`, which swallow their failures. Those two record
 * something the application derived and can derive again — losing one is a
 * nuisance. This one records something a PERSON TYPED. It exists nowhere else,
 * there is no second copy to fall back on, and an agent told "saved" over a
 * note that was not saved has been lied to about the case record. A failure
 * here has to reach the agent, so it is raised rather than logged.
 *
 * INSERT ONLY. Phase 1 creates and views; there is no update and no delete
 * statement in this feature.
 *
 * `visibility` IS NOT WRITTEN. The column defaults to 'internal' and
 * `ck_internal_notes_visibility` permits nothing else, so the guarantee comes
 * from the schema rather than from a value this writer could get wrong.
 * `author_user_id` is likewise left to its NULL default: this application has
 * no interactive agent identity, and an invented author is worse than an
 * absent one.
 */

export type Writable = {
  query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * The returned shape is identical for the create and the edit, so the columns
 * are named once. A created note and an edited one must not be able to
 * disagree about what a note is.
 */
const RETURNED_COLUMNS = `
RETURNING id::text              AS id,
          conversation_id::text AS conversation_id,
          note_category         AS note_category,
          note_text             AS note_text,
          source_order_id::text AS source_order_id,
          author_user_id::text  AS author_user_id,
          created_at::text      AS created_at,
          updated_at::text      AS updated_at`;

/**
 * BOTH THE ID AND THE CONVERSATION MUST MATCH.
 *
 * `conversation_id = $2` is what stops a note id borrowed from another case
 * being edited through this one's URL. Only the text and `updated_at` are set:
 * ownership, visibility, category and `created_at` are all untouchable here.
 */
const EDIT_NOTE = `
UPDATE cst_app.internal_notes
SET note_text  = $3,
    updated_at = now()
WHERE id = $1::bigint
  AND conversation_id = $2::bigint
${RETURNED_COLUMNS}`;

/** Same scoping rule as the edit: a note id alone is never enough. */
const REMOVE_NOTE = `
DELETE FROM cst_app.internal_notes
WHERE id = $1::bigint
  AND conversation_id = $2::bigint
RETURNING id::text AS id`;

const ADD_NOTE = `
INSERT INTO cst_app.internal_notes (conversation_id, note_category, note_text, source_order_id)
VALUES ($1::bigint, $2, $3, $4::bigint)
${RETURNED_COLUMNS}`;

type WrittenRow = {
  id: string;
  conversation_id: string;
  note_category: string;
  note_text: string;
  source_order_id: string | null;
  author_user_id: string | null;
  created_at: string;
  updated_at: string;
};

/** Postgres `foreign_key_violation` — the conversation does not exist. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Whether the write failed because there is no such conversation.
 *
 * `fk_internal_notes_conversation` is what establishes that a note belongs to
 * a real case, so a violation here is a 404 about the conversation rather than
 * a 500 about the note. Checked by code, never by matching the message text.
 */
export function isUnknownConversation(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === FOREIGN_KEY_VIOLATION
  );
}

/**
 * Stores one note and returns it as it was written.
 *
 * RETURNS THE STORED ROW, not the submitted draft. The id and both timestamps
 * are the database's, so the panel shows the row that actually exists rather
 * than an optimistic copy of what was asked for.
 *
 * The draft has already been validated by `parseInternalNoteRequest`; the
 * database checks the same two rules again (`ck_internal_notes_category`,
 * `ck_internal_notes_text_present`) and would reject a note that slipped past.
 */
export async function addInternalNote(
  client: Writable,
  conversationId: string,
  draft: InternalNoteDraft,
): Promise<InternalNote> {
  const { rows } = await client.query({
    text: ADD_NOTE,
    // The category is this application's constant, never the caller's: the
    // column is NOT NULL and nobody is asked to fill it. See the domain module.
    values: [conversationId, STORED_INTERNAL_NOTE_CATEGORY, draft.noteText, draft.sourceOrderId],
  });

  const row = (rows as WrittenRow[])[0];
  if (row === undefined) {
    throw new Error("internal note insert returned no row");
  }
  return toNote(row);
}

/**
 * Replaces one note's text, and stamps `updated_at`.
 *
 * CONVERSATION-SCOPED IN THE WHERE CLAUSE, AND THAT IS THE ACCESS CONTROL.
 * Both the id and the conversation must match, so a note id from one
 * conversation cannot be edited through another conversation's URL — the
 * statement simply matches no row and the caller gets a 404. This is not a
 * check the route performs and could forget; it is the only statement there
 * is, and `tests/guards/internal-note-visibility.test.ts` pins the clause.
 *
 * THE SET CLAUSE IS TWO COLUMNS. `conversation_id` is not among them, so an
 * edit cannot move a note to another case; `visibility` is not among them, so
 * an edit cannot make a note customer-visible; `note_category` is not among
 * them, so an edit cannot reclassify what it never asked about; and
 * `created_at` is not among them, because when a note was written does not
 * change when it is corrected.
 *
 * Returns undefined when no such note belongs to that conversation, which the
 * route answers as 404 — deliberately the same answer for "no such note" and
 * "not your conversation", so a caller cannot use the difference to learn that
 * a note id exists somewhere else.
 */
export async function updateInternalNote(
  client: Writable,
  conversationId: string,
  noteId: string,
  edit: { readonly noteText: string },
): Promise<InternalNote | undefined> {
  const { rows } = await client.query({
    text: EDIT_NOTE,
    values: [noteId, conversationId, edit.noteText],
  });
  const row = (rows as WrittenRow[])[0];
  return row === undefined ? undefined : toNote(row);
}

/**
 * Removes one note.
 *
 * CONVERSATION-SCOPED, for the same reason and in the same way as the edit
 * above: a note id alone is never enough. Returns false when nothing matched,
 * which the route answers as 404.
 *
 * A REAL DELETE, NOT A FLAG. This project uses no soft deletes anywhere — see
 * migration 0003's note on the same question — and inventing one here would be
 * a new convention introduced by a note feature rather than by a decision.
 */
export async function deleteInternalNote(
  client: Writable,
  conversationId: string,
  noteId: string,
): Promise<boolean> {
  const { rows } = await client.query({
    text: REMOVE_NOTE,
    values: [noteId, conversationId],
  });
  return rows.length > 0;
}

/** One stored row, as the application reads it. Shared by all three writes. */
function toNote(row: WrittenRow): InternalNote {
  const category = parseInternalNoteCategory(row.note_category);
  if (category === null) {
    // Unreachable while the CHECK and the declared set agree. Raised rather
    // than coerced, because a note whose category this application cannot name
    // is a note it cannot account for.
    throw new Error("internal note was stored with an unknown category");
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    category,
    noteText: row.note_text,
    sourceOrderId: row.source_order_id,
    authorUserId: row.author_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
