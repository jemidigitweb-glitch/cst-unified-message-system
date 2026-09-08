import {
  type FetchOptions,
  type FetchResult,
  type Queryable,
  buildFetchQuery,
  buildPkFetchQuery as buildSourcePkFetchQuery,
  classifyRows as classifySourceRows,
  fetchMessages as fetchSourceMessages,
  fetchMessagesByPk as fetchSourceMessagesByPk,
} from "@/lib/marketplaces/source-fetch";

import { BANDQ_SOURCE, type BandqSourceRow, normalizeRow } from "./adapter";

/**
 * Read-only B&Q message repository.
 *
 * STRICTLY READ-ONLY — every statement is a SELECT. The pool supplied by the
 * caller additionally pins `default_transaction_read_only=on`.
 *
 * There is no system-notice rule here. eBay needed one because 29% of its rows
 * are bodiless platform notices; every B&Q row carries body text, so inventing
 * a filter would silently drop real customer messages.
 */

/**
 * `m.date::text` keeps the naive `timestamp without time zone` exactly as
 * stored; without it the driver would build a Date through the process
 * timezone while the authoritative source zone is still unconfirmed.
 */
const SELECT_COLUMNS = `
    m.${BANDQ_SOURCE.pkColumn}::text        AS id,
    m.message_id                            AS message_id,
    m.sub_source                            AS sub_source,
    m.message_type                          AS message_type,
    m.order_id                              AS order_id,
    m.${BANDQ_SOURCE.timestampColumn}::text AS message_date,
    m.message_content                       AS message_content`;

export function buildQuery(options: FetchOptions): { text: string; values: unknown[] } {
  return buildFetchQuery(BANDQ_SOURCE, SELECT_COLUMNS, options);
}

export function classifyRows(rows: readonly BandqSourceRow[]): FetchResult {
  return classifySourceRows(rows, normalizeRow);
}

export async function fetchMessages(
  client: Queryable,
  options: FetchOptions,
): Promise<FetchResult> {
  return fetchSourceMessages(client, BANDQ_SOURCE, SELECT_COLUMNS, normalizeRow, options);
}

/**
 * Re-reads named rows by primary key, for body repair. No window and no
 * watermark — see `buildPkFetchQuery` in the shared module.
 */
export function buildPkQuery(sourcePks: readonly string[]): { text: string; values: unknown[] } {
  return buildSourcePkFetchQuery(BANDQ_SOURCE, SELECT_COLUMNS, sourcePks);
}

export async function fetchMessagesByPk(
  client: Queryable,
  sourcePks: readonly string[],
): Promise<FetchResult> {
  return fetchSourceMessagesByPk(client, BANDQ_SOURCE, SELECT_COLUMNS, normalizeRow, sourcePks);
}
