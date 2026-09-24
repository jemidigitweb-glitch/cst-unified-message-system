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
 * 48 HOURS, SET BY CST. This was 72 on the reasoning that an order placed on a
 * Friday evening is still unshipped on Monday morning, so a shorter window would
 * drop it across the weekend. CST asked for 48 instead, defining the case area as
 * "customer message within 48 hours AND not dispatched", and that is their call to
 * make: they are the ones reading the queue. The weekend case is not imaginary —
 * a Friday-evening query chased on Monday IS past 48 hours from the FIRST message
 * — but the window is measured from the NEWEST customer message, so a customer who
 * writes again on Monday restarts it, and a customer who does not is one nobody
 * replied to for two days, which the response SLA is the right instrument for.
 *
 * IT IS THE ONLY NUMBER HERE, and both readers take it from this constant: the
 * inbox's urgent flag and the order-change notification feed. Changing it changes
 * both together, which is the point — a panel and a flag that disagreed about what
 * "before shipping" means would be two features wearing one name.
 *
 * DELIBERATELY NOT AN SLA. This decides what is still WORTH SHOWING; the response
 * SLA decides how fast it must be answered. Different questions, and the SLA's
 * duration is still unapproved — see `RESPONSE_SLA_MINUTES`.
 *
 * MEASURED FROM `LATEST_INBOUND_INSTANT`, which is `ingested_at` until the
 * ingestion layer fills `source_ts_utc` (0 of 23,363 inbound messages today). For
 * a backfilled conversation that is when the import ran, not when the customer
 * wrote — so this window is "48 hours since we could first have seen it", and on
 * historical data it is more generous than it looks.
 *
 * The dispatch condition bounds this far more tightly than any window does: an
 * order that has shipped drops out whatever its age. The window exists for the
 * other direction — a thread nobody ever shipped and nobody ever closed must not
 * sit at the top of the inbox forever.
 */
export const BEFORE_SHIPMENT_RECENCY_HOURS = 48;

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
  /**
   * A before-shipping order-change query that NOBODY HAS REPLIED TO.
   *
   * Urgent on the case area and the silence alone — no age limit, no order
   * lookup, no dispatch read. See `UNANSWERED_BEFORE_SHIPPING_IS_URGENT`.
   */
  | "unanswered_before_shipping"
  /**
   * The customer is asking to stop or change the order and we CANNOT SEE the
   * order at all. Urgent, and the one outcome that says so without claiming
   * the order is real — see `orderStateUnverifiedIsUrgent`.
   */
  | "order_state_unverified"
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
  /**
   * Whether the conversation's CASE AREA is the before-shipping one — the
   * category the inbox already displays beside the row, from
   * `BEFORE_SHIPPING_CATEGORY`.
   *
   * ------------------------------------------------------------------------
   * THIS IS THE CONDITION CST ASKED FOR, AND IT HAS NO CLOCK
   * ------------------------------------------------------------------------
   * "It needs to be order-before-shipping category, and it's not replied yet —
   * show the urgency until it is replied." That is the whole rule, and the two
   * things it does NOT say are the point of it:
   *
   *   NO TIME LIMIT. The 48-hour recency window does not apply to this path.
   *   An unanswered before-shipping query was previously urgent for two days
   *   and then vanished from the urgent block — which is precisely backwards,
   *   because the longer nobody answers, the more it needs answering. It now
   *   stays up until somebody replies.
   *
   *   NO ORDER REQUIRED. It does not wait for the order to be identified. The
   *   eBay identity race described under `orderNumber` means the order often
   *   cannot be linked during the very window it could still be stopped in.
   *
   * ------------------------------------------------------------------------
   * DISPATCH STILL VETOES IT
   * ------------------------------------------------------------------------
   * When the order IS known and the source says it has gone, this is not
   * urgent: the window has closed and "please cancel" on a parcel already in
   * transit is a return, not a cancellation. When the order is not known, no
   * claim is made either way and the silence decides.
   *
   * A BOOLEAN, NOT TEXT, for the same reason `orderChangeIntent` is one: the
   * vocabulary stays in `message-category.ts`, read once by the repository, and
   * this module keeps having nothing a keyword could arrive through.
   */
  readonly beforeShippingCategory: boolean;
  /**
   * Whether the customer's NEWEST message is a bare thank-you in a thread we
   * have already replied to — "Great Thanks" after CST answered.
   *
   * ------------------------------------------------------------------------
   * THE SECOND CLOSING SIGNAL, AND IT READS THE CUSTOMER RATHER THAN US
   * ------------------------------------------------------------------------
   * `staffClosedTheOrder` catches the threads WE ended by saying the order went
   * out or was stopped. It cannot catch the ones the CUSTOMER ended, and those
   * are just as finished: eBay `piotr.woss-uk` had CST reply "we understand you
   * would like to keep the order as it is", the customer answer "Great Thanks"
   * twice, and the row stayed URGENT with the SLA 14 days overdue — because the
   * newest message was inbound and nothing asked whether it was a REQUEST.
   *
   * BOTH HALVES ARE REQUIRED, and the caller composes them: the message says
   * nothing but thanks, AND we have replied in this thread. A customer whose
   * opening message is "Hello, thanks" has not been answered by anybody and
   * must not be dropped, which is why the reply is part of the condition rather
   * than the wording alone.
   *
   * A BOOLEAN, NOT TEXT — the same contract as every other input here. The
   * vocabulary stays in `message-category.ts`, behind `isPleasantryOnly`.
   */
  readonly customerAcknowledgedOnly: boolean;
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
  // We already told them it went out, or that we stopped it. A customer's
  // "thank you" after that is not waiting work, however unshipped the source
  // still believes the order to be. Checked BEFORE the case-area rule below,
  // because "until it is replied" is satisfied by the reply that closed it.
  if (input.staffClosedTheOrder) return "thread_resolved";
  /*
   * AND THE THREADS THE CUSTOMER ENDED. Same outcome, because they are the same
   * fact — nobody is waiting on us — arrived at from the other side of the
   * conversation. Checked here, above the case-area rule, so a finished thread
   * cannot be held open by the category its opening message earned.
   */
  if (input.customerAcknowledgedOnly) return "thread_resolved";

  /*
   * ------------------------------------------------------------------------
   * THE CASE-AREA RULE — no clock, no order required, until somebody replies
   * ------------------------------------------------------------------------
   * Placed HERE, above the recency window, the Amazon restriction and the
   * order lookup, because it is subject to none of them. Everything above it
   * still binds: this is a real customer reply thread, the newest message is
   * theirs, and we have not already closed it.
   *
   * THE DISPATCH VETO IS THE ONE THING THAT OVERRIDES IT. Where the order was
   * found and the source says it has gone, the window has closed and this is
   * not urgent — the same guarantee the order-state path below gives, applied
   * at the same strength. Where the order was NOT found, `shipment` is null,
   * no claim is made in either direction, and the silence decides.
   *
   * IT DOES NOT TOUCH THE PATH BELOW. A conversation whose case area is
   * something else — a delivery chase, a pre-sales question — falls straight
   * through to the original rule and keeps exactly the behaviour it had.
   */
  /*
   * ------------------------------------------------------------------------
   * THE CASE AREA IS REQUIRED. THIS IS THE CONDITION, NOT A SECOND ROUTE IN.
   * ------------------------------------------------------------------------
   * CST's rule is "it needs to be order-before-shipping category AND it's not
   * replied yet", so a conversation filed under any other case area is not
   * urgent however its order is doing.
   *
   * WHAT THIS DELIBERATELY TURNS OFF. Urgency used to be decided by the WINDOW
   * alone and asked nothing about what the customer wrote — so an unanswered
   * delivery chase, a pre-sales question or a damage report on any unshipped
   * order was URGENT. On Amazon, where the thread is keyed by the order number
   * and almost every conversation resolves, that was most of the tab: the
   * inbox showed an "Admin related issues" row wearing the red badge purely
   * because the warehouse had not shipped yet.
   *
   * The previous author's reasoning for the wider rule is preserved in
   * `shouldTagAsOrderChange` and is not wrong — a customer asking about a
   * colour option before dispatch is someone we can still help. It is now a
   * question for the SLA timer and the priority ribbon, which still rank those
   * rows; URGENT is reserved for the case area CST named.
   */
  if (!input.beforeShippingCategory) return "not_an_order_change";

  /* ---- 2 and 3. The order, where we can see it ---- */
  if (input.shipment?.dispatched === true) return "already_dispatched";
  /*
   * WHERE THE ORDER WAS ACTUALLY CHECKED, SAY THE STRONGER THING.
   *
   * A non-null `shipment` means the order was found in the source, and the line
   * above has ruled out its having gone — which is precisely `eligible`, the
   * outcome that earns "order has not shipped yet" on the badge. Falling
   * through to `unanswered_before_shipping` would downgrade a verified row to a
   * vaguer claim than the evidence supports.
   */
  if (input.shipment !== null) return "eligible";

  /* ---- The order we cannot see ---- */
  const nothingToLookUp = input.orderNumber === null || input.orderNumber.trim() === "";

  if (!nothingToLookUp) {
    /*
     * Looked up, and the source has no record of it. An absence is not a
     * window: a reference is a claim, and the row in the source is the
     * verification. Still urgent, because the case area and the silence are
     * what CST's rule turns on — but reported as unverified, never as a
     * statement about a parcel.
     */
    return "unanswered_before_shipping";
  }

  {
    /*
     * ------------------------------------------------------------------------
     * WE CANNOT SEE THE ORDER, AND THE CUSTOMER IS ASKING US TO STOP IT
     * ------------------------------------------------------------------------
     * Returning `no_matching_order` here was silently burying the most
     * time-critical message in the inbox, and the cause is a RACE rather than
     * a missing feature.
     *
     * On eBay the only link between a conversation and an order is
     * `customers.customer_info.ebay_buyer_id` — the one column in the entire
     * source that carries a buyer username. Measured 2026-09-23 it is populated
     * on 0% of eBay orders under 6 hours old, 14% by 12 hours, and 100% only
     * after 12-24 hours. eBay orders dispatch at a median of 12.6 hours, and
     * 1,203 of 2,577 (47%) ship inside 12 hours.
     *
     * So for roughly the first half-day of an order's life CST cannot identify
     * whose it is — and that is precisely the window in which a "please cancel
     * before it ships" can still be acted on. The rule was structurally
     * incapable of firing during the window it exists to protect.
     *
     * ------------------------------------------------------------------------
     * WHY THIS IS NOT THE OLD KEYWORD BUG COMING BACK
     * ------------------------------------------------------------------------
     * The header above describes three ways the original wording-driven rule
     * was wrong. None of them is reachable here:
     *
     *   A PROMOTIONAL EMAIL still fails condition 1 — it is not a customer
     *   reply thread, and this branch sits after every one of those checks.
     *
     *   OLD TEXT still cannot hold a thread urgent. `orderChangeIntent` is
     *   computed from the NEWEST inbound message only, and the 48-hour window
     *   has already been applied above.
     *
     *   AN ALREADY-DISPATCHED ORDER still cannot reach this branch. A delivered
     *   parcel HAS a findable order, so it resolves to `already_dispatched`
     *   below. This branch is only reached when the order cannot be found at
     *   all, which for a message under 48 hours old is overwhelmingly an order
     *   too new to have been identified — not an old one.
     *
     * INTENT IS REQUIRED, and that is what keeps this narrow. Measured across
     * the whole live store on 2026-09-23, the conversations this newly raises
     * are 1 on eBay, 3 on Amazon, 1 on Shopify and none on B&Q or Temu. Five.
     * Without the intent condition it would have been 416.
     *
     * IT IS A SEPARATE OUTCOME, NOT `eligible`, so the interface can say the
     * order has not been identified rather than implying we checked and found
     * it. An agent opening this needs to know the order is unconfirmed.
     *
     * ------------------------------------------------------------------------
     * ONLY WHEN THERE WAS NOTHING TO LOOK UP — NOT WHEN A LOOKUP FAILED
     * ------------------------------------------------------------------------
     * This branch is reached only when `orderNumber` is absent, which is the
     * identity race above: no key exists yet, so no lookup was even attempted
     * and the source's availability is irrelevant.
     *
     * A conversation that HAS an order key and whose `shipment` came back null
     * falls through to `no_matching_order` below, unchanged. That case is
     * ambiguous in a way this one is not — it is both "the source has no such
     * order" and "the source could not be reached", because
     * `applyBeforeShipmentRule` passes an empty map when the pool is absent.
     * Treating it as urgent would mean a source outage lighting up the inbox,
     * and would also read a genuine "no such order" as a reason to escalate.
     */
    if (input.orderChangeIntent) return "order_state_unverified";
    /*
     * No key, and the newest message is not itself asking us to stop or change
     * anything — a follow-up inside a before-shipping thread, say. Urgent on
     * the case area and the silence, which is CST's rule, and reported as the
     * outcome that claims nothing about any parcel.
     */
    return "unanswered_before_shipping";
  }
}

/**
 * Whether an unverifiable order still earns the urgent flag.
 *
 * A NAMED CONSTANT rather than a literal in `isBeforeShipmentUrgent`, because
 * this is the one place the rule trades certainty for speed and somebody will
 * want to turn it off without reading the whole module. Setting it false
 * restores the previous behaviour exactly: `order_state_unverified` stops being
 * urgent and the outcome remains visible as the explanation.
 */
export const URGENT_WHEN_ORDER_STATE_UNVERIFIED = true;

/**
 * Whether an unanswered before-shipping query is urgent on its case area alone.
 *
 * A NAMED CONSTANT for the same reason as the one above: this is CST's rule,
 * and somebody should be able to find and reverse it without reading the
 * module. Setting it false restores the pure order-state behaviour — the
 * outcome remains visible as the explanation.
 */
export const UNANSWERED_BEFORE_SHIPPING_IS_URGENT = true;

/** Whether the before-shipment urgent rule fires for this conversation. */
export function isBeforeShipmentUrgent(input: BeforeShipmentInput): boolean {
  const outcome = beforeShipmentEligibility(input);
  if (outcome === "eligible") return true;
  if (outcome === "unanswered_before_shipping") {
    return UNANSWERED_BEFORE_SHIPPING_IS_URGENT;
  }
  return URGENT_WHEN_ORDER_STATE_UNVERIFIED && outcome === "order_state_unverified";
}

/**
 * Whether the order behind an urgent row was actually verified.
 *
 * The interface needs this to tell the two apart: `eligible` means we looked up
 * the order and it is still here, `order_state_unverified` means we could not
 * find it at all. Both are urgent; only the first is a statement about an
 * order, and a badge that implied otherwise would be the same over-claim the
 * `no_matching_order` outcome was introduced to prevent.
 */
export function urgentOrderIsVerified(outcome: BeforeShipmentOutcome): boolean {
  return outcome === "eligible";
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

/**
 * What the badge says when the order could not be identified.
 *
 * Says what we KNOW (they are asking us to stop or change it) and what we do
 * NOT (which order, or whether it has gone), rather than borrowing the
 * confident wording above. An agent seeing this needs to find the order
 * themselves, and a badge claiming "has not shipped yet" would tell them the
 * opposite of the truth — we have not established that.
 */
export const URGENT_UNVERIFIED_DESCRIPTION =
  "Urgent: customer asked to change or stop an order - order not yet identified";

/** The badge word for an urgent row whose order could not be identified. */
export const URGENT_UNVERIFIED_LABEL = "URGENT?";

/**
 * What the badge says for an unanswered before-shipping query.
 *
 * Says the two things this path actually established — the case area, and that
 * nobody has replied — and claims nothing about the parcel. It must not borrow
 * `URGENT_DESCRIPTION`'s "order has not shipped yet": where the order was found
 * and had shipped this row is not urgent at all, and where it was not found we
 * never checked, so either way that sentence would be unearned here.
 */
export const URGENT_UNANSWERED_DESCRIPTION =
  "Urgent: before-shipping order change - nobody has replied yet";

/**
 * The badge a row should wear, chosen from the outcome that raised it.
 *
 * ONE PLACE DECIDES THIS. It was previously a boolean the list computed by
 * comparing the outcome to a string, which put a second opinion about what the
 * badge means in a component — the same split that let `order_state_unverified`
 * be flagged by the rule and ignored by the flag. The component now renders
 * what this returns and forms no view of its own.
 */
/*
 * TAKES A LOOSE STRING, DELIBERATELY. `InboxItem.beforeShipmentOutcome` is
 * `z.string().nullable()` rather than an enum because `inbox.ts` cannot import
 * this module — this one already imports `ORDER_CHANGE_CATEGORY` from it, and
 * narrowing the schema would close that loop into a cycle. So the carried value
 * arrives here as a string, and the final `return` is the total fallback that
 * makes any unrecognised value render the ordinary badge rather than crash.
 */
export function urgentBadge(outcome: BeforeShipmentOutcome | string | null): {
  readonly label: string;
  readonly description: string;
} {
  if (outcome === "order_state_unverified") {
    return { label: URGENT_UNVERIFIED_LABEL, description: URGENT_UNVERIFIED_DESCRIPTION };
  }
  if (outcome === "unanswered_before_shipping") {
    return { label: URGENT_LABEL, description: URGENT_UNANSWERED_DESCRIPTION };
  }
  return { label: URGENT_LABEL, description: URGENT_DESCRIPTION };
}
