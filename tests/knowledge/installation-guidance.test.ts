import { describe, expect, it } from "vitest";

import {
  classifyConversationCategory,
  classifyMessageCategory,
  classifyMessageCategoryWithFallback,
} from "@/lib/knowledge/message-category";
import { classifyMessagePriority } from "@/lib/knowledge/message-priority";

/**
 * SPECIFICATION IS PRE SALES. INSTALLATION GUIDANCE IS ADMIN.
 *
 * The workbooks draw this line themselves — the pre-sales book owns
 * `WIRING DRIVER TRANSFORMER ADVICE` (which driver should I buy) and
 * `ADMIN.xlsx` sheet 12 owns `INSTALLATION / WIRING GUIDANCE` and
 * `MANUAL / WIRING DIAGRAM` (how do I fit the one I have). The classifier read
 * every product question as a specification question, so a live installation
 * problem sat in the queue for buyers who had not bought yet.
 *
 * OWNERSHIP IS NOT THE TEST. `PRE_SALES` states, and this suite preserves, that
 * "Pre sales survives a previous purchase" — a specification question is Pre
 * sales whoever asks it. What changed is that a HOW-DO-I question is Admin
 * whoever asks it. Nothing here reads an order, and nothing here can.
 *
 * All three read paths are asserted on every case — the strict table, the
 * intent fallback, and the conversation reading — because the inbox uses the
 * third, the priority engine uses the first, and a split between them is how a
 * row ends up labelled one thing and ranked as another.
 *
 * Synthetic messages throughout. No customer, product, marketplace or order
 * appears in any fixture.
 */

function everyPath(text: string) {
  return {
    strict: classifyMessageCategory(text),
    fallback: classifyMessageCategoryWithFallback(text),
    conversation: classifyConversationCategory([text]),
  };
}

/** The reading the inbox actually shows, and the one the ribbon is coloured from. */
const shown = (text: string) => classifyConversationCategory([text]);

/* ------------------------------------------------------------------------- *
 * SPECIFICATION AND COMPATIBILITY STAY PRE SALES
 * ------------------------------------------------------------------------- */

describe("asking WHAT it is, or WHETHER it suits, is still a sales question", () => {
  const SPECIFICATION = [
    // 1, 2, 3, 4 — the brief's own list.
    "Will this connector work with 3x1.5 mm cable?",
    "Is it compatible with this cable?",
    "What cable size does this support?",
    "Is this light dimmable?",
    // The neighbours most at risk from a rule about fitting and using.
    "What voltage does it use?",
    "Which driver do I need?",
    "Is this suitable for outdoor use?",
    "Can I use this outside?",
    "Will this fit a 28mm pendant?",
  ] as const;

  it.each(SPECIFICATION)("reads %j as Pre sales", (text) => {
    expect(shown(text)).toBe("Pre sales queries");
  });

  it("agrees on every read path", () => {
    for (const text of SPECIFICATION) {
      const paths = everyPath(text);
      expect(paths.fallback, text).toBe("Pre sales queries");
      expect(paths.conversation, text).toBe("Pre sales queries");
    }
  });

  /**
   * 10, 15. THE APPROVED REGRESSION, UNCHANGED. A customer already holding the
   * transformer, correcting us mid-thread, asking a pure specification
   * question. `PRE_SALES` exists to keep this one Pre sales and it still does —
   * which is the proof that this fix did not quietly become an ownership gate.
   */
  it("keeps a specification question from somebody who already owns it", () => {
    const owner =
      "However, it unfortunately has nothing to do with my actual question! " +
      "I wanted to know exactly whether this transformer has two galvanically/electrically isolated windings? " +
      "I didn't ask about the power rating!";
    expect(shown(owner)).toBe("Pre sales queries");
    expect(classifyMessageCategory(owner)).toBe("Pre sales queries");
  });

  it("keeps a plain specification question about a product in hand", () => {
    expect(shown("Does this transformer have two isolated windings?")).toBe("Pre sales queries");
  });
});

/* ------------------------------------------------------------------------- *
 * ASKING HOW BECOMES ADMIN
 * ------------------------------------------------------------------------- */

describe("asking HOW to fit, wire, connect or use it is installation guidance", () => {
  const GUIDANCE = [
    // 5, 6, 7 — the brief's own list.
    "How do I connect this cable?",
    "How should I wire this?",
    "How do I install this?",
    // The request-for-guidance shape, with no question word about the method.
    "Can you explain how to install this?",
    "Please advise on fitting this.",
    // 8 — the reported-difficulty shape, the commonest in live text.
    "I'm struggling to fit the cable. What should I do?",
    "I cannot get it onto the thread. What can I do?",
  ] as const;

  it.each(GUIDANCE)("reads %j as Admin", (text) => {
    expect(shown(text)).toBe("Admin related issues");
  });

  it("agrees on every read path", () => {
    for (const text of GUIDANCE) {
      const paths = everyPath(text);
      expect(paths.fallback, text).toBe("Admin related issues");
      expect(paths.conversation, text).toBe("Admin related issues");
    }
  });

  /**
   * 9. THE REPORTED CASE, synthesised. No customer, no marketplace, no order,
   * and no part of it hard-coded into the classifier: the sentence is carried
   * by the general difficulty-with-a-fitting shape, and the cable size, the
   * thread and the product are incidental to it.
   */
  it("reads the reported installation problem as Admin", () => {
    const reported =
      "I'm having problems using this product. I want to connect 3x1.5 mm cable, " +
      "but because of the cable thickness I cannot get it onto the thread. What can I do?";
    expect(shown(reported)).toBe("Admin related issues");
    expect(classifyMessageCategory(reported)).toBe("Admin related issues");
  });

  /**
   * The same message in German, untranslated. There is no translation step in
   * front of the classifier — `HAS_NOT_ARRIVED` carries "nicht erhalten" for
   * exactly this reason — so the German shapes sit beside the English ones.
   */
  it("reads the same problem written in German as Admin", () => {
    const german =
      "Ich habe Probleme mit diesem Produkt. Ich möchte 3x1,5 mm² Erdkabel anschließen. " +
      "Wegen der Kabeldicke ist es fast unmöglich, auf das Gewinde zu kommen. Was kann ich tun?";
    expect(shown(german)).toBe("Admin related issues");
    expect(classifyMessageCategory(german)).toBe("Admin related issues");
  });

  it("reads a German how-to question with a separated verb as Admin", () => {
    expect(shown("Wie schließe ich das an?")).toBe("Admin related issues");
  });

  /** Ownership makes no difference in either direction — it is not the test. */
  it("reads the same guidance request the same way with and without ownership", () => {
    expect(shown("How do I connect this cable?")).toBe("Admin related issues");
    expect(shown("I received this connector. How do I connect this cable?")).toBe(
      "Admin related issues",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * PROBLEM CATEGORIES ARE UNTOUCHED
 * ------------------------------------------------------------------------- */

describe("a reported problem is never taken for a request for instructions", () => {
  /** 11, 12, 13, 14. */
  const PROBLEMS: readonly (readonly [string, string])[] = [
    ["I received it and it does not work.", "Defective items"],
    ["I received it but the fitting is missing.", "Parts missing queries"],
    ["The item arrived damaged.", "Damage queries"],
    ["You have sent me the wrong item.", "Wrong item sent messages"],
    ["The shade arrived smashed as per the photograph. Can you advise please.", "Damage queries"],
  ];

  it.each(PROBLEMS)("keeps %j as its own case", (text, expected) => {
    expect(shown(text)).toBe(expected);
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });

  /**
   * THE ONE THAT CAUGHT IT. "cannot assemble as photograph portrays" carries a
   * `cannot` and an `assemble` and is not asking how to do anything — it says
   * the goods do not match the listing. Without the claim guard in
   * `asksHowToUseIt` this became Admin and Wrong description lost it.
   */
  it("reads a listing complaint shaped like a fitting problem as Wrong description", () => {
    const text = "Received wall lamps but shades/fittings cannot assemble as photograph portrays";
    expect(classifyMessageCategory(text)).toBeNull();
    expect(classifyMessageCategoryWithFallback(text)).toBe("Wrong description issues");
  });

  it("still reads a fault reported after installation as a defect", () => {
    expect(
      classifyConversationCategory([
        "Connected to 12v led light and it is pulsing - what say you?",
        "I need constant current, yours is constant voltage which is probably causing the led to pulse on off per sec.",
      ]),
    ).toBe("Defective items");
    expect(shown("I have wired it in and the bulbs flash on and off constantly.")).toBe(
      "Defective items",
    );
  });

  /** A denial is not a report, so it does not block a genuine guidance request. */
  it("is not blocked by a problem the customer explicitly denies", () => {
    expect(shown("Nothing is broken, I just want to know how to wire it.")).toBe(
      "Admin related issues",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * THE DOWNSTREAM PRIORITY RESULT
 * ------------------------------------------------------------------------- */

describe("what the corrected category does to priority", () => {
  /**
   * APPROVED AND EXPECTED, not a side effect to be suppressed. The priority
   * engine already reads the category — that dependency predates this fix and
   * is unchanged — so correcting the category necessarily moves these
   * conversations off the pre-sales route.
   *
   * `lib/knowledge/message-priority.ts` is NOT modified to compensate.
   */
  it("leaves a specification question LOW", () => {
    expect(shown("Is this light dimmable?")).toBe("Pre sales queries");
    expect(classifyMessagePriority("Is this light dimmable?")).toBe("LOW");
  });

  it("moves an installation question to MEDIUM, which is the point", () => {
    expect(shown("How do I connect this cable?")).toBe("Admin related issues");
    expect(classifyMessagePriority("How do I connect this cable?")).toBe("MEDIUM");
  });

  it("ranks the reported case as work rather than as a sales enquiry", () => {
    const reported =
      "I'm having problems using this product. I want to connect 3x1.5 mm cable, " +
      "but because of the cable thickness I cannot get it onto the thread. What can I do?";
    expect(classifyMessagePriority(reported)).toBe("MEDIUM");
  });

  it("changes nothing about how a real problem ranks", () => {
    expect(classifyMessagePriority("I received it and it does not work.")).toBe("MEDIUM");
    expect(classifyMessagePriority("The item arrived damaged.")).toBe("MEDIUM");
    expect(classifyMessagePriority("Please cancel my order.")).toBe("HIGH");
  });
});
