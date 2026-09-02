import { describe, expect, it } from "vitest";

import {
  ORDER_STATUS_VALUES,
  correctionBlock,
  describeFinding,
  dispatchState,
  validateDraftAccuracy,
} from "@/lib/ai/draft-validation";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * The accuracy gate.
 *
 * WHAT THESE TESTS PIN. That a draft contradicting a verified fact is caught,
 * that a draft ignoring the customer's question is caught, and — the half that
 * is easy to forget and expensive to get wrong — that a CORRECT draft is not.
 * A validator that fails good drafts costs a second model call and a reviewer's
 * attention on every conversation, so the "passes" cases below are load-bearing
 * rather than decorative.
 *
 * Every message and every draft here is written for the test. No customer text.
 */

function message(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-08-01 09:00:00",
    bodyText: "Hello",
    bodyDecodeStatus: "decoded",
    attachments: [],
    ...overrides,
  };
}

function customer(text: string): ConversationMessageView[] {
  return [message({ bodyText: text })];
}

function facts(entries: Record<string, string>): VerifiedFact[] {
  return Object.entries(entries).map(([name, value]) => ({ name, value }));
}

function check(
  reply: string,
  entries: Record<string, string>,
  text: string,
  knowledgeAvailable = true,
) {
  return validateDraftAccuracy({
    reply,
    facts: facts(entries),
    messages: customer(text),
    knowledgeAvailable,
  });
}

/* ------------------------------------------------------------------ */

describe("what the verified facts establish", () => {
  /**
   * The three states, and the middle one matters most: 15% of completed orders
   * carry no tracking number, so a missing one cannot be read as proof the
   * parcel is still here.
   */
  it("reads a tracking number as proof of dispatch", () => {
    expect(dispatchState(facts({ order_status: "Completed", tracking_number: "AB123456789GB" }))).toBe(
      "dispatched",
    );
  });

  it("reads the New status as proof of non-dispatch", () => {
    expect(dispatchState(facts({ order_status: "New" }))).toBe("not_dispatched");
  });

  it("refuses to infer non-dispatch from a missing tracking number", () => {
    expect(dispatchState(facts({ order_status: "Completed" }))).toBe("unknown");
    expect(dispatchState([])).toBe("unknown");
  });

  it("lets an explicit dispatch_status fact outrank the derivation", () => {
    expect(dispatchState(facts({ dispatch_status: "Not dispatched" }))).toBe("not_dispatched");
    expect(dispatchState(facts({ dispatch_status: "Dispatched" }))).toBe("dispatched");
  });

  it("knows the statuses this system actually records", () => {
    // A closed vocabulary is what makes "the draft named a status that is not
    // this order's" decidable. Measured against the live orders table.
    expect([...ORDER_STATUS_VALUES].sort()).toEqual(
      ["Cancelled", "Completed", "Deleted", "Hold", "Inprogress", "New", "Refunded"].sort(),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("the reported failures", () => {
  /**
   * Reported example 1. The dispatch status was resolved before the model ran.
   * Offering to check it is not caution, it is a reply that does nothing.
   */
  it("catches a draft that offers to check something already established", () => {
    const result = check(
      "Thank you for getting in touch. We will check the dispatch status and cancel if possible.",
      { order_number: "12-34567-89012", order_status: "New" },
      "I purchased these by mistake. Could I cancel the order and get a refund please.",
    );

    expect(result.passed).toBe(false);
    const finding = result.findings.find((f) => f.issue === "contradicts_verified_fact");
    expect(finding).toBeDefined();
    expect(finding!.incorrectStatement).toContain("check the dispatch status");
    expect(finding!.verifiedFact).toBe("order_status = New");
    expect(finding!.regenerationReason).toMatch(/NOT DISPATCHED/);
  });

  /** Reported example 2. Stale order information, stated as ours. */
  it("catches a draft that reports a status the order does not have", () => {
    const result = check(
      "Your order is still showing as New.",
      { order_number: "12-34567-89012", order_status: "Refunded" },
      "What is happening with my money?",
    );

    expect(result.passed).toBe(false);
    const finding = result.findings.find((f) => f.verifiedFact === "order_status = Refunded");
    expect(finding).toBeDefined();
    expect(finding!.issue).toBe("contradicts_verified_fact");
    expect(finding!.regenerationReason).toMatch(/"New"/);
  });

  it("accepts the same sentence when it reports the status the order has", () => {
    const result = check(
      "Your order is showing as Refunded, so the money is on its way back to you.",
      { order_status: "Refunded" },
      "What is happening with my money?",
    );
    expect(result.findings.filter((f) => f.issue === "contradicts_verified_fact")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("the required cases", () => {
  /** 1. Cancellation before dispatch. */
  it("passes a reply that cancels and refunds an undispatched order", () => {
    const result = check(
      "Sorry to hear that. Your order has not left us yet, so we can stop it. We have raised the cancellation and the refund will go back to your original payment method within a few working days.",
      { order_number: "12-34567-89012", order_status: "New" },
      "I purchased these by mistake. Could I cancel the order and get a refund please.",
    );
    expect(result.findings).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("flags a reply that cancels but never mentions the money", () => {
    const result = check(
      "Sorry to hear that. Your order has not left us yet, so we have cancelled it for you.",
      { order_status: "New" },
      "I purchased these by mistake. Could I cancel the order and get a refund please.",
    );
    const finding = result.findings.find((f) => f.issue === "rule_not_followed");
    expect(finding).toBeDefined();
    expect(finding!.regenerationReason).toMatch(/refund/i);
  });

  /** 2. Cancellation after dispatch — a different piece of work entirely. */
  it("requires the return route once the order has been dispatched", () => {
    const result = check(
      "Of course, we have cancelled the order for you and you will be refunded.",
      { order_status: "Completed", tracking_number: "AB123456789GB" },
      "I have changed my mind, please cancel my order and refund me.",
    );

    const finding = result.findings.find((f) => f.issue === "rule_not_followed");
    expect(finding).toBeDefined();
    expect(finding!.ruleThatApplies).toMatch(/return route/i);
  });

  it("passes a dispatched cancellation handled as a return", () => {
    const result = check(
      "Your order is already on its way, so it cannot be stopped now. Once it arrives you can return it to us unopened and we will refund you in full.",
      { order_status: "Completed", tracking_number: "AB123456789GB" },
      "I have changed my mind, please cancel my order and refund me.",
    );
    expect(result.findings).toEqual([]);
  });

  /** 3. Wrong item received. */
  it("flags a wrong-item reply that never mentions the wrong item", () => {
    const result = check(
      "Thank you for your message. Please could you confirm your delivery postcode so we can look at your account.",
      {},
      "You have sent me the wrong one, this is a different colour to the one I ordered.",
    );
    const finding = result.findings.find((f) => f.issue === "intent_not_addressed");
    expect(finding).toBeDefined();
    expect(finding!.regenerationReason).toMatch(/wrong item/i);
  });

  it("passes a wrong-item reply that addresses the wrong item", () => {
    const result = check(
      "I am sorry the wrong one reached you. Please send us a photo of what arrived and we will arrange for the correct item to be sent to you.",
      {},
      "You have sent me the wrong one, this is a different colour to the one I ordered.",
    );
    expect(result.findings.filter((f) => f.issue === "intent_not_addressed")).toEqual([]);
  });

  /** 4. Missing component. */
  it("flags a missing-part reply that never mentions the part", () => {
    const result = check(
      "Thank you for contacting us. We are sorry for the inconvenience and hope you enjoy your purchase.",
      {},
      "The parcel arrived but the fixing screws are missing.",
    );
    const finding = result.findings.find((f) => f.issue === "intent_not_addressed");
    expect(finding).toBeDefined();
    expect(finding!.ruleThatApplies).toMatch(/missing/i);
  });

  it("passes a missing-part reply that addresses the part", () => {
    const result = check(
      "I am sorry a part was missing from your parcel. Please confirm which piece is absent and we will send the missing part out to you.",
      {},
      "The parcel arrived but the fixing screws are missing.",
    );
    expect(result.findings.filter((f) => f.issue === "intent_not_addressed")).toEqual([]);
  });

  /**
   * 5. A pre-sales question, answered by asking for an order number the person
   * cannot have. The one decidable failure in a category with no fixed
   * vocabulary.
   */
  it("flags a pre-sales enquiry answered by asking for order details", () => {
    const result = check(
      "Thank you for your message. Please could you provide your order number so that we can help.",
      {},
      "Before I buy, will this fit a standard 40mm ceiling rose? I have not ordered yet.",
    );
    const finding = result.findings.find((f) => f.issue === "intent_not_addressed");
    expect(finding).toBeDefined();
    expect(finding!.ruleThatApplies).toMatch(/pre-sales/i);
  });

  /** 6. A delivery question, with tracking already in the verified context. */
  it("flags a delivery reply that asks for tracking we already hold", () => {
    const result = check(
      "Thank you for your message. Unfortunately we do not have a tracking number for this order.",
      { order_status: "Completed", tracking_number: "AB123456789GB", delivery_courier: "Royal Mail" },
      "Where is my parcel? It still has not arrived.",
    );
    const finding = result.findings.find((f) => f.issue === "contradicts_verified_fact");
    expect(finding).toBeDefined();
    expect(finding!.verifiedFact).toBe("tracking_number = AB123456789GB");
  });

  it("passes a delivery reply that uses the verified tracking", () => {
    const result = check(
      "Your parcel was collected by Royal Mail and is travelling under tracking number AB123456789GB. You can follow it with that reference.",
      { order_status: "Completed", tracking_number: "AB123456789GB", delivery_courier: "Royal Mail" },
      "Where is my parcel? It still has not arrived.",
    );
    expect(result.findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("identifiers are compared by value", () => {
  it("catches a tracking number that is not the verified one", () => {
    const result = check(
      "Your tracking number is AB999999999GB.",
      { tracking_number: "AB123456789GB" },
      "Where is my parcel?",
    );
    const finding = result.findings.find((f) => f.ruleThatApplies?.includes("Identifiers"));
    expect(finding).toBeDefined();
    expect(finding!.regenerationReason).toContain("AB123456789GB");
  });

  it("accepts the verified tracking number written back", () => {
    const result = check(
      "Your tracking number is AB123456789GB.",
      { tracking_number: "AB123456789GB" },
      "Where is my parcel?",
    );
    expect(result.findings.filter((f) => f.ruleThatApplies?.includes("Identifiers"))).toEqual([]);
  });

  it("catches an order number that is not the verified one", () => {
    const result = check(
      "I can see order number 99-99999-99999 on our system.",
      { order_number: "12-34567-89012", order_status: "Completed" },
      "Any news?",
    );
    expect(result.findings.some((f) => f.ruleThatApplies?.includes("Identifiers"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("claims nothing supports", () => {
  it("catches a dispatch claim the verified context does not establish", () => {
    const result = check(
      "Good news — your order has been dispatched and is on its way.",
      { order_status: "New" },
      "Has it been sent?",
    );
    expect(result.findings.some((f) => f.issue === "unsupported_claim")).toBe(true);
  });

  it("accepts the same claim when a tracking number establishes it", () => {
    const result = check(
      "Good news — your order has been dispatched and is on its way under AB123456789GB.",
      { order_status: "Completed", tracking_number: "AB123456789GB" },
      "Has it been sent?",
    );
    expect(result.findings.filter((f) => f.issue === "unsupported_claim")).toEqual([]);
  });

  it("catches an investigation that cannot have happened", () => {
    const result = check(
      "I have checked our system and everything looks fine with your delivery.",
      {},
      "Where is my parcel?",
    );
    const finding = result.findings.find((f) => f.issue === "unsupported_claim");
    expect(finding).toBeDefined();
    expect(finding!.regenerationReason).toMatch(/checked or looked up/i);
  });

  it("catches a cancellation asserted against an order that is not cancelled", () => {
    const result = check(
      "Your order has been cancelled and nothing further will be charged.",
      { order_status: "Completed" },
      "Please cancel it.",
    );
    expect(result.findings.some((f) => f.issue === "unsupported_claim")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("what the hedge check must not do", () => {
  /**
   * The failure mode that would make this layer worse than useless: reporting
   * correct, confident replies as contradictions because they contain the word
   * "confirm" or "see". These are the drafts the whole design is trying to
   * produce.
   */
  it("leaves a statement of the settled fact alone", () => {
    for (const reply of [
      "I can confirm your order was dispatched on Tuesday.",
      "I can see your order has been dispatched, and it is with the courier now.",
      "We have confirmed the dispatch and it is on its way.",
    ]) {
      const result = check(
        reply,
        { order_status: "Completed", tracking_number: "AB123456789GB" },
        "Has my order been sent?",
      );
      expect(
        result.findings.filter((f) => f.issue === "contradicts_verified_fact"),
        reply,
      ).toEqual([]);
    }
  });

  it("says nothing about dispatch when dispatch is unknown", () => {
    const result = check(
      "We will check whether it has been dispatched and come back to you.",
      { order_status: "Completed" },
      "Has my order been sent?",
    );
    expect(result.findings.filter((f) => f.issue === "contradicts_verified_fact")).toEqual([]);
  });

  it("does not read a replacement offer as a status report", () => {
    // "a new one" contains a status name. Only a sentence actually reporting
    // our system's state may match.
    const result = check(
      "We are sorry about that. We will send you a new one straight away.",
      { order_status: "Completed" },
      "The glass arrived cracked.",
    );
    expect(result.findings.filter((f) => f.issue === "contradicts_verified_fact")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("restricted drafts", () => {
  /**
   * Without the CST knowledge base the draft is INSTRUCTED to state no policy
   * and only to acknowledge and ask. Failing it for not applying a rule would
   * be failing it for obeying its instructions, and the only way to satisfy the
   * finding would be to invent the policy it was told not to invent.
   */
  it("does not grade a restricted draft on rules or intent coverage", () => {
    const result = check(
      "Thank you for getting in touch. Could you tell us a little more so we can help?",
      { order_status: "New" },
      "I purchased these by mistake. Could I cancel the order and get a refund please.",
      false,
    );
    expect(result.findings.filter((f) => f.issue === "rule_not_followed")).toEqual([]);
    expect(result.findings.filter((f) => f.issue === "intent_not_addressed")).toEqual([]);
  });

  it("still checks a restricted draft against the verified facts", () => {
    const result = check(
      "We will check the dispatch status for you.",
      { order_status: "New" },
      "Has it been sent?",
      false,
    );
    expect(result.findings.some((f) => f.issue === "contradicts_verified_fact")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("the report", () => {
  it("carries all five fields on every finding", () => {
    const result = check(
      "We will check the dispatch status and cancel if possible.",
      { order_status: "New" },
      "I purchased these by mistake. Could I cancel the order and get a refund please.",
    );

    for (const note of result.notes) {
      expect(note).toMatch(/^Accuracy check \[(critical|minor)\] \(/);
      // issue — statement — verified — rule — reason
      expect(note.split(" — ").length).toBeGreaterThanOrEqual(5);
    }
    expect(describeFinding(result.findings[0]!)).toContain("Accuracy check");
  });

  it("deduplicates a correction two checks arrive at separately", () => {
    const result = check(
      "We will check the dispatch status. We will check the dispatch status again tomorrow.",
      { order_status: "New" },
      "Please cancel and refund.",
    );
    expect(result.findings.length).toBeGreaterThan(1);
    expect(new Set(result.corrections).size).toBe(result.corrections.length);
  });

  it("writes a correction block naming every point", () => {
    const block = correctionBlock(["Fix the first thing.", "Fix the second thing."]);
    expect(block).toMatch(/REJECTED/);
    expect(block).toContain("1. Fix the first thing.");
    expect(block).toContain("2. Fix the second thing.");
    // The correction must not become a licence to invent a way out.
    expect(block).toMatch(/without inventing|not be done by inventing/i);
  });
});

/* ------------------------------------------------------------------ */

/**
 * THE CONVERSATION CATEGORY IS A REVIEW FLAG, NOT A SECOND MODEL CALL.
 *
 * `categoryCoverage` was added so the category a reviewer sees and the draft
 * they are handed cannot be about different things — the two had drifted apart
 * on 313 of the 5,806 live conversations that carry a category.
 *
 * It is confined on purpose, and these tests are the confinement. A category is
 * derived by a classifier; letting a classifier change rewrite customer-facing
 * text would make every future tuning decision a content decision. So a finding
 * from this source may flag a draft for a human and may do nothing else:
 *
 *   never critical            so `regenerationWarranted` cannot become true
 *   never in `corrections`    so nothing reaches the provider's second call
 *
 * `corrections` is built from critical findings alone, so the first guarantee
 * implies the second; both are asserted because they are separate promises.
 */
describe("the conversation category flags for review and never regenerates", () => {
  /**
   * THE DIVERGENCE, IN THE SHAPE IT ACTUALLY TAKES.
   *
   * A damage case whose last message is a stock question. `detectIntents` reads
   * the newest message and raises `pre_sale_question` — which has no coverage
   * entry, deliberately — while the thread reads as Damage queries because the
   * issue outranks the enquiry. Without `categoryCoverage` a reply that answers
   * only the stock question is reported as having nothing wrong with it.
   */
  const DAMAGE_THEN_STOCK = [
    message({ id: "1", bodyText: "One of the shades arrived smashed" }),
    message({ id: "2", bodyText: "Do you have that colour in stock?" }),
  ];

  const review = (reply: string) =>
    validateDraftAccuracy({ reply, facts: [], messages: DAMAGE_THEN_STOCK, knowledgeAvailable: true });

  const fromCategory = (result: ReturnType<typeof review>) =>
    result.findings.filter((finding) => finding.regenerationReason.includes("categorised as"));

  it("raises the gap the per-message intents miss", () => {
    const result = review("Yes, that colour is back in stock next week.");
    expect(fromCategory(result).length).toBeGreaterThan(0);
  });

  it("raises it as minor, never critical", () => {
    for (const finding of fromCategory(review("Yes, that colour is back in stock next week."))) {
      expect(finding.severity).toBe("minor");
    }
  });

  it("never buys a regeneration and never reaches the corrections", () => {
    const result = review("Yes, that colour is back in stock next week.");
    // Nothing else flagged this draft, so the category finding stands alone.
    expect(result.findings.filter((finding) => finding.severity === "critical")).toEqual([]);
    expect(result.regenerationWarranted).toBe(false);
    expect(result.corrections).toEqual([]);
  });

  it("says nothing when the reply already addresses the category", () => {
    const result = review(
      "We are sorry the shade arrived damaged — we will send a replacement. That colour is back in stock next week.",
    );
    expect(fromCategory(result)).toEqual([]);
  });
});
