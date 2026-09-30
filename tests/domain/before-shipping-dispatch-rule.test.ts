import { describe, expect, it } from "vitest";

import {
  CANCELLATION_TRIGGER_ID,
  DISPATCH_ORDERING_MARGIN_HOURS,
  RETURNS_REFUND_CATEGORY,
  type VerifiedDispatch,
  asksToCancelTheOrder,
  categoryForBeforeShipping,
  requestTargetOrder,
} from "@/lib/domain/before-shipping-dispatch-rule";
import { ORDER_CHANGE_CATEGORY } from "@/lib/domain/inbox";
import { CST_EVIDENCE } from "@/lib/knowledge/cst-category-evidence";
import { MESSAGE_CATEGORIES, readConversation } from "@/lib/knowledge/message-category";

/**
 * "Order change, BEFORE SHIPPING" is a claim about an order, and this checks it.
 *
 * ------------------------------------------------------------------------
 * THE RULE UNDER TEST, IN CST'S WORDS
 * ------------------------------------------------------------------------
 * "The main rule for order before shipping is: the conversation's order had not
 * shipped when the message was received. If it's shipped, it's not order before
 * shipping." Once the parcel has gone the case is a return or a refund.
 *
 * ------------------------------------------------------------------------
 * THE TWO CONVERSATIONS THAT FORCED IT, AND WHAT IS SYNTHETIC HERE
 * ------------------------------------------------------------------------
 * eBay 50802 — a buyer with a 1-light and a 3-light chandelier on order, writing
 * to cancel the 3-light one nine days after it shipped.
 * eBay 40467 — "thanks for sending lights so quickly, but thinking 3 separate
 * lights might be more suitable, how do we go about swapping them", on an order
 * dispatched the day before. Not a cancellation, and wrong for the same reason.
 *
 * The SHAPE of both is reproduced below. The WORDS are written for this test and
 * the order numbers are the documented placeholders, because no customer text or
 * reference may reach a tracked file — see `tests/guards/no-customer-data.test.ts`.
 *
 * ------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 * ------------------------------------------------------------------------
 * The rule has one job and one failure mode. The job: read the dispatch state of
 * the order the request is about. The failure mode: read some OTHER order's — the
 * one the resolver picked, the one on screen, the sibling. Half of this file is
 * therefore negative: a dispatched sibling must never move the target's category,
 * and the type is shaped so that it cannot.
 */

/** The target: the order the request is about. */
const TARGET = "99-99999-99999";
/** A sibling order on the same conversation. Dispatched in the negative tests. */
const SIBLING = "12-34567-89012";

/** The synthetic stand-in for 50802's cancellation message. */
const ITALIAN_CANCELLATION =
  "Ho ricevuto il lampadario a 1 luce, grazie. Procedo con la cancellazione dell'altro lampadario a 3 luci, non posso aspettare altro tempo.";

/** The chase that opened it. No cancellation wording at all. */
const ITALIAN_CHASE = "Buona sera, il mio ordine non e ancora arrivato. Quando arriva?";

/** The synthetic stand-in for 40467 — a post-delivery swap, not a cancellation. */
const SWAP_REQUEST =
  "Thanks for sending the lights so quickly, but three separate lights might suit better. How do we go about swapping them?";

/** When the customer wrote, in the fixtures below. */
const MESSAGE_AT = "2026-09-29T08:20:44.000Z";
/** Eight days before that: unambiguously before the message. */
const DISPATCHED_BEFORE = "2026-09-21 10:26:16";
/** Eight days after it: unambiguously later, so the request WAS pre-shipping. */
const DISPATCHED_AFTER = "2026-10-07 10:26:16";

/** A dispatch state for one named order. `dispatchedAt` is null when it has not gone. */
function dispatch(
  orderNumber: string,
  dispatched: boolean,
  dispatchedAt: string | null = dispatched ? DISPATCHED_BEFORE : null,
): VerifiedDispatch {
  return { orderNumber, dispatched, dispatchedAt };
}

const reading = (input: Parameters<typeof categoryForBeforeShipping>[0]) =>
  categoryForBeforeShipping({ messageAt: MESSAGE_AT, ...input });

/* ------------------------------------------------------------------------- *
 * THE CANCELLATION READING — REPORTED, AND CST'S OWN ROW
 * ------------------------------------------------------------------------- */

describe("the cancellation trigger is CST's, read rather than restated", () => {
  it("keys off a row that exists in the approved evidence map", () => {
    const row = CST_EVIDENCE.find((entry) => entry.id === CANCELLATION_TRIGGER_ID);
    expect(row).toBeDefined();
    /*
     * The row's own condition is where this rule came from. If somebody rewrites
     * it so it no longer says to check dispatch status, that is a change to CST's
     * instruction and to this rule's premise, and it should be noticed here rather
     * than in a silently different inbox.
     */
    expect(row!.condition.toLowerCase()).toContain("dispatch");
    expect(row!.pattern.source).toContain("cancel");
  });

  it("reads a cancellation in English, German and Italian", () => {
    expect(asksToCancelTheOrder(["Please cancel my order"])).toBe(true);
    expect(asksToCancelTheOrder(["Bitte um Kaufabbruch"])).toBe(true);
    expect(asksToCancelTheOrder(["Bitte die Bestellung stornieren"])).toBe(true);
    expect(asksToCancelTheOrder([ITALIAN_CANCELLATION])).toBe(true);
  });

  it("does not read a swap, an address change or a chase as one", () => {
    expect(asksToCancelTheOrder([SWAP_REQUEST])).toBe(false);
    expect(asksToCancelTheOrder(["Please change my delivery address"])).toBe(false);
    expect(asksToCancelTheOrder([ITALIAN_CHASE])).toBe(false);
    expect(asksToCancelTheOrder([])).toBe(false);
    expect(asksToCancelTheOrder([null, "   "])).toBe(false);
  });

  it("reads every customer message, not only the last one", () => {
    expect(asksToCancelTheOrder([ITALIAN_CANCELLATION, "Grazie"])).toBe(true);
    expect(asksToCancelTheOrder([ITALIAN_CHASE, ITALIAN_CANCELLATION])).toBe(true);
  });

  /**
   * IT IS REPORTED, NOT A CONDITION. The dispatch state decides; this only says
   * what kind of request it was, which is what a reviewer asks first.
   */
  it("is carried on the reading without deciding it", () => {
    const cancellation = reading({
      category: ORDER_CHANGE_CATEGORY,
      customerMessages: [ITALIAN_CANCELLATION],
      knownOrders: [{ orderNumber: TARGET }],
      dispatch: [dispatch(TARGET, true)],
    });
    expect(cancellation.cancellationRequested).toBe(true);
    expect(cancellation.category).toBe(RETURNS_REFUND_CATEGORY);

    const swap = reading({
      category: ORDER_CHANGE_CATEGORY,
      customerMessages: [SWAP_REQUEST],
      knownOrders: [{ orderNumber: TARGET }],
      dispatch: [dispatch(TARGET, true)],
    });
    expect(swap.cancellationRequested).toBe(false);
    // ...and it is corrected just the same, because the ORDER is what decides.
    expect(swap.category).toBe(RETURNS_REFUND_CATEGORY);
  });
});

/* ------------------------------------------------------------------------- *
 * WHICH ORDER THE REQUEST IS ABOUT
 * ------------------------------------------------------------------------- */

describe("the target order is resolved, never guessed", () => {
  it("is the order number the customer typed", () => {
    expect(
      requestTargetOrder({
        customerMessages: [`Please cancel order ${TARGET}, I no longer need it`],
        knownOrders: [{ orderNumber: SIBLING }, { orderNumber: TARGET }],
      }),
    ).toEqual({ status: "resolved", orderNumber: TARGET, how: "quoted_by_customer" });
  });

  it("matches a quoted number through punctuation and spacing", () => {
    expect(
      requestTargetOrder({
        customerMessages: ["cancel my order 99 99999 99999 please"],
        knownOrders: [{ orderNumber: TARGET }, { orderNumber: SIBLING }],
      }),
    ).toEqual({ status: "resolved", orderNumber: TARGET, how: "quoted_by_customer" });
  });

  it("is the only known order where the customer quoted none", () => {
    expect(
      requestTargetOrder({
        customerMessages: [ITALIAN_CHASE, ITALIAN_CANCELLATION],
        knownOrders: [{ orderNumber: TARGET }],
      }),
    ).toEqual({ status: "resolved", orderNumber: TARGET, how: "only_known_order" });
  });

  /**
   * CST'S OWN DUPLICATE-ORDER ROW SAYS "CONFIRM WHICH ORDER TO CANCEL — NEVER
   * ASSUME". Two orders and no number quoted is that scenario exactly, and a
   * silent pick of the displayed one is the assumption it forbids.
   */
  it("is ambiguous where two orders are equally consistent with the request", () => {
    expect(
      requestTargetOrder({
        customerMessages: ["Please cancel my order"],
        knownOrders: [{ orderNumber: TARGET }, { orderNumber: SIBLING }],
      }),
    ).toEqual({ status: "ambiguous", orderNumbers: [TARGET, SIBLING] });
  });

  it("is ambiguous where the customer quoted both", () => {
    expect(
      requestTargetOrder({
        customerMessages: [`cancel ${TARGET} and ${SIBLING}`],
        knownOrders: [{ orderNumber: TARGET }, { orderNumber: SIBLING }],
      }),
    ).toEqual({ status: "ambiguous", orderNumbers: [TARGET, SIBLING] });
  });

  it("is unavailable, not ambiguous, where no order is known at all", () => {
    expect(
      requestTargetOrder({ customerMessages: ["Please cancel my order"], knownOrders: [] }),
    ).toEqual({ status: "unavailable" });
    expect(
      requestTargetOrder({
        customerMessages: ["Please cancel my order"],
        knownOrders: [{ orderNumber: "   " }],
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("counts the same order arriving twice as one candidate", () => {
    expect(
      requestTargetOrder({
        customerMessages: ["Please cancel my order"],
        knownOrders: [{ orderNumber: TARGET }, { orderNumber: TARGET }],
      }),
    ).toEqual({ status: "resolved", orderNumber: TARGET, how: "only_known_order" });
  });
});

/* ------------------------------------------------------------------------- *
 * THE REPORTED CANCELLATION, BOTH WAYS ROUND
 * ------------------------------------------------------------------------- */

describe("the reported cancellation conversation", () => {
  /**
   * The thread as the classifier reads it, so the fixtures below are not asserting
   * against a category invented by this test. This is the input the correction
   * receives in production, produced by the classifier itself.
   */
  const thread = [
    { direction: "inbound" as const, text: ITALIAN_CHASE },
    {
      direction: "outbound" as const,
      text: "The 3-light chandelier is out of stock, so that order will be cancelled and refunded.",
    },
    { direction: "inbound" as const, text: ITALIAN_CANCELLATION },
  ];
  const customerMessages = thread
    .filter((turn) => turn.direction === "inbound")
    .map((turn) => turn.text);

  it("classifies from the text alone as the before-shipping case area", () => {
    expect(readConversation(thread).category).toBe(ORDER_CHANGE_CATEGORY);
  });

  it("becomes Return and refunds when the TARGET order had already shipped", () => {
    const result = reading({
      category: readConversation(thread).category,
      customerMessages,
      knownOrders: [{ orderNumber: TARGET }],
      dispatch: [dispatch(TARGET, true)],
    });
    expect(result.category).toBe(RETURNS_REFUND_CATEGORY);
    expect(result.outcome).toBe("target_dispatched");
    expect(result.target).toEqual({
      status: "resolved",
      orderNumber: TARGET,
      how: "only_known_order",
    });
  });

  it("keeps Order change, before shipping when the TARGET order has not shipped", () => {
    const result = reading({
      category: readConversation(thread).category,
      customerMessages,
      knownOrders: [{ orderNumber: TARGET }],
      dispatch: [dispatch(TARGET, false)],
    });
    expect(result.category).toBe(ORDER_CHANGE_CATEGORY);
    expect(result.outcome).toBe("target_not_dispatched");
  });
});

/* ------------------------------------------------------------------------- *
 * THE REPORTED SWAP — NOT A CANCELLATION, WRONG FOR THE SAME REASON
 * ------------------------------------------------------------------------- */

describe("the reported post-delivery swap conversation", () => {
  const thread = [{ direction: "inbound" as const, text: SWAP_REQUEST }];

  it("classifies from the text alone as the before-shipping case area", () => {
    expect(readConversation(thread).category).toBe(ORDER_CHANGE_CATEGORY);
  });

  it("becomes Return and refunds because the order had shipped, cancellation or not", () => {
    const result = reading({
      category: readConversation(thread).category,
      customerMessages: [SWAP_REQUEST],
      knownOrders: [{ orderNumber: TARGET }],
      dispatch: [dispatch(TARGET, true)],
    });
    expect(result.category).toBe(RETURNS_REFUND_CATEGORY);
    expect(result.outcome).toBe("target_dispatched");
    expect(result.cancellationRequested).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * "WHEN THE MESSAGE WAS RECEIVED" IS PART OF THE RULE
 * ------------------------------------------------------------------------- */

describe("a parcel that left AFTER the customer wrote", () => {
  const input = {
    category: ORDER_CHANGE_CATEGORY,
    customerMessages: [`Please cancel order ${TARGET}`],
    knownOrders: [{ orderNumber: TARGET }],
  };

  /**
   * IT WAS A BEFORE-SHIPPING REQUEST WHEN IT WAS MADE, and it keeps that category.
   * Shipping it anyway is a failure to act on a live request, which is a different
   * finding from a mis-categorised conversation, and the category has to keep
   * saying what the customer asked for or that finding disappears.
   */
  it("keeps the before-shipping category", () => {
    expect(
      reading({ ...input, dispatch: [dispatch(TARGET, true, DISPATCHED_AFTER)] }),
    ).toMatchObject({
      category: ORDER_CHANGE_CATEGORY,
      outcome: "dispatched_after_the_message",
    });
  });

  /**
   * TOO CLOSE TO CALL RESOLVES TO "THE ORDER HAS GONE" — see
   * `DISPATCH_ORDERING_MARGIN_HOURS`. The two timestamps come from different
   * databases whose zones are unconfirmed, so a few hours apart is not an ordering
   * this rule may assert, and the operational truth is that the parcel has left.
   */
  it("is read as dispatched when the two instants are within the margin", () => {
    expect(DISPATCH_ORDERING_MARGIN_HOURS).toBe(24);
    // Six hours after the message: inside the margin, so not "clearly later".
    expect(
      reading({ ...input, dispatch: [dispatch(TARGET, true, "2026-09-29 14:20:44")] }),
    ).toMatchObject({ category: RETURNS_REFUND_CATEGORY, outcome: "target_dispatched" });
  });

  /** An instant nobody could establish cannot satisfy an ordering condition. */
  it("is read as dispatched when either instant is missing or unreadable", () => {
    for (const [dispatchedAt, messageAt] of [
      [null, MESSAGE_AT],
      [DISPATCHED_AFTER, null],
      ["not a timestamp", MESSAGE_AT],
      [DISPATCHED_AFTER, "not a timestamp"],
    ] as const) {
      expect(
        categoryForBeforeShipping({
          ...input,
          messageAt,
          dispatch: [dispatch(TARGET, true, dispatchedAt)],
        }),
      ).toMatchObject({ category: RETURNS_REFUND_CATEGORY, outcome: "target_dispatched" });
    }
  });

  /**
   * THE COMPARISON DOES NOT DEPEND ON THE MACHINE'S TIMEZONE. A naive source
   * timestamp is read as UTC rather than as local time, so the same fixture
   * decides the same way on a developer's laptop and on the server.
   */
  it("reads a naive source timestamp the same way whatever the process zone is", () => {
    const naive = reading({ ...input, dispatch: [dispatch(TARGET, true, DISPATCHED_AFTER)] });
    const explicit = reading({
      ...input,
      dispatch: [dispatch(TARGET, true, `${DISPATCHED_AFTER.replace(" ", "T")}Z`)],
    });
    expect(naive.outcome).toBe(explicit.outcome);
  });
});

/* ------------------------------------------------------------------------- *
 * THE NEGATIVE HALF: ANOTHER ORDER'S DISPATCH STATE DECIDES NOTHING
 * ------------------------------------------------------------------------- */

describe("a dispatched OTHER order cannot change the target's category", () => {
  const customerMessages = [`Please cancel order ${TARGET}, I no longer need it`];
  const knownOrders = [{ orderNumber: TARGET }, { orderNumber: SIBLING }];

  it("refuses a state that names the sibling and not the target", () => {
    const result = reading({
      category: ORDER_CHANGE_CATEGORY,
      customerMessages,
      knownOrders,
      dispatch: [dispatch(SIBLING, true)],
    });
    expect(result.category).toBe(ORDER_CHANGE_CATEGORY);
    expect(result.outcome).toBe("dispatch_state_for_another_order");
    // ...and it still knows which order it WANTED, so the gap is reportable.
    expect(result.target).toEqual({
      status: "resolved",
      orderNumber: TARGET,
      how: "quoted_by_customer",
    });
  });

  it("uses the target's state and ignores the sibling's when both are supplied", () => {
    expect(
      reading({
        category: ORDER_CHANGE_CATEGORY,
        customerMessages,
        knownOrders,
        dispatch: [dispatch(SIBLING, true), dispatch(TARGET, false)],
      }),
    ).toMatchObject({ category: ORDER_CHANGE_CATEGORY, outcome: "target_not_dispatched" });

    expect(
      reading({
        category: ORDER_CHANGE_CATEGORY,
        customerMessages,
        knownOrders,
        dispatch: [dispatch(SIBLING, false), dispatch(TARGET, true)],
      }),
    ).toMatchObject({ category: RETURNS_REFUND_CATEGORY, outcome: "target_dispatched" });
  });

  /**
   * THE CASE THE WHOLE MODULE EXISTS FOR, stated as an assertion: where the target
   * cannot be told apart from its sibling, a dispatched sibling changes nothing.
   * The previous behaviour — read whichever order the conversation happened to
   * resolve to — is exactly what this forbids.
   */
  it("decides nothing at all while the target is ambiguous", () => {
    const result = reading({
      category: ORDER_CHANGE_CATEGORY,
      customerMessages: ["Please cancel my order"],
      knownOrders,
      dispatch: [dispatch(SIBLING, true), dispatch(TARGET, true)],
    });
    expect(result.category).toBe(ORDER_CHANGE_CATEGORY);
    expect(result.outcome).toBe("target_order_unresolved");
    expect(result.target.status).toBe("ambiguous");
  });

  it("treats two states for one order as unknown rather than picking one", () => {
    const result = reading({
      category: ORDER_CHANGE_CATEGORY,
      customerMessages,
      knownOrders,
      dispatch: [dispatch(TARGET, true), dispatch(TARGET, false)],
    });
    expect(result.category).toBe(ORDER_CHANGE_CATEGORY);
    expect(result.outcome).toBe("target_dispatch_unknown");
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT IT REFUSES TO TOUCH
 * ------------------------------------------------------------------------- */

describe("the correction is confined to one case area", () => {
  it("leaves every other category alone, dispatched or not", () => {
    for (const category of MESSAGE_CATEGORIES.filter((c) => c !== ORDER_CHANGE_CATEGORY)) {
      expect(
        reading({
          category,
          customerMessages: [`Please cancel order ${TARGET}`],
          knownOrders: [{ orderNumber: TARGET }],
          dispatch: [dispatch(TARGET, true)],
        }),
      ).toMatchObject({ category, outcome: "not_the_before_shipping_category" });
    }
  });

  it("leaves a null category null", () => {
    expect(
      reading({
        category: null,
        customerMessages: [`Please cancel order ${TARGET}`],
        knownOrders: [{ orderNumber: TARGET }],
        dispatch: [dispatch(TARGET, true)],
      }),
    ).toMatchObject({ category: null, outcome: "not_the_before_shipping_category" });
  });

  it("claims nothing where no dispatch state was read", () => {
    expect(
      reading({
        category: ORDER_CHANGE_CATEGORY,
        customerMessages: [`Please cancel order ${TARGET}`],
        knownOrders: [{ orderNumber: TARGET }],
        dispatch: [],
      }),
    ).toMatchObject({ category: ORDER_CHANGE_CATEGORY, outcome: "target_dispatch_unknown" });
  });

  it("uses only categories the classifier already has", () => {
    expect(MESSAGE_CATEGORIES).toContain(RETURNS_REFUND_CATEGORY);
    expect(MESSAGE_CATEGORIES).toContain(ORDER_CHANGE_CATEGORY);
  });
});
