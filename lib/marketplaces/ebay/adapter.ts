import type { MessageDirection } from "@/lib/domain/message";
import type { BodyDecodeStatus, SourceMessage } from "@/lib/domain/source-message";

/**
 * eBay adapter — the ONLY place eBay's source encodings are allowed to appear.
 *
 * Everything marketplace-specific lives here so the domain layer and the
 * `cst_app` schema stay marketplace-neutral. Adding Amazon later means adding a
 * sibling adapter, not editing shared contracts.
 *
 * All mappings below were verified against live data during source discovery.
 * Nothing here is inferred from a column name.
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
 * read as CST replies.
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
 * body reference. Verified structurally — 29,468 such rows, always from the eBay
 * system sender, never carrying a reply. These never become customer messages.
 */
export function isSystemNotice(row: {
  messageType: string | null;
  extMessageId: string | null;
}): boolean {
  return row.messageType === null && row.extMessageId === null;
}

/**
 * eBay message bodies are stored JSON-encoded, not as raw text: 20,000/20,000
 * sampled rows parsed as valid JSON (19,670 string scalars, 330 JSON null).
 *
 * Decoding is a JSON parse — never regex unescaping, which would mangle the
 * `\uXXXX` sequences that 96% of bodies contain. An unexpected representation is
 * reported as a decode failure rather than silently corrupting content.
 */
export function decodeBody(raw: string | null): {
  text: string | null;
  status: BodyDecodeStatus;
} {
  if (raw === null) return { text: null, status: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: null, status: "failed" };
  }
  if (parsed === null) return { text: null, status: "empty" };
  if (typeof parsed === "string") return { text: parsed, status: "decoded" };
  return { text: null, status: "failed" };
}

/** Realises the neutral ordering intent with eBay's actual column names. */
export const EBAY_ORDER_BY = `ORDER BY ${EBAY_SOURCE.timestampColumn} ASC, ${EBAY_SOURCE.pkColumn} ASC` as const;

/**
 * A raw eBay header+body row, exactly as the repository selects it.
 *
 * Every field is text or number: bigints arrive as strings so precision is not
 * lost, and `receive_date` arrives as text so the driver cannot coerce a naive
 * timestamp through the process timezone.
 */
export type EbaySourceRow = {
  id: string;
  ext_message_id: string | null;
  message_id: string | null;
  sub_source: number | null;
  item_id: string | null;
  folder_id: number | null;
  message_type: string | null;
  sender_id: string | null;
  receiver_id: string | null;
  receive_date: string;
  body_raw: string | null;
};

/** eBay's sentinel for "no listing attached". */
function listingRefOf(itemId: string | null): string | null {
  if (itemId === null || itemId === "" || itemId === "0") return null;
  return itemId;
}

/**
 * Normalizes one eBay source row into the marketplace-neutral contract.
 *
 * Returns null when the row cannot be represented honestly — an unmapped
 * `folder_id`, a missing `sub_source`, or a missing counterparty. Such rows are
 * counted and reported, never coerced into a plausible-looking message.
 */
export function normalizeRow(row: EbaySourceRow): SourceMessage | null {
  if (row.folder_id === null || row.sub_source === null) return null;

  let direction: MessageDirection;
  try {
    direction = directionFromFolderId(row.folder_id);
  } catch {
    return null;
  }

  const counterpartyRef = counterpartyOf({
    folderId: row.folder_id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
  });
  if (counterpartyRef === null || counterpartyRef === "") return null;

  const body = decodeBody(row.body_raw);

  return {
    marketplace: "ebay",
    sourceDatabase: EBAY_SOURCE.database,
    sourceSchema: EBAY_SOURCE.schema,
    sourceTable: EBAY_SOURCE.headerTable,
    sourcePk: row.id,
    externalMessageId: row.message_id,
    subSourceId: row.sub_source,
    listingItemRef: listingRefOf(row.item_id),
    counterpartyRef,
    direction,
    // Carried through verbatim. No cast, no zone applied, no arithmetic.
    sourceTimestamp: row.receive_date,
    bodyText: body.text,
    bodyDecodeStatus: body.status,
    sourceMetadata: {
      messageType: row.message_type,
      extMessageId: row.ext_message_id,
    },
  };
}

/** Whether a raw row is a system notice, before normalization. */
export function rowIsSystemNotice(row: EbaySourceRow): boolean {
  return isSystemNotice({ messageType: row.message_type, extMessageId: row.ext_message_id });
}
