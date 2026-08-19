import type { SourceMessage, SourceWatermark } from "@/lib/domain/source-message";

import { EBAY_SOURCE, type EbaySourceRow, normalizeRow, rowIsSystemNotice } from "./adapter";

/**
 * Read-only eBay message repository.
 *
 * STRICTLY READ-ONLY. Every statement here is a SELECT. The pool supplied by the
 * caller additionally pins `default_transaction_read_only=on`, so the server
 * rejects a write rather than relying on this module's discipline.
 *
 * No ORM: the source has zero foreign key constraints, so the header/body join
 * below is an explicitly reviewed relationship proven against real data, not one
 * a mapper inferred from column names.
 *
 * The pool is injected rather than imported so this module stays free of
 * `server-only` and remains directly testable. Production callers pass
 * `getSourcePool()`.
 */

/** The slice of node-postgres this repository needs. */
export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export const MAX_FETCH_LIMIT = 1000;
export const DEFAULT_FETCH_LIMIT = 200;

/**
 * Which slice of the source to read. There is deliberately NO default.
 *
 * An earlier revision treated "no watermark" as "read the whole table oldest
 * first, with a LIMIT". That is an unbounded historical backfill arrived at by
 * accident rather than by decision, so the caller must now say which it wants.
 *
 *   after               resume: strictly after a (timestamp, pk) pair
 *   bootstrap           first run: at or after an explicit start timestamp
 *   unbounded_backfill  everything, oldest first — deliberate opt-in only
 *
 * No bootstrap duration is encoded here. Choosing how far back to start is a
 * business decision for the sync caller, not a constant in the source layer.
 */
export type FetchWindow =
  | { readonly mode: "after"; readonly watermark: SourceWatermark }
  | { readonly mode: "bootstrap"; readonly startAt: string }
  | { readonly mode: "unbounded_backfill" };

export type FetchOptions = {
  readonly window: FetchWindow;
  readonly limit?: number;
};

export type FetchResult = {
  readonly messages: readonly SourceMessage[];
  /** Rows excluded because they are structurally proven platform notices. */
  readonly systemNoticeCount: number;
  /** Rows that could not be represented honestly (unmapped folder, missing handle). */
  readonly unusableCount: number;
  /** Raw rows examined, before any exclusion. */
  readonly rowsExamined: number;
};

/**
 * Base projection.
 *
 * Two casts matter and are deliberate:
 *   `h.receive_date::text` — keeps the naive `timestamp without time zone`
 *     exactly as stored. Without it the driver builds a JS Date through the
 *     process timezone, silently shifting every message while the authoritative
 *     source zone is still unconfirmed.
 *   `h.id::text` / `h.item_id::text` / `h.ext_message_id::text` — bigints as
 *     text, so values beyond 2^53 keep full precision.
 *
 * LEFT JOIN, not JOIN: ~29% of headers have no body row. Those must still be
 * seen, so they can be classified rather than silently dropped.
 * The join is safe 1:1 from the header side — `ebay_messages.message_id` is
 * UNIQUE — so it cannot fan out a header into duplicate rows.
 */
const SELECT_COLUMNS = `
    h.${EBAY_SOURCE.pkColumn}::text          AS id,
    h.ext_message_id::text                   AS ext_message_id,
    h.message_id                             AS message_id,
    h.sub_source                             AS sub_source,
    h.item_id::text                          AS item_id,
    h.folder_id                              AS folder_id,
    h.message_type                           AS message_type,
    h.sender_id                              AS sender_id,
    h.receiver_id                            AS receiver_id,
    h.${EBAY_SOURCE.timestampColumn}::text   AS receive_date,
    b.message                                AS body_raw
  FROM ${EBAY_SOURCE.schema}.${EBAY_SOURCE.headerTable} h
  LEFT JOIN ${EBAY_SOURCE.schema}.${EBAY_SOURCE.bodyTable} b
    ON b.${EBAY_SOURCE.bodyForeignColumn} = h.${EBAY_SOURCE.bodyJoinColumn}`;

const ORDER_BY = `ORDER BY h.${EBAY_SOURCE.timestampColumn} ASC, h.${EBAY_SOURCE.pkColumn} ASC`;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_FETCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, received: ${String(limit)}`);
  }
  return Math.min(limit, MAX_FETCH_LIMIT);
}

/**
 * Builds the fetch. Every supplied value is parameterised; only fixed
 * identifiers are interpolated.
 *
 * The resume predicate uses a row-value comparison —
 * `(receive_date, id) > ($1, $2)` — which is exactly "strictly after this pair".
 * A plain `receive_date > $1` would skip every remaining row sharing the
 * boundary second, and `>=` would replay them. Row-value comparison gets the
 * tiebreaker right in one predicate, so pagination neither skips nor duplicates.
 *
 * Bootstrap uses `>=` so a row landing exactly on the chosen start instant is
 * included rather than lost.
 */
export function buildFetchQuery(options: FetchOptions): {
  text: string;
  values: unknown[];
} {
  const values: unknown[] = [];
  let where = "";

  switch (options.window.mode) {
    case "after": {
      values.push(options.window.watermark.sourceTimestamp, options.window.watermark.sourcePk);
      where = `\n  WHERE (h.${EBAY_SOURCE.timestampColumn}, h.${EBAY_SOURCE.pkColumn}) > ($1::timestamp, $2::bigint)`;
      break;
    }
    case "bootstrap": {
      values.push(options.window.startAt);
      where = `\n  WHERE h.${EBAY_SOURCE.timestampColumn} >= $1::timestamp`;
      break;
    }
    case "unbounded_backfill": {
      where = "";
      break;
    }
  }

  values.push(clampLimit(options.limit));
  const text = `SELECT${SELECT_COLUMNS}${where}\n  ${ORDER_BY}\n  LIMIT $${values.length}`;

  return { text, values };
}

/**
 * Fetches the next batch of eBay messages for the requested window.
 *
 * System notices are excluded from the returned messages and counted instead —
 * they are not customer conversations and must never become one. Rows that
 * cannot be normalized honestly are likewise counted, not coerced.
 */
export async function fetchMessages(
  client: Queryable,
  options: FetchOptions,
): Promise<FetchResult> {
  const { rows } = await client.query(buildFetchQuery(options));
  return classifyRows(rows as EbaySourceRow[]);
}

/** Splits raw rows into usable messages, system notices, and unusable rows. */
export function classifyRows(rows: readonly EbaySourceRow[]): FetchResult {
  const messages: SourceMessage[] = [];
  let systemNoticeCount = 0;
  let unusableCount = 0;

  for (const row of rows) {
    if (rowIsSystemNotice(row)) {
      systemNoticeCount += 1;
      continue;
    }
    const normalized = normalizeRow(row);
    if (normalized === null) {
      unusableCount += 1;
      continue;
    }
    messages.push(normalized);
  }

  return { messages, systemNoticeCount, unusableCount, rowsExamined: rows.length };
}

/**
 * Confirms the connection really is read-only before any source read.
 * Cheap, and it fails loudly if the guard is ever dropped from the pool config.
 */
export async function assertSourceReadOnly(client: Queryable): Promise<void> {
  const { rows } = await client.query({
    text: "SELECT current_setting('transaction_read_only') AS read_only, current_database() AS db",
  });
  const row = rows[0] as { read_only?: string; db?: string } | undefined;
  if (row?.read_only !== "on") {
    throw new Error(
      `Source connection is not read-only (transaction_read_only=${String(row?.read_only)})`,
    );
  }
  if (row.db !== EBAY_SOURCE.database) {
    throw new Error(`Source connection is not the expected source database`);
  }
}
