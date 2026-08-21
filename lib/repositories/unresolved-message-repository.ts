import "server-only";

import type { Marketplace } from "@/lib/domain/marketplace";
import type { UnresolvedFeed, UnresolvedMessageView } from "@/lib/domain/unresolved-messages";

/**
 * Read-only repository for source messages with unverified direction.
 *
 * SELECT only — this module issues no write of any kind, and it never reaches a
 * live marketplace source. Every query is parameterised, and the client is
 * injected so the module is testable without a database.
 *
 * The projection is deliberately narrow. `direction` and any counterparty
 * column are not selected because the table has none; that is the point of the
 * table. Nor is `source_reference` returned to the browser: in a source whose
 * provenance is unproven, its meaning is unproven too, and showing it beside a
 * message would invite reading it as the message's order.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export const MAX_FEED_LIMIT = 200;
export const DEFAULT_FEED_LIMIT = 100;

/**
 * `source_ts::text` keeps the stored naive timestamp exactly as recorded — the
 * driver would otherwise build a Date through the process timezone, and the
 * authoritative source zone is still unconfirmed.
 *
 * Newest first: with no conversation to open, the feed is a chronological log
 * and the most recent activity belongs at the top. The source PK breaks ties.
 */
const LIST_UNRESOLVED_MESSAGES = `
SELECT id::text          AS id,
       marketplace,
       source_ts::text   AS source_ts,
       body_text,
       body_decode_status
FROM cst_app.unresolved_marketplace_messages
WHERE marketplace = $1
ORDER BY source_ts DESC, id DESC
LIMIT $2`;

type UnresolvedMessageRow = {
  id: string;
  marketplace: string;
  source_ts: string;
  body_text: string | null;
  body_decode_status: string;
};

function toMessageView(row: UnresolvedMessageRow): UnresolvedMessageView {
  return {
    id: row.id,
    marketplace: row.marketplace as UnresolvedMessageView["marketplace"],
    sourceTimestamp: row.source_ts,
    bodyText: row.body_text,
    bodyDecodeStatus: row.body_decode_status as UnresolvedMessageView["bodyDecodeStatus"],
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_FEED_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_FEED_LIMIT;
  return Math.min(limit, MAX_FEED_LIMIT);
}

/** Postgres `undefined_table`. */
const UNDEFINED_TABLE = "42P01";

export function isMissingTableError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === UNDEFINED_TABLE
  );
}

/**
 * Lists one marketplace's unresolved message feed, newest first.
 *
 * When the store has not been created yet this reports `not_provisioned` rather
 * than raising or returning an empty list. An empty list would state that there
 * are no messages, which is false — they exist in the source and are waiting on
 * a reviewed schema change. The two situations look identical to a caller that
 * only sees an array, so they are distinguished here.
 *
 * The marketplace is required, not optional: a mixed feed would put messages
 * from different sources side by side, which is what the tabbed workspace
 * exists to prevent.
 */
export async function listUnresolvedMessages(
  client: Queryable,
  options: { readonly marketplace: Marketplace; readonly limit?: number },
): Promise<UnresolvedFeed> {
  try {
    const { rows } = await client.query({
      text: LIST_UNRESOLVED_MESSAGES,
      values: [options.marketplace, clampLimit(options.limit)],
    });
    return {
      marketplace: options.marketplace,
      state: "available",
      messages: (rows as UnresolvedMessageRow[]).map(toMessageView),
    };
  } catch (cause) {
    if (isMissingTableError(cause)) {
      return { marketplace: options.marketplace, state: "not_provisioned", messages: [] };
    }
    throw cause;
  }
}
