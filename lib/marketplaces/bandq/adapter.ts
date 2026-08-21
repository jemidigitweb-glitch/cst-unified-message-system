import { unresolvedReferenceFor } from "@/lib/domain/conversation-reference";
import type { BodyDecodeStatus, SourceMessage } from "@/lib/domain/source-message";

/**
 * B&Q adapter — the ONLY place B&Q's source encodings appear.
 *
 * Verified against the live source during discovery:
 *
 *   Bodies are PLAIN TEXT. The eBay JSON decoder must never be applied here; it
 *   would mark every real message as a decode failure.
 *
 *   Direction is inbound-only, verified rather than assumed: across all 7,933
 *   source rows the recipient is a company domain in 7,933 cases and the sender
 *   is a company domain in 0. This source carries no previous CST replies.
 *
 *   A source order reference is present on 5,943 of 7,933 rows (74.9%) and is
 *   deterministic in shape. It is used as a GROUPING key and nothing more — see
 *   `sourceOrderRefOf`.
 */

export const BANDQ_SOURCE = {
  database: "ledsone",
  schema: "customer_service",
  messageTable: "bandq_messages",
  pkColumn: "id",
  timestampColumn: "date",
} as const;

/**
 * A raw B&Q source row, exactly as the repository selects it.
 * Bigints and timestamps arrive as text so precision and the naive timestamp
 * survive the driver untouched.
 */
export type BandqSourceRow = {
  id: string;
  message_id: string | null;
  sub_source: number | null;
  message_type: string | null;
  order_id: string | null;
  message_date: string;
  message_content: string | null;
};

/** B&Q message bodies are plain text; the only question is whether one exists. */
export function readBody(raw: string | null): {
  text: string | null;
  status: BodyDecodeStatus;
} {
  if (raw === null || raw.trim() === "") return { text: null, status: "empty" };
  return { text: raw, status: "decoded" };
}

/**
 * The source's own order reference, treating blank as absent.
 *
 * This is a SOURCE reference, not a resolved application order. It has not been
 * matched against the order tables, so nothing downstream may present it as a
 * confirmed purchase, derive delivery or refund state from it, or use it to
 * populate context. Its only sanctioned use is deterministic grouping: two
 * messages carrying the same reference came from the same source correspondence.
 */
export function sourceOrderRefOf(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return raw;
}

/**
 * Normalises one B&Q source row into the marketplace-neutral contract.
 *
 * Returns null when the row cannot be represented honestly — a missing
 * sub_source leaves the message unattributable to an account. Such rows are
 * counted, never coerced.
 *
 * `counterpartyRef` is deliberately NOT taken from the sender address: every
 * message arrives from one of four platform or courier relay domains, so that
 * address identifies the channel, not the person. Grouping on it would merge
 * thousands of unrelated customers into a handful of threads.
 *
 * `listingItemRef` stays null: this source carries no listing or item field.
 */
export function normalizeRow(row: BandqSourceRow): SourceMessage | null {
  if (row.sub_source === null) return null;

  const body = readBody(row.message_content);
  const sourceOrderRef = sourceOrderRefOf(row.order_id);

  return {
    marketplace: "bandq",
    sourceDatabase: BANDQ_SOURCE.database,
    sourceSchema: BANDQ_SOURCE.schema,
    sourceTable: BANDQ_SOURCE.messageTable,
    sourcePk: row.id,
    externalMessageId: row.message_id,
    subSourceId: row.sub_source,
    listingItemRef: null,
    // The source reference groups the conversation. Where there is none, the
    // message stands alone under a sentinel keyed on its own source PK.
    counterpartyRef: sourceOrderRef ?? unresolvedReferenceFor(row.id),
    // Verified inbound-only; this source has no outbound history.
    direction: "inbound",
    // Carried through verbatim. No cast, no zone applied, no arithmetic.
    sourceTimestamp: row.message_date,
    bodyText: body.text,
    bodyDecodeStatus: body.status,
    sourceMetadata: {
      messageType: row.message_type,
      sourceOrderRef,
    },
  };
}

/** Whether a normalised message carries the source's grouping reference. */
export function hasSourceOrderReference(message: SourceMessage): boolean {
  const reference = message.sourceMetadata.sourceOrderRef;
  return reference !== null && reference !== undefined;
}
