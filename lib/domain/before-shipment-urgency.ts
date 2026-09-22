import { ORDER_CHANGE_CATEGORY } from "@/lib/domain/inbox";
import type { MessageCategory } from "@/lib/knowledge/message-category";

/**
 * The before-shipment urgent rule.
 *
 * ------------------------------------------------------------------------
 * THREE CONDITIONS, ALL REQUIRED, NONE OF THEM TEXT
 * ------------------------------------------------------------------------
 *   1. A CURRENT CUSTOMER MESSAGE NEEDING CST ACTION — the newest message in
 *      the thread is inbound, so nobody has answered it, and the thread is a
 *      customer reply thread rather than a platform notice.
 *   2. A REAL MATCHING ORDER — the conversation has a stored context snapshot
 *      resolved to `single_order`. Not a guess, not a keyword, not an order
 *      number spotted in a sentence: the resolution the system already treats
 *      as verified everywhere else (`mayUseOrderFacts`).
 *   3. NOT YET DISPATCHED — the source shows no dispatch for that order.
 *
 * ------------------------------------------------------------------------
 * WHY NOT A WORD OF THE MESSAGE IS READ
 * ------------------------------------------------------------------------
 * The first version of this feature raised URGENT from the customer's wording —
 * `cancellation_requested`, matched anywhere in the thread. Three things were
 * wrong with that, and each is now structurally impossible rather than merely
 * tested for:
 *
 *   A PROMOTIONAL OR SYSTEM EMAIL containing the word "cancel" could raise it.
 *   Nothing here reads text, so no word in any message can.
 *
 *   OLD TEXT KEPT A THREAD URGENT. Priority is read across every customer
 *   message in the thread, so a cancellation asked for in March kept its
 *   conversation red in September. This rule reads only the CURRENT state:
 *   is the newest message unanswered, and is the order still here. A thread
 *   that has been answered stops being urgent the moment it is answered.
 *
 *   IT ESCALATED ORDERS THAT HAD ALREADY GONE. "Please cancel" on a parcel
 *   delivered a fortnight ago is a return, not a cancellation, and putting it
 *   at the top of the queue under a countdown promised a window that had
 *   closed. Condition 3 is the whole of the difference.
 *
 * ------------------------------------------------------------------------
 * IT PRIORITISES WORK. IT DOES NOT DO WORK.
 * ------------------------------------------------------------------------
 * Nothing here — or anywhere beneath it — cancels an order, holds a dispatch,
 * changes an order status, calls a marketplace or sends a message. It decides
 * which conversation a CST agent should open first, and the agent acts in the
 * systems that can act.
 *
 * PURE. No database, no clock, no network.
 */

/**
 * The case area an eligible conversation is tagged with.
 *
 * The classifier's OWN value, imported rather than retyped, so the tag this
 * rule assigns is the same string the inbox's category filter and the
 * notification feed already match on. `ORDER_CHANGE_NOTIFICATION_TITLE` is the
 * display spelling and is deliberately a different constant — only this one may
 * reach a comparison.
 */
export const BEFORE_SHIPPING_CATEGORY: MessageCategory = ORDER_CHANGE_CATEGORY;

/**
 * How far back a before-shipping query still counts as live work.
 *
 * EVERY ONE OF THE LAST 72 HOURS, not just today. An order placed on Friday and
 * queried on Friday evening is still unshipped on Monday morning, and a window
 * of 24 hours would have dropped it over the weekend — which is exactly when
 * the queue is least watched and the customer has waited longest.
 *
 * 72 IS THE OUTER BOUND, AND IT IS THE ONLY NUMBER HERE. Shortening it to 48 or
 * 24 is this one constant. It is deliberately not an SLA and must not be read
 * as one: this decides what is still WORTH SHOWING, while the response SLA
 * decides how fast it must be answered. They are different questions, and the
 * SLA's duration is still unapproved — see `RESPONSE_SLA_MINUTES`.
 *
 * Condition 3 already bounds this far more tightly than any window does: an
 * order that has shipped drops out whatever its age. The window exists for the
 * other direction — a thread nobody ever shipped and nobody ever closed must
 * not sit at the top of the inbox forever.
 */
export const BEFORE_SHIPMENT_RECENCY_HOURS = 72;

/**
 * The marketplace that carries the extra "never replied" restriction.
 *
 * THE RULE ITSELF RUNS EVERYWHERE — the order key, the dispatch read and the
 * recency window are all marketplace-neutral, and every other marketplace keeps
 * exactly the behaviour it already had. Amazon alone additionally requires that
 * nobody has replied in the thread at all.
 *
 * It is a VALUE, not a string repeated in a condition and a query, so the one
 * marketplace that differs is visible in one place rather than spread across
 * two that could drift apart.
 */
export const BEFORE_SHIPMENT_MARKETPLACE = "amazon";

/** Why the rule did or did not fire. Safe to log — no customer text. */
export type BeforeShipmentOutcome =
  /** Amazon only: we have replied in this thread, so it is not a fresh request. */
  | "already_replied"
  /** Every condition held. */
  | "eligible"
  /** The newest message is ours, so the customer is not waiting on us. */
  | "no_customer_action_needed"
  /** Not a customer reply thread — a platform notice or a filtered placement. */
  | "not_a_customer_conversation"
  /** The thread has been worked to its terminal state. */
  | "thread_resolved"
  /** Older than the recency window. */
  | "too_old"
  /** The customer is not asking to change or stop the order. */
  | "not_an_order_change"
  /** No context snapshot resolved to a single order. */
  | "no_matching_order"
  /** The order has already left. */
  | "already_dispatched";

export type BeforeShipmentInput = {
  /** Which marketplace the conversation belongs to. */
  readonly marketplace: string;
  /**
   * Whether we have EVER replied in this thread.
   *
   * STRICTER THAN "the customer spoke last", and deliberately so. A thread we
   * answered and the customer came back on is a conversation in progress;
   * this rule is for the request nobody has touched yet. `lastDirection ===
   * "inbound"` is true of both, so it cannot tell them apart — the presence of
   * any outbound message can.
   */
  readonly everReplied: boolean;
  /**
   * Direction of the newest message in the thread. Inbound means the customer
   * spoke last and nobody has replied — the system's existing definition of
   * "unread", read from the messages themselves rather than any stored flag.
   */
  readonly lastDirection: "inbound" | "outbound" | null;
  /** Where the ingestion layer placed the thread. Only a reply inbox qualifies. */
  readonly inboxPlacement: "reply_inbox" | "outbound_only" | "filtered";
  /**
   * Whether this thread is a marketplace's own platform notice rather than a
   * customer — there is no customer on the other end of one, so there is
   * nobody to be urgent for.
   */
  readonly platformNotice: boolean;
  /**
   * Whether our own most recent reply told the customer the order reached an
   * end state — dispatched, shipped, cancelled or refunded.
   *
   * DELIBERATELY NOT `workflow_state === "reviewed"`. That is a state a
   * reviewer sets on a DRAFT, and it says a reply was approved rather than that
   * the order was settled: a thread can be marked reviewed with the parcel
   * still sitting in the warehouse, and can be settled without anybody touching
   * the workflow at all. What closes a before-shipment case is CST having said
   * the order went out or was stopped — so that is what is read, from our own
   * outbound wording, by `staffClosedTheOrder`.
   */
  readonly staffClosedTheOrder: boolean;
  /**
   * How many hours since the newest customer message arrived, or null where
   * that instant could not be established. A null is NOT treated as recent:
   * an unknown age cannot satisfy a recency condition.
   */
  readonly ageHours: number | null;
  /**
   * The order number this conversation is about, or null where none could be
   * established.
   *
   * TWO SOURCES, BOTH DETERMINISTIC, NEITHER A GUESS FROM MESSAGE TEXT:
   *
   *   the stored context snapshot resolved to `single_order` — the resolution
   *   the rest of the system already treats as verified; or
   *
   *   the conversation's own `counterparty_ref`, which on Shopify, Amazon, B&Q
   *   and Temu IS the marketplace order number, because that is what the thread
   *   is keyed by. Verified against live data: Shopify conversation 46268 is
   *   keyed `LED65289`, which is `orders.order_id` in the source.
   *
   * THE SECOND PATH IS WHY THIS RULE IS NOT eBAY-ONLY. Context snapshots are
   * written by the on-demand eBay order resolver, so all 383 of them are eBay
   * and no Shopify conversation has ever had one. Requiring a snapshot made the
   * rule structurally incapable of firing on four of the five marketplaces.
   */
  /**
   * Whether the CURRENT customer message is asking to change or stop the
   * order — a cancellation, a stop-dispatch, an address change, an amendment.
   *
   * ------------------------------------------------------------------------
   * WHY THIS CONDITION EXISTS
   * ------------------------------------------------------------------------
   * Without it the rule fired on the order's state alone, and re-tagged EVERY
   * unanswered message on an unshipped order as an order change. On Amazon,
   * where the thread is keyed by the order number so almost every conversation
   * resolves to a real order, that meant delivery queries, pre-sales questions
   * and damage reports all came back tagged "Order change, before shipping
   * queries" purely because the parcel had not left yet. The tag has to say
   * what the customer ASKED, not what the warehouse has done.
   *
   * ------------------------------------------------------------------------
   * THE CURRENT MESSAGE ONLY, AND COMPUTED BY THE EXISTING CLASSIFIER
   * ------------------------------------------------------------------------
   * The caller derives this from the NEWEST inbound message and no other — that
   * is what keeps "do not scan old messages to hold a thread urgent" true. A
   * cancellation asked for in March cannot raise it in September, because the
   * March message is never read.
   *
   * It is a boolean here rather than text, so this module still has nothing a
   * keyword could arrive through: the vocabulary lives where it already lived,
   * in `message-category.ts` and `message-priority.ts`, and is read once by the
   * repository.
   *
   * IT IS NOT SUFFICIENT ON ITS OWN. A promotional email containing "cancel"
   * still fails condition 1; a cancellation on a shipped order still fails
   * condition 4. Intent decides WHAT the message is; the order state decides
   * whether anything can still be done about it.
   */
  readonly orderChangeIntent: boolean;
  readonly orderNumber: string | null;
  /**
   * Dispatch state for that order, or null where the SOURCE had no record of
   * it.
   *
   * THIS IS WHAT PROVES THE ORDER IS REAL. A reference is a claim; a row in the
   * source is the verification. NULL IS NOT "NOT DISPATCHED" — an order nobody
   * can find is `no_matching_order`, never an open window.
   */
  readonly shipment: { readonly dispatched: boolean } | null;
};

/**
 * The one place the three conditions are evaluated.
 *
 * Returns the OUTCOME rather than a boolean, so a reviewer, a log line and a
 * test can all see which condition stopped it. Every caller that wants a
 * boolean asks `outcome === "eligible"` — see `isBeforeShipmentUrgent`.
 *
 * ORDER OF THE CHECKS IS CHEAPEST-FIRST and does not change the answer: all
 * three conditions must hold, so whichever fails first is a complete
 * explanation on its own.
 */
export function beforeShipmentEligibility(
  input: BeforeShipmentInput,
): BeforeShipmentOutcome {
  /* ---- 1. A current customer message needing CST action ---- */
  if (input.platformNotice) return "not_a_customer_conversation";
  if (input.inboxPlacement !== "reply_inbox") return "not_a_customer_conversation";
  // Outbound last means we answered; null means no message landed at all.
  if (input.lastDirection !== "inbound") return "no_customer_action_needed";
  /*
   * AMAZON ONLY: never replied, not merely "not replied to the newest message".
   *
   * A thread we have already answered is a conversation in progress; on Amazon
   * this rule is reserved for the request nobody has touched. Everywhere else
   * the existing behaviour is unchanged — a thread we answered and the customer
   * came back on still counts, because `lastDirection === "inbound"` above is
   * the condition those marketplaces have always used.
   */
  if (input.marketplace === BEFORE_SHIPMENT_MARKETPLACE && input.everReplied) {
    return "already_replied";
  }
  // We already told them it went out, or that we stopped it. A customer's
  // "thank you" after that is not waiting work, however unshipped the source
  // still believes the order to be.
  if (input.staffClosedTheOrder) return "thread_resolved";
  // An unknown age cannot satisfy a recency condition, so null fails here
  // rather than defaulting to "recent enough".
  if (input.ageHours === null || input.ageHours > BEFORE_SHIPMENT_RECENCY_HOURS) {
    return "too_old";
  }

  /* ---- 2. A real matching customer order ---- */
  // Nothing to look up at all.
  if (input.orderNumber === null || input.orderNumber.trim() === "") {
    return "no_matching_order";
  }
  // Looked up, and the source has no record of it. An absence is not a window:
  // a reference is a claim, and the row in the source is the verification.
  if (input.shipment === null) return "no_matching_order";

  /* ---- 3. Not yet dispatched ---- */
  if (input.shipment.dispatched) return "already_dispatched";

  return "eligible";
}

/** Whether the before-shipment urgent rule fires for this conversation. */
export function isBeforeShipmentUrgent(input: BeforeShipmentInput): boolean {
  return beforeShipmentEligibility(input) === "eligible";
}

/**
 * Whether to RE-TAG the conversation as an order change.
 *
 * ------------------------------------------------------------------------
 * URGENCY AND THE TAG ARE DIFFERENT QUESTIONS, AND THIS IS THE SPLIT
 * ------------------------------------------------------------------------
 * They were briefly the same thing, and that was wrong in both directions at
 * once:
 *
 *   TAGGING TOO MUCH. Every unanswered message on an unshipped order was
 *   re-tagged "Order change, before shipping queries" — so on Amazon, where the
 *   thread is keyed by the order number and nearly every conversation resolves
 *   to a real order, delivery queries and pre-sales questions were filed as
 *   order changes because the parcel had not left the warehouse.
 *
 *   THEN FLAGGING TOO LITTLE. Requiring order-change wording for URGENCY
 *   dropped a customer waiting on a real, unshipped order who happened to be
 *   asking about a colour option — someone we can still help before it goes
 *   out, which is the entire point of the window.
 *
 * So: URGENCY is about the WINDOW — an unanswered customer, a real order, still
 * here. It asks nothing about what they wrote, which is what keeps a
 * promotional email out (it is not a customer reply thread) and what keeps a
 * pre-sales question in (they are still waiting, and the order is still here).
 *
 * THE TAG is about the SUBJECT — it names the case area, so it may only be
 * applied when the customer is actually asking to change or stop the order. A
 * conversation this declines keeps whatever the phrase table read.
 */
export function shouldTagAsOrderChange(input: BeforeShipmentInput): boolean {
  return isBeforeShipmentUrgent(input) && input.orderChangeIntent;
}

/** The badge word. Short, because it sits on a dense list row. */
export const URGENT_LABEL = "URGENT";

/**
 * What the badge says it is about, on hover and to a screen reader.
 *
 * Names the WINDOW rather than the request, because the window is what makes it
 * urgent: the order is still here, and it will not be for long.
 */
export const URGENT_DESCRIPTION = "Urgent: order has not shipped yet - before-shipping query";
