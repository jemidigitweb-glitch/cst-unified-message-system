import { describe, expect, it } from "vitest";

import { CST_CATEGORY_CORPUS } from "@/lib/knowledge/cst-corpus-match";
import { classifyConversationCategory, classifyMessageCategory } from "@/lib/knowledge/message-category";
import {
  MESSAGE_PRIORITIES,
  PRIORITY_CORPUS_STATS,
  classifyConversationPriority,
  classifyMessagePriority,
  explainConversationPriority,
  explainMessagePriority,
  normalisePriority,
} from "@/lib/knowledge/message-priority";

/**
 * The priority engine, read against the Feature 1 urgency rules.
 *
 * Priority answers "how soon does a person need to touch this", which is NOT
 * the question the workbooks' own `Priority` column answers — see the module's
 * header. Every expectation below is stated in those terms, and the reason a
 * message ranks the way it does is asserted alongside the level wherever the
 * reason is the point.
 */

const priorityOf = (text: string | null) => classifyMessagePriority(text);
const reasonsOf = (text: string) => explainMessagePriority(text).reasons;

/* ------------------------------------------------------------------------- *
 * THE LEVELS
 * ------------------------------------------------------------------------- */

describe("three levels, and no fourth", () => {
  it("is exactly HIGH, MEDIUM and LOW", () => {
    expect(MESSAGE_PRIORITIES).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });

  it("never offers HIGHEST as a level of its own", () => {
    expect(MESSAGE_PRIORITIES).not.toContain("HIGHEST");
  });
});

/* ------------------------------------------------------------------------- *
 * HIGH — ISSUE AND ACTION
 * ------------------------------------------------------------------------- */

describe("HIGH: the issue or the action makes it urgent", () => {
  /** 1. Cancellation. */
  it("ranks a cancellation request HIGH", () => {
    expect(priorityOf("Please cancel my order.")).toBe("HIGH");
    expect(priorityOf("Can I cancel my order?")).toBe("HIGH");
    expect(priorityOf("I want to cancel my order please.")).toBe("HIGH");
    expect(reasonsOf("Please cancel my order.")).toContain("cancellation_requested");
  });

  /**
   * A QUESTION ABOUT THE PROCESS IS NOT AN INSTRUCTION ABOUT AN ORDER. Every
   * cancellation pattern carries its own request frame, so a policy question
   * cannot reach it — which is what makes accepting the polite question form
   * ("can you cancel…?") safe in the first place.
   */
  it("does not treat a cancellation policy question as a cancellation", () => {
    expect(priorityOf("What is your cancellation policy?")).not.toBe("HIGH");
    expect(reasonsOf("What is your cancellation policy?")).not.toContain(
      "cancellation_requested",
    );
  });

  /** 2. Exchange. */
  it("ranks an exchange or replacement request HIGH", () => {
    expect(priorityOf("I'd like to exchange this for a different size.")).toBe("HIGH");
    expect(priorityOf("Can you send me a replacement?")).toBe("HIGH");
    expect(reasonsOf("Can you send me a replacement?")).toContain("exchange_requested");
  });

  /**
   * MENTIONING A REPLACEMENT IS NOT ASKING FOR ONE. "The replacement has
   * arrived damaged" is a customer reporting that our second attempt failed;
   * reading the noun as a request ranked it as urgent as a recall.
   */
  it("does not read a report about a replacement as a request for one", () => {
    expect(reasonsOf("Actually the replacement has arrived damaged.")).not.toContain(
      "exchange_requested",
    );
    expect(priorityOf("Actually the replacement has arrived damaged.")).toBe("MEDIUM");
  });

  /** A send frame with the wrong object must not read as an exchange. */
  it("does not read an invoice request as an exchange", () => {
    expect(reasonsOf("Please send me the invoice for this order.")).not.toContain(
      "exchange_requested",
    );
    expect(priorityOf("Please send me the invoice for this order.")).toBe("MEDIUM");
  });

  /** 3. Platform claim or case. */
  it("ranks an opened marketplace case HIGH", () => {
    expect(priorityOf("I have opened a case with eBay.")).toBe("HIGH");
    expect(priorityOf("I've filed an A-to-Z claim.")).toBe("HIGH");
    expect(priorityOf("I am reporting this to Trading Standards.")).toBe("HIGH");
    expect(reasonsOf("I have opened a case with eBay.")).toContain("platform_case");
  });

  /** 4. Safety. */
  it("ranks a safety concern HIGH", () => {
    expect(priorityOf("It sparked when I switched it on and gave me an electric shock.")).toBe(
      "HIGH",
    );
    expect(priorityOf("There is a burning smell and burn marks on the transformer.")).toBe("HIGH");
    expect(priorityOf("My son was injured by the broken glass.")).toBe("HIGH");
    expect(reasonsOf("It sparked when I switched it on.")).toContain("safety_hazard");
  });

  /** 5. A defect that is also a hazard. */
  it("ranks a hazardous defect HIGH, above the ordinary damage beside it", () => {
    const hazardous = "The fitting is damaged and started smoking when connected.";
    expect(priorityOf(hazardous)).toBe("HIGH");
    expect(reasonsOf(hazardous)).toContain("safety_hazard");
    // The same damage without the hazard is ordinary work.
    expect(priorityOf("The fitting is damaged.")).toBe("MEDIUM");
  });

  /**
   * A FINISH IS NOT A FIRE. "Smoked" is a glass finish in this catalogue, and a
   * bare `smoke` pattern ranked a pre-sales question about a shade as an
   * electrical hazard.
   */
  it("does not read a smoked-glass question as a hazard", () => {
    expect(reasonsOf("Is the shade made of smoked glass?")).not.toContain("safety_hazard");
    expect(priorityOf("Is the shade made of smoked glass?")).toBe("LOW");
  });

  /**
   * 20. THE ADDRESS-CHANGE RULE, AND WHY IT STOPS HERE.
   *
   * The business escalates an address change requested BEFORE DISPATCH. Whether
   * an order has been dispatched is a verified fact about the order, not
   * something a sentence can establish, so this module must not escalate on the
   * request alone — it would be inventing the state.
   */
  it("never escalates an address change, because it cannot know if it shipped", () => {
    expect(priorityOf("Can I change the delivery address on my order?")).toBe("MEDIUM");
    expect(priorityOf("Please change my delivery address to 12 High Street.")).toBe("MEDIUM");
    expect(PRIORITY_CORPUS_STATS.addressChangeIsNotEscalated).toBe(true);
  });

  /** An address change WITH urgency is HIGH for the urgency, not the address. */
  it("still hears urgency stated alongside an address change", () => {
    const urgent = "Please change my delivery address urgently, it goes out today.";
    expect(priorityOf(urgent)).toBe("HIGH");
    expect(reasonsOf(urgent)).toContain("customer_urgency");
  });
});

/* ------------------------------------------------------------------------- *
 * HIGH — THE CUSTOMER
 * ------------------------------------------------------------------------- */

describe("HIGH: the customer says it cannot wait", () => {
  /** 6. Explicit urgency and distress. */
  it("ranks an explicitly urgent customer HIGH", () => {
    expect(priorityOf("This is urgent, I need it today.")).toBe("HIGH");
    expect(priorityOf("I need an answer today please.")).toBe("HIGH");
    expect(priorityOf("Please send it ASAP.")).toBe("HIGH");
    expect(reasonsOf("This is urgent.")).toContain("customer_urgency");
  });

  /** 7. Repeated unanswered contact. */
  it("ranks a customer chasing an unanswered message HIGH", () => {
    expect(priorityOf("I have contacted you three times and had no response.")).toBe("HIGH");
    expect(priorityOf("This is the third time I have written about this.")).toBe("HIGH");
    expect(priorityOf("I am still waiting for a reply.")).toBe("HIGH");
    expect(reasonsOf("I have had no response from anyone.")).toContain(
      "chasing_unanswered_contact",
    );
  });

  /**
   * WAITING FOR A COURIER IS NOT WAITING FOR US. "Still waiting" is the single
   * commonest sentence in a delivery query, and ranking it as a chase would put
   * every ordinary WISMO in the red.
   */
  it("does not treat waiting for the parcel as chasing us", () => {
    expect(reasonsOf("I am still waiting for my parcel.")).not.toContain(
      "chasing_unanswered_contact",
    );
    expect(priorityOf("I am still waiting for my parcel.")).toBe("MEDIUM");
    expect(priorityOf("I am still waiting for my refund.")).toBe("MEDIUM");
  });

  /** 8. The word alone is not the signal. */
  it("does not rank a message HIGH because the word urgent appears in it", () => {
    const denied = "This is not urgent, whenever you get a chance.";
    expect(priorityOf(denied)).not.toBe("HIGH");
    expect(reasonsOf(denied)).not.toContain("customer_urgency");
  });

  it("does not rank a hypothetical escalation HIGH", () => {
    // A conditional threat is a warning about a future, not a case that exists.
    expect(reasonsOf("I'll open a case if this is not sorted.")).not.toContain("platform_case");
  });

  /** The brief's own worked example, end to end. */
  it("ranks the brief's delivery-urgency example HIGH", () => {
    expect(
      priorityOf(
        "My parcel still hasn't arrived and I've contacted you twice. I need an answer today.",
      ),
    ).toBe("HIGH");
  });
});

/* ------------------------------------------------------------------------- *
 * MEDIUM
 * ------------------------------------------------------------------------- */

describe("MEDIUM: real work, but not today", () => {
  /** 9. Delivery and WISMO. */
  it("ranks an ordinary delivery query MEDIUM", () => {
    expect(priorityOf("Where is my parcel?")).toBe("MEDIUM");
    expect(priorityOf("When will my order arrive?")).toBe("MEDIUM");
    expect(priorityOf("Any update on my delivery?")).toBe("MEDIUM");
    expect(priorityOf("Where is my order? It still has not arrived.")).toBe("MEDIUM");
  });

  /** 10. Wrong item. */
  it("ranks a wrong item MEDIUM", () => {
    expect(priorityOf("You have sent me the wrong item.")).toBe("MEDIUM");
  });

  /** 11. Damage with no hazard. */
  it("ranks non-hazardous damage MEDIUM", () => {
    expect(priorityOf("The item arrived damaged.")).toBe("MEDIUM");
    expect(priorityOf("One of the shades arrived smashed.")).toBe("MEDIUM");
    expect(priorityOf("The box was crushed in transit.")).toBe("MEDIUM");
  });

  /** 12. Parts missing. */
  it("ranks a missing part MEDIUM", () => {
    expect(priorityOf("Some of the parts are missing from the box.")).toBe("MEDIUM");
  });

  /** 13. Return request. */
  it("ranks a return request MEDIUM", () => {
    expect(priorityOf("I would like to return this please.")).toBe("MEDIUM");
  });

  /** 14. Refund follow-up. */
  it("ranks a refund follow-up MEDIUM", () => {
    expect(priorityOf("I am still waiting for my refund.")).toBe("MEDIUM");
    expect(priorityOf("When will I get my refund?")).toBe("MEDIUM");
  });

  it("ranks an admin request MEDIUM", () => {
    expect(priorityOf("Can I have an invoice for this order please?")).toBe("MEDIUM");
  });
});

/* ------------------------------------------------------------------------- *
 * LOW
 * ------------------------------------------------------------------------- */

describe("LOW: routine, and nothing has gone wrong", () => {
  /** 15. Routine pre-sales. */
  it("ranks a routine pre-sales question LOW", () => {
    expect(priorityOf("Is this light dimmable?")).toBe("LOW");
    expect(priorityOf("What are the dimensions of this shade?")).toBe("LOW");
    expect(priorityOf("Is this suitable for outdoor use?")).toBe("LOW");
  });

  /** 16. Compatibility and general product information. */
  it("ranks a compatibility question LOW", () => {
    expect(priorityOf("Will this work with a dimmer switch?")).toBe("LOW");
    expect(priorityOf("Can you tell me what wattage this bulb is?")).toBe("LOW");
  });

  /** 17. Bulk order. */
  it("ranks a bulk-order enquiry LOW", () => {
    expect(priorityOf("I want to buy in bulk, do you offer trade pricing?")).toBe("LOW");
  });

  /** 18. Thank-you and informational. */
  it("ranks a customer closing the case LOW", () => {
    expect(priorityOf("Thank you, that is all sorted now.")).toBe("LOW");
    expect(priorityOf("Thank you.")).toBe("LOW");
    expect(reasonsOf("Thank you.")).toContain("case_closed_by_customer");
    expect(explainMessagePriority("Thank you.").closesTheCase).toBe(true);
  });

  /**
   * A THANK-YOU WITH A QUESTION ATTACHED IS NOT A CLOSING MESSAGE, and the
   * distinction has to hold or a polite customer's live question would clear
   * the thread's priority.
   */
  it("does not treat a thank-you carrying a live problem as closing", () => {
    const stillOpen = "Thanks for the reply, but the item is still damaged.";
    expect(explainMessagePriority(stillOpen).closesTheCase).toBe(false);
    expect(priorityOf(stillOpen)).toBe("MEDIUM");
  });

  /**
   * "Delivered" is a word about the parcel's journey, not about the customer's
   * problem. Reading it as a closing message let a live non-delivery clear a
   * thread.
   */
  it("does not treat a tracking-says-delivered complaint as closing", () => {
    const text = "Tracking says delivered but I have not received it.";
    expect(explainMessagePriority(text).closesTheCase).toBe(false);
    expect(priorityOf(text)).toBe("MEDIUM");
  });
});

/* ------------------------------------------------------------------------- *
 * NULL
 * ------------------------------------------------------------------------- */

describe("null: nothing established, which is not the same as LOW", () => {
  /** 19. Unknown. */
  it("returns null when nothing in the message says anything", () => {
    expect(priorityOf("Hello.")).toBeNull();
    expect(priorityOf("asdf qwerty")).toBeNull();
    expect(priorityOf("")).toBeNull();
    expect(priorityOf("   ")).toBeNull();
    expect(priorityOf(null)).toBeNull();
  });

  it("does not default an unmatched message to LOW", () => {
    for (const text of ["Hello.", "asdf qwerty", "..."]) {
      expect(priorityOf(text), text).not.toBe("LOW");
    }
  });
});

/* ------------------------------------------------------------------------- *
 * THE WORKBOOK COLUMN
 * ------------------------------------------------------------------------- */

describe("the workbook Priority column no longer decides", () => {
  /**
   * THE REGRESSION THIS WHOLE REVISION EXISTS FOR.
   *
   * `DIMMABLE QUERIES` carries `priority: "HIGH"` in PRE-SALES QUERIES.xlsx.
   * Under the first implementation that made a routine sales question rank level
   * with a product recall. The column is read for its HIGHEST tier and nothing
   * else, so the row's own HIGH is now inert.
   */
  it("does not escalate a routine pre-sales question that the workbook calls HIGH", () => {
    const dimmable = CST_CATEGORY_CORPUS.find((rule) => rule.name === "DIMMABLE QUERIES");
    expect(dimmable, "the row this regression is about must still exist").toBeDefined();
    expect(normalisePriority(dimmable!.priority)).toBe("HIGH");

    expect(priorityOf("Is this light dimmable?")).toBe("LOW");
    expect(reasonsOf("Is this light dimmable?")).not.toContain("workbook_highest");
  });

  it("ignores every workbook HIGH, MED and LOW row, whatever it says", () => {
    // Sampled across three workbooks: each row's stated level is not the answer.
    const samples: readonly (readonly [string, string])[] = [
      ["Is this light dimmable?", "HIGH"],
      ["Is this suitable for outdoor use?", "HIGH"],
      ["What are the dimensions of this shade?", "MEDIUM"],
    ];
    for (const [text, stated] of samples) {
      // The workbook says one thing...
      expect(MESSAGE_PRIORITIES).toContain(stated);
      // ...and the inbox reads a routine enquiry.
      expect(priorityOf(text), text).toBe("LOW");
    }
  });

  /**
   * THE ONE SURVIVING USE. All twenty HIGHEST rows are recalls, safety
   * concerns, waiting electricians or compensation demands — every one a
   * Feature 1 HIGH on its own terms.
   */
  it("still hears the HIGHEST tier, which is recalls and safety", () => {
    expect(priorityOf("I received a product recall notice for this light.")).toBe("HIGH");
    expect(reasonsOf("I received a product recall notice for this light.")).toContain(
      "workbook_highest",
    );
  });

  it("reads every stated priority in the corpus", () => {
    const unreadable = CST_CATEGORY_CORPUS.filter(
      (rule) => rule.priority !== "" && normalisePriority(rule.priority) === null,
    ).map((rule) => `${rule.id}: ${rule.priority}`);
    expect(unreadable).toEqual([]);
  });

  it("folds the four workbook levels into three, keeping HIGHEST distinguishable", () => {
    expect(normalisePriority("🔴 HIGHEST")).toBe("HIGHEST");
    expect(normalisePriority("RED HIGHEST")).toBe("HIGHEST");
    expect(normalisePriority("🔴 HIGHEST — overrides all other routing")).toBe("HIGHEST");
    expect(normalisePriority("🟠 HIGH")).toBe("HIGH");
    expect(normalisePriority("RED HIGH")).toBe("HIGH");
    expect(normalisePriority("YELLOW MED")).toBe("MEDIUM");
    expect(normalisePriority("MEDIUM")).toBe("MEDIUM");
    expect(normalisePriority("🟢 LOW")).toBe("LOW");
    expect(normalisePriority("")).toBeNull();
    expect(normalisePriority("TL notification")).toBeNull();
  });

  it("counts what the column still contributes", () => {
    expect(PRIORITY_CORPUS_STATS.rules).toBe(730);
    expect(PRIORITY_CORPUS_STATS.rulesWithStatedPriority).toBe(199);
    expect(PRIORITY_CORPUS_STATS.highestTierRules).toBe(20);
  });
});

/* ------------------------------------------------------------------------- *
 * DELIVERY AND DAMAGE
 * ------------------------------------------------------------------------- */

describe("delivery and damage, which the workbook column never ranked", () => {
  /**
   * Neither workbook has a Priority column — the delivery book is
   * scenario-shaped and the damage book is a decision matrix — so the first
   * implementation returned null for both. They are ranked from the semantic
   * and category evidence instead.
   */
  it("ranks the whole delivery family", () => {
    const readings = [
      "Where is my parcel?",
      "When will my order arrive?",
      "Any update on my delivery?",
      "My order has not arrived yet.",
      "I am still waiting for my parcel.",
    ].map((text) => priorityOf(text));
    expect(readings).toEqual(["MEDIUM", "MEDIUM", "MEDIUM", "MEDIUM", "MEDIUM"]);
  });

  it("ranks the whole damage family", () => {
    const readings = [
      "The item arrived damaged.",
      "One of the shades arrived smashed.",
      "The box was crushed in transit.",
    ].map((text) => priorityOf(text));
    expect(readings).toEqual(["MEDIUM", "MEDIUM", "MEDIUM"]);
  });

  it("separates ordinary delivery from urgent delivery", () => {
    expect(priorityOf("Where is my parcel?")).toBe("MEDIUM");
    expect(
      priorityOf(
        "My parcel still hasn't arrived and I've contacted you twice. I need an answer today.",
      ),
    ).toBe("HIGH");
  });

  it("separates ordinary damage from a hazard", () => {
    expect(priorityOf("The item arrived damaged.")).toBe("MEDIUM");
    expect(priorityOf("The fitting is damaged and started smoking when connected.")).toBe("HIGH");
  });
});

/* ------------------------------------------------------------------------- *
 * A CONVERSATION
 * ------------------------------------------------------------------------- */

describe("a conversation is ranked on its current issue", () => {
  it("takes the most urgent message while the case is open", () => {
    expect(
      classifyConversationPriority([
        "Where is my parcel?",
        "This is urgent now, I need an answer today.",
      ]),
    ).toBe("HIGH");
  });

  /**
   * THE HISTORICAL-URGENCY FIX. Taking the maximum across the whole thread left
   * a conversation red forever, including after the customer said it was sorted
   * — and a row that is always red is a row a reviewer learns to ignore.
   */
  it("drops back once the customer closes the case", () => {
    expect(
      classifyConversationPriority([
        "My electrician is coming on Friday and I need this urgently.",
        "Thank you, all sorted now.",
      ]),
    ).toBe("LOW");
  });

  it("picks the new issue up again after a closing message", () => {
    expect(
      classifyConversationPriority([
        "Thank you, all sorted now.",
        "Actually the replacement has arrived damaged.",
      ]),
    ).toBe("MEDIUM");
  });

  it("reads each message on its own, never the thread concatenated", () => {
    // Glued together these would form a phrase neither message contains.
    expect(classifyConversationPriority(["Is this the right product", "recall anything?"])).not.toBe(
      "HIGH",
    );
  });

  it("skips messages with no readable body", () => {
    expect(classifyConversationPriority([null, "Where is my parcel?", null])).toBe("MEDIUM");
  });

  it("returns null for a thread with nothing in it", () => {
    expect(classifyConversationPriority([])).toBeNull();
    expect(classifyConversationPriority([null, null])).toBeNull();
    expect(classifyConversationPriority(["Hello.", "asdf"])).toBeNull();
  });

  it("explains the thread with the reasons that decided it", () => {
    const reading = explainConversationPriority([
      "Where is my parcel?",
      "This is urgent now, I need an answer today.",
    ]);
    expect(reading.priority).toBe("HIGH");
    expect(reading.reasons).toContain("customer_urgency");
  });
});

/* ------------------------------------------------------------------------- *
 * INDEPENDENCE
 * ------------------------------------------------------------------------- */

describe("priority is a second reading, not a change to the first", () => {
  const THREADS: readonly (readonly string[])[] = [
    ["Where is my parcel?"],
    ["What is your return policy?"],
    ["Please cancel my order."],
    ["I received a product recall notice for this light."],
    ["What are the dimensions of this shade?"],
    ["Can I have an invoice for this order please?"],
    ["The fitting is damaged and started smoking when connected."],
    ["Thank you, that is all sorted now."],
  ];

  /** 21. Priority calculation does not change category output. */
  it("leaves every category answer exactly as it was", () => {
    const before = THREADS.map((thread) => classifyConversationCategory(thread));
    THREADS.forEach((thread) => classifyConversationPriority(thread));
    const after = THREADS.map((thread) => classifyConversationCategory(thread));
    expect(after).toEqual(before);
  });

  it("leaves single-message category answers alone too", () => {
    const texts = THREADS.map((thread) => thread[0]!);
    const before = texts.map((text) => classifyMessageCategory(text));
    texts.forEach((text) => classifyMessagePriority(text));
    expect(texts.map((text) => classifyMessageCategory(text))).toEqual(before);
  });

  it("is stable when called repeatedly — no accumulated state", () => {
    for (const thread of THREADS) {
      const first = classifyConversationPriority(thread);
      expect(classifyConversationPriority(thread)).toBe(first);
      expect(classifyConversationPriority(thread)).toBe(first);
    }
  });

  it("gives one category two different priorities", () => {
    // A recall and an invoice request are both admin work; only one needs
    // somebody now.
    const recall = "I received a product recall notice for this light.";
    const invoice = "Can I have an invoice for this order please?";
    expect(classifyConversationCategory([recall])).toBe(classifyConversationCategory([invoice]));
    expect(priorityOf(recall)).toBe("HIGH");
    expect(priorityOf(invoice)).toBe("MEDIUM");
  });

  it("gives one priority two different categories", () => {
    const recall = "I received a product recall notice for this light.";
    const cancel = "Please cancel my order.";
    expect(priorityOf(recall)).toBe(priorityOf(cancel));
    expect(classifyConversationCategory([recall])).not.toBe(
      classifyConversationCategory([cancel]),
    );
  });
});
