import { unresolvedReferenceFor } from "@/lib/domain/conversation-reference";
import type { BodyDecodeStatus, SourceMessage } from "@/lib/domain/source-message";

/**
 * Temu adapter — the ONLY place Temu's source encodings appear.
 *
 * Verified against the live source during discovery:
 *
 *   Bodies are PLAIN TEXT. The eBay JSON decoder must never be applied here; it
 *   would mark every real message as a decode failure.
 *
 *   Direction is inbound-only, verified rather than assumed: across all 1,091
 *   source rows the recipient is a company domain in 1,091 cases and the sender
 *   is a company domain in 0. This source carries no previous CST replies.
 *
 *   There is NO reliable conversation key. Only 439 of 1,091 rows carry a source
 *   reference at all, and those 439 resolve to 422 distinct values — so the
 *   reference is very nearly one-per-message and groups almost nothing. It is
 *   carried in `sourceMetadata` for later review but is deliberately not used
 *   for threading; see the thread builder.
 */

export const TEMU_SOURCE = {
  database: "ledsone",
  schema: "customer_service",
  messageTable: "temu_messages",
  pkColumn: "id",
  timestampColumn: "date",
} as const;

/**
 * A raw Temu source row, exactly as the repository selects it.
 * Bigints and timestamps arrive as text so precision and the naive timestamp
 * survive the driver untouched.
 */
export type TemuSourceRow = {
  id: string;
  message_id: string | null;
  sub_source: number | null;
  message_type: string | null;
  order_id: string | null;
  message_date: string;
  message_content: string | null;
};

/** Temu message bodies are plain text; the only question is whether one exists. */
export function readBody(raw: string | null): {
  text: string | null;
  status: BodyDecodeStatus;
} {
  if (raw === null || raw.trim() === "") return { text: null, status: "empty" };
  return { text: raw, status: "decoded" };
}

/**
 * The source's own reference, treating blank as absent.
 *
 * Recorded for traceability only. It is NOT a resolved application order and is
 * NOT used to group conversations — it is too close to unique to establish that
 * two messages belong together.
 */
export function sourceReferenceOf(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return raw;
}

/**
 * Normalises one Temu source row into the marketplace-neutral contract.
 *
 * Returns null when the row cannot be represented honestly — a missing
 * sub_source leaves the message unattributable to an account. Such rows are
 * counted, never coerced.
 *
 * `counterpartyRef` is the ungrouped sentinel for every message, because the
 * source establishes neither a customer identity nor a thread. It is
 * deliberately NOT taken from the sender address: every message arrives from a
 * Temu relay domain, so grouping on it would merge every customer into one
 * thread.
 */
export function normalizeRow(row: TemuSourceRow): SourceMessage | null {
  if (row.sub_source === null) return null;

  const body = readBody(row.message_content);

  return {
    marketplace: "temu",
    sourceDatabase: TEMU_SOURCE.database,
    sourceSchema: TEMU_SOURCE.schema,
    sourceTable: TEMU_SOURCE.messageTable,
    sourcePk: row.id,
    externalMessageId: row.message_id,
    subSourceId: row.sub_source,
    listingItemRef: null,
    counterpartyRef: unresolvedReferenceFor(row.id),
    // Verified inbound-only; this source has no outbound history.
    direction: "inbound",
    // Carried through verbatim. No cast, no zone applied, no arithmetic.
    sourceTimestamp: row.message_date,
    bodyText: body.text,
    bodyDecodeStatus: body.status,
    sourceMetadata: {
      messageType: row.message_type,
      sourceReference: sourceReferenceOf(row.order_id),
    },
  };
}
