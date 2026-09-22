import "server-only";

import {
  type FollowUpReminder,
  type FollowUpReminderStatus,
} from "@/lib/domain/follow-up-reminder";

/**
 * Shared follow-up reminder storage, in the application database only.
 *
 * WRITES ONLY TO cst_app.follow_up_reminders. Nothing here touches the
 * read-only source database, another project's schema, `cst_app.internal_notes`,
 * `cst_app.automation_items`, or anything the draft workflow owns. The only two
 * statements that write are `INSERT_REMINDER` and `COMPLETE_REMINDER`, and both
 * name that one table.
 *
 * NOTHING HERE CAN CONTACT A CUSTOMER. There is no transport, no template, no
 * recipient and no marketplace call — creating or completing a reminder changes
 * one row and has no effect a customer could observe.
 *
 * Every query is parameterised. The only values ever interpolated are the two
 * ORDER BY constants below, chosen from a closed set by an already-validated
 * status — never a caller's string.
 *
 * NO DELETE. A reminder is completed or cancelled, never removed: the record of
 * what CST promised is the point of the table.
 */

/**
 * The slice of node-postgres this repository needs.
 *
 * A structural type rather than `Pool`, following `conversation-repository.ts`:
 * the pool is injected rather than imported, so every statement here can be
 * exercised against a recording fake without a database. Production callers
 * pass `getAppPool()`.
 */
export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/** Postgres `undefined_table` — migration 0014 has not been applied here. */
const UNDEFINED_TABLE = "42P01";
/** Postgres `foreign_key_violation` — no such conversation. */
const FOREIGN_KEY_VIOLATION = "23503";

function hasCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === code
  );
}

export function isFollowUpStoreMissing(cause: unknown): boolean {
  return hasCode(cause, UNDEFINED_TABLE);
}

/**
 * Whether the insert failed because the conversation does not exist.
 *
 * READ FROM THE DATABASE'S OWN ANSWER rather than from a prior SELECT. Checking
 * first and inserting second is a race: the conversation can be deleted between
 * the two, and the foreign key is the only thing that actually decides. One
 * statement, and its error is the verdict.
 */
export function isUnknownConversation(cause: unknown): boolean {
  return hasCode(cause, FOREIGN_KEY_VIOLATION);
}

/** Defaults and ceiling for a page, mirroring the inbox list's shape. */
export const DEFAULT_REMINDER_LIMIT = 100;
export const MAX_REMINDER_LIMIT = 200;

const COLUMNS = `
       id::text              AS id,
       conversation_id::text AS conversation_id,
       promised_due_at,
       note,
       status,
       completed_at,
       created_at,
       updated_at`;

/**
 * The working list: what is still owed, soonest first.
 *
 * `promised_due_at ASC, id ASC` is exactly the order `ix_follow_up_reminders_due`
 * stores, so the partial index answers this without a sort.
 */
const ORDER_SOONEST_DUE = "promised_due_at ASC, id ASC";

/**
 * History: what was dealt with, most recently first.
 *
 * `COALESCE(completed_at, updated_at)` because a cancelled reminder has no
 * completion time but was still acted on at some point, and ordering it by the
 * promise it no longer owes would file it under a date nobody acted on.
 */
const ORDER_RECENTLY_SETTLED = "COALESCE(completed_at, updated_at) DESC, id DESC";

/**
 * One reminder. `RETURNING` the whole row rather than just the id, so the
 * caller reports what the database actually stored — the normalised instant and
 * the defaulted status — instead of echoing back what it sent.
 */
const INSERT_REMINDER = `
INSERT INTO cst_app.follow_up_reminders (conversation_id, promised_due_at, note)
VALUES ($1::bigint, $2::timestamptz, $3::text)
RETURNING${COLUMNS}`;

/**
 * Completion, guarded on the status.
 *
 * `AND status = 'scheduled'` is what makes this safe to call twice: a reminder
 * that is already completed matches no row, so `completed_at` cannot be
 * rewritten and a second completion cannot be recorded. The caller learns which
 * happened from the row count — see `completeReminder`.
 *
 * `now()` is the DATABASE clock for both columns, so the two can never disagree
 * and no application timezone reaches the row.
 */
const COMPLETE_REMINDER = `
UPDATE cst_app.follow_up_reminders
   SET status = 'completed',
       completed_at = now(),
       updated_at = now()
 WHERE id = $1::bigint AND status = 'scheduled'
RETURNING${COLUMNS}`;

type ReminderRow = {
  id: string;
  conversation_id: string;
  promised_due_at: string | Date;
  note: string | null;
  status: string;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

/**
 * A timestamptz column as an ISO string, or null.
 *
 * The same normalisation `conversation-repository.ts` applies, and for the same
 * reason: node-postgres hands back a `Date` for `timestamptz` and a string for
 * text, and one wire format is what a caller can rely on.
 */
function instantOf(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toReminder(row: ReminderRow): FollowUpReminder {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    // NOT NULL in the schema, so a null here would be a broken read rather than
    // an absent value; the empty string is never produced by `instantOf`.
    promisedDueAt: instantOf(row.promised_due_at) ?? "",
    note: row.note,
    status: row.status as FollowUpReminderStatus,
    completedAt: instantOf(row.completed_at),
    createdAt: instantOf(row.created_at) ?? "",
    updatedAt: instantOf(row.updated_at) ?? "",
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return DEFAULT_REMINDER_LIMIT;
  return Math.min(limit, MAX_REMINDER_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  return offset !== undefined && Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

/**
 * Records a promise. ONE INSERT, and nothing else happens.
 *
 * No notification is raised, no worker is woken and no message is prepared:
 * this writes a row. The conversation is verified by the foreign key rather
 * than by a prior read — see `isUnknownConversation`.
 */
export async function createReminder(
  db: Queryable,
  input: {
    readonly conversationId: string;
    readonly promisedDueAt: string;
    readonly note?: string | null;
  },
): Promise<FollowUpReminder> {
  const { rows } = await db.query({
    text: INSERT_REMINDER,
    values: [input.conversationId, input.promisedDueAt, input.note ?? null],
  });
  const row = (rows as ReminderRow[])[0];
  if (row === undefined) throw new Error("Reminder insert returned no row");
  return toReminder(row);
}

export type ReminderPage = {
  readonly items: readonly FollowUpReminder[];
  readonly hasMore: boolean;
};

/**
 * The shared list, across every conversation, narrowed to one status.
 *
 * A STATUS IS REQUIRED rather than defaulted here, because "all reminders ever"
 * is not a list anybody works from and mixing what is owed with what is done
 * would need two orderings at once. The route supplies the default.
 *
 * `hasMore` comes from asking for one row more than the page and never
 * returning it — the same trick `listConversations` uses, so a caller can tell
 * "that is everything" from "there is another page".
 */
export async function listReminders(
  db: Queryable,
  options: {
    readonly status: FollowUpReminderStatus;
    readonly limit?: number;
    readonly offset?: number;
  },
): Promise<ReminderPage> {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);
  // Chosen from two constants by an already-validated status. No caller string
  // reaches this, and the status itself is still bound as $1.
  const order = options.status === "scheduled" ? ORDER_SOONEST_DUE : ORDER_RECENTLY_SETTLED;
  const { rows } = await db.query({
    text: `SELECT${COLUMNS}
  FROM cst_app.follow_up_reminders
 WHERE status = $1::text
 ORDER BY ${order}
 LIMIT $2 OFFSET $3`,
    values: [options.status, limit + 1, offset],
  });
  const all = rows as ReminderRow[];
  return { items: all.slice(0, limit).map(toReminder), hasMore: all.length > limit };
}

/**
 * Every reminder on one conversation, whatever its status.
 *
 * NOT FILTERED, because opening a thread should show what was promised AND what
 * was done — a completed reminder is the evidence somebody dealt with it.
 * Ordered newest promise first, which is the order
 * `ix_follow_up_reminders_conversation` stores.
 */
export async function getConversationReminders(
  db: Queryable,
  conversationId: string,
): Promise<readonly FollowUpReminder[]> {
  const { rows } = await db.query({
    text: `SELECT${COLUMNS}
  FROM cst_app.follow_up_reminders
 WHERE conversation_id = $1::bigint
 ORDER BY promised_due_at DESC, id DESC
 LIMIT ${MAX_REMINDER_LIMIT}`,
    values: [conversationId],
  });
  return (rows as ReminderRow[]).map(toReminder);
}

/**
 * Marks a scheduled reminder completed. `scheduled -> completed`, and no other
 * transition exists in this module.
 *
 * Returns the updated reminder, or NULL when no scheduled reminder had that id
 * — which covers both "no such reminder" and "already settled". The caller
 * turns that into the conflict response; see the route. Calling this twice
 * cannot produce a second completion or move `completed_at`, because the second
 * call matches no row.
 */
export async function completeReminder(
  db: Queryable,
  reminderId: string,
): Promise<FollowUpReminder | null> {
  const { rows } = await db.query({
    text: COMPLETE_REMINDER,
    values: [reminderId],
  });
  const row = (rows as ReminderRow[])[0];
  return row === undefined ? null : toReminder(row);
}
