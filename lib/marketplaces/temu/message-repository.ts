import {
  type FetchOptions,
  type FetchResult,
  type Queryable,
  buildFetchQuery,
  classifyRows as classifySourceRows,
  fetchMessages as fetchSourceMessages,
} from "@/lib/marketplaces/source-fetch";

import { TEMU_SOURCE, type TemuSourceRow, normalizeRow } from "./adapter";

/**
 * Read-only Temu message repository.
 *
 * STRICTLY READ-ONLY — every statement is a SELECT. The pool supplied by the
 * caller additionally pins `default_transaction_read_only=on`.
 *
 * There is no system-notice rule here. eBay needed one because 29% of its rows
 * are bodiless platform notices; every Temu row carries body text, so inventing
 * a filter would silently drop real customer messages.
 */

/**
 * `m.date::text` keeps the naive `timestamp without time zone` exactly as
 * stored; without it the driver would build a Date through the process
 * timezone while the authoritative source zone is still unconfirmed.
 */
const SELECT_COLUMNS = `
    m.${TEMU_SOURCE.pkColumn}::text        AS id,
    m.message_id                           AS message_id,
    m.sub_source                           AS sub_source,
    m.message_type                         AS message_type,
    m.order_id                             AS order_id,
    m.${TEMU_SOURCE.timestampColumn}::text AS message_date,
    m.message_content                      AS message_content`;

export function buildQuery(options: FetchOptions): { text: string; values: unknown[] } {
  return buildFetchQuery(TEMU_SOURCE, SELECT_COLUMNS, options);
}

export function classifyRows(rows: readonly TemuSourceRow[]): FetchResult {
  return classifySourceRows(rows, normalizeRow);
}

export async function fetchMessages(
  client: Queryable,
  options: FetchOptions,
): Promise<FetchResult> {
  return fetchSourceMessages(client, TEMU_SOURCE, SELECT_COLUMNS, normalizeRow, options);
}
