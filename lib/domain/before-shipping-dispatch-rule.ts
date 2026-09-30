import { ORDER_CHANGE_CATEGORY } from "@/lib/domain/inbox";
import { normaliseOrderIdentifier, orderIdentifierQuoted } from "@/lib/domain/order";
import { collectCategoryEvidence } from "@/lib/knowledge/cst-category-evidence";
import type { MessageCategory } from "@/lib/knowledge/message-category";

/**
 * "Order change, BEFORE SHIPPING" is a claim about an ORDER, and this checks it.
 *
 * ------------------------------------------------------------------------
 * CST'S RULE, IN THEIR WORDS
 * ------------------------------------------------------------------------
 * "The main rule for order before shipping is: the conversation's order had not
 * shipped when the message was received. If it's shipped, it's not order before
 * shipping." A request that arrives after the parcel has gone is a return or a
 * refund — the customer refuses delivery or sends it back — and CST's own
 * workbook says exactly that under "Cannot cancel after dispatch. Two options:
 * refuse delivery or return on arrival."
 *
 * The category classifier reads the customer's WORDS and cannot read an order.
 * Nothing in the system was reading one for this purpose, so a request made days
 * after dispatch still arrived under a heading asserting the window was open.
 *
 * ------------------------------------------------------------------------
 * THE TWO CONVERSATIONS THAT FORCED IT
 * ------------------------------------------------------------------------
 * eBay 50802 — the buyer had a 1-light and a 3-light chandelier on order, CST
 * wrote to say the 3-light was out of stock, and the customer replied that the
 * 1-light had arrived and they were therefore proceeding with the cancellation of
 * the 3-light one. That order had shipped nine days earlier.
 *
 * eBay 40467 — "thanks for sending lights so quickly, but thinking 3 separate
 * lights might be more suitable, how do we go about swapping them". A post-
 * delivery exchange, filed under before-shipping, on an order dispatched the day
 * before the customer wrote. NOT a cancellation, which is why the rule turns on
 * the ORDER's state rather than on cancellation wording.
 *
 * ------------------------------------------------------------------------
 * THE DISPATCH STATE OF *WHICH* ORDER, AND WHY IT IS HALF THE RULE
 * ------------------------------------------------------------------------
 * A conversation can display several orders. A buyer who ordered twice sees two;
 * a reviewer who picked one from a list sees theirs; the resolver's snapshot
 * names one. NONE of those is automatically the order the request is about, and
 * reading a dispatch state off the wrong one is how a cancellation that could
 * still be honoured gets filed as a return, or a parcel already in transit gets
 * promised a cancellation.
 *
 * So the target is resolved FIRST, from the customer's own words, and the
 * dispatch state is only ever read for THAT order:
 *
 *   `requestTargetOrder`        which order the request is about — resolved,
 *                              ambiguous or unavailable. Never a guess.
 *   `categoryForBeforeShipping` the category, corrected only when a dispatch
 *                              state was supplied FOR THE TARGET.
 *
 * The dispatch state arrives NAMING THE ORDER IT BELONGS TO (`VerifiedDispatch`)
 * rather than as a bare boolean, and the name is compared against the target
 * before it is believed. That is what makes "never use another order's status"
 * structural rather than a thing a caller has to remember: hand this rule the
 * sibling order's state and it declines to decide, loudly, with
 * `dispatch_state_for_another_order`.
 *
 * ------------------------------------------------------------------------
 * IT MOVES A CONVERSATION BETWEEN TWO EXISTING CATEGORIES. IT INVENTS NONE.
 * ------------------------------------------------------------------------
 * Not shipped keeps `ORDER_CHANGE_CATEGORY`; shipped becomes
 * `RETURNS_REFUND_CATEGORY`. Both are the classifier's own values, imported
 * rather than retyped, and the vocabulary is untouched — `MESSAGE_CATEGORIES`
 * still has eleven members and `lib/knowledge/message-category.ts` is not edited
 * by this feature.
 *
 * ------------------------------------------------------------------------
 * PURE. No database, no clock, no network — see `lib/domain`'s contract. The
 * source read that produces a `VerifiedDispatch` belongs to the repository, and
 * the one place it happens is `order-shipment-state-repository.ts`, which the
 * before-shipment urgent rule already uses. There is no second dispatch reader.
 * ------------------------------------------------------------------------
 */

/**
 * Where a request lands once the order has gone.
 *
 * THE EXISTING CATEGORY, NOT A NEW ONE. "Return and refunds" is what CST already
 * files a refuse-delivery-or-return-on-arrival case under, and it is the
 * classifier's own spelling. Typed as `MessageCategory` so a drift in that
 * vocabulary is a compile error rather than a category nothing ever matches.
 */
export const RETURNS_REFUND_CATEGORY: MessageCategory = "Return and refunds";

/**
 * The CST trigger row that says a message is a cancellation.
 *
 * `INT-OS01`, from "ORDER BEFORRE SHIPPING And cancelation .xlsx" sheet 17. Its
 * pattern is `\bcancel\w*\b|\bstorni\w*\b|\bkaufabbruch\b`, which is why the
 * Italian "cancellazione" in conversation 50802 is read as a cancellation without
 * a word of new vocabulary being written here.
 *
 * IT IS REPORTED, NOT A CONDITION. The rule turns on the ORDER's state, so a
 * post-dispatch exchange request (eBay 40467) is corrected exactly like a
 * post-dispatch cancellation. This is carried on the reading because "was this a
 * cancellation" is the first thing a reviewer asks of a corrected row, and
 * because a cancellation CST could no longer honour is the case they most want
 * counted.
 *
 * READ, NEVER RESTATED. Matching the row by id and running the row's OWN pattern
 * is the difference between this and a third classifier: there is no cancellation
 * regex in this file, so the vocabulary cannot drift from the workbook it came
 * from. `collectCategoryEvidence` is the same collector the category layer runs.
 *
 * ITS `requires` CONDITION IS DELIBERATELY NOT APPLIED. `INT-OS01` requires
 * `goods_not_yet_arrived`, which is exactly the fact this rule refuses to take
 * from the text — the customer in 50802 says the OTHER parcel arrived, and the
 * order's own dispatch record is what decides. So the raw collector is used
 * rather than `resolveEvidenceOwnership`.
 */
export const CANCELLATION_TRIGGER_ID = "INT-OS01";

/**
 * Whether the customer asked to cancel, in any of their messages.
 *
 * THE THREAD, NOT THE NEWEST MESSAGE, and that is a different choice from the one
 * the urgent rule makes — on purpose. Urgency is a claim about NOW, so it reads
 * the current message only (see `BeforeShipmentInput.orderChangeIntent`). The
 * CATEGORY has always been a reading of the whole conversation
 * (`readConversation`), so anything reported alongside a corrected category has
 * to come from the same messages that produced it.
 */
export function asksToCancelTheOrder(customerMessages: readonly (string | null)[]): boolean {
  return customerMessages.some((text) => {
    const trimmed = text?.trim() ?? "";
    if (trimmed === "") return false;
    return collectCategoryEvidence(trimmed).some(
      (match) => match.id === CANCELLATION_TRIGGER_ID,
    );
  });
}

/** An order the conversation is known to be about. A claim the source verified. */
export type KnownOrder = { readonly orderNumber: string };

/**
 * Which order the request refers to.
 *
 * THREE OUTCOMES, AND `ambiguous` IS A FIRST-CLASS ONE — see `ContextResolution`
 * for the same shape and the same reason. A machine that picks between two
 * genuine candidates to keep a function simple is the bug this codebase is shaped
 * to prevent, and here the cost of picking wrong is a category that tells an
 * agent the opposite of the truth about a parcel.
 */
export type RequestTarget =
  | {
      readonly status: "resolved";
      readonly orderNumber: string;
      /**
       * WHY this order. `quoted_by_customer` is the customer having typed the
       * number; `only_known_order` is there being nothing else it could be.
       */
      readonly how: "quoted_by_customer" | "only_known_order";
    }
  /** Several orders are equally consistent with the request. Nothing is chosen. */
  | { readonly status: "ambiguous"; readonly orderNumbers: readonly string[] }
  /** No order is known for this conversation at all. */
  | { readonly status: "unavailable" };

/**
 * The order a request is about, from the customer's own words and the orders the
 * conversation is verified against.
 *
 * ORDER OF PREFERENCE, and each step is evidence rather than a ranking:
 *
 *   1. AN ORDER NUMBER THE CUSTOMER TYPED. Exact containment of the normalised
 *      identifier, the same test `order-match-evidence.ts` shows a reviewer as
 *      "Order number found in message" — so the reason on screen and the reason
 *      the category moved are one fact. Two different numbers quoted is
 *      `ambiguous`: the customer named both and nothing here may choose.
 *   2. THE ONLY ORDER THERE IS. Where the conversation is verified against
 *      exactly one order and the customer quoted none, that order is what the
 *      request is about, because there is nothing else it could be.
 *   3. SEVERAL ORDERS AND NO NUMBER QUOTED is `ambiguous`. This is the case the
 *      target resolution exists for: the duplicate-order scenario in CST's own
 *      workbook says "confirm which order to cancel — NEVER ASSUME", and a
 *      silent pick of the displayed one is the assumption it forbids.
 *   4. NO ORDERS is `unavailable`, which is not the same claim as ambiguous and
 *      must not be reported as one.
 *
 * Duplicate order numbers in `knownOrders` are counted once — the same logical
 * order arriving twice (a lifecycle row and its sibling) is not two candidates.
 */
export function requestTargetOrder(input: {
  readonly customerMessages: readonly (string | null)[];
  readonly knownOrders: readonly KnownOrder[];
}): RequestTarget {
  const orderNumbers = [
    ...new Set(
      input.knownOrders
        .map((order) => order.orderNumber.trim())
        .filter((orderNumber) => orderNumber !== ""),
    ),
  ];
  if (orderNumbers.length === 0) return { status: "unavailable" };

  const normalisedText = normaliseOrderIdentifier(
    input.customerMessages
      .map((text) => text ?? "")
      .filter((text) => text.trim() !== "")
      .join("\n"),
  );
  const quoted = orderNumbers.filter((orderNumber) =>
    orderIdentifierQuoted(orderNumber, normalisedText),
  );
  if (quoted.length === 1) {
    return { status: "resolved", orderNumber: quoted[0]!, how: "quoted_by_customer" };
  }
  if (quoted.length > 1) return { status: "ambiguous", orderNumbers: quoted };

  if (orderNumbers.length === 1) {
    return { status: "resolved", orderNumber: orderNumbers[0]!, how: "only_known_order" };
  }
  return { status: "ambiguous", orderNumbers };
}

/**
 * A dispatch state, and the order it was read FOR.
 *
 * THE ORDER NUMBER IS NOT DECORATION. It is what lets
 * `categoryForBeforeShipping` refuse a state that belongs to a sibling order
 * instead of silently applying it. A bare `{ dispatched: boolean }` would make
 * the defect this module fixes unrepresentable in a test and re-introducible in
 * one line of a caller.
 */
export type VerifiedDispatch = {
  readonly orderNumber: string;
  /** Whether the parcel has LEFT — see `OrderShipmentState.dispatched`. */
  readonly dispatched: boolean;
  /**
   * WHEN it left, as the source recorded it. Null for an order with no recorded
   * dispatch, which is every undispatched one.
   */
  readonly dispatchedAt: string | null;
};

/**
 * How far apart two timestamps must be before their ORDER can be trusted.
 *
 * ------------------------------------------------------------------------
 * WHY A MARGIN AT ALL, AND WHY IT IS NOT A FUDGE
 * ------------------------------------------------------------------------
 * CST's rule is about the order at the moment the message ARRIVED, so the two
 * instants have to be compared — and they come from two different databases whose
 * zones this repository has not confirmed. `shipped_time` is
 * `timestamp without time zone` in the source; the message instant is
 * `COALESCE(source_ts_utc, ingested_at)`, and `source_ts_utc` is populated for
 * none of the inbound messages today. So the comparison is reliable at the scale
 * of days and not at the scale of hours.
 *
 * 24 hours is larger than any real offset between the two (the widest inhabited
 * zone offset is 14 hours), so a difference bigger than this cannot have been
 * produced by a zone error. Anything closer than that is "too close to call".
 *
 * THE FAILURE DIRECTION IS DELIBERATE. Too-close-to-call resolves to "the order
 * has gone", because that is the operational truth an agent needs: a parcel that
 * left within a day of the message cannot be stopped now, whatever the clocks
 * say, and a heading promising otherwise is the defect this rule exists to fix.
 * Only an UNAMBIGUOUSLY later dispatch keeps the before-shipping reading.
 */
export const DISPATCH_ORDERING_MARGIN_HOURS = 24;

const MS_PER_HOUR = 3_600_000;

/**
 * A stored timestamp as milliseconds, or NaN.
 *
 * A NAIVE VALUE IS READ AS UTC RATHER THAN AS LOCAL TIME, which is the only
 * choice that makes this pure: `Date.parse("2026-09-21 10:26:16")` uses the
 * process timezone, so the same fixture would compare differently on a
 * developer's machine and on the server. The residual offset is exactly what
 * `DISPATCH_ORDERING_MARGIN_HOURS` absorbs.
 */
function instantMs(value: string): number {
  const trimmed = value.trim();
  const iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  return Date.parse(zoned);
}

/**
 * Whether the parcel left UNAMBIGUOUSLY AFTER the customer wrote.
 *
 * True only when the request genuinely was a before-shipping request at the
 * moment it was made and the warehouse shipped anyway — which is a failure to act
 * on a live request, not a mis-categorised conversation, and the category must
 * keep saying what the customer asked for. Everything else, including an
 * unreadable or missing timestamp, returns false.
 */
function dispatchedAfterTheMessage(
  dispatchedAt: string | null,
  messageAt: string | null,
): boolean {
  if (dispatchedAt === null || messageAt === null) return false;
  const dispatched = instantMs(dispatchedAt);
  const message = instantMs(messageAt);
  if (Number.isNaN(dispatched) || Number.isNaN(message)) return false;
  return dispatched - message > DISPATCH_ORDERING_MARGIN_HOURS * MS_PER_HOUR;
}

/** Why the category was or was not corrected. Safe to log — no customer text. */
export type BeforeShippingOutcome =
  /** The conversation is not filed under the before-shipping case area. */
  | "not_the_before_shipping_category"
  /** Which order the request means could not be established, or several could be it. */
  | "target_order_unresolved"
  /** No dispatch state was supplied for the target. Nothing is claimed. */
  | "target_dispatch_unknown"
  /**
   * States were supplied, and NONE of them is the target's.
   *
   * ITS OWN OUTCOME rather than folded into the one above, because the two are
   * different mistakes: not looking is a gap, and looking up the WRONG order is
   * the bug. A caller that produces this is passing a sibling order's state, and
   * it should be visible rather than silently equivalent to "we did not check".
   */
  | "dispatch_state_for_another_order"
  /** The target order is still here. The before-shipping category stands. */
  | "target_not_dispatched"
  /**
   * The target order shipped, but only AFTER the customer wrote. It was a
   * before-shipping request when it was made, and it keeps that category — see
   * `DISPATCH_ORDERING_MARGIN_HOURS`.
   */
  | "dispatched_after_the_message"
  /** The target order had gone when the message arrived. The case is a return. */
  | "target_dispatched";

export type BeforeShippingReading = {
  /** The category to display — the input category unless it was corrected. */
  readonly category: MessageCategory | null;
  readonly outcome: BeforeShippingOutcome;
  readonly target: RequestTarget;
  /**
   * Whether the customer asked to CANCEL, as opposed to amending or swapping.
   *
   * Reported, never a condition — see `CANCELLATION_TRIGGER_ID`. It is the first
   * thing a reviewer asks of a corrected row, and a cancellation CST could no
   * longer honour is the case they most want counted.
   */
  readonly cancellationRequested: boolean;
};

/**
 * The category for a conversation, checked against the TARGET order's dispatch
 * state.
 *
 * ONLY ONE OUTCOME CHANGES ANYTHING, and everything else returns the category it
 * was given. That is the failure direction this rule is built to fail in: a
 * missed correction leaves a reviewer reading the category the classifier
 * produced, which is the behaviour that existed before this module; a wrong
 * correction would tell them a parcel can be stopped when it cannot.
 *
 * THE CLASSIFIER IS NOT CONSULTED AND NOT CHANGED. `category` arrives already
 * read from the customer's text by `readConversation`; this decides nothing about
 * what the message SAYS. The two axes stay separate: the classifier reads the
 * request, the source reads the order.
 *
 * WHY ONLY THE BEFORE-SHIPPING AREA IS CORRECTED. That category's own name makes
 * a claim about the order, and it is the only one that does. A delivery chase, a
 * damage report or an admin matter says nothing about dispatch, so a dispatch
 * state cannot make any of them wrong — and re-tagging them from an order fact is
 * the exact over-reach `shouldTagAsOrderChange` was split out to stop.
 */
export function categoryForBeforeShipping(input: {
  /** What the classifier read from the customer's messages. */
  readonly category: MessageCategory | null;
  /** The customer's own messages, in order. Never ours. */
  readonly customerMessages: readonly (string | null)[];
  /** Every order this conversation is verified against. */
  readonly knownOrders: readonly KnownOrder[];
  /** Dispatch states read from the source, each naming the order it belongs to. */
  readonly dispatch: readonly VerifiedDispatch[];
  /**
   * When the customer's newest message arrived, or null where that instant could
   * not be established. A null is not treated as any particular moment: the
   * ordering test simply cannot be made, and the order's having gone decides.
   */
  readonly messageAt?: string | null;
}): BeforeShippingReading {
  const cancellationRequested = asksToCancelTheOrder(input.customerMessages);
  const unavailable: RequestTarget = { status: "unavailable" };
  const unchanged = (outcome: BeforeShippingOutcome, target: RequestTarget) => ({
    category: input.category,
    outcome,
    target,
    cancellationRequested,
  });

  if (input.category !== ORDER_CHANGE_CATEGORY) {
    return unchanged("not_the_before_shipping_category", unavailable);
  }

  const target = requestTargetOrder({
    customerMessages: input.customerMessages,
    knownOrders: input.knownOrders,
  });
  if (target.status !== "resolved") return unchanged("target_order_unresolved", target);

  /*
   * THE ONE COMPARISON THE WHOLE MODULE IS FOR. A state is believed only when it
   * names the target order. Anything else — a sibling's state, the displayed
   * order's state, the snapshot's state — is not an answer to the question asked,
   * and is reported as such rather than used.
   */
  const forTarget = input.dispatch.filter(
    (state) => state.orderNumber.trim() === target.orderNumber,
  );
  if (forTarget.length === 0) {
    return unchanged(
      input.dispatch.length === 0
        ? "target_dispatch_unknown"
        : "dispatch_state_for_another_order",
      target,
    );
  }
  /*
   * TWO STATES FOR ONE ORDER IS NOT A TIE TO BREAK. The source answers once per
   * order number (`shipmentStateForOrders` groups by it), so a second row means a
   * caller merged two reads and this rule cannot tell which is current.
   */
  if (forTarget.length > 1) return unchanged("target_dispatch_unknown", target);

  const state = forTarget[0]!;
  if (!state.dispatched) return unchanged("target_not_dispatched", target);
  if (dispatchedAfterTheMessage(state.dispatchedAt, input.messageAt ?? null)) {
    return unchanged("dispatched_after_the_message", target);
  }

  return {
    category: RETURNS_REFUND_CATEGORY,
    outcome: "target_dispatched",
    target,
    cancellationRequested,
  };
}
