import type { SourceMessage, UnresolvedSourceMessage } from "@/lib/domain/source-message";
import {
  type FetchOptions,
  type Queryable,
  buildFetchQuery,
} from "@/lib/marketplaces/source-fetch";

import {
  SHOPIFY_SOURCE,
  type ShopifySourceRow,
  directionFromAddresses,
  normalizeAmbiguousRow,
  normalizeRow,
} from "./adapter";

/**
 * Read-only Shopify message repository.
 *
 * STRICTLY READ-ONLY — every statement is a SELECT. The pool supplied by the
 * caller additionally pins `default_transaction_read_only=on`.
 *
 * Rows leave here in one of two streams, and both are kept:
 *
 *   messages   direction decided by the addresses; becomes a conversation
 *   ambiguous  direction undecidable; stays on the neutral feed
 *
 * Nothing is discarded, and the split is reported so a bootstrap can be
 * reconciled against the source rather than trusted.
 */

export type ShopifyFetchResult = {
  readonly messages: readonly SourceMessage[];
  readonly ambiguous: readonly UnresolvedSourceMessage[];
  readonly unusableCount: number;
  readonly rowsExamined: number;
};

/**
 * `m.date::text` keeps the naive `timestamp without time zone` exactly as
 * stored; without it the driver would build a Date through the process
 * timezone while the authoritative source zone is still unconfirmed.
 *
 * `from_msg` and `to_msg` are selected because together they ARE the direction
 * rule. The display names are not: they decide nothing and are personal data.
 */
const SELECT_COLUMNS = `
    m.${SHOPIFY_SOURCE.pkColumn}::text        AS id,
    m.message_id                              AS message_id,
    m.sub_source                              AS sub_source,
    m.from_msg                                AS from_msg,
    m.to_msg                                  AS to_msg,
    m.subject                                 AS subject,
    m.order_id                                AS order_id,
    m.${SHOPIFY_SOURCE.timestampColumn}::text AS message_date,
    m.message_content                         AS message_content`;

export function buildQuery(options: FetchOptions): { text: string; values: unknown[] } {
  return buildFetchQuery(SHOPIFY_SOURCE, SELECT_COLUMNS, options);
}

/** Splits rows into decided and ambiguous, counting anything unrepresentable. */
export function classifyRows(rows: readonly ShopifySourceRow[]): ShopifyFetchResult {
  const messages: SourceMessage[] = [];
  const ambiguous: UnresolvedSourceMessage[] = [];
  let unusableCount = 0;

  for (const row of rows) {
    if (directionFromAddresses(row) === null) {
      ambiguous.push(normalizeAmbiguousRow(row));
      continue;
    }
    const normalized = normalizeRow(row);
    // Direction was decided, so only a missing account attribution lands here.
    if (normalized === null) unusableCount += 1;
    else messages.push(normalized);
  }

  return { messages, ambiguous, unusableCount, rowsExamined: rows.length };
}

export async function fetchMessages(
  client: Queryable,
  options: FetchOptions,
): Promise<ShopifyFetchResult> {
  const { rows } = await client.query(buildQuery(options));
  return classifyRows(rows as ShopifySourceRow[]);
}
