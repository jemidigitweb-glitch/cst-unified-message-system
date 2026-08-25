import type { SourceMessage } from "@/lib/domain/source-message";
import {
  type FetchOptions,
  type Queryable,
  buildFetchQuery,
} from "@/lib/marketplaces/source-fetch";

import {
  AMAZON_SOURCE,
  type AmazonSourceRow,
  isPlatformNotice,
  normalizeRow,
} from "./adapter";

/**
 * Read-only Amazon message repository.
 *
 * STRICTLY READ-ONLY — every statement is a SELECT. The pool supplied by the
 * caller additionally pins `default_transaction_read_only=on`.
 *
 * Every row that can be honestly normalized becomes a message — including
 * Amazon's own platform notices, which are tagged and counted
 * (`platformNoticeCount`) but not excluded. CST is a human-verification
 * system: nothing read from the source is hidden from the reviewer.
 *
 *   messages       a customer message, a CST reply, or a platform notice
 *   unusable       an unmapped sender, or no account attribution
 *
 * Nothing is silently discarded.
 */

export type AmazonFetchResult = {
  readonly messages: readonly SourceMessage[];
  readonly platformNoticeCount: number;
  readonly unusableCount: number;
  readonly rowsExamined: number;
};

/**
 * `m.date::text` keeps the naive `timestamp without time zone` exactly as
 * stored; without it the driver would build a Date through the process
 * timezone while the authoritative source zone is still unconfirmed.
 *
 * `from_msg` and `from_name` are selected because they ARE the direction rule.
 * The recipient columns are not: the mailbox is always ours, so they carry no
 * information and are personal data we have no use for.
 */
const SELECT_COLUMNS = `
    m.${AMAZON_SOURCE.pkColumn}::text        AS id,
    m.message_id                             AS message_id,
    m.sub_source                             AS sub_source,
    m.from_msg                               AS from_msg,
    m.from_name                              AS from_name,
    m.message_type                           AS message_type,
    m.order_id                               AS order_id,
    m.asin                                   AS asin,
    m.${AMAZON_SOURCE.timestampColumn}::text AS message_date,
    m.message_content                        AS message_content`;

export function buildQuery(options: FetchOptions): { text: string; values: unknown[] } {
  return buildFetchQuery(AMAZON_SOURCE, SELECT_COLUMNS, options);
}

/** Normalizes every row into a message, tagging platform notices and counting the unmapped. */
export function classifyRows(rows: readonly AmazonSourceRow[]): AmazonFetchResult {
  const messages: SourceMessage[] = [];
  let platformNoticeCount = 0;
  let unusableCount = 0;

  for (const row of rows) {
    if (isPlatformNotice(row)) platformNoticeCount += 1;
    const normalized = normalizeRow(row);
    if (normalized === null) unusableCount += 1;
    else messages.push(normalized);
  }

  return { messages, platformNoticeCount, unusableCount, rowsExamined: rows.length };
}

export async function fetchMessages(
  client: Queryable,
  options: FetchOptions,
): Promise<AmazonFetchResult> {
  const { rows } = await client.query(buildQuery(options));
  return classifyRows(rows as AmazonSourceRow[]);
}
