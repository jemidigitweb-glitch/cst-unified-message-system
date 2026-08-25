import { unresolvedReferenceFor } from "@/lib/domain/conversation-reference";
import type { MessageDirection } from "@/lib/domain/message";
import type { BodyDecodeStatus, SourceMessage } from "@/lib/domain/source-message";

/**
 * Amazon adapter — the ONLY place Amazon's source encodings appear.
 *
 * Bodies are PLAIN TEXT. Of 610 sampled source bodies exactly one parsed as
 * JSON and none was a JSON string scalar, so the eBay JSON decoder must never
 * be applied here — it would mark every real message as a decode failure.
 *
 * DIRECTION comes from the sender fields, and from nothing else.
 *
 *   An earlier reading of this source concluded "inbound-only, verified,
 *   because every message arrives from an Amazon domain and none from a company
 *   domain". The premise is true and the conclusion does not follow: Amazon
 *   Buyer-Seller Messaging relays BOTH directions through Amazon-owned domains,
 *   so that observation says nothing about which way a message travelled.
 *
 *   The sender fields do separate it. Two domains partition the source, and
 *   within the Amazon-side domain the sender NAME distinguishes the relayed
 *   seller reply from Amazon's own platform notices:
 *
 *     @marketplace.amazon.co.uk                  3,081 rows   customer
 *     @amazon.com  + name "Amazon.co.uk"         4,293 rows   CST reply
 *     @amazon.com  + name "…Seller Central…"       192 rows   platform notice
 *     @amazon.com  + anything else                  38 rows   UNMAPPED
 *
 *   Evidence for the split, measured rather than read: the customer domain
 *   carries 753 distinct personal sender names and ZERO staff or relay names.
 *   And on a one-way marker that only we write — our own warehouse address —
 *   the CST bucket matches 849 times and the customer bucket twice, both of
 *   those being customers quoting an earlier reply back at us.
 *
 * WHAT IS DELIBERATELY NOT USED. `extraction_method` looked like a direction
 * field and is not one: verified CST replies appear under both `pre-tag` and
 * `seller-message-pattern`, so it describes how the body was parsed, not who
 * sent it. Nor is the sign-off name, the greeting, or anything else in the
 * message wording. Direction is decided by two stored fields and no reading.
 *
 * The 38 unmapped rows are REJECTED rather than assigned a side. Guessing them
 * would put a fabricated customer message or a fabricated CST reply on screen,
 * which is the exact failure this whole mapping exists to prevent.
 */

export const AMAZON_SOURCE = {
  database: "ledsone",
  schema: "customer_service",
  messageTable: "amazon_messages",
  pkColumn: "id",
  timestampColumn: "date",
} as const;

/** The customer side of Buyer-Seller Messaging. */
const CUSTOMER_DOMAIN = "marketplace.amazon.co.uk";
/** The Amazon-side domain, carrying both relayed seller replies and notices. */
const PLATFORM_DOMAIN = "amazon.com";
/** Sender name Amazon uses when relaying a seller reply back into the thread. */
const SELLER_RELAY_NAME = "amazon.co.uk";

/**
 * A raw Amazon source row, exactly as the repository selects it.
 * Bigints and timestamps arrive as text so precision and the naive timestamp
 * survive the driver untouched.
 */
export type AmazonSourceRow = {
  id: string;
  message_id: string | null;
  sub_source: number | null;
  from_msg: string | null;
  from_name: string | null;
  message_type: string | null;
  order_id: string | null;
  asin: string | null;
  message_date: string;
  message_content: string | null;
};

/** The domain half of an address, lowercased. Null when there is no address. */
export function senderDomainOf(fromMsg: string | null): string | null {
  if (fromMsg === null) return null;
  const at = fromMsg.lastIndexOf("@");
  if (at === -1) return null;
  const domain = fromMsg.slice(at + 1).trim().toLowerCase();
  return domain === "" ? null : domain;
}

/**
 * Amazon's own notice traffic — order updates, policy alerts, and the like.
 *
 * Not a customer message and not a CST reply. CST is a human-verification
 * system, so this is a label for stats and review, not an exclusion rule —
 * `directionFromSender` below still gives these a side so they reach a human
 * like any other row.
 */
export function isPlatformNotice(row: {
  from_msg: string | null;
  from_name: string | null;
}): boolean {
  return (
    senderDomainOf(row.from_msg) === PLATFORM_DOMAIN &&
    (row.from_name ?? "").toLowerCase().includes("seller central")
  );
}

/**
 * Maps the sender fields to a neutral direction.
 *
 * Returns null for a sender combination the rule does not cover, so the caller
 * rejects the row instead of defaulting it to a side. Amazon's own platform
 * notices arrive into our mailbox the same way a customer message does, so
 * they are treated as inbound rather than rejected.
 */
export function directionFromSender(row: {
  from_msg: string | null;
  from_name: string | null;
}): MessageDirection | null {
  const domain = senderDomainOf(row.from_msg);
  if (domain === CUSTOMER_DOMAIN) return "inbound";
  if (domain === PLATFORM_DOMAIN && (row.from_name ?? "").trim().toLowerCase() === SELLER_RELAY_NAME) {
    return "outbound";
  }
  if (isPlatformNotice(row)) return "inbound";
  return null;
}

/**
 * Amazon message bodies are plain text.
 *
 * There is nothing to decode, so the only question is whether content exists.
 * `failed` is unreachable by construction — the status is carried purely so the
 * neutral contract stays uniform across marketplaces.
 */
export function readBody(raw: string | null): {
  text: string | null;
  status: BodyDecodeStatus;
} {
  if (raw === null || raw.trim() === "") return { text: null, status: "empty" };
  return { text: raw, status: "decoded" };
}

/** Normalises an order reference, treating blank as absent. */
export function orderRefOf(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return raw;
}

/** Normalises an ASIN. This is a marketplace ITEM reference — never a SKU. */
export function itemRefOf(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return raw;
}

/**
 * Normalises one Amazon source row into the marketplace-neutral contract.
 *
 * Returns null when the row cannot be represented honestly — an unmapped sender
 * combination, or a missing sub_source that leaves the message unattributable
 * to an account. Such rows are counted, never coerced.
 *
 * `counterpartyRef` is deliberately NOT the sender address: it is a shared
 * Amazon relay, and 100 of 223 order threads contain several distinct senders,
 * so grouping on it would merge unrelated people. The ORDER reference carries
 * conversation identity instead.
 */
export function normalizeRow(row: AmazonSourceRow): SourceMessage | null {
  if (row.sub_source === null) return null;

  const direction = directionFromSender(row);
  if (direction === null) return null;

  const body = readBody(row.message_content);
  const orderRef = orderRefOf(row.order_id);

  return {
    marketplace: "amazon",
    sourceDatabase: AMAZON_SOURCE.database,
    sourceSchema: AMAZON_SOURCE.schema,
    sourceTable: AMAZON_SOURCE.messageTable,
    sourcePk: row.id,
    externalMessageId: row.message_id,
    subSourceId: row.sub_source,
    // The marketplace item reference (ASIN), not a SKU.
    listingItemRef: itemRefOf(row.asin),
    // The order reference is the conversation identity for this source.
    counterpartyRef: orderRef ?? unresolvedReferenceFor(row.id),
    direction,
    // Carried through verbatim. No cast, no zone applied, no arithmetic.
    sourceTimestamp: row.message_date,
    bodyText: body.text,
    bodyDecodeStatus: body.status,
    sourceMetadata: {
      messageType: row.message_type,
      orderRef,
      itemRef: itemRefOf(row.asin),
    },
  };
}
