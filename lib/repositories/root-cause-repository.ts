import {
  type MessageAppRootCause,
  type MessageAppRootCauseCandidate,
  resolveMessageAppRootCause,
} from "@/lib/domain/message-app-root-cause";
import { AMAZON_SOURCE } from "@/lib/marketplaces/amazon/adapter";
import { BANDQ_SOURCE } from "@/lib/marketplaces/bandq/adapter";
import { EBAY_SOURCE } from "@/lib/marketplaces/ebay/adapter";
import { SHOPIFY_SOURCE } from "@/lib/marketplaces/shopify/adapter";
import { TEMU_SOURCE } from "@/lib/marketplaces/temu/adapter";

/**
 * Reads the message application's stored root cause for a CST conversation.
 *
 * TWO CLIENTS, AND THE SPLIT IS THE WHOLE SAFETY STORY. The conversation's
 * source identity comes from the APP database (`cst_app.conversation_messages`);
 * the root cause itself comes from the read-only marketplace SOURCE. Neither
 * statement in this file is anything but a SELECT, and the source pool pins
 * `default_transaction_read_only=on` on its session, so the server would refuse
 * a write from this path even if one were written.
 *
 * ---------------------------------------------------------------------------
 * NO SECOND THREADING SYSTEM, DELIBERATELY
 * ---------------------------------------------------------------------------
 * The message application rebuilds a thread per marketplace at read time —
 * eBay by (sender_id, sub_source, item_id) with a 200-row cap, Shopify by
 * (sub_source, mail_id, subject) behind a hard date floor, Amazon by its own
 * scope helper — and then picks a "buyer anchor" row within it.
 *
 * None of that is reimplemented here and none of it needs to be. CST has ALREADY
 * threaded these rows: `lib/domain/threading.ts` grouped them, the sync recorded
 * each row's full source identity, and `uq_conversation_messages_source_identity`
 * guarantees one row per source row. So the question "which source rows belong to
 * this thread" is already answered, by a stored, versioned, reviewable decision.
 * This file asks that question of `conversation_messages` and nothing else.
 *
 * The consequence worth stating: CST's thread and the message application's
 * thread are not guaranteed to be the same set of rows. Where they differ, CST
 * sees its own grouping — which is the grouping the reviewer is looking at on
 * screen, and therefore the right one to report against. A disagreement surfaces
 * as `ambiguous`, not as a silently different answer.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE NAME IS NEVER TAKEN FROM THE DATABASE
 * ---------------------------------------------------------------------------
 * `conversation_messages.source_table` is stored text, and a table identifier
 * cannot be a bound parameter. Interpolating that column into SQL would be
 * injection through a data column.
 *
 * So the statements below are built ONCE, at module load, from the marketplace
 * adapters' own `as const` source constants — compile-time literals, the same
 * ones the sync wrote with. A stored `source_table` is only ever used to LOOK UP
 * a prepared statement, never to build one. A row naming anything not on the
 * allowlist is counted and skipped; see `unreadableRowCount`.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * Every source table that carries a `root_cause` column, from the adapters.
 *
 * ALL FIVE MARKETPLACES, and the column is on the table CST already records as
 * the row's `source_table` in each case — including eBay, where that is the
 * HEADER table (`ebay_message_headers`) and not the body table. The body table
 * has no root cause and is never the recorded source table.
 */
const ROOT_CAUSE_SOURCES = [
  { schema: EBAY_SOURCE.schema, table: EBAY_SOURCE.headerTable, pk: EBAY_SOURCE.pkColumn },
  { schema: AMAZON_SOURCE.schema, table: AMAZON_SOURCE.messageTable, pk: AMAZON_SOURCE.pkColumn },
  { schema: SHOPIFY_SOURCE.schema, table: SHOPIFY_SOURCE.messageTable, pk: SHOPIFY_SOURCE.pkColumn },
  { schema: BANDQ_SOURCE.schema, table: BANDQ_SOURCE.messageTable, pk: BANDQ_SOURCE.pkColumn },
  { schema: TEMU_SOURCE.schema, table: TEMU_SOURCE.messageTable, pk: TEMU_SOURCE.pkColumn },
] as const;

/**
 * A safe SQL identifier.
 *
 * The values above are literals from reviewed source files, so this can only
 * fail if somebody edits an adapter into something dangerous — which is exactly
 * when a loud failure is wanted. Checked in code rather than trusted in a
 * comment, and unit-tested, because a rule that lives only inside a template
 * string cannot be.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function isSafeSqlIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER.test(value);
}

/** Statement per table, keyed by `schema.table`, built once from literals. */
const SELECT_ROOT_CAUSE = new Map<string, string>(
  ROOT_CAUSE_SOURCES.map((source) => {
    for (const identifier of [source.schema, source.table, source.pk]) {
      if (!isSafeSqlIdentifier(identifier)) {
        throw new Error(`root cause source: unsafe identifier ${identifier}`);
      }
    }
    return [
      `${source.schema}.${source.table}`,
      `
SELECT ${source.pk}::text AS source_pk,
       root_cause
FROM ${source.schema}.${source.table}
WHERE ${source.pk} = ANY($1::bigint[])`,
    ];
  }),
);

/** Exposed so a test can assert which tables are reachable, and which are not. */
export const ROOT_CAUSE_SOURCE_KEYS: readonly string[] = [...SELECT_ROOT_CAUSE.keys()];

/**
 * The conversation's source rows, NEWEST FIRST.
 *
 * `source_pk::bigint` for the tiebreak, matching `GET_MESSAGES` in
 * `conversation-repository.ts` — the thread already orders this way, and a text
 * sort would put row 9 after row 10. This is that ordering reversed, because the
 * newest stored spelling of an agreed label is the one to display.
 */
const GET_CONVERSATION_SOURCE_ROWS = `
SELECT source_schema,
       source_table,
       source_pk
FROM cst_app.conversation_messages
WHERE conversation_id = $1::bigint
ORDER BY source_ts DESC, source_pk::bigint DESC`;

/** Exposed so a test can assert what it selects, and that it selects only. */
export const GET_CONVERSATION_SOURCE_ROWS_SQL = GET_CONVERSATION_SOURCE_ROWS;

type SourceRowIdentity = {
  source_schema: string;
  source_table: string;
  source_pk: string;
};

type RootCauseRow = {
  source_pk: string;
  root_cause: string | null;
};

export type MessageAppRootCauseLookup = {
  readonly rootCause: MessageAppRootCause;
  /** Every source row on this conversation, readable or not. */
  readonly sourceRowCount: number;
  /** Rows skipped because the table was unmapped or the key was not a number. */
  readonly unreadableRowCount: number;
};

/** A primary key this repository is willing to put in a bigint array. */
function usableSourcePk(raw: string): string | null {
  return /^[0-9]{1,19}$/.test(raw) ? raw : null;
}

/**
 * The message application's root cause for one conversation.
 *
 * ONE QUERY PER SOURCE TABLE, not one per row. A conversation is almost always
 * single-table, so this is normally two statements in total; a mixed-table
 * conversation costs one more. The source pool is `max: 1` and every use is a
 * single `pool.query()`, so these are issued in sequence rather than in parallel —
 * concurrent statements on that pool would queue anyway.
 *
 * NEVER THROWS ON MISSING DATA. A conversation with no rows, no readable rows,
 * or no stored value all return a lookup whose state says which — the caller
 * renders the difference, and nothing is invented to fill a gap.
 */
export async function loadMessageAppRootCause(
  app: Queryable,
  source: Queryable,
  conversationId: string,
): Promise<MessageAppRootCauseLookup> {
  const identityResult = await app.query({
    text: GET_CONVERSATION_SOURCE_ROWS,
    values: [conversationId],
  });
  const rows = identityResult.rows as SourceRowIdentity[];

  if (rows.length === 0) {
    return {
      rootCause: resolveMessageAppRootCause([]),
      sourceRowCount: 0,
      unreadableRowCount: 0,
    };
  }

  // Which keys to ask for, per table, de-duplicated. A slice written by the
  // classifier repeats the same label across rows, so asking twice for one key
  // would cost a round trip and change no answer.
  const wanted = new Map<string, Set<string>>();
  let unreadableRowCount = 0;

  for (const row of rows) {
    const key = `${row.source_schema}.${row.source_table}`;
    const pk = usableSourcePk(row.source_pk);
    if (!SELECT_ROOT_CAUSE.has(key) || pk === null) {
      unreadableRowCount += 1;
      continue;
    }
    const keys = wanted.get(key);
    if (keys === undefined) wanted.set(key, new Set([pk]));
    else keys.add(pk);
  }

  // `${table} ${pk}` — NUL cannot occur in either half, so the composite
  // key cannot collide the way a `:` separator could against a table name.
  const stored = new Map<string, string | null>();
  for (const [tableKey, keys] of wanted) {
    const result = await source.query({
      text: SELECT_ROOT_CAUSE.get(tableKey)!,
      values: [[...keys]],
    });
    for (const found of result.rows as RootCauseRow[]) {
      stored.set(`${tableKey} ${found.source_pk}`, found.root_cause);
    }
  }

  // Walked in the app database's newest-first order, so "newest spelling wins"
  // is decided by the stored timestamp rather than by however the source
  // happened to return its rows.
  const candidates: MessageAppRootCauseCandidate[] = [];
  for (const row of rows) {
    const key = `${row.source_schema}.${row.source_table}`;
    const pk = usableSourcePk(row.source_pk);
    if (pk === null) continue;
    const found = stored.get(`${key} ${pk}`);
    // `undefined` is "the source no longer has this row", which is a legitimate
    // absence rather than an error: the source is authoritative and may have
    // removed it. It contributes no value, exactly like a NULL column.
    candidates.push({ value: found ?? null });
  }

  return {
    rootCause: resolveMessageAppRootCause(candidates),
    sourceRowCount: rows.length,
    unreadableRowCount,
  };
}

/**
 * The conversation's source rows for MANY conversations at once, newest first
 * within each.
 *
 * SAME ORDERING AS THE SINGLE-CONVERSATION READ, because the resolution rule
 * depends on it: "newest wins" decides which SPELLING of an agreed label to
 * show. `conversation_id` leads only to group the result; it does not change
 * which value wins inside a group.
 */
const GET_SOURCE_ROWS_FOR_CONVERSATIONS = `
SELECT conversation_id::text AS conversation_id,
       source_schema,
       source_table,
       source_pk
FROM cst_app.conversation_messages
WHERE conversation_id = ANY($1::bigint[])
ORDER BY conversation_id, source_ts DESC, source_pk::bigint DESC`;

/** Exposed so a test can assert what it selects, and that it selects only. */
export const GET_SOURCE_ROWS_FOR_CONVERSATIONS_SQL = GET_SOURCE_ROWS_FOR_CONVERSATIONS;

/**
 * The message application's root cause for MANY conversations, for export.
 *
 * ---------------------------------------------------------------------------
 * ONE QUERY PER SOURCE TABLE FOR THE WHOLE BATCH
 * ---------------------------------------------------------------------------
 * The per-conversation reader issues up to five statements per conversation.
 * Exporting a thousand conversations that way would be five thousand round
 * trips on a pool of ONE connection, which is not an export but an outage.
 *
 * So every conversation's keys are collected first and asked for per TABLE —
 * five statements in total, whatever the batch size. The resolution itself is
 * the same pure function the panel uses, applied per conversation, so the
 * export and the screen can never disagree about what a thread's value is.
 *
 * NEVER THROWS ON MISSING DATA, exactly like the single read: a conversation
 * with no rows, no readable rows or no stored value resolves to a state that
 * says which, and nothing is invented to fill a gap.
 */
export async function loadMessageAppRootCausesForConversations(
  app: Queryable,
  source: Queryable,
  conversationIds: readonly string[],
): Promise<Map<string, MessageAppRootCause>> {
  const resolved = new Map<string, MessageAppRootCause>();
  if (conversationIds.length === 0) return resolved;

  const identityResult = await app.query({
    text: GET_SOURCE_ROWS_FOR_CONVERSATIONS,
    values: [[...conversationIds]],
  });
  const rows = identityResult.rows as (SourceRowIdentity & { conversation_id: string })[];

  // Which keys to ask for, per table, across the whole batch and de-duplicated.
  const wanted = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.source_schema}.${row.source_table}`;
    const pk = usableSourcePk(row.source_pk);
    if (!SELECT_ROOT_CAUSE.has(key) || pk === null) continue;
    const keys = wanted.get(key);
    if (keys === undefined) wanted.set(key, new Set([pk]));
    else keys.add(pk);
  }

  const stored = new Map<string, string | null>();
  for (const [tableKey, keys] of wanted) {
    const result = await source.query({
      text: SELECT_ROOT_CAUSE.get(tableKey)!,
      values: [[...keys]],
    });
    for (const found of result.rows as RootCauseRow[]) {
      stored.set(`${tableKey} ${found.source_pk}`, found.root_cause);
    }
  }

  // Walked in the app database's order, so each conversation's candidates keep
  // their newest-first sequence.
  const candidates = new Map<string, MessageAppRootCauseCandidate[]>();
  for (const row of rows) {
    const key = `${row.source_schema}.${row.source_table}`;
    const pk = usableSourcePk(row.source_pk);
    if (pk === null) continue;
    const found = stored.get(`${key} ${pk}`);
    const list = candidates.get(row.conversation_id);
    if (list === undefined) candidates.set(row.conversation_id, [{ value: found ?? null }]);
    else list.push({ value: found ?? null });
  }

  for (const id of conversationIds) {
    resolved.set(id, resolveMessageAppRootCause(candidates.get(id) ?? []));
  }
  return resolved;
}
