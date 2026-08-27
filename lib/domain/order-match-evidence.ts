import type { SourceOrderDetail } from "./order";

/**
 * Why each of several matching orders matched — for a CST reviewer, and for
 * nobody and nothing else.
 *
 * THE PROBLEM THIS SOLVES. When a buyer has ordered the same listing more than
 * once, the sidebar shows every matching order in the same format, which is
 * honest but leaves a reviewer comparing two near-identical blocks with no
 * help. Usually one of them is obviously the right one — the customer quoted
 * its tracking number, or it is the only one placed before they wrote — and
 * that reasoning is cheap to compute and expensive to redo by eye on every
 * conversation.
 *
 * EVIDENCE, NOT A DECISION. Nothing here selects, ranks, scores, or reorders.
 * Every order keeps its place in the list and its own evidence line; a reader
 * decides. Two orders can carry the same evidence, and when they do, both say
 * so rather than one being quietly promoted — the honest rendering of "these
 * are equally consistent with the message" is showing it twice.
 *
 * PURE, AND NO MODEL. Exact string containment over the customer's own words
 * and the order's own values. No network, no database, no inference, no
 * classifier — a reviewer can check any line here by reading the message
 * themselves, which is the property that makes evidence worth showing at all.
 *
 * NEVER A FACT. These strings never become `VerifiedFact`s and never reach a
 * prompt. An ambiguous conversation grounds a draft in nothing, before and
 * after this module exists.
 */

export const MATCH_EVIDENCE_HEADING = "Why this order matched";

/** One order's evidence, keyed by the order number the block is showing. */
export type OrderMatchEvidence = {
  readonly orderNumber: string;
  readonly reasons: string[];
};

/** The message fields this reads. A subset of `ConversationMessageView`. */
export type EvidenceMessage = {
  readonly direction: "inbound" | "outbound";
  readonly sourceTimestamp: string;
  readonly bodyText: string | null;
  readonly bodyDecodeStatus: string;
};

export const EVIDENCE_SAME_BUYER = "Same buyer";
export const EVIDENCE_SAME_LISTING = "Same listing";
export const EVIDENCE_ORDER_NUMBER = "Order number found in message";
export const EVIDENCE_TRACKING = "Tracking number found in message";
export const EVIDENCE_SKU = "Product/SKU match";
export const EVIDENCE_CLOSEST_BEFORE = "Closest order before message date";

/**
 * The shortest identifier worth searching for.
 *
 * A three-character SKU or a two-digit fragment would hit inside unrelated
 * words and postcodes and report a match that is not one. Six is long enough
 * that a containment hit is the customer having typed the identifier.
 */
const MIN_IDENTIFIER_LENGTH = 6;

/** Letters and digits only, upper-cased — so "12-34567-89012" matches "12 34567 89012". */
function normaliseIdentifier(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/**
 * Only the customer's own decoded words.
 *
 * Outbound replies are excluded deliberately: a previous CST reply may well
 * quote an order number, and finding it there would be the system matching
 * against itself. An undecodable body contributes nothing — that is an absent
 * signal, not a weak one.
 */
function customerText(messages: readonly EvidenceMessage[]): string {
  return messages
    .filter(
      (message) =>
        message.direction === "inbound" &&
        message.bodyDecodeStatus === "decoded" &&
        message.bodyText !== null &&
        message.bodyText.trim() !== "",
    )
    .map((message) => message.bodyText)
    .join("\n");
}

/** Exact containment of a normalised identifier, or false for anything too short to trust. */
function quotedInMessage(value: string | null, normalisedText: string): boolean {
  if (value === null) return false;
  const needle = normaliseIdentifier(value);
  if (needle.length < MIN_IDENTIFIER_LENGTH) return false;
  return normalisedText.includes(needle);
}

/** The first thing the customer said, which is what any order must predate. */
function firstInboundTimestamp(messages: readonly EvidenceMessage[]): string | null {
  const inbound = messages
    .filter((message) => message.direction === "inbound")
    .map((message) => message.sourceTimestamp)
    .filter((timestamp) => timestamp.trim() !== "")
    .sort();
  return inbound[0] ?? null;
}

/**
 * The order placed most recently before the customer wrote — at most one.
 *
 * Compared as stored strings, matching `formatSourceTimestamp`'s own refusal
 * to parse these into dates while the source timezone is unconfirmed: both
 * values come from the same database in the same format, so lexical order is
 * chronological order without asserting a zone.
 *
 * Returns null on a tie, on no message to compare against, and when no order
 * predates the message. A tie is not a near-miss to round off — two orders
 * placed the same day are exactly the case a reviewer must look at, and
 * awarding the line to whichever sorted first would hide that.
 */
function closestBeforeMessage(
  orders: readonly SourceOrderDetail[],
  messages: readonly EvidenceMessage[],
): string | null {
  const wroteAt = firstInboundTimestamp(messages);
  if (wroteAt === null) return null;

  const preceding = orders.filter(
    (order) => order.orderDate !== null && order.orderDate <= wroteAt,
  );
  if (preceding.length === 0) return null;

  const latest = preceding.reduce((best, order) =>
    (order.orderDate ?? "") > (best.orderDate ?? "") ? order : best,
  );
  const tied = preceding.filter((order) => order.orderDate === latest.orderDate);
  return tied.length === 1 ? latest.orderNumber : null;
}

/**
 * The matching orders, nearest to the conversation first.
 *
 * NEAREST MEANS NEAREST TO WHAT THE CUSTOMER WROTE, not simply newest. Orders
 * placed before the first inbound message come first, most recent of those at
 * the top, because that is the one a customer writing today is most often
 * asking about. Orders placed after the message follow, soonest first — they
 * cannot be what the message was about, but they are still this buyer's orders
 * and are not hidden. Orders with no recorded date come last, in the order
 * given, since there is nothing to compare them on.
 *
 * ORDERING IS NOT SELECTION. Nothing is chosen, nothing is preselected, and
 * every order stays in the list under the same heading in the same format. A
 * reviewer still picks; this only saves them reading bottom-up.
 *
 * The sort is stable, so two orders sharing a date keep the order the source
 * returned them in rather than swapping between loads.
 */
export function orderByNearest(
  orders: readonly SourceOrderDetail[],
  messages: readonly EvidenceMessage[],
): SourceOrderDetail[] {
  const wroteAt = firstInboundTimestamp(messages);

  const decorated = orders.map((order, index) => ({ order, index }));
  const undated = decorated.filter((entry) => entry.order.orderDate === null);
  const dated = decorated.filter((entry) => entry.order.orderDate !== null);

  const before = dated.filter((entry) => wroteAt === null || entry.order.orderDate! <= wroteAt);
  const after = dated.filter((entry) => wroteAt !== null && entry.order.orderDate! > wroteAt);

  // Most recent first among those that precede the message...
  before.sort((a, b) =>
    a.order.orderDate! === b.order.orderDate!
      ? a.index - b.index
      : a.order.orderDate! < b.order.orderDate!
        ? 1
        : -1,
  );
  // ...and soonest first among those that follow it.
  after.sort((a, b) =>
    a.order.orderDate! === b.order.orderDate!
      ? a.index - b.index
      : a.order.orderDate! > b.order.orderDate!
        ? 1
        : -1,
  );

  return [...before, ...after, ...undated].map((entry) => entry.order);
}

/**
 * Every matching order's evidence, in the order the orders were given.
 *
 * `EVIDENCE_SAME_BUYER` and `EVIDENCE_SAME_LISTING` appear on every order
 * because they are what the lookup matched ON — stating them is not padding,
 * it tells a reviewer what the list already has in common so they can skip
 * looking for a difference there.
 *
 * `EVIDENCE_SKU` is offered only when the orders actually differ in SKU. Where
 * they do not, every order would carry it, and a line true of everything
 * distinguishes nothing while reading as though it did.
 */
export function matchEvidenceFor(
  orders: readonly SourceOrderDetail[],
  messages: readonly EvidenceMessage[],
): OrderMatchEvidence[] {
  const normalisedText = normaliseIdentifier(customerText(messages));
  const closest = closestBeforeMessage(orders, messages);

  const distinctSkus = new Set(
    orders.map((order) => order.sku).filter((sku): sku is string => sku !== null),
  );
  const skuIsDistinguishing = distinctSkus.size > 1;

  return orders.map((order) => {
    const reasons = [EVIDENCE_SAME_BUYER, EVIDENCE_SAME_LISTING];

    if (quotedInMessage(order.orderNumber, normalisedText)) reasons.push(EVIDENCE_ORDER_NUMBER);
    if (quotedInMessage(order.trackingNumber, normalisedText)) reasons.push(EVIDENCE_TRACKING);
    if (skuIsDistinguishing && quotedInMessage(order.sku, normalisedText)) {
      reasons.push(EVIDENCE_SKU);
    }
    if (closest !== null && order.orderNumber === closest) reasons.push(EVIDENCE_CLOSEST_BEFORE);

    return { orderNumber: order.orderNumber, reasons };
  });
}
