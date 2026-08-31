import { describe, expect, it } from "vitest";

import {
  type MessageCategory,
  classifyConversationCategory,
  classifyMessageCategoryWithFallback,
  explainMessageCategory,
} from "@/lib/knowledge/message-category";

/**
 * WHICH CATEGORY OWNS A MESSAGE, WHEN SEVERAL COULD CLAIM IT.
 *
 * Every case here is one the eleven workbooks genuinely disagree about, in the
 * sense that the same words appear in two or more of them. That is not a fault
 * in the documents — the Returns book lists "damaged" because damage is a reason
 * to accept a return, and the Defective book lists "shade smashed" because a
 * smashed shade arrives at the defect desk. What none of them can do is decide
 * the case, and these tests pin the decision.
 *
 * They are written as COMPLETE MESSAGES, as customers send them. A trigger
 * fragment lifted out of its sentence is the thing this whole design refuses to
 * classify on.
 */

/* ------------------------------------------------------------------------- *
 * CROSS-CATEGORY COLLISIONS
 * ------------------------------------------------------------------------- */

describe("the problem owns the case, not the remedy asked for", () => {
  const CASES: readonly (readonly [string, string, MessageCategory])[] = [
    [
      "damage with a refund request",
      "One of the shades arrived smashed. Please refund me.",
      "Damage queries",
    ],
    [
      "a fault with a refund request",
      "The driver arrived and does not work at all. I would like a refund please.",
      "Defective items",
    ],
    [
      "a wrong item with a return offered",
      "I ordered the black pendant and you sent the gold one. I can return it if you send the right one.",
      "Wrong item sent messages",
    ],
    [
      "a shortage with a replacement request",
      "I ordered 6 bulbs but only received 3. Please send the missing three.",
      "Wrong quantity sent issues",
    ],
    [
      "an absent part with a refund request",
      "The lamp arrived but the mounting screws are missing from the box. I want my money back.",
      "Parts missing queries",
    ],
    [
      "a listing error with a refund request",
      "The listing states 150cm but the cord I received is only 90cm. Please refund me.",
      "Wrong description issues",
    ],
    [
      "a change of mind, where nothing is wrong",
      "I received my parcel today but the colour is not what I expected. Can I return them and swap both for black?",
      "Return and refunds",
    ],
  ];

  it.each(CASES)("reads %s as its problem", (_name, text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });
});

describe("damage, delivery and a functional fault are three different things", () => {
  const CASES: readonly (readonly [string, MessageCategory])[] = [
    ["The outer box was crushed but everything inside is fine.", "Delivery queries"],
    ["The box was fine but the glass shade inside is smashed.", "Damage queries"],
    ["The lamp arrived in perfect condition but it does not switch on.", "Defective items"],
    ["Tracking says delivered but I have not received anything.", "Delivery queries"],
    ["The transformer casing arrived cracked.", "Damage queries"],
  ];

  it.each(CASES)("reads %j correctly", (text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });
});

describe("a quantity, a component and a different item are three different things", () => {
  const CASES: readonly (readonly [string, MessageCategory])[] = [
    ["I ordered two transformers and only one arrived.", "Wrong quantity sent issues"],
    ["The package arrived without the required bracket.", "Parts missing queries"],
    ["I ordered the braided black flex and received a plain white one.", "Wrong item sent messages"],
    ["I received my lampshades but there was only one white plastic reducer.", "Parts missing queries"],
  ];

  it.each(CASES)("reads %j correctly", (text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });
});

describe("a pre-sales question survives the vocabulary it shares", () => {
  const PRE_SALES: readonly string[] = [
    "Does this transformer have two galvanically isolated windings?",
    "Could you confirm whether the primary and secondary windings are electrically isolated please",
    "Is this light dimmable and can I use it outdoors?",
    "What is your return policy if it does not suit?",
    "How many bulbs are included for the price?",
    "When will the twisted cable set be back in stock?",
    "Which driver would I need for a 60w LED strip?",
  ];

  it.each(PRE_SALES)("keeps %j in pre-sales", (text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Pre sales queries");
  });

  it("gives up pre-sales the moment a real problem is asserted", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "I asked about the wattage before buying and the driver you sent does not work.",
      ),
    ).toBe("Defective items");
  });
});

describe("admin owns paperwork, and yields to everything else", () => {
  it("keeps an invoice request in admin however much product it names", () => {
    expect(
      classifyMessageCategoryWithFallback("Can you please send a VAT invoice for the 12v 100w driver?"),
    ).toBe("Admin related issues");
  });

  it("keeps a German missing-invoice request in admin", () => {
    expect(classifyMessageCategoryWithFallback("Leider fehlt uns die Rechnung hierzu, bitte senden.")).toBe(
      "Admin related issues",
    );
  });

  /**
   * ADMIN IS A FALLBACK, AND A FALLBACK OUTRANKS NOTHING. Each of these used to
   * reach Admin through a word that has nothing to do with the case.
   */
  const NOT_ADMIN: readonly (readonly [string, MessageCategory])[] = [
    ["I paid for next day delivery and it is a week late.", "Delivery queries"],
    ["We have gone to wire the light up, plugged it in and it has gone bang in the switch.", "Defective items"],
  ];

  it.each(NOT_ADMIN)("does not let an admin word take %j", (text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * METAMORPHIC: THE SAME MESSAGE, WRITTEN DIFFERENTLY
 * ------------------------------------------------------------------------- */

describe("the same message classified the same way however it is typed", () => {
  /**
   * A CATEGORY THAT DEPENDS ON A QUESTION MARK IS NOT A CATEGORY.
   *
   * Customers write without punctuation, in capitals, with emoji, with HTML
   * entities that survived a marketplace's escaping, and with the sentences in a
   * different order. None of that changes what they are telling us, so none of
   * it may change the answer. These are deliberately transformations of MEANING-
   * PRESERVING kinds only — no typo dictionary, because a fragile list of
   * misspellings would be a worse test than none.
   */
  const VARIANTS: readonly (readonly [string, readonly string[], MessageCategory])[] = [
    [
      "a smashed shade",
      [
        "One of the shades arrived smashed.",
        "one of the shades arrived smashed",
        "ONE OF THE SHADES ARRIVED SMASHED!!!",
        "Hi there — one of the shades arrived smashed. Many thanks, Trevor",
        "One of the shades arrived smashed 😞",
        "One of the shade&apos;s arrived smashed.",
        "One of the shades\narrived\nsmashed.",
        "The order came this morning. One of the shades arrived smashed.",
        "One of the shades arrived smashed. The order came this morning.",
      ],
      "Damage queries",
    ],
    [
      "a dimmable question",
      [
        "Is this light dimmable?",
        "is this light dimmable",
        "IS THIS LIGHT DIMMABLE",
        "Hello, is this light dimmable? Thanks in advance.",
        "Is this lamp dimmable &amp; suitable for a dimmer switch?",
      ],
      "Pre sales queries",
    ],
    [
      "a non-delivery",
      [
        "Tracking says delivered but I have not received anything.",
        "tracking says delivered but i have not received anything",
        "Tracking says delivered but I have not recieved anything",
        "Hi, tracking says delivered but I have not received anything. Regards",
      ],
      "Delivery queries",
    ],
    [
      "a shortage",
      [
        "I ordered 6 bulbs but only received 3.",
        "i ordered 6 bulbs but only received 3",
        "I ordered six bulbs but only received three.",
        "Hi. I ordered 6 bulbs but only received 3. Thanks!",
      ],
      "Wrong quantity sent issues",
    ],
  ];

  for (const [name, variants, expected] of VARIANTS) {
    it(`keeps ${name} stable across rewordings`, () => {
      for (const variant of variants) {
        expect(classifyMessageCategoryWithFallback(variant), variant).toBe(expected);
      }
    });
  }
});

/* ------------------------------------------------------------------------- *
 * ASSERTION, QUESTION, NEGATION
 * ------------------------------------------------------------------------- */

describe("asking about a thing is not reporting it", () => {
  const PAIRS: readonly (readonly [string, MessageCategory, string, MessageCategory])[] = [
    [
      "Does it have two windings?",
      "Pre sales queries",
      "One winding is missing from the transformer I received.",
      "Parts missing queries",
    ],
    [
      "Is it one lamp or a pair for that price?",
      "Pre sales queries",
      "I ordered two but received one.",
      "Wrong quantity sent issues",
    ],
    [
      "Is the colour copper or more of a bronze?",
      "Pre sales queries",
      "The listing says copper but the shade I received is red.",
      "Wrong description issues",
    ],
    [
      "Will this shade be too big for a 28mm pendant?",
      "Pre sales queries",
      "The glass shades I received are too large to fit under the chamfered edge.",
      "Wrong item sent messages",
    ],
  ];

  it.each(PAIRS)(
    "separates the question %j from the report %j",
    (question, questionCategory, report, reportCategory) => {
      expect(classifyMessageCategoryWithFallback(question), question).toBe(questionCategory);
      expect(classifyMessageCategoryWithFallback(report), report).toBe(reportCategory);
    },
  );
});

describe("a concept the customer rules out is not evidence for it", () => {
  const DENIALS: readonly string[] = [
    "Nothing is broken, I just want to check the wiring before I fit it.",
    "The item is not damaged, the box was just scuffed.",
    "It is not faulty, I had wired it wrongly. All working now.",
    "I am not asking for a refund, I only want to know the diameter.",
    "The box is damaged but the item inside is completely fine.",
  ];

  it.each(DENIALS)("takes no problem from %j", (text) => {
    const category = classifyMessageCategoryWithFallback(text);
    expect(category, text).not.toBe("Damage queries");
    expect(category, text).not.toBe("Defective items");
  });

  it("takes nothing from the correction in the rollert4 message", () => {
    const explained = explainMessageCategory(
      "However, it unfortunately has nothing to do with my actual question! " +
        "I wanted to know exactly whether this transformer has two galvanically isolated windings? " +
        "I didn't ask about the power rating!",
    );
    expect(explained.semantics.claims.absent_component).toBe("not_stated");
    expect(explained.category).toBe("Pre sales queries");
  });
});

/* ------------------------------------------------------------------------- *
 * THE CURRENT UNRESOLVED INTENT, ACROSS A THREAD
 * ------------------------------------------------------------------------- */

describe("a conversation is decided by what is still open", () => {
  const THREADS: readonly (readonly [string, readonly string[], MessageCategory | null])[] = [
    [
      "a chase answered by the parcel arriving damaged",
      ["Where is my parcel?", "It arrived but the shade is smashed."],
      "Damage queries",
    ],
    [
      "a chase nothing has answered",
      ["Where is my parcel?", "Still nothing has arrived."],
      "Delivery queries",
    ],
    [
      "a chase the customer gives up on",
      [
        "I have paid an electrician to attend on Saturday, I need this today at the latest.",
        "No, as I've said I paid an electrician on Saturday to fix one I got from B&Q. Please issue the refund.",
      ],
      "Return and refunds",
    ],
    [
      "a technical question the customer has to repeat",
      [
        "What power is this transformer?",
        "That wasn't my question. I need to know whether the windings are electrically isolated.",
      ],
      "Pre sales queries",
    ],
    [
      "a pre-sales colour question that becomes a swap",
      ["Do you have these in black?", "I received the red ones and would like to return them for black."],
      "Return and refunds",
    ],
    [
      "a parts case the customer closes themselves",
      ["A part is missing from the box.", "Found it, all sorted, thank you."],
      "Parts missing queries",
    ],
    [
      "a parts case closed, then a new fault",
      [
        "A part is missing from the box.",
        "Found it, all sorted, thank you.",
        "Now the bulb does not work at all.",
      ],
      "Defective items",
    ],
    [
      "a delivery chase that becomes a shortage",
      ["Has my order been sent yet?", "It came today but I ordered 4 and only 2 arrived."],
      "Wrong quantity sent issues",
    ],
    [
      "a damage case that continues into a replacement",
      ["The glass shade arrived cracked.", "When will the replacement arrive?"],
      "Damage queries",
    ],
    [
      "a thread that is only the customer signing off",
      ["All sorted now.", "Many thanks!"],
      null,
    ],
    [
      "a pre-sales thread that stays pre-sales",
      ["Is this suitable for a bathroom?", "And what is the IP rating?"],
      "Pre sales queries",
    ],
    [
      "an invoice request with a product mentioned",
      ["Could you send me the VAT invoice for the 100w driver please?", "My email is on the order."],
      "Admin related issues",
    ],
    [
      "a wrong item confirmed by a later message",
      [
        "Hi, received two vintage wall lamps as ordered, but are unable to assemble these as the glass shades are too large to fit underneath the chamfered edge to secure properly.",
        "The fixing supplied belongs to another type of light. Please send a return label.",
      ],
      "Wrong item sent messages",
    ],
    [
      "a cancellation before dispatch",
      ["I have just ordered this by mistake.", "Please cancel it before you send it."],
      "Order change, before shipping queries",
    ],
    [
      "a listing complaint that stays one",
      [
        "The listing states the cord is 150cm.",
        "The one I received measures 90cm, which is not as described.",
      ],
      "Wrong description issues",
    ],
    [
      "a defect reported after an installation question",
      ["Which wire is live on this pendant?", "It is wired correctly now and it still does not come on."],
      "Defective items",
    ],
    [
      "a customer who received the wrong colour and wants the right one",
      ["I ordered the rustic red shades but you sent copper ones. Please send the red ones."],
      "Wrong item sent messages",
    ],
    [
      "a refund chase after a return",
      ["I posted the return last week.", "I still have not received my refund."],
      "Return and refunds",
    ],
    [
      "a delivery chase in German",
      ["Hallo, meine Sendung ist noch nicht angekommen.", "Gibt es ein Update zur Sendungsverfolgung?"],
      "Delivery queries",
    ],
    [
      "a German technical question",
      [
        "Hallo, ich hätte gerne gewußt ob das wirklich 2 getrennte Wicklungen sind? Mir geht es um die Galvanische Trennung zur Netzspannung!",
        "However, it unfortunately has nothing to do with my actual question! I wanted to know whether this transformer has two isolated windings? I didn't ask about the power rating!",
      ],
      "Pre sales queries",
    ],
    [
      "a customer asking for a manual",
      ["Is there a wiring diagram for this fitting?", "A PDF would be fine, thank you."],
      "Admin related issues",
    ],
    [
      "a box damaged in transit with the contents intact",
      ["The box arrived crushed.", "Everything inside seems fine though."],
      "Delivery queries",
    ],
    [
      "an order amendment asked for as a preference",
      ["Hi, I have just ordered this cage but want it in black please.", "Please ensure you send me a black one."],
      "Order change, before shipping queries",
    ],
    [
      "a return already under way, arguing about postage",
      [
        "Due to the physical size and weight of my returning parcel, I believe the cost should be no more than a standard first class letter.",
      ],
      "Return and refunds",
    ],
    [
      "a customer asking where to send it back",
      ["Do you want me to send the parcel straight back to you, or to Amazon?"],
      "Return and refunds",
    ],
    [
      "a stolen parcel",
      ["The courier left it on the doorstep and someone stole it."],
      "Delivery queries",
    ],
  ];

  it.each(THREADS)("reads %s", (_name, messages, expected) => {
    expect(classifyConversationCategory(messages)).toBe(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * THE REAL REGRESSIONS
 * ------------------------------------------------------------------------- */

describe("every reported real case, in the customer's own words", () => {
  it("rollert4 — a transformer winding clarification is a pre-sales query", () => {
    expect(
      classifyConversationCategory([
        "Hallo, ich hätte gerne gewußt ob das wirklich 2 getrennte Wicklungen sind? Mir geht es um die Galvanische Trennung zur Netzspannung!",
        "Hello James, Thank you for your reply. However, it unfortunately has nothing to do with my actual question! " +
          'I wanted to know exactly whether this transformer "has two galvanically/electrically isolated windings"? ' +
          "I didn't ask about the power rating! I would be very grateful for a correct answer.",
      ]),
    ).toBe("Pre sales queries");
  });

  it("trego0-13 — a shade that arrived smashed is a damage case", () => {
    expect(
      classifyConversationCategory([
        "Have received my order from your good selves this morning, however one of the shades arrived smashed as per the photograph. Can you advise please. Thank you.",
      ]),
    ).toBe("Damage queries");
  });

  it("lcra1821 — six bulbs ordered, three received", () => {
    expect(classifyConversationCategory(["I ordered 6 bulbs but only received 3."])).toBe(
      "Wrong quantity sent issues",
    );
  });

  it("bilal5124 — two ordered, one driver received", () => {
    expect(classifyConversationCategory(["I ordered 2 but only one driver arrived."])).toBe(
      "Wrong quantity sent issues",
    );
  });

  it("the crow wall lamp — a pack-size question before buying", () => {
    expect(classifyConversationCategory(["Is it just one crow for £19.89?"])).toBe("Pre sales queries");
  });

  it("a colour swap after delivery is a return", () => {
    expect(
      classifyConversationCategory([
        "I'm really sorry I received my parcel today but the colour is not what I expected. " +
          "Please is it possible to return it and swap them both for black. " +
          "Box is packaged exactly the same as I only took out the shades to look at.",
      ]),
    ).toBe("Return and refunds");
  });

  it("a deeper copper wanted, with a stock question, is a return", () => {
    expect(
      classifyConversationCategory([
        "The lamp arrived safely. I was hoping for a deeper copper colour though. Do you have that shade in stock so I could exchange it?",
      ]),
    ).toBe("Return and refunds");
  });

  it("three shades bought at an option price stays the admin fallback", () => {
    expect(
      classifyConversationCategory([
        "🤣brought 3 of these shades this week didn't know I could buy as an option £10.89. £10.89. £10.89",
      ]),
    ).toBe("Admin related issues");
  });

  it("zain2k11 — a spent delivery deadline followed by a refund request", () => {
    expect(
      classifyConversationCategory([
        "I have paid an electrician to attend on Saturday to put all the lighting in, I need this today or early morning tomorrow at the latest.",
        "No, as I've said I paid an electrician on Saturday to fix one I've got from B&Q. Please issue the refund.",
      ]),
    ).toBe("Return and refunds");
  });

  it("murgatroyd88 — damage found on unpacking, blamed on the post", () => {
    expect(
      classifyConversationCategory([
        "Hi. We've just opened the box for the first time since receiving it, and unfortunately one shade is broken. It must have happened in the post.",
      ]),
    ).toBe("Damage queries");
  });

  it("0193london — shades too large to assemble is a wrong item", () => {
    expect(
      classifyConversationCategory([
        "Hi, received two vintage wall lamps as ordered, but are unable to assemble these as the glass shades are too large to fit underneath the champhored edge to secure properly.",
      ]),
    ).toBe("Wrong item sent messages");
  });
});
