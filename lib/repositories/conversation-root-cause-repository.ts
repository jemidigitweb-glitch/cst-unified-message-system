import "server-only";

import type { RootCauseExportRow } from "@/lib/domain/root-cause-export";
import type { ConversationRootCause, RootCauseRecord } from "@/lib/domain/root-cause-selection";

/**
 * CST's own recorded root cause, in the application database only.
 *
 * WRITES ONLY TO cst_app.conversation_root_causes AND
 * cst_app.conversation_root_cause_labels, and the only two writing statements
 * in this file are one INSERT into each. Nothing here touches the read-only
 * marketplace source, another project's schema, the automation's tables, the
 * staff notes table, or anything the draft workflow owns.
 *
 * Those neighbours are described rather than named, following
 * `follow-up-reminder-repository.ts`: a comment saying "not that one" is
 * indistinguishable from a query to the text search that guards them.
 *
 * ---------------------------------------------------------------------------
 * APPEND-ONLY, AND THE ABSENCE OF AN UPDATE IS THE FEATURE
 * ---------------------------------------------------------------------------
 * Changing a root cause INSERTS; it never updates. There is no UPDATE and no
 * DELETE anywhere in this module and neither should be added.
 *
 * This is the one behaviour of the message application's that is deliberately
 * not copied. There, changing a root cause overwrites the column and discards
 * the prior confirmation, so nothing records what it was before or how often it
 * moved. The whole point of asking which courier causes the most problems is
 * that somebody will later ask how a number was arrived at — and a history that
 * was overwritten cannot answer.
 *
 * THE CURRENT VALUE IS THEREFORE A READ, not a column: the newest row for the
 * conversation. `ix_conversation_root_causes_conversation` stores exactly that
 * ordering, so it costs an index lookup rather than a sort.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER DECIDES WHAT IS VALID
 * ---------------------------------------------------------------------------
 * `readRootCauseSelection` does, and this stores what it produced. Nothing here
 * re-checks a vocabulary, defaults a missing courier or trims a note: a
 * repository that silently repaired its input would make the rules two
 * statements in two places, and the quieter one would win.
 *
 * Every query is parameterised. No caller string is ever interpolated.
 */

/**
 * The slice of node-postgres this repository needs.
 *
 * Structural rather than `Pool`, following `conversation-repository.ts`, so
 * every statement here can be exercised against a recording fake without a
 * database. Production callers pass `getAppPool()`.
 */
export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/** A checked-out connection. Released by the caller, always. */
export type Session = Queryable & { release: () => void };

/**
 * A pool that can hand out one connection for a transaction.
 *
 * SEPARATE FROM `Queryable` ON PURPOSE. Only `recordRootCause` needs this;
 * every read takes the narrower type and therefore CANNOT open a transaction
 * even by accident. Production callers pass `getAppPool()`.
 */
export type Transactable = Queryable & { connect: () => Promise<Session> };

/** Postgres `undefined_table` — migration 0020 has not been applied here. */
const UNDEFINED_TABLE = "42P01";
/** Postgres `foreign_key_violation` — no such conversation. */
const FOREIGN_KEY_VIOLATION = "23503";
/** Postgres `check_violation` — the last line held; see `readRootCauseSelection`. */
const CHECK_VIOLATION = "23514";

function hasCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === code
  );
}

/**
 * Whether the table is absent.
 *
 * 0020 is applied BY HAND, like every migration in this project, so a deployment
 * that has not run it yet is a real state rather than a broken one. The route
 * turns this into "recording is not available here" — which is a different
 * thing to tell an agent than "your selection failed".
 */
export function isRootCauseStoreMissing(cause: unknown): boolean {
  return hasCode(cause, UNDEFINED_TABLE);
}

/**
 * Whether the insert failed because the conversation does not exist.
 *
 * READ FROM THE DATABASE'S OWN ANSWER rather than from a prior SELECT. Checking
 * first and inserting second is a race — the conversation can be deleted between
 * the two — and the foreign key is the only thing that actually decides.
 */
export function isUnknownConversation(cause: unknown): boolean {
  return hasCode(cause, FOREIGN_KEY_VIOLATION);
}

/**
 * Whether a CHECK rejected the row.
 *
 * This should be unreachable: `readRootCauseSelection` enforces the same rules
 * first and refuses with a sentence an agent can act on. If it ever fires, the
 * two statements of the rules have drifted — so it is reported as a rejection
 * rather than a 500, and logged loudly at the route.
 */
export function isRejectedByConstraint(cause: unknown): boolean {
  return hasCode(cause, CHECK_VIOLATION);
}

const COLUMNS = `
       id::text AS id,
       custom_root_cause,
       courier,
       courier_issue_type,
       vocabulary_version,
       issue_note,
       recorded_at`;

/**
 * One recorded selection.
 *
 * `recorded_by_user_id` IS NOT IN THIS STATEMENT AT ALL, rather than being sent
 * as NULL. CST has no interactive sign-in and the agreed position for this phase
 * is a single staff user, so the column takes its default — and a writer that
 * cannot name an author is better than one holding a parameter slot waiting for
 * a caller to guess at one. A courier report naming a person is read as fact
 * about them.
 *
 * `RETURNING` the stored row rather than echoing the input, so the caller
 * reports what the database actually holds and the recorded instant is the
 * database's own clock.
 */
const INSERT_ROOT_CAUSE = `
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, custom_root_cause, courier, courier_issue_type,
        issue_note, vocabulary_version)
VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::integer)
RETURNING${COLUMNS}`;

/**
 * The current value: the newest row, and only ever one row.
 *
 * `recorded_at DESC, id DESC` matches the index and breaks a tie the way the
 * rest of this project does — two rows can share an instant when a selection is
 * corrected immediately, and the identity column is the only total order.
 */
const GET_CURRENT_ROOT_CAUSE = `
SELECT${COLUMNS}
  FROM cst_app.conversation_root_causes
 WHERE conversation_id = $1::bigint
 ORDER BY recorded_at DESC, id DESC
 LIMIT 1`;

/**
 * The full history of one conversation, newest first.
 *
 * Bounded by a constant rather than a caller's limit: this is a sidebar read on
 * a single case, and a conversation whose root cause has moved more than fifty
 * times is telling a story that a longer list would not improve.
 */
const HISTORY_LIMIT = 50;

const GET_ROOT_CAUSE_HISTORY = `
SELECT${COLUMNS}
  FROM cst_app.conversation_root_causes
 WHERE conversation_id = $1::bigint
 ORDER BY recorded_at DESC, id DESC
 LIMIT ${HISTORY_LIMIT}`;

/**
 * The selected labels, against the parent revision just inserted.
 *
 * `unnest` rather than a statement per label: the whole set goes in ONE round
 * trip, and the array is bound, so a label can never reach the SQL text. The
 * unique constraint on (parent, label) is the database's last word on
 * duplicates; the domain rule catches them first with a sentence.
 */
const INSERT_LABELS = `
INSERT INTO cst_app.conversation_root_cause_labels
       (conversation_root_cause_id, root_cause)
SELECT $1::bigint, label
  FROM unnest($2::text[]) AS label`;

/**
 * The labels belonging to a set of parent revisions.
 *
 * BY PARENT ID, never by conversation. Asking the conversation would pile every
 * revision's labels together and keep reporting a cause an agent had removed.
 *
 * Ordered by `id` so the set reads back in the order it was written, which is
 * the order the agent selected them in.
 */
const GET_LABELS = `
SELECT conversation_root_cause_id::text AS parent_id,
       root_cause
  FROM cst_app.conversation_root_cause_labels
 WHERE conversation_root_cause_id = ANY($1::bigint[])
 ORDER BY conversation_root_cause_id, id`;

/** Exposed so a guard test can assert what these statements do, and do not do. */
export const ROOT_CAUSE_STATEMENTS = {
  insert: INSERT_ROOT_CAUSE,
  insertLabels: INSERT_LABELS,
  current: GET_CURRENT_ROOT_CAUSE,
  history: GET_ROOT_CAUSE_HISTORY,
  labels: GET_LABELS,
} as const;

type RootCauseRow = {
  id: string;
  custom_root_cause: string | null;
  courier: string | null;
  courier_issue_type: string | null;
  issue_note: string | null;
  vocabulary_version: number | string;
  recorded_at: string | Date;
};

type LabelRow = {
  parent_id: string;
  root_cause: string;
};

/**
 * A timestamptz column as an ISO string.
 *
 * The same normalisation `conversation-repository.ts` applies: node-postgres
 * hands back a `Date` for `timestamptz` and a string for text, and one wire
 * format is what a caller can rely on.
 */
function instantOf(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toRootCause(
  row: RootCauseRow,
  rootCauses: readonly string[] = [],
): ConversationRootCause {
  return {
    id: row.id,
    // The labels of THIS revision, verbatim. Never re-cased and never mapped to
    // a canonical spelling: a value on screen must be findable
    // character-for-character in what was stored.
    rootCauses,
    // The agent's own words, read back exactly as they wrote them. Kept apart
    // from the labels so a reader can tell a chosen capsule from typed prose,
    // and from `issueNote` because they answer different questions.
    customRootCause: row.custom_root_cause,
    courier: row.courier,
    courierIssueType: row.courier_issue_type,
    issueNote: row.issue_note,
    // `integer` arrives as a number, but a bigint-shaped driver setting or a
    // fake could hand back text; the column is NOT NULL, so 0 marks a read that
    // went wrong rather than a version that exists.
    vocabularyVersion: Number(row.vocabulary_version) || 0,
    // NOT NULL in the schema, so null here would be a broken read rather than an
    // absent value. The empty string is never produced by `instantOf`.
    recordedAt: instantOf(row.recorded_at) ?? "",
  };
}

/**
 * Records a selection: one revision header and its labels, atomically.
 *
 * No message is prepared, no draft is touched, no worker is woken and nothing
 * is sent anywhere: this writes rows a CST agent will read. The conversation is
 * verified by the foreign key rather than by a prior read.
 */
export async function recordRootCause(
  db: Transactable,
  conversationId: string,
  record: RootCauseRecord,
): Promise<ConversationRootCause> {
  /*
   * ONE TRANSACTION, ON ONE CHECKED-OUT CONNECTION.
   *
   * The parent revision and its labels are one recorded decision, so
   * they commit together or not at all. Issued on the pool directly they would
   * be free to land on different connections, and a failing child would leave a
   * parent behind claiming the agent chose nothing extra — a silently wrong
   * record, which is worse than a failed save because nobody would look at it
   * again.
   *
   * `release()` is in `finally` so the connection returns to the pool on every
   * path. The pool is small (`max: 2`); a leaked client here would starve the
   * whole application, which is the failure this project has already had once.
   */
  const session = await db.connect();
  try {
    await session.query({ text: "BEGIN" });

    const { rows } = await session.query({
      text: INSERT_ROOT_CAUSE,
      values: [
        conversationId,
        record.customRootCause,
        record.courier,
        record.courierIssueType,
        record.issueNote,
        record.vocabularyVersion,
      ],
    });
    const row = (rows as RootCauseRow[])[0];
    if (row === undefined) throw new Error("Root cause insert returned no row");

    /*
     * ALWAYS AT LEAST ONE LABEL, AND THE STATEMENT IS UNCONDITIONAL.
     *
     * `readRootCauseSelection` refuses an empty selection, so a parent with no
     * labels cannot be produced by this path. Writing it unconditionally means
     * a future caller that skipped that rule fails loudly here rather than
     * committing a headless revision nobody can read.
     */
    await session.query({
      text: INSERT_LABELS,
      values: [row.id, [...record.rootCauses]],
    });

    await session.query({ text: "COMMIT" });

    // The labels as they were validated — the same set the statement above
    // wrote, in the same order. Not re-read: the transaction has committed and
    // a second round trip would only re-fetch what is already known.
    return toRootCause(row, record.rootCauses);
  } catch (cause) {
    /*
     * ROLLBACK, and a failure to roll back must not replace the real error.
     * The original tells the caller why the record was rejected; a secondary
     * connection fault thrown from here would hide it.
     */
    try {
      await session.query({ text: "ROLLBACK" });
    } catch {
      /* the connection is already broken; the pool discards it on release */
    }
    throw cause;
  } finally {
    session.release();
  }
}

/**
 * The root cause CST currently holds for a conversation, or null.
 *
 * NULL MEANS NOTHING HAS BEEN RECORDED, which the panel renders as an empty
 * selector rather than as an error — most conversations will never have one, and
 * that is not a degraded state.
 */
export async function getCurrentRootCause(
  db: Queryable,
  conversationId: string,
): Promise<ConversationRootCause | null> {
  const { rows } = await db.query({
    text: GET_CURRENT_ROOT_CAUSE,
    values: [conversationId],
  });
  const row = (rows as RootCauseRow[])[0];
  if (row === undefined) return null;

  /*
   * The labels of THIS revision and no other. Asking by parent id rather than
   * by conversation is what makes a removed label actually disappear: an
   * earlier revision's set stays attached to that earlier revision.
   *
   * A second statement rather than a join, because a join would repeat the
   * whole parent row once per label and the caller would have to collapse it
   * again. Two small indexed reads are cheaper to issue and to read.
   */
  const labels = await labelsFor(db, [row.id]);
  return toRootCause(row, labels.get(row.id) ?? []);
}

/**
 * Labels for a set of parent revisions, grouped by parent.
 *
 * Returns an empty map for an empty request rather than issuing a statement
 * with an empty array — a caller with no revisions has nothing to ask about,
 * and a round trip to learn that is one nobody needs.
 */
async function labelsFor(
  db: Queryable,
  parentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (parentIds.length === 0) return grouped;

  const { rows } = await db.query({
    text: GET_LABELS,
    values: [[...parentIds]],
  });

  for (const row of rows as LabelRow[]) {
    const existing = grouped.get(row.parent_id);
    if (existing === undefined) grouped.set(row.parent_id, [row.root_cause]);
    else existing.push(row.root_cause);
  }
  return grouped;
}

/**
 * Every selection ever recorded on a conversation, newest first.
 *
 * The append-only table's reason for existing, readable. Not consumed by the
 * panel in this phase; it is here so that the question "when did this change,
 * and from what" has an answer that does not require a hand-written query.
 */
export async function getRootCauseHistory(
  db: Queryable,
  conversationId: string,
): Promise<readonly ConversationRootCause[]> {
  const { rows } = await db.query({
    text: GET_ROOT_CAUSE_HISTORY,
    values: [conversationId],
  });
  const revisions = rows as RootCauseRow[];

  /*
   * EACH REVISION GETS ITS OWN LABELS, and they are never pooled. One statement
   * fetches every revision's children and they are grouped by parent — so a
   * label removed in a later revision still shows against the earlier one that
   * recorded it, which is the entire point of keeping this history.
   */
  const labels = await labelsFor(
    db,
    revisions.map((revision) => revision.id),
  );
  return revisions.map((revision) => toRootCause(revision, labels.get(revision.id) ?? []));
}

/**
 * Every conversation's CURRENT root cause revision, for export.
 *
 * `DISTINCT ON (conversation_id)` with the same ordering the panel uses, so the
 * export and the screen agree about what "current" means. Counting rows here
 * counts CASES — one line per conversation — which is the number an operator
 * reading a spreadsheet will assume they are counting.
 *
 * The marketplace and store come from `cst_app.conversations`, a join inside
 * the SAME database. The store NAME lives in the read-only source and is
 * deliberately not fetched here: this statement must not reach across.
 */
const EXPORT_CURRENT_ROOT_CAUSES = `
WITH current_revision AS (
  SELECT DISTINCT ON (r.conversation_id)
         r.id,
         r.conversation_id,
         r.custom_root_cause,
         r.courier,
         r.courier_issue_type,
         r.issue_note,
         r.recorded_at
    FROM cst_app.conversation_root_causes r
   WHERE ($1::timestamptz IS NULL OR r.recorded_at >= $1::timestamptz)
     AND ($2::timestamptz IS NULL OR r.recorded_at <  $2::timestamptz)
   ORDER BY r.conversation_id, r.recorded_at DESC, r.id DESC
)
SELECT cr.conversation_id::text AS conversation_id,
       c.marketplace,
       c.sub_source_id,
       c.counterparty_ref,
       COALESCE(
         (SELECT s.order_number
            FROM cst_app.context_snapshots s
           WHERE s.conversation_id = c.id
             AND s.resolution = 'single_order'
             AND s.order_number IS NOT NULL
           ORDER BY s.resolved_at DESC, s.id DESC
           LIMIT 1),
         CASE WHEN c.marketplace <> $3::text THEN c.counterparty_ref END
       ) AS order_number,
       cr.custom_root_cause,
       cr.courier,
       cr.courier_issue_type,
       cr.issue_note,
       cr.recorded_at,
       COALESCE(
         (SELECT array_agg(l.root_cause ORDER BY l.id)
            FROM cst_app.conversation_root_cause_labels l
           WHERE l.conversation_root_cause_id = cr.id),
         ARRAY[]::text[]
       ) AS root_causes
  FROM current_revision cr
  JOIN cst_app.conversations c ON c.id = cr.conversation_id
 ORDER BY cr.recorded_at DESC, cr.id DESC`;

/**
 * What this module can supply.
 *
 * NOT the message application's value — that lives in the read-only source and
 * this module must never reach it. The route joins the two halves, which keeps
 * "the writer cannot touch the source" a property of the code rather than a
 * promise in a comment.
 */
export type ExportRowWithoutMessageApp = Omit<
  RootCauseExportRow,
  "messageAppRootCause" | "customerName"
> & {
  /**
   * The thread's own reference, carried out so the ROUTE can resolve a name
   * from it. A buyer username on eBay, an order number everywhere else.
   *
   * It is not itself a column in the file: a marketplace handle printed under
   * "Customer" would look like a person's name to whoever reads the report.
   */
  readonly counterpartyRef: string;
};

/**
 * The marketplace whose `counterparty_ref` is a PERSON, not an order.
 *
 * The same constant `conversation-repository.ts` keeps, and for the same
 * reason: eBay keys its threads by the buyer's username, every other
 * marketplace by the order number. BOUND as a parameter rather than inlined,
 * so no marketplace literal appears in this SQL.
 */
const USERNAME_KEYED_MARKETPLACE = "ebay";

type ExportRow = {
  conversation_id: string;
  marketplace: string;
  sub_source_id: number | null;
  counterparty_ref: string;
  order_number: string | null;
  custom_root_cause: string | null;
  courier: string | null;
  courier_issue_type: string | null;
  issue_note: string | null;
  recorded_at: string | Date;
  root_causes: string[] | null;
};

/**
 * The current root cause of every conversation that has one, newest first.
 *
 * Both bounds are OPTIONAL and bound as NULL when absent, so one statement
 * serves "everything" and "this date range" without string-building a WHERE
 * clause — which is how a date filter turns into an injection point.
 */
export async function exportCurrentRootCauses(
  db: Queryable,
  range: { readonly from?: string | null; readonly to?: string | null } = {},
): Promise<readonly ExportRowWithoutMessageApp[]> {
  const { rows } = await db.query({
    text: EXPORT_CURRENT_ROOT_CAUSES,
    values: [range.from ?? null, range.to ?? null, USERNAME_KEYED_MARKETPLACE],
  });

  return (rows as ExportRow[]).map((row) => ({
    conversationId: row.conversation_id,
    marketplace: row.marketplace,
    subSourceId: row.sub_source_id,
    orderNumber: row.order_number,
    counterpartyRef: row.counterparty_ref,
    rootCauses: row.root_causes ?? [],
    customRootCause: row.custom_root_cause,
    courier: row.courier,
    courierIssueType: row.courier_issue_type,
    issueNote: row.issue_note,
    recordedAt: instantOf(row.recorded_at) ?? "",
  }));
}
