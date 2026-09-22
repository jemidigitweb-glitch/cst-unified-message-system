import { claimStatus } from "./message-semantics";

/**
 * Has CST already told this customer the matter is closed?
 *
 * ------------------------------------------------------------------------
 * IT READS OUR OWN REPLIES, NEVER THE CUSTOMER'S MESSAGE
 * ------------------------------------------------------------------------
 * Every other text reader in this system grades what a CUSTOMER wrote. This one
 * grades what WE wrote, and the difference is the whole reason it is safe.
 *
 * A customer's vocabulary is unbounded — that is why the before-shipment urgent
 * rule refuses to read it at all, and why an earlier version of that rule
 * escalated promotional emails containing the word "cancel". An outbound CST
 * reply is our own writing, in our own words, answering our own customer. The
 * phrases below are the ones a CST agent actually types when an order has gone
 * out or been stopped.
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ------------------------------------------------------------------------
 * The before-shipment rule needs the newest message to be an unanswered
 * customer one, which already excludes a thread whose last word is ours. What it
 * does not exclude is the thread where we said "your order has been cancelled"
 * and the customer replied "thank you" — newest message inbound, nobody
 * technically waiting, and no reason at all to sit at the top of the inbox under
 * a countdown.
 *
 * THIS IS THE CLOSING SIGNAL, and it is deliberately narrow: it means a member
 * of staff stated that the ORDER REACHED AN END STATE — dispatched, shipped,
 * cancelled or refunded. It is not a general "we replied" detector, because
 * replying is not resolving.
 *
 * ------------------------------------------------------------------------
 * READ THROUGH `claimStatus`, FOR ONE SPECIFIC REASON
 * ------------------------------------------------------------------------
 * "Your order has NOT been dispatched yet" is the single most likely sentence in
 * a before-shipment thread, and a bare phrase match would read it as the exact
 * opposite of what it says — closing the very conversations this feature exists
 * to raise. The semantic layer puts the negator in front of the concept and
 * returns `negated`, so only a flat statement that it HAS happened counts.
 *
 * "Would you like us to cancel?" is `asked` and likewise does not count: an
 * offer is not an outcome.
 *
 * PURE. No network, no model, no database.
 */

/**
 * The order reached an end state, said plainly.
 *
 * Each alternative requires the EVENT, not the topic. Bare "dispatch" and bare
 * "cancellation" are absent: "our dispatch team will look at this" and "see our
 * cancellation policy" are both ordinary sentences in a thread that is still
 * very much open.
 */
const ORDER_CLOSED_BY_STAFF = new RegExp(
  [
    // Dispatched / shipped / sent out.
    "\\b(?:has|have|was|were|is|are)\\s+(?:now\\s+|already\\s+)?(?:been\\s+)?(?:dispatched|despatched|shipped|posted)\\b",
    "\\bwe\\s+(?:have|'ve)?\\s*(?:now\\s+)?(?:dispatched|despatched|shipped|posted|sent)\\s+(?:it|this|your|the)\\b",
    "\\b(?:order|parcel|item|package)\\s+(?:has\\s+)?(?:now\\s+)?(?:gone|left)\\s+(?:out|us|the\\s+warehouse)\\b",
    "\\bshipment\\s+(?:is|has\\s+been)\\s+(?:done|completed|made)\\b",
    "\\bon\\s+its\\s+way\\s+to\\s+you\\b",
    "\\btracking\\s+number\\s+is\\b",
    // Cancelled / refunded.
    "\\b(?:has|have|was|were|is|are)\\s+(?:now\\s+)?(?:been\\s+)?(?:cancelled|canceled|refunded)\\b",
    "\\bwe\\s+(?:have|'ve)?\\s*(?:now\\s+)?(?:cancelled|canceled|refunded)\\s+(?:it|this|your|the)\\b",
    "\\bcancellation\\s+(?:has\\s+been\\s+)?(?:confirmed|processed|completed)\\b",
    "\\brefund\\s+(?:has\\s+been\\s+)?(?:issued|processed|completed)\\b",
  ].join("|"),
  "i",
);

/**
 * Whether a CST reply states the order was dispatched, cancelled or refunded.
 *
 * Takes the text of OUR message. A caller passing a customer's message would be
 * asking the wrong question of the right function, which is why the parameter
 * is named for whose words these are.
 */
export function staffClosedTheOrder(outboundText: string | null): boolean {
  const text = outboundText?.trim() ?? "";
  if (text === "") return false;
  return claimStatus(text, ORDER_CLOSED_BY_STAFF) === "asserted";
}
