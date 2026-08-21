import { isCompanyAddress } from "@/lib/domain/company-domains";
import { unresolvedReferenceFor } from "@/lib/domain/conversation-reference";
import type { MessageDirection } from "@/lib/domain/message";
import type {
  BodyDecodeStatus,
  SourceMessage,
  UnresolvedSourceMessage,
} from "@/lib/domain/source-message";

import { filterReasonFor } from "./inbox-filter";

/**
 * Shopify adapter — the ONLY place Shopify's source encodings appear.
 *
 * Bodies are PLAIN TEXT. The eBay JSON decoder must never be applied here.
 *
 * DIRECTION comes from the two addresses, and from nothing else. This source is
 * ordinary email, so the question "who sent it" is answered by whether each
 * side is a company domain:
 *
 *   from outside  → to company   inbound    17,043
 *   from company  → to outside   outbound    4,209
 *   from company  → to company   AMBIGUOUS   2,431
 *   from outside  → to outside   AMBIGUOUS      709
 *   either address missing       AMBIGUOUS      559
 *
 * 85.2% resolves. The remaining 14.8% is genuinely undecidable from the
 * addresses — internal forwards between our own mailboxes, and third-party
 * traffic where neither side is us — and is REJECTED rather than assigned a
 * side. Those messages keep the neutral handling they already had.
 *
 * WHAT IS DELIBERATELY NOT USED. Not the wording, not the sign-off name, not
 * `extraction_method`. This source was previously rendering CST replies as
 * customer messages precisely because nothing was deciding direction at all;
 * the fix is a stored-field rule, not a better reading of the text.
 *
 * THE SOURCE IS STILL MIXED. "Inbound" here means "somebody outside wrote to
 * us" — which includes suppliers, couriers, Wayfair purchase orders, Shopify's
 * own notifications and cold sales mail, not only customers. Direction is now
 * established; "is this a customer" is not, and nothing here claims it.
 */

export const SHOPIFY_SOURCE = {
  database: "ledsone",
  schema: "customer_service",
  messageTable: "shopify_messages",
  pkColumn: "id",
  timestampColumn: "date",
} as const;

/**
 * A raw Shopify source row, exactly as the repository selects it.
 * Both addresses are selected because together they ARE the direction rule.
 */
export type ShopifySourceRow = {
  id: string;
  message_id: string | null;
  sub_source: number | null;
  from_msg: string | null;
  to_msg: string | null;
  subject: string | null;
  order_id: string | null;
  message_date: string;
  message_content: string | null;
};

/** Shopify message bodies are plain text; the only question is whether one exists. */
export function readBody(raw: string | null): {
  text: string | null;
  status: BodyDecodeStatus;
} {
  if (raw === null || raw.trim() === "") return { text: null, status: "empty" };
  return { text: raw, status: "decoded" };
}

/** An opaque source reference, treating blank as absent. */
export function sourceReferenceOf(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return raw;
}

/**
 * Maps the two addresses to a neutral direction.
 *
 * Returns null when the pair does not decide it — both ours, neither ours, or
 * an address missing — so the caller keeps the message neutral instead of
 * defaulting it to a side.
 */
export function directionFromAddresses(row: {
  from_msg: string | null;
  to_msg: string | null;
}): MessageDirection | null {
  if (row.from_msg === null || row.to_msg === null) return null;
  const fromCompany = isCompanyAddress(row.from_msg);
  const toCompany = isCompanyAddress(row.to_msg);
  if (fromCompany === toCompany) return null;
  return fromCompany ? "outbound" : "inbound";
}

/**
 * Normalises one Shopify row whose direction the addresses decide.
 *
 * Returns null when direction is undecidable, or when a missing sub_source
 * leaves the message unattributable to an account. Such rows are counted and
 * handled neutrally, never coerced onto a side.
 *
 * `counterpartyRef` is the order reference where the source recorded one, and
 * the ungrouped sentinel otherwise. It is deliberately NOT the customer's
 * address: that would put a real email address into a conversation title, and
 * this source's identity mapping is still unproven.
 */
export function normalizeRow(row: ShopifySourceRow): SourceMessage | null {
  if (row.sub_source === null) return null;

  const direction = directionFromAddresses(row);
  if (direction === null) return null;

  const body = readBody(row.message_content);
  const orderRef = sourceReferenceOf(row.order_id);

  return {
    marketplace: "shopify",
    sourceDatabase: SHOPIFY_SOURCE.database,
    sourceSchema: SHOPIFY_SOURCE.schema,
    sourceTable: SHOPIFY_SOURCE.messageTable,
    sourcePk: row.id,
    externalMessageId: row.message_id,
    subSourceId: row.sub_source,
    listingItemRef: null,
    counterpartyRef: orderRef ?? unresolvedReferenceFor(row.id),
    direction,
    // Carried through verbatim. No cast, no zone applied, no arithmetic.
    sourceTimestamp: row.message_date,
    bodyText: body.text,
    bodyDecodeStatus: body.status,
    sourceMetadata: {
      orderRef,
      // Decided here, where the sender domain and subject are still in scope;
      // they are not carried further. Null means this is reply work.
      inboxFilterReason: filterReasonFor(row),
    },
  };
}

/**
 * Normalises a row whose direction the addresses do NOT decide.
 *
 * Produces the no-direction shape, so an ambiguous message cannot reach a
 * conversation view even by mistake — the type has no `direction` field to read.
 */
export function normalizeAmbiguousRow(row: ShopifySourceRow): UnresolvedSourceMessage {
  const body = readBody(row.message_content);

  return {
    marketplace: "shopify",
    sourceDatabase: SHOPIFY_SOURCE.database,
    sourceSchema: SHOPIFY_SOURCE.schema,
    sourceTable: SHOPIFY_SOURCE.messageTable,
    sourcePk: row.id,
    externalMessageId: row.message_id,
    subSourceId: row.sub_source,
    sourceTimestamp: row.message_date,
    bodyText: body.text,
    bodyDecodeStatus: body.status,
    sourceReference: sourceReferenceOf(row.order_id),
  };
}
