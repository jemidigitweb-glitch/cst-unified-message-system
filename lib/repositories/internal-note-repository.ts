import "server-only";

import {
  type InternalNote,
  type InternalNoteFeed,
  orderInternalNotes,
  parseInternalNoteCategory,
} from "@/lib/domain/internal-note";

/**
 * Reads `cst_app.internal_notes` — the CST staff notes written in this
 * application, in the APPLICATION database.
 *
 * THE APPLICATION POOL, NEVER THE SOURCE POOL. These rows do not exist in the
 * read-only marketplace database and nothing here may reach it. That is not a
 * style preference: `lib/db/pools.ts` pins `default_transaction_read_only=on`
 * on the source pool and the source role holds SELECT only, so a note written
 * through the wrong pool would fail — but a note READ through the wrong pool
 * would simply, silently, find nothing. `tests/guards/internal-note-
 * visibility.test.ts` pins which pool this feature uses.
 *
 * READS ONLY. The insert lives in `lib/sync/internal-note-writer.ts`, which is
 * where this project puts writes.
 *
 * NO EDIT OR DELETE. Phase 1 creates and views. There is no update statement
 * and no delete statement in this feature at all.
 */

/** Application reads. Satisfied by a `pg` Pool or a pooled client. */
export type Queryable = {
  query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows: unknown[] }>;
};

type InternalNoteRow = {
  id: string;
  conversation_id: string;
  note_category: string;
  note_text: string;
  source_order_id: string | null;
  author_user_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * `visibility` is deliberately not selected.
 *
 * Migration 0012 constrains it to the single value 'internal', so reading it
 * back would put a column on screen that can only ever say one thing. The
 * guarantee is in the schema, not in a field the interface renders.
 *
 * `LIMIT $2 + 1` fetches one more row than asked so the caller can report
 * whether the list is complete without a second counting query — the same
 * device `customer-note-repository.ts` uses.
 */
const FIND_NOTES = `
SELECT n.id::text              AS id,
       n.conversation_id::text AS conversation_id,
       n.note_category         AS note_category,
       n.note_text             AS note_text,
       n.source_order_id::text AS source_order_id,
       n.author_user_id::text  AS author_user_id,
       n.created_at::text      AS created_at,
       n.updated_at::text      AS updated_at
FROM cst_app.internal_notes n
WHERE n.conversation_id = $1::bigint
ORDER BY n.created_at DESC, n.id DESC
LIMIT $2::int`;

/** Postgres `undefined_table` — migration 0012 has not been applied. */
const UNDEFINED_TABLE = "42P01";

/**
 * Whether the notes table is absent.
 *
 * The same predicate as `isDraftStoreMissing` in `draft-repository.ts`, named
 * for this store rather than imported from that one. A notes route reporting a
 * missing DRAFT store would read as a bug in the draft feature, and sending a
 * reader to the wrong migration is the entire cost this saves.
 */
export function isInternalNoteStoreMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === UNDEFINED_TABLE
  );
}

/**
 * A stored row, or undefined when it is one this application will not show.
 *
 * `note_category` is re-checked against the declared set even though
 * `ck_internal_notes_category` already constrains it. The CHECK is what keeps
 * the column honest; this is what keeps the TYPE honest, so a value added to
 * the database ahead of the application cannot arrive typed as something the
 * interface has no label for.
 */
function toNote(row: InternalNoteRow): InternalNote | undefined {
  const category = parseInternalNoteCategory(row.note_category);
  if (category === null) return undefined;
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

/** The declared page size. A guard against a runaway, not a shape. */
export const INTERNAL_NOTE_PAGE_LIMIT = 200;

/**
 * One conversation's internal notes, newest first.
 *
 * SCOPED BY CONVERSATION IN THE WHERE CLAUSE, and by nothing else. There is no
 * unscoped listing of every note in this repository, deliberately: the only
 * question this feature answers is "what has CST recorded about THIS case".
 */
export async function findInternalNotes(
  client: Queryable,
  conversationId: string,
  options: { readonly limit?: number } = {},
): Promise<InternalNoteFeed> {
  const limit = Math.max(1, Math.min(options.limit ?? INTERNAL_NOTE_PAGE_LIMIT, INTERNAL_NOTE_PAGE_LIMIT));
  const { rows } = await client.query({ text: FIND_NOTES, values: [conversationId, limit + 1] });

  const notes = (rows as InternalNoteRow[])
    .map(toNote)
    .filter((note): note is InternalNote => note !== undefined);

  return {
    // Ordered again in the domain, so the rendered order is the declared one
    // whether the rows came from this query or from a caller's own read.
    notes: orderInternalNotes(notes).slice(0, limit),
    hasMore: notes.length > limit,
  };
}
