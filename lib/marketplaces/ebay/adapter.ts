import type { MessageDirection } from "@/lib/domain/message";

/**
 * eBay adapter — the ONLY place eBay's source encodings are allowed to appear.
 *
 * Everything marketplace-specific lives here so the domain layer and the
 * `cst_app` schema stay marketplace-neutral. Adding Amazon later means adding a
 * sibling adapter, not editing shared contracts.
 *
 * No SQL is executed from this module; it declares identifiers that the
 * repository layer will use in parameterised queries in a later task.
 */

/** Source relations this adapter reads. All read-only. */
export const EBAY_SOURCE = {
  database: "ledsone",
  schema: "customer_service",
  headerTable: "ebay_message_headers",
  bodyTable: "ebay_messages",
  /** Header PK. Also the ordering tiebreaker. */
  pkColumn: "id",
  /** Authoritative source timestamp. Non-null on every row, indexed. */
  timestampColumn: "receive_date",
  /** Header -> body join: ebay_messages.message_id = ebay_message_headers.ext_message_id */
  bodyJoinColumn: "ext_message_id",
  bodyForeignColumn: "message_id",
} as const;

const FOLDER_INBOUND = 0;
const FOLDER_OUTBOUND = 1;

/**
 * Maps eBay `folder_id` to a neutral direction. Unknown values are rejected
 * rather than guessed.
 *
 * Evidence: folder 0 carries ~10.5k distinct senders against 17 receivers;
 * folder 1 carries 16 distinct senders against ~22k receivers, and its bodies
 * read as CST replies. Verified in Day 1 discovery.
 */
export function directionFromFolderId(folderId: number): MessageDirection {
  switch (folderId) {
    case FOLDER_INBOUND:
      return "inbound";
    case FOLDER_OUTBOUND:
      return "outbound";
    default:
      throw new Error(`Unmapped eBay folder_id: ${folderId}`);
  }
}

/**
 * The counterparty (customer) handle, which sits in a different column
 * depending on direction.
 */
export function counterpartyOf(row: {
  folderId: number;
  senderId: string | null;
  receiverId: string | null;
}): string | null {
  return directionFromFolderId(row.folderId) === "inbound" ? row.senderId : row.receiverId;
}

/**
 * A platform notice rather than a customer conversation: no message type AND no
 * body. Verified structurally — 29,468 such rows, always from the eBay system
 * sender, never carrying a reply. These are not ingested as conversations.
 */
export function isSystemNotice(row: {
  messageType: string | null;
  extMessageId: string | number | null;
}): boolean {
  return row.messageType === null && row.extMessageId === null;
}

/**
 * eBay message bodies are stored JSON-encoded, not as raw text: 20,000/20,000
 * sampled rows parse as valid JSONB (19,670 string scalars, 330 JSON null).
 *
 * Decoding therefore uses a JSON parse, never regex unescaping. Returns null for
 * a JSON `null` body, and reports failure rather than throwing so a single bad
 * row cannot break a thread render.
 */
export function decodeBody(raw: string | null): {
  text: string | null;
  status: "decoded" | "empty" | "failed";
} {
  if (raw === null) return { text: null, status: "empty" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null) return { text: null, status: "empty" };
    if (typeof parsed === "string") return { text: parsed, status: "decoded" };
    return { text: null, status: "failed" };
  } catch {
    return { text: null, status: "failed" };
  }
}

/** Realises the neutral ordering intent with eBay's actual column names. */
export const EBAY_ORDER_BY = `ORDER BY ${EBAY_SOURCE.timestampColumn} ASC, ${EBAY_SOURCE.pkColumn} ASC` as const;
