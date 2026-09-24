import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ResponseSlaTimer } from "@/components/response-sla-timer";
import { UrgentFlag } from "@/components/urgent-flag";
import {
  BEFORE_SHIPMENT_MARKETPLACE,
  BEFORE_SHIPMENT_RECENCY_HOURS,
  BEFORE_SHIPPING_CATEGORY,
  type BeforeShipmentInput,
  UNANSWERED_BEFORE_SHIPPING_IS_URGENT,
  URGENT_DESCRIPTION,
  URGENT_LABEL,
  URGENT_UNANSWERED_DESCRIPTION,
  URGENT_UNVERIFIED_LABEL,
  beforeShipmentEligibility,
  isBeforeShipmentUrgent,
  urgentBadge,
  urgentOrderIsVerified,
} from "@/lib/domain/before-shipment-urgency";
import { isPleasantryOnly } from "@/lib/knowledge/message-category";
import { ORDER_CHANGE_CATEGORY } from "@/lib/domain/inbox";
import {
  RESPONSE_SLA_MINUTES,
  SLA_NOT_CONFIGURED_TEXT,
  SLA_STARTED_AT_INGEST_TEXT,
  formatDuration,
  formatSlaDueAt,
  isSlaCritical,
  responseSlaStatus,
} from "@/lib/domain/response-sla";
import { staffClosedTheOrder } from "@/lib/knowledge/staff-resolution";
import { type Queryable, listConversations } from "@/lib/repositories/conversation-repository";

/**
 * The before-shipment urgent rule and the response SLA.
 *
 * Synthetic data throughout. No real customer message, order or address appears.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/** An eligible conversation. Each test spoils exactly one condition. */
function eligible(overrides: Partial<BeforeShipmentInput> = {}): BeforeShipmentInput {
  return {
    lastDirection: "inbound",
    inboxPlacement: "reply_inbox",
    platformNotice: false,
    staffClosedTheOrder: false,
    marketplace: "amazon",
    everReplied: false,
    ageHours: 2,
    orderChangeIntent: true,
    /*
     * TRUE, because it is now a CONDITION of the rule rather than one of two
     * routes into it: "it needs to be order-before-shipping category and it's
     * not replied yet." A fixture that left it false would describe a
     * conversation the rule refuses outright, which is what the dedicated
     * tests below set it false to prove.
     */
    beforeShippingCategory: true,
    customerAcknowledgedOnly: false,
    orderNumber: "LED65289",
    shipment: { dispatched: false },
    ...overrides,
  };
}

/* ------------------------------------------------------------------------- *
 * THE RULE
 * ------------------------------------------------------------------------- */

describe("a customer message on a linked, unshipped order is urgent", () => {
  it("fires when all three conditions hold", () => {
    expect(beforeShipmentEligibility(eligible())).toBe("eligible");
  });

  /** The case area is the classifier's own value, not a second spelling of it. */
  it("tags it Order change, before shipping queries", () => {
    expect(BEFORE_SHIPPING_CATEGORY).toBe(ORDER_CHANGE_CATEGORY);
    expect(BEFORE_SHIPPING_CATEGORY).toBe("Order change, before shipping queries");
  });

  /**
   * NO TEXT REACHES THIS MODULE. The intent is supplied as a BOOLEAN the
   * repository computed from the newest inbound message, so the cancellation
   * vocabulary still lives only in `message-category.ts` and
   * `message-priority.ts` — there is no string here for a keyword to arrive
   * through and no second detector to drift from the first.
   */
  it("takes no customer text as input at all", () => {
    expect(Object.keys(eligible()).sort()).toEqual(
      [
        "ageHours",
        "beforeShippingCategory",
        "customerAcknowledgedOnly",
        "everReplied",
        "inboxPlacement",
        "marketplace",
        "orderChangeIntent",
        "lastDirection",
        "orderNumber",
        "platformNotice",
        "shipment",
        "staffClosedTheOrder",
      ].sort(),
    );
    // Comments stripped first: the doc-comment explaining WHY cancellation
    // wording is not read names that wording, and must not trip its own guard.
    const source = read("lib", "domain", "before-shipment-urgency.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/new RegExp|\.test\(|cancel|stop dispatch/i);
  });
});

/* ------------------------------------------------------------------------- *
 * THE CASE-AREA RULE — before-shipping, unanswered, until somebody replies
 *
 * CST's rule, and it overrides the recency window entirely: "it needs to be
 * order-before-shipping category, and it's not replied yet — show the urgency
 * until it is replied." Plus the one veto they added: where the order IS
 * visible and has been dispatched, it is not urgent.
 * ------------------------------------------------------------------------- */

describe("an unanswered before-shipping query stays urgent until it is answered", () => {
  /*
   * The order is DELIBERATELY invisible here. With a readable, undispatched
   * order the rule says `eligible` — the stronger claim — so this helper
   * describes the other half: a before-shipping case area whose order could not
   * be checked, which is where `unanswered_before_shipping` lives.
   */
  const unanswered = (overrides: Partial<BeforeShipmentInput> = {}) =>
    eligible({
      beforeShippingCategory: true,
      orderNumber: null,
      shipment: null,
      orderChangeIntent: false,
      ...overrides,
    });

  it("fires on the case area and the silence alone", () => {
    expect(beforeShipmentEligibility(unanswered())).toBe("unanswered_before_shipping");
    expect(isBeforeShipmentUrgent(unanswered())).toBe(true);
  });

  /**
   * THE WHOLE POINT OF THE CHANGE. Every one of these ages was `too_old` before
   * — the conversation was urgent for two days and then vanished, which is
   * backwards: the longer nobody answers, the more it needs answering.
   */
  it.each([0, 1, 47, 48, 49, 72, 24 * 7, 24 * 90])("ignores the clock at %ih", (ageHours) => {
    expect(beforeShipmentEligibility(unanswered({ ageHours })), `${ageHours}h`).toBe(
      "unanswered_before_shipping",
    );
  });

  /** Even an age nobody could establish, which the order-state path refuses. */
  it("does not need the arrival time to be known", () => {
    expect(beforeShipmentEligibility(unanswered({ ageHours: null }))).toBe(
      "unanswered_before_shipping",
    );
  });

  /**
   * NO ORDER REQUIRED. The eBay identity race means the order usually cannot be
   * linked during the window it could still be stopped in.
   */
  it.each([null, "", "   "])("does not wait for the order to be identified (%j)", (orderNumber) => {
    expect(
      beforeShipmentEligibility(unanswered({ orderNumber, shipment: null })),
    ).toBe("unanswered_before_shipping");
  });

  /** And it does not care whether the customer's wording reads as an order change. */
  it("does not re-read the customer's intent", () => {
    expect(beforeShipmentEligibility(unanswered({ orderChangeIntent: false }))).toBe(
      "unanswered_before_shipping",
    );
  });

  /**
   * THE VETO CST ASKED FOR, IN BOTH DIRECTIONS: "if order details available and
   * it's not dispatched yet it's order before shipping; if it's dispatched it's
   * not urgent."
   */
  it("is not urgent once the visible order has been dispatched", () => {
    const dispatched = unanswered({ shipment: { dispatched: true } });
    expect(beforeShipmentEligibility(dispatched)).toBe("already_dispatched");
    expect(isBeforeShipmentUrgent(dispatched)).toBe(false);
  });

  /**
   * The other side of the veto. A VISIBLE, undispatched order is the stronger
   * outcome — `eligible` — because it is the one that earns "order has not
   * shipped yet" on the badge. Still urgent either way.
   */
  it("is urgent, and says so more confidently, while the visible order has not been dispatched", () => {
    const visible = unanswered({
      orderNumber: "LED65289",
      shipment: { dispatched: false },
    });
    expect(beforeShipmentEligibility(visible)).toBe("eligible");
    expect(isBeforeShipmentUrgent(visible)).toBe(true);
    expect(urgentOrderIsVerified(beforeShipmentEligibility(visible))).toBe(true);
  });

  /** An order nobody can see makes no claim either way, so the silence decides. */
  it("stays urgent when the order cannot be seen at all", () => {
    expect(isBeforeShipmentUrgent(unanswered({ shipment: null }))).toBe(true);
  });

  /* --- what still stops it --- */

  /** "Until it is replied" — and this is the reply. */
  it("stops the moment we answer", () => {
    expect(beforeShipmentEligibility(unanswered({ lastDirection: "outbound" }))).toBe(
      "no_customer_action_needed",
    );
  });

  /** Our reply closed the order out, so the thread is done however it is tagged. */
  it("stops when our reply already closed the order", () => {
    expect(beforeShipmentEligibility(unanswered({ staffClosedTheOrder: true }))).toBe(
      "thread_resolved",
    );
  });

  /**
   * ------------------------------------------------------------------------
   * THE DEFECT THIS CLOSED, FOUND ON SCREEN
   * ------------------------------------------------------------------------
   * eBay `piotr.woss-uk`: CST replied "we understand you would like to keep the
   * order as it is and do not wish to cancel it", the customer answered "Great
   * Thanks" twice, and the row sat URGENT with the SLA 14 days overdue. The
   * newest message was inbound, so "nobody has replied" was true of the message
   * and false of the thread — and nothing asked whether it was a REQUEST.
   */
  it("stops when the customer's last word is a bare thank-you", () => {
    const acknowledged = unanswered({ customerAcknowledgedOnly: true });
    expect(beforeShipmentEligibility(acknowledged)).toBe("thread_resolved");
    expect(isBeforeShipmentUrgent(acknowledged)).toBe(false);
  });

  /** It closes the thread whatever its age, and whatever the order is doing. */
  it.each([
    ["an old thread", { ageHours: 24 * 90 }],
    ["an undispatched order", { shipment: { dispatched: false } }],
    ["an order nobody can see", { shipment: null, orderNumber: null }],
  ])("closes %s once the customer has signed off", (_label, override) => {
    expect(
      beforeShipmentEligibility(unanswered({ customerAcknowledgedOnly: true, ...override })),
    ).toBe("thread_resolved");
  });

  it.each([
    ["a platform notice", { platformNotice: true }],
    ["a filtered placement", { inboxPlacement: "filtered" as const }],
    ["an outbound-only thread", { inboxPlacement: "outbound_only" as const }],
  ])("never fires for %s", (_label, override) => {
    expect(beforeShipmentEligibility(unanswered(override))).toBe(
      "not_a_customer_conversation",
    );
  });

  /**
   * IT OVERRIDES AMAZON'S NEVER-REPLIED RESTRICTION, and that is intended. That
   * restriction reserves the ORDER-STATE path for untouched requests; this rule
   * is about a customer waiting on an answer, and a thread we replied in once
   * before still has nobody answering the message on screen now.
   */
  it("fires on Amazon even in a thread we have replied in before", () => {
    expect(
      beforeShipmentEligibility(unanswered({ marketplace: "amazon", everReplied: true })),
    ).toBe("unanswered_before_shipping");
  });

  it("still reads no customer text", () => {
    const source = read("lib", "domain", "before-shipment-urgency.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/new RegExp|\.test\(|cancel|stop dispatch/i);
  });

  it("can be reversed from one named constant", () => {
    expect(UNANSWERED_BEFORE_SHIPPING_IS_URGENT).toBe(true);
  });
});

describe("a customer signing off is read as a sign-off", () => {
  /** The exact messages from the screenshot, and their common variants. */
  it.each([
    "Great Thanks",
    "Great, thanks",
    "Thanks",
    "Many thanks",
    "Thank you",
    "Thanks, kind regards",
    "Perfect, thank you!",
    "Brilliant thanks",
    "Vielen Dank",
  ])("reads %j as nothing but thanks", (text) => {
    expect(isPleasantryOnly(text)).toBe(true);
  });

  /**
   * THE SENTENCES IT MUST NOT SWALLOW. A thank-you with a question attached is
   * a question — reading it as closure would silently drop the request, which
   * is the same class of error as `staffClosedTheOrder` reading "has NOT been
   * dispatched" as dispatched.
   */
  it.each([
    "Thanks, but when will it ship?",
    "Thank you - please cancel the order.",
    "Great, can you change the address?",
    "Thanks for nothing, this arrived broken",
    "",
    "   ",
  ])("does not read %j as a sign-off", (text) => {
    expect(isPleasantryOnly(text)).toBe(false);
  });

  it("treats an absent message as no signal rather than closure", () => {
    expect(isPleasantryOnly(null)).toBe(false);
    expect(isPleasantryOnly(undefined)).toBe(false);
  });
});

describe("the badge says what was actually established", () => {
  it("claims the parcel is still here only where the order was checked", () => {
    expect(urgentBadge("eligible").description).toBe(URGENT_DESCRIPTION);
    expect(urgentBadge("eligible").label).toBe(URGENT_LABEL);
  });

  /**
   * The case-area rule does not read dispatch when the order is invisible, so
   * its badge must not borrow a sentence that says the parcel has not shipped.
   */
  it("claims nothing about the parcel for an unanswered before-shipping query", () => {
    const badge = urgentBadge("unanswered_before_shipping");
    expect(badge.label).toBe(URGENT_LABEL);
    expect(badge.description).toBe(URGENT_UNANSWERED_DESCRIPTION);
    expect(badge.description).not.toMatch(/not shipped|has not shipped/i);
  });

  it("keeps the question mark for an order nobody could find", () => {
    expect(urgentBadge("order_state_unverified").label).toBe(URGENT_UNVERIFIED_LABEL);
  });

  /** An unrecognised or absent outcome renders the ordinary badge, never a crash. */
  it.each([null, "something_new"])("falls back safely for %j", (outcome) => {
    expect(urgentBadge(outcome).label).toBe(URGENT_LABEL);
  });

  it("is what the component renders, rather than a second opinion", () => {
    const element = UrgentFlag({ urgent: true, outcome: "unanswered_before_shipping" }) as {
      props: { title: string; children: unknown };
    };
    expect(element.props.title).toBe(URGENT_UNANSWERED_DESCRIPTION);
    expect(element.props.children).toBe(URGENT_LABEL);
  });
});

describe("the rule does not fire", () => {
  /**
   * REQUIRED CASE: no matching order, AND the customer is not asking us to
   * change or stop one.
   *
   * `orderChangeIntent: false` is what makes this "no matching order" rather
   * than `order_state_unverified` — see the pair of tests below, which cover
   * the same absence when the customer IS asking us to stop the order.
   */
  /**
   * ------------------------------------------------------------------------
   * THE CASE AREA IS THE CONDITION, AND THIS IS THE TEST THAT SAYS SO
   * ------------------------------------------------------------------------
   * FOUND ON SCREEN: the Amazon tab showed a conversation tagged "Admin
   * related issues" wearing the URGENT badge, because urgency used to be
   * decided by the window alone and asked nothing about what the customer
   * wrote — and on Amazon the thread is keyed by the order number, so almost
   * every conversation resolves to a real, often-unshipped order.
   *
   * CST's rule is "it needs to be order-before-shipping category AND it's not
   * replied yet", so any other case area is refused however open the window is.
   */
  it("when the case area is not before-shipping, whatever the order is doing", () => {
    const input = eligible({ beforeShippingCategory: false });
    expect(beforeShipmentEligibility(input)).toBe("not_an_order_change");
    expect(isBeforeShipmentUrgent(input)).toBe(false);
  });

  /** Not even when the order is verifiably still sitting in the warehouse. */
  it.each([
    ["an undispatched order", { shipment: { dispatched: false } }],
    ["a brand-new message", { ageHours: 0 }],
    ["an explicit order-change request", { orderChangeIntent: true }],
  ])("refuses another case area with %s", (_label, override) => {
    expect(
      beforeShipmentEligibility(eligible({ beforeShippingCategory: false, ...override })),
    ).toBe("not_an_order_change");
  });

  /**
   * ------------------------------------------------------------------------
   * THE ORDER WE CANNOT SEE YET
   * ------------------------------------------------------------------------
   * Found live on 2026-09-23: eBay conversation 48230 (`david_tuck_ward`) asked
   * us to switch carrier or cancel two items that had not shipped, and was not
   * flagged. Both of its orders existed and were undispatched; CST simply could
   * not tell they were his, because `customers.customer_info.ebay_buyer_id` is
   * the only link and it is populated on 0% of eBay orders under 6 hours old,
   * 14% by 12 hours, and 100% only after 12-24. eBay dispatches at a median of
   * 12.6 hours, so the rule was blind for most of the window it protects.
   */
  it("fires when there is no order key at all and the customer asked us to stop it", () => {
    for (const orderNumber of [null, "", "   "]) {
      expect(
        beforeShipmentEligibility(
          eligible({ orderNumber, shipment: null, orderChangeIntent: true }),
        ),
        JSON.stringify(orderNumber),
      ).toBe("order_state_unverified");
    }
  });

  /**
   * A REAL KEY THAT FAILED TO RESOLVE IS STILL URGENT NOW, and this test
   * asserted the opposite until CST's rule arrived.
   *
   * It used to return `no_matching_order` and drop out, on the reasoning that
   * "looked it up and got nothing back" is ambiguous — it is also what a source
   * outage looks like. That reasoning applied when the ORDER decided urgency.
   * The case area decides it now, and the order is only a veto: an outage means
   * no veto was established, not that the customer stopped waiting.
   *
   * It is reported as `unanswered_before_shipping`, so the badge claims nothing
   * about the parcel — see the badge tests above.
   */
  it("still fires when a real order key failed to resolve", () => {
    expect(
      beforeShipmentEligibility(
        eligible({ orderNumber: "LED65289", shipment: null, orderChangeIntent: false }),
      ),
    ).toBe("unanswered_before_shipping");
  });

  it("treats an unverified order as urgent, but not as a verified one", () => {
    const input = eligible({ orderNumber: null, shipment: null, orderChangeIntent: true });
    expect(isBeforeShipmentUrgent(input)).toBe(true);
    expect(urgentOrderIsVerified(beforeShipmentEligibility(input))).toBe(false);
    expect(urgentOrderIsVerified("eligible")).toBe(true);
  });

  /**
   * THE OLD KEYWORD BUG MUST STAY DEAD. A dispatched order has a FINDABLE
   * order, so it can never reach the unverified branch however urgently the
   * customer words it — "please cancel" on a parcel delivered a fortnight ago
   * is a return, not a cancellation.
   */
  it("never resurrects a dispatched order, whatever the customer asked", () => {
    expect(
      beforeShipmentEligibility(
        eligible({ shipment: { dispatched: true }, orderChangeIntent: true }),
      ),
    ).toBe("already_dispatched");
  });

  /**
   * The guarantees of condition 1 still bind first, and still bind hardest —
   * they sit above the case-area rule, so no category can reach past them.
   *
   * THE TWO AGE ROWS ARE GONE from this table on purpose. They asserted
   * `too_old`, and there is no longer any age at which this rule gives up: that
   * is the whole of what CST asked for. The ages are covered positively in
   * "ignores the clock at %ih" above.
   */
  it.each([
    ["a platform notice", { platformNotice: true }, "not_a_customer_conversation"],
    ["a filtered placement", { inboxPlacement: "filtered" as const }, "not_a_customer_conversation"],
    ["our own message last", { lastDirection: "outbound" as const }, "no_customer_action_needed"],
    ["a thread we closed out", { staffClosedTheOrder: true }, "thread_resolved"],
    ["a customer sign-off", { customerAcknowledgedOnly: true }, "thread_resolved"],
  ])("still refuses %s even with no order and a cancellation", (_label, override, expected) => {
    expect(
      beforeShipmentEligibility(
        eligible({ orderNumber: null, shipment: null, orderChangeIntent: true, ...override }),
      ),
    ).toBe(expected);
  });

  /** REQUIRED CASE: already dispatched. */
  it("when the order has already shipped", () => {
    expect(beforeShipmentEligibility(eligible({ shipment: { dispatched: true } }))).toBe(
      "already_dispatched",
    );
  });

  /** REQUIRED CASE: a promotional or system email mentioning cancellation. */
  it("for a platform or system notice, whatever it says", () => {
    expect(beforeShipmentEligibility(eligible({ platformNotice: true }))).toBe(
      "not_a_customer_conversation",
    );
    for (const placement of ["filtered", "outbound_only"] as const) {
      expect(
        beforeShipmentEligibility(eligible({ inboxPlacement: placement })),
        placement,
      ).toBe("not_a_customer_conversation");
    }
  });

  /**
   * ------------------------------------------------------------------------
   * THE AMAZON "NEVER REPLIED AT ALL" RESTRICTION IS GONE, EVERYWHERE
   * ------------------------------------------------------------------------
   * This test asserted `already_replied` on Amazon: a thread we had answered
   * was treated as a conversation in progress rather than an untouched request.
   *
   * CST's rule replaces it. "Not replied yet" now means the message ON SCREEN
   * is unanswered, and a thread we replied in last week still has nobody
   * answering the one the customer sent today. What stops those threads is a
   * reply or a sign-off, which is what `thread_resolved` is for — and that is
   * the condition doing the real work, as `piotr.woss-uk` showed.
   *
   * The matching predicate was removed from the sweep SQL in the same change,
   * so the query and the rule still agree.
   */
  it.each(["amazon", "ebay", "shopify", "bandq", "temu"])(
    "counts a thread we replied in, on %s",
    (marketplace) => {
      expect(beforeShipmentEligibility(eligible({ marketplace, everReplied: true }))).toBe(
        "eligible",
      );
    },
  );

  /** The constant survives for the sweep's own use; it no longer gates the rule. */
  it("the scoped marketplace is stated once", () => {
    expect(BEFORE_SHIPMENT_MARKETPLACE).toBe("amazon");
  });

  it("when we answered last, so nobody is waiting on us", () => {
    expect(beforeShipmentEligibility(eligible({ lastDirection: "outbound" }))).toBe(
      "no_customer_action_needed",
    );
    expect(beforeShipmentEligibility(eligible({ lastDirection: null }))).toBe(
      "no_customer_action_needed",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * THE RECENCY WINDOW NO LONGER GATES THE RULE
 *
 * This block asserted that 24h and 48h counted and anything older did not. CST
 * removed the window outright — "forget about the 48h" — so the assertions are
 * inverted rather than deleted: an age that used to drop a conversation must
 * now be proved NOT to.
 *
 * `BEFORE_SHIPMENT_RECENCY_HOURS` survives because the response SLA is still
 * expressed against it, and because the sweep's own comments refer to what it
 * used to bound. It decides nothing here any more, and that is what the last
 * test pins.
 * ------------------------------------------------------------------------- */

describe("every before-shipping query counts, at every age", () => {
  it("includes everything from brand new to a month old", () => {
    for (const ageHours of [0, 1, 24, 47, 48, 48.5, 72, 100, 24 * 30]) {
      expect(beforeShipmentEligibility(eligible({ ageHours })), `${ageHours}h`).toBe("eligible");
    }
  });

  /** An unknown arrival time is no longer a reason to give up on the customer. */
  it("keeps a conversation whose arrival time is unknown", () => {
    expect(beforeShipmentEligibility(eligible({ ageHours: null }))).toBe("eligible");
  });

  it("still states the number, which the response SLA is measured against", () => {
    expect(BEFORE_SHIPMENT_RECENCY_HOURS).toBe(48);
  });

  /**
   * THE RULE MUST NOT READ IT AGAIN. A future edit that reintroduces an age
   * comparison would silently restore the behaviour CST asked us to remove, so
   * this asserts the two ages either side of the old boundary agree.
   */
  it("gives the same answer either side of the old boundary", () => {
    expect(beforeShipmentEligibility(eligible({ ageHours: 47 }))).toBe(
      beforeShipmentEligibility(eligible({ ageHours: 49 })),
    );
  });
});

/* ------------------------------------------------------------------------- *
 * RESOLVED THREADS — our own reply said it was dispatched or cancelled
 * ------------------------------------------------------------------------- */

describe("a thread CST already closed is not urgent", () => {
  it("drops it when our last reply said the order went out or was stopped", () => {
    expect(beforeShipmentEligibility(eligible({ staffClosedTheOrder: true }))).toBe(
      "thread_resolved",
    );
  });

  it.each([
    "Your order has been dispatched this morning.",
    "This has now been despatched.",
    "We have cancelled your order as requested.",
    "Your order has been cancelled.",
    "The refund has been processed.",
    "Shipment is done, tracking number is AB123456789GB.",
    "It is on its way to you.",
  ])("reads %j as closing the order", (text) => {
    expect(staffClosedTheOrder(text)).toBe(true);
  });

  /**
   * THE SENTENCE THIS EXISTS FOR. "Your order has NOT been dispatched yet" is
   * the commonest reply in a before-shipment thread, and a phrase match would
   * read it as the exact opposite — closing the very conversations the feature
   * is meant to raise.
   */
  it.each([
    "Your order has not been dispatched yet.",
    "It has not been shipped so far.",
    "Your order has not been cancelled.",
    "Would you like us to cancel it?",
    "Shall I check whether it has been dispatched?",
    "Our dispatch team will look at this today.",
    "Please see our cancellation policy for details.",
    "",
  ])("does not read %j as closing the order", (text) => {
    expect(staffClosedTheOrder(text)).toBe(false);
  });

  it("reads our reply and never the customer's message", () => {
    const source = read("lib", "knowledge", "staff-resolution.ts");
    expect(source).toContain("outboundText");
  });
});

/* ------------------------------------------------------------------------- *
 * OLD CANCELLATION TEXT DOES NOT KEEP A THREAD URGENT
 * ------------------------------------------------------------------------- */

describe("old text cannot keep a conversation urgent", () => {
  /**
   * THE DEFECT THIS RULE REPLACED. Urgency used to be read across every customer
   * message in the thread, so a cancellation asked for months ago kept its
   * conversation red forever — including after the parcel was delivered.
   *
   * There is now no path from any message, old or new, to the flag. What
   * decides is the order's CURRENT state and the thread's CURRENT state, so an
   * answered thread, a shipped order or an old one each drop out on their own.
   */
  it("has no text input that an old message could reach", () => {
    const shipped = beforeShipmentEligibility(
      eligible({ shipment: { dispatched: true }, ageHours: 24 * 90 }),
    );
    expect(shipped).not.toBe("eligible");

    // The same conversation, answered: still not urgent, whatever was said.
    expect(beforeShipmentEligibility(eligible({ lastDirection: "outbound" }))).not.toBe(
      "eligible",
    );
  });

  it("evaluates the newest inbound message only, never the thread's history", () => {
    const repository = read("lib", "repositories", "conversation-repository.ts");
    // The clock and the closing signal both read ONE message, with LIMIT 1.
    expect(repository).toContain("LATEST_INBOUND_INSTANT");
    expect(repository).toContain("LATEST_OUTBOUND_TEXT");
    // The sweep does not feed thread-wide text into the urgency decision.
    expect(repository).toContain("beforeShipmentEligibility");
  });
});

/* ------------------------------------------------------------------------- *
 * ORDERING — URGENT ABOVE NORMAL, ACROSS PAGINATION
 * ------------------------------------------------------------------------- */

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    marketplace: "ebay",
    sub_source_id: 7,
    counterparty_ref: "buyer-a",
    listing_item_ref: "listing-1",
    workflow_state: "received",
    needs_context: false,
    inbox_visibility: "reply_inbox",
    first_source_ts: "2026-09-20 10:00:00",
    last_source_ts: "2026-09-20 10:00:00",
    message_count: 1,
    inbound_count: 1,
    last_direction: "inbound",
    inbound_texts: ["Can I change the delivery address?"],
    latest_inbound_text: "Please cancel my order.",
    ...overrides,
  };
}

/**
 * A sweep candidate: a conversation row plus its verified order.
 *
 * The order number is SYNTHETIC and shaped like eBay's only in that it is a
 * string. A real one used to sit here; `no-customer-data.test.ts` is right that it
 * should not, and nothing in this file depends on the format.
 */
function candidate(overrides: Record<string, unknown> = {}) {
  return row({
    order_number: "ORDER-SWEEP-1",
    sla_starts_at: new Date("2026-09-22T08:00:00Z"),
    latest_outbound_text: null,
    ever_replied: false,
    ...overrides,
  });
}

const NOW = new Date("2026-09-22T10:00:00Z");
const isSweep = (sql: string) => sql.includes("context_snapshots");

function fake(page: unknown[][], sweep: unknown[][] = []) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let p = 0;
  let s = 0;
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows: isSweep(config.text) ? (sweep[s++] ?? []) : (page[p++] ?? []) };
    },
  };
  return { calls, client };
}

/** A source that reports the given orders as dispatched or not. */
function fakeSource(dispatched: boolean) {
  return {
    query: async (config: { values?: readonly unknown[] }) => {
      const numbers = (config.values?.[0] ?? []) as string[];
      return {
        rows: numbers.map((orderNumber) => ({
          sub_source_id: 104,
          order_number: orderNumber,
          order_status: "Inprogress",
          shipped_time: dispatched ? "2026-09-21 09:00:00" : null,
          has_completed_shipment: dispatched,
        })),
      };
    },
  };
}

/* ------------------------------------------------------------------------- *
 * THE SOURCE IS ONLY ASKED ABOUT ORDERS THAT COULD CHANGE THE ANSWER
 * ------------------------------------------------------------------------- */

describe("the dispatch lookup is kept off the hot path", () => {
  /** A source that records whether it was asked anything at all. */
  function countingSource(dispatched: boolean) {
    const asked: string[][] = [];
    return {
      asked,
      source: {
        query: async (config: { values?: readonly unknown[] }) => {
          const numbers = (config.values?.[0] ?? []) as string[];
          asked.push(numbers);
          return {
            rows: numbers.map((orderNumber) => ({
              sub_source_id: 104,
              order_number: orderNumber,
              order_status: "Inprogress",
              shipped_time: dispatched ? "2026-09-21 09:00:00" : null,
              has_completed_shipment: dispatched,
            })),
          };
        },
      },
    };
  }

  /**
   * THE COMMON CASE, AND IT COSTS NOTHING.
   *
   * `cst-source-ro` is a pool to a database shared with unrelated production
   * systems, and it draws on the same 25-connection role budget as everything
   * else. A candidate filed under another case area returns
   * `not_an_order_change` before `shipment` is read, so looking its order up is
   * a round trip for an answer nobody reads — and where NO candidate is a
   * before-shipping case, the source is never dialled at all.
   */
  it("does not touch the source when no candidate is a before-shipping case", async () => {
    const latest = "Where is my parcel?";
    const { asked, source } = countingSource(false);
    const { client } = fake(
      [[row({ id: "ordinary" })]],
      [
        [
          candidate({ id: "c1", inbound_texts: [latest], latest_inbound_text: latest }),
          candidate({ id: "c2", inbound_texts: [latest], latest_inbound_text: latest }),
        ],
      ],
    );
    const page = await listConversations(client, { marketplace: "amazon", source, now: NOW });
    expect(asked).toEqual([]);
    expect(page.urgentCount).toBe(0);
  });

  /** And when it does ask, it asks only about the rows that need the veto. */
  it("asks only about the before-shipping candidates", async () => {
    const other = "Is this light dimmable?";
    const { asked, source } = countingSource(false);
    const { client } = fake(
      [[]],
      [
        [
          candidate({
            id: "relevant",
            order_number: "ORDER-RELEVANT",
            inbound_texts: ["Please cancel my order."],
            latest_inbound_text: "Please cancel my order.",
          }),
          candidate({
            id: "irrelevant",
            order_number: "ORDER-IRRELEVANT",
            inbound_texts: [other],
            latest_inbound_text: other,
          }),
        ],
      ],
    );
    await listConversations(client, { marketplace: "amazon", source, now: NOW });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(["ORDER-RELEVANT"]);
  });

  /** The veto still works for the rows it does ask about. */
  it("still vetoes a dispatched before-shipping order", async () => {
    const { asked, source } = countingSource(true);
    const { client } = fake([[row({ id: "ordinary" })]], [[candidate({ id: "shipped" })]]);
    const page = await listConversations(client, { marketplace: "amazon", source, now: NOW });
    expect(asked).toHaveLength(1);
    expect(page.items.map((item) => item.id)).toEqual(["ordinary"]);
    expect(page.urgentCount).toBe(0);
  });
});

describe("an urgent conversation is ordered above the ordinary stream", () => {
  it("puts an unshipped-order conversation above newer ordinary ones", async () => {
    const { client } = fake(
      [
        [
          row({ id: "new-1", last_source_ts: "2026-09-22 09:00:00" }),
          row({ id: "new-2", last_source_ts: "2026-09-22 08:00:00" }),
        ],
      ],
      [[candidate({ id: "unshipped", last_source_ts: "2026-09-20 10:00:00" })]],
    );
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    expect(page.items.map((item) => item.id)).toEqual(["unshipped", "new-1", "new-2"]);
    expect(page.items[0]!.urgent).toBe(true);
    expect(page.items[0]!.beforeShipmentOutcome).toBe("eligible");
    // Re-tagged with the case area, from the classifier's own vocabulary.
    expect(page.items[0]!.category).toBe(BEFORE_SHIPPING_CATEGORY);
    // And the SLA clock start travels with it.
    expect(page.items[0]!.slaStartsAt).toBe("2026-09-22T08:00:00.000Z");
    expect(page.urgentCount).toBe(1);
  });

  /**
   * ------------------------------------------------------------------------
   * URGENCY NOW FOLLOWS THE CASE AREA, AND THIS IS THE TABLE THAT PROVES IT
   * ------------------------------------------------------------------------
   * THIS TABLE ASSERTED THE OPPOSITE FOR THE BOTTOM FOUR ROWS. Every row here
   * is an unanswered customer on a real, unshipped order, and that used to be
   * enough on its own: the window was open, so a delivery chase and a pre-sales
   * question wore the same red badge as a cancellation.
   *
   * CST found that on the Amazon tab — a row tagged "Admin related issues"
   * showing URGENT — and the rule is now "it needs to be order-before-shipping
   * category AND it's not replied yet". So urgency and the tag agree by
   * construction: both follow the case area.
   *
   * Run through `listConversations` rather than the pure function, so these
   * assert the vocabulary the system actually uses rather than a boolean a
   * fixture set.
   */
  it.each([
    ["Please cancel my order.", true],
    ["Stop dispatch, I ordered the wrong size.", true],
    ["Can I change the delivery address before it goes out?", true],
    // Ordinary traffic on an unshipped order. Still waiting, still ranked by
    // the SLA timer and the priority ribbon — but no longer URGENT.
    ["Where is my parcel?", false],
    ["Is this light dimmable?", false],
    ["The shade arrived cracked.", false],
    ["Can I have a VAT invoice?", false],
  ])("is urgent for %j only when it is the before-shipping case area (%s)", async (latest, urgent) => {
    const { client } = fake([[]], [[candidate({ id: "c1", inbound_texts: [latest], latest_inbound_text: latest })]]);
    const page = await listConversations(client, {
      marketplace: "amazon",
      source: fakeSource(false),
      now: NOW,
    });
    // A row the rule refuses rejoins the ordinary stream, so it may not be
    // first -- or present at all when the page is empty.
    const item = page.items.find((candidate) => candidate.id === "c1") ?? null;
    expect(item?.urgent ?? false, latest).toBe(urgent);
    expect(page.urgentCount, latest).toBe(urgent ? 1 : 0);
  });

  /**
   * THE AMAZON OVER-TAGGING DEFECT, PINNED — AND NOW THE OVER-FLAGGING ONE TOO.
   *
   * A pre-sales question on an unshipped order must not be filed as an order
   * change just because the parcel has not left the warehouse. It keeps the
   * category the phrase table read, and it is no longer URGENT either: that is
   * the second half CST added, having found exactly this row wearing the badge
   * on the Amazon tab.
   */
  it("neither files nor flags a pre-sales question as an order change", async () => {
    const latest =
      "This link shows white ceiling fittings. Is there an option for a dome cone the same colour as the shade?";
    const { client } = fake([[]], [[candidate({ id: "c1", inbound_texts: [latest], latest_inbound_text: latest })]]);
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    const item = page.items.find((candidate) => candidate.id === "c1") ?? null;
    expect(item?.urgent ?? false).toBe(false);
    expect(item?.category).not.toBe(BEFORE_SHIPPING_CATEGORY);
    expect(page.urgentCount).toBe(0);
  });

  /**
   * OLD TEXT CANNOT DECIDE THE TAG. The thread's history contains a
   * cancellation; the newest message does not — and the classifier reads the
   * thread in order, so the conversation is not filed as an order change on a
   * request that is no longer being made, and is therefore not urgent either.
   */
  it("reads the newest message only when deciding the tag", async () => {
    const { client } = fake(
      [[]],
      [
        [
          candidate({
            id: "c1",
            inbound_texts: ["Please cancel my order.", "Actually, where is my parcel?"],
            latest_inbound_text: "Actually, where is my parcel?",
          }),
        ],
      ],
    );
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    const item = page.items.find((candidate) => candidate.id === "c1") ?? null;
    expect(item?.category).not.toBe(BEFORE_SHIPPING_CATEGORY);
  });

  /** REQUIRED CASE: a dispatched order is not lifted. */
  it("does not lift a candidate whose order has already shipped", async () => {
    const { client } = fake([[row({ id: "ordinary" })]], [[candidate({ id: "shipped" })]]);
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(true),
      now: NOW,
    });
    expect(page.items.map((item) => item.id)).toEqual(["ordinary"]);
    expect(page.urgentCount).toBe(0);
  });

  /**
   * ------------------------------------------------------------------------
   * "NO SOURCE, NO FLAG" NO LONGER HOLDS FOR A BEFORE-SHIPPING CASE AREA
   * ------------------------------------------------------------------------
   * This asserted the opposite until CST's rule arrived, and the inversion is
   * deliberate: "if order details are available and it is not dispatched it is
   * order-before-shipping; if it is dispatched it is not urgent." The order
   * details are a VETO, so their absence cannot be the thing that suppresses a
   * waiting customer — it only means no claim is made about the parcel, which
   * is exactly what `unanswered_before_shipping` says and why its badge borrows
   * none of `URGENT_DESCRIPTION`'s confidence.
   *
   * THE COST, STATED: a source outage now lights up every unanswered
   * before-shipping thread rather than none of them. That is the safer
   * direction — a customer nobody answered is real whether or not the source is
   * reachable — but it is a change in blast radius, not just in wording.
   *
   * The dispatch state still decides everything it can decide. See the test
   * above: a candidate whose order IS readable and HAS shipped is not lifted.
   */
  it("still flags a before-shipping query when the dispatch state cannot be read", async () => {
    const { client } = fake([[row({ id: "ordinary" })]], [[candidate({ id: "unknown" })]]);
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: null,
      now: NOW,
    });
    expect(page.items.map((item) => item.id)).toEqual(["unknown", "ordinary"]);
    expect(page.items[0]!.urgent).toBe(true);
    // And it says the order was never checked, rather than implying it was.
    expect(page.items[0]!.beforeShipmentOutcome).toBe("unanswered_before_shipping");
    expect(page.urgentCount).toBe(1);
  });

  /**
   * The other half of the same guarantee, and the one that matters more: a
   * conversation whose case area is NOT before-shipping still gets nothing
   * without a source, because that path is the pure order-state rule and an
   * unknown dispatch state must never read as "not dispatched".
   */
  it("still flags nothing without a source when it is not a before-shipping case", async () => {
    const latest = "Where is my parcel?";
    const { client } = fake(
      [[row({ id: "ordinary" })]],
      [[candidate({ id: "unknown", inbound_texts: [latest], latest_inbound_text: latest })]],
    );
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: null,
      now: NOW,
    });
    expect(page.items.map((item) => item.id)).toEqual(["ordinary"]);
    expect(page.urgentCount).toBe(0);
  });

  /** The sweep reads the whole marketplace, not the loaded page. */
  it("scans past the current page", async () => {
    const { calls, client } = fake([[row()]]);
    await listConversations(client, {
      marketplace: "ebay",
      limit: 2,
      offset: 40,
      source: fakeSource(false),
      now: NOW,
    });
    const sweep = calls.find((call) => isSweep(call.text))!;
    expect(sweep.text).not.toContain("OFFSET");
    expect(sweep.values).not.toContain(40);
  });

  /**
   * THE WINDOW IS NO LONGER A PREDICATE IN THE SWEEP, and this pins that.
   *
   * It used to be passed as a parameter and compared against the newest inbound
   * instant, so an unanswered before-shipping query stopped being a CANDIDATE
   * after 48 hours — it could not be ranked because it was never transferred.
   * The constant still exists and still bounds the ORDER-STATE path inside
   * `beforeShipmentEligibility`; it must not come back here.
   */
  it("no longer bounds the candidate set by age", async () => {
    const { calls, client } = fake([[row()]]);
    await listConversations(client, { marketplace: "ebay", source: fakeSource(false), now: NOW });
    const sweep = calls.find((call) => isSweep(call.text))!;
    expect(sweep.values).not.toContain(BEFORE_SHIPMENT_RECENCY_HOURS);
    expect(sweep.text).not.toContain("make_interval");
  });

  /**
   * THE CASE FROM THE INBOX, END TO END.
   *
   * eBay `piotr.woss-uk`: an order-change thread CST replied to, which the
   * customer closed with "Great Thanks". It sat URGENT with the SLA 14 days
   * overdue. Run through `listConversations` rather than the pure function, so
   * this asserts what the list actually produces.
   */
  it("does not flag a thread the customer closed with a thank-you", async () => {
    const { client } = fake(
      [[row({ id: "ordinary" })]],
      [
        [
          candidate({
            id: "signed-off",
            inbound_texts: ["Please cancel my order.", "Great Thanks"],
            latest_inbound_text: "Great Thanks",
            latest_outbound_text: "We understand you would like to keep the order as it is.",
            ever_replied: true,
          }),
        ],
      ],
    );
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    expect(page.items.map((item) => item.id)).toEqual(["ordinary"]);
    expect(page.urgentCount).toBe(0);
  });

  it("holds the urgent ids out of the ordinary stream, and serves the block once", async () => {
    const sweep = [[candidate({ id: "urgent-1" })]];
    const first = fake([[row({ id: "ordinary" })]], sweep);
    await listConversations(first.client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    const pageCall = first.calls.find((call) => !isSweep(call.text))!;
    expect(pageCall.values![4]).toEqual(["urgent-1"]);

    const second = await listConversations(
      fake([[row({ id: "older" })]], sweep).client,
      { marketplace: "ebay", offset: 100, source: fakeSource(false), now: NOW },
    );
    expect(second.items.map((item) => item.id)).toEqual(["older"]);
    expect(second.urgentCount).toBe(0);
  });
});

/* ------------------------------------------------------------------------- *
 * THE RED INDICATOR AND THE SLA TIMER
 * ------------------------------------------------------------------------- */

describe("the urgent indicator", () => {
  const classNameOf = (element: unknown) =>
    String((element as { props: { className: unknown } }).props.className);

  it("renders a red badge for an urgent conversation", () => {
    const element = UrgentFlag({ urgent: true });
    expect(element).not.toBeNull();
    expect(classNameOf(element)).toMatch(/\bbg-red-\d{3}\b/);
    expect(classNameOf(element)).toContain("text-white");
  });

  it("renders nothing for an ordinary conversation", () => {
    expect(UrgentFlag({ urgent: false })).toBeNull();
  });

  it("is not interactive", () => {
    expect(read("components", "urgent-flag.tsx")).not.toMatch(
      /onClick|onSubmit|<button|<a\s|href=|<form/,
    );
  });
});

describe("the response SLA timer", () => {
  const received = new Date("2026-09-22T09:00:00Z");

  /**
   * THE APPROVED FIGURE, PINNED.
   *
   * This test previously asserted the constant was NULL — the blocker that
   * stood while no duration had been agreed. CST has now approved 24 hours, so
   * the pin moves to that exact figure rather than being deleted: a number this
   * one drifts to silently is the invented target the original blocker existed
   * to prevent, and "some number is set" would not catch it.
   */
  it("carries the approved duration and no other", () => {
    expect(RESPONSE_SLA_MINUTES).toBe(24 * 60);
  });

  /**
   * THE REASON 24 AND NOT 48. The urgent sweep drops a conversation once the
   * newest customer message passes `BEFORE_SHIPMENT_RECENCY_HOURS`, and the
   * panel renders on urgent rows only — so a target equal to that window would
   * put the deadline and the row's disappearance on the same instant and make
   * CRITICAL / ESCALATE unreachable. The gap is what makes a breach visible.
   */
  it("expires strictly inside the window that keeps the row on screen", () => {
    expect(RESPONSE_SLA_MINUTES).not.toBeNull();
    expect(RESPONSE_SLA_MINUTES!).toBeLessThan(BEFORE_SHIPMENT_RECENCY_HOURS * 60);
  });

  /** The unset state is still reachable, and still says so rather than counting down. */
  it("says so rather than showing a countdown, when no duration is set", () => {
    const status = responseSlaStatus({
      targetMinutes: null,
      receivedAt: received,
      now: NOW,
    });
    expect(status.state).toBe("not_configured");
    expect(isSlaCritical(status)).toBe(false);
  });

  /**
   * The approved figure exercised end to end: a message 25 hours old is one
   * hour past a 24-hour promise, and the row is still inside the 48-hour urgent
   * window, so this is the state an agent will actually meet.
   */
  it("goes overdue on the approved duration, while the row is still urgent", () => {
    const status = responseSlaStatus({
      targetMinutes: RESPONSE_SLA_MINUTES,
      receivedAt: received,
      now: new Date(received.getTime() + 25 * 60 * 60_000),
    });
    expect(status.state).toBe("expired");
    expect(status.state === "expired" && status.minutesOver).toBe(60);
    expect(isSlaCritical(status)).toBe(true);
  });

  it("reports an unestablished arrival time rather than guessing one", () => {
    const status = responseSlaStatus({ targetMinutes: 30, receivedAt: null, now: NOW });
    expect(status.state).toBe("unknown_received_time");
    expect(isSlaCritical(status)).toBe(false);
  });

  /** Minutes-based, with an explicit target so the unit is proved today. */
  it("counts down in minutes", () => {
    const status = responseSlaStatus({
      targetMinutes: 90,
      receivedAt: received,
      now: new Date("2026-09-22T09:30:00Z"),
    });
    expect(status).toEqual({
      state: "within",
      targetMinutes: 90,
      dueAt: new Date("2026-09-22T10:30:00Z"),
      minutesLeft: 60,
    });
    expect(isSlaCritical(status)).toBe(false);
  });

  /** REQUIRED CASE: the overdue state. */
  it("expires, and reports how far overdue", () => {
    const status = responseSlaStatus({
      targetMinutes: 30,
      receivedAt: received,
      now: new Date("2026-09-22T10:38:00Z"),
    });
    expect(status.state).toBe("expired");
    expect(status.state === "expired" && status.minutesOver).toBe(68);
    expect(isSlaCritical(status)).toBe(true);
  });

  /** Landing exactly on the deadline is met, not missed. */
  it("treats the deadline moment itself as met", () => {
    const status = responseSlaStatus({
      targetMinutes: 60,
      receivedAt: received,
      now: new Date("2026-09-22T10:00:00Z"),
    });
    expect(status.state).toBe("within");
    expect(isSlaCritical(status)).toBe(false);
  });

  it("states the due time in SL time, always labelled", () => {
    const rendered = formatSlaDueAt(new Date("2026-09-22T10:30:00Z"));
    // 10:30 UTC is 16:00 in Asia/Colombo (UTC+5:30).
    expect(rendered).toContain("16:00");
    expect(rendered).toContain("SL time");
  });

  it("keeps minutes visible at every scale", () => {
    expect(formatDuration(8)).toBe("8m");
    expect(formatDuration(90)).toBe("1h 30m");
    expect(formatDuration(0)).toBe("0m");
  });

  /* --- the panel --- */

  const panel = (status: Parameters<typeof ResponseSlaTimer>[0]["status"]) =>
    ResponseSlaTimer({ status }) as {
      props: { className: string; children: unknown[]; "aria-label": string };
    };

  it("renders the heading and the not-configured line today", () => {
    const element = panel({ state: "not_configured" });
    expect(element.props["aria-label"]).toBe("Response SLA");
    expect(JSON.stringify(element.props.children)).toContain(SLA_NOT_CONFIGURED_TEXT);
    // An absence is never red.
    expect(element.props.className).not.toMatch(/\bborder-red-|\bbg-red-/);
  });

  it("goes red and says CRITICAL / ESCALATE with the overdue duration", () => {
    const element = panel({
      state: "expired",
      targetMinutes: 30,
      dueAt: new Date("2026-09-22T09:30:00Z"),
      minutesOver: 68,
    });
    expect(element.props.className).toMatch(/\bborder-red-\d{3}\b/);
    const rendered = JSON.stringify(element.props.children);
    expect(rendered).toContain("Critical");
    expect(rendered).toContain("Escalate");
    expect(rendered).toContain("1h 8m");
    expect(rendered).toContain("Time expired");
  });

  it("shows the due time and time left while within the target", () => {
    const rendered = JSON.stringify(
      panel({
        state: "within",
        targetMinutes: 30,
        dueAt: new Date("2026-09-22T10:30:00Z"),
        minutesLeft: 12,
      }).props.children,
    );
    expect(rendered).toContain("Due");
    expect(rendered).toContain("Time left");
    expect(rendered).toContain("12m");
  });

  it("reads no clock of its own", () => {
    const source = read("components", "response-sla-timer.tsx");
    expect(source).not.toMatch(/Date\.now|new Date\(/);
  });

  /* --- where the clock started --- */

  const panelWithSource = (
    status: Parameters<typeof ResponseSlaTimer>[0]["status"],
    startSource: Parameters<typeof ResponseSlaTimer>[0]["startSource"],
  ) =>
    ResponseSlaTimer({ status, startSource }) as {
      props: { className: string; children: unknown[] };
    };

  const within = {
    state: "within",
    targetMinutes: 24 * 60,
    dueAt: new Date("2026-09-23T09:00:00Z"),
    minutesLeft: 120,
  } as const;

  /**
   * THE FALLBACK IS STATED, NOT HIDDEN. `source_ts_utc` is empty on every
   * inbound message today, so every live countdown is measured from ingest —
   * a fact a reader would otherwise assume the other way.
   */
  it("says when the countdown was measured from ingest", () => {
    const rendered = JSON.stringify(panelWithSource(within, "ingest").props.children);
    expect(rendered).toContain(SLA_STARTED_AT_INGEST_TEXT);
  });

  it("says nothing extra when the clock started at the customer's own message", () => {
    const rendered = JSON.stringify(panelWithSource(within, "customer_message").props.children);
    expect(rendered).not.toContain(SLA_STARTED_AT_INGEST_TEXT);
  });

  /** An unknown provenance is not a claim that it was the good one. */
  it("says nothing extra when the provenance was never established", () => {
    const rendered = JSON.stringify(panelWithSource(within, null).props.children);
    expect(rendered).not.toContain(SLA_STARTED_AT_INGEST_TEXT);
  });

  /** A caveat on a measurement is not a breach, and must not be coloured as one. */
  it("does not colour the panel for an ingest-measured clock", () => {
    expect(panelWithSource(within, "ingest").props.className).not.toMatch(
      /\bborder-red-|\bbg-red-/,
    );
  });

  /**
   * There is no deadline for the note to qualify, so it does not appear — a
   * provenance line under "no target exists" is noise about a measurement
   * nobody is making.
   */
  it("omits the note where there is no running clock", () => {
    const rendered = JSON.stringify(
      panelWithSource({ state: "not_configured" }, "ingest").props.children,
    );
    expect(rendered).not.toContain(SLA_STARTED_AT_INGEST_TEXT);
  });
});

/* ------------------------------------------------------------------------- *
 * THE COUNTDOWN ADVANCES WITHOUT A RELOAD
 * ------------------------------------------------------------------------- */

describe("the SLA clock ticks", () => {
  /*
   * SOURCE ASSERTIONS, because vitest runs with `environment: "node"` — there
   * is no DOM to mount a hook into, and adding one for a single interval would
   * be a larger change than the interval. These pin the wiring that a DOM test
   * would exercise: a clock that advances, in ONE place, on a stated cadence.
   */
  const source = read("components", "inbox-list.tsx");

  it("re-reads the clock on an interval rather than only on render", () => {
    expect(source).toMatch(/setInterval\(\s*\(\)\s*=>\s*setNow\(new Date\(\)\)/);
    expect(source).toMatch(/clearInterval\(id\)/);
  });

  it("ticks no faster than the smallest unit the panel prints", () => {
    // Every figure is whole minutes, so a sub-minute redraw changes nothing a
    // reader can see. 30s bounds the staleness of that unit to half of it.
    expect(source).toMatch(/const SLA_TICK_MS = 30_000;/);
  });

  it("keeps one clock for the whole list", () => {
    // A `now` per row would let two panels rendered microseconds apart
    // disagree about how much time is left.
    expect(source.match(/useNow\(/g)).toHaveLength(2); // the definition and its one call
  });
});

/* ------------------------------------------------------------------------- *
 * IT PRIORITISES WORK AND DOES NOTHING ELSE
 * ------------------------------------------------------------------------- */

describe("no sending, cancellation or order-changing capability was added", () => {
  const NEW_FILES = [
    ["lib", "domain", "before-shipment-urgency.ts"],
    ["lib", "domain", "response-sla.ts"],
    ["lib", "knowledge", "staff-resolution.ts"],
    ["lib", "repositories", "order-shipment-state-repository.ts"],
    ["components", "urgent-flag.tsx"],
    ["components", "response-sla-timer.tsx"],
  ];

  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("contains no verb that would act on an order", () => {
    for (const file of [...NEW_FILES, ["lib", "repositories", "conversation-repository.ts"]]) {
      const source = stripComments(read(...file));
      for (const pattern of [
        /\bcancelOrder\b/i,
        /\bcancelShipment\b/i,
        /\bstopDispatch\b/i,
        /\bholdDispatch\b/i,
        /\bupdateOrderStatus\b/i,
        /\bsetOrderStatus\b/i,
        /\bsendReply\b/i,
        /\bsendMessage\b/i,
        /\bsendToMarketplace\b/i,
        /\bnotifyCustomer\b/i,
        /\bmarketplaceCredentials\b/i,
      ]) {
        expect(source, `${file.join("/")} :: ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("opens no network connection", () => {
    for (const file of NEW_FILES) {
      expect(stripComments(read(...file)), file.join("/")).not.toMatch(
        /\bfetch\s*\(|XMLHttpRequest|axios|https?:\/\/|WebSocket|nodemailer|smtp/i,
      );
    }
  });

  /**
   * THE SOURCE DATABASE IS READ, NEVER WRITTEN. The one new statement against it
   * is a SELECT, and the pool it runs on pins `default_transaction_read_only`.
   */
  it("writes to no database, and only reads the source", () => {
    const shipment = stripComments(read("lib", "repositories", "order-shipment-state-repository.ts"));
    expect(shipment).toContain("SELECT");
    expect(shipment).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|TRUNCATE)\s/);
    expect(
      stripComments(read("lib", "repositories", "conversation-repository.ts")),
    ).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE)\s/);
  });

  it("adds no mutating endpoint", () => {
    const route = read("app", "api", "conversations", "route.ts");
    expect(route).toContain("export async function GET");
    expect(route).not.toMatch(/export async function (?:POST|PUT|PATCH|DELETE)/);
  });

  /** The flag is observed, never set: no override, no stored column, no endpoint. */
  it("cannot be set by hand", () => {
    expect(read("app", "api", "conversations", "route.ts")).not.toMatch(
      /setUrgent|markUrgent|urgentOverride/i,
    );
  });
});
