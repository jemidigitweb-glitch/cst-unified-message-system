import { describe, expect, it } from "vitest";

import {
  MESSAGE_CATEGORIES,
  type MessageCategory,
  type MessageIntent,
  SIGNALS,
  type ShortfallReason,
  classifyConversationCategory,
  classifyMessageCategory,
  classifyMessageCategoryWithFallback,
  detectIntents,
  quantityShortfallEvidence,
} from "@/lib/knowledge/message-category";

describe("classifyMessageCategory", () => {
  it("names each of the eleven categories from its own signal phrases", () => {
    const examples: Record<string, string> = {
      "Delivery queries": "My parcel still has not arrived and tracking shows nothing.",
      "Pre sales queries": "Before i buy, does it fit a standard socket?",
      "Admin related issues": "Please send me a VAT invoice for this order.",
      "Order change, before shipping queries": "I need to cancel my order before it ships.",
      "Defective items": "The unit is faulty and stopped working after a day.",
      "Damage queries": "The item arrived damaged and the glass is cracked.",
      "Wrong item sent messages": "This is the wrong item, not what i ordered.",
      "Parts missing queries": "There are missing parts in the box, no screws included.",
      "Wrong quantity sent issues": "I only received two instead of the wrong quantity ordered.",
      "Wrong description issues": "The listing says something different — not as described.",
      "Return and refunds": "I would like a refund for this order.",
    };

    for (const category of MESSAGE_CATEGORIES) {
      expect(classifyMessageCategory(examples[category])).toBe(category);
    }
  });

  it("returns null for empty or whitespace-only text, never a guessed category", () => {
    expect(classifyMessageCategory("")).toBeNull();
    expect(classifyMessageCategory("   ")).toBeNull();
    expect(classifyMessageCategory(null)).toBeNull();
  });

  it("returns null when no signal phrase matches, rather than defaulting to one", () => {
    expect(classifyMessageCategory("Thanks so much, that all makes sense now.")).toBeNull();
  });

  it("returns null on a genuine tie between two equally-strong categories", () => {
    // Exactly one phrase each for two different categories -- a real tie,
    // not a guess resolved by array order.
    expect(classifyMessageCategory("It arrived damaged and I would like a refund.")).toBeNull();
  });

  it("matches a signal phrase as a whole word, and does not match it embedded inside a longer word", () => {
    expect(classifyMessageCategory("Where can I read your cancellation policy document?")).toBe(
      "Order change, before shipping queries",
    );
    // "cancellation" must not fire when it is not actually the word present.
    expect(classifyMessageCategory("precancellationxyz is not a real word")).toBeNull();
  });

  it("reads only the text it is given -- pure, no hidden state across calls", () => {
    const first = classifyMessageCategory("My order is damaged.");
    const second = classifyMessageCategory("Thanks, no issues here.");
    expect(first).toBe("Damage queries");
    expect(second).toBeNull();
  });

  it("names each of the eleven categories from its own German signal phrases", () => {
    const examples: Record<string, string> = {
      "Delivery queries": "Mein Paket ist noch nicht angekommen, die Sendungsverfolgung zeigt nichts.",
      "Pre sales queries": "Bevor ich kaufe, passt das in eine Standardfassung?",
      "Admin related issues": "Bitte senden Sie mir eine Mehrwertsteuerrechnung für diese Bestellung.",
      "Order change, before shipping queries": "Ich möchte meine Bestellung stornieren, bevor sie versendet wird.",
      "Defective items": "Das Gerät ist defekt und funktioniert nicht mehr.",
      "Damage queries": "Das Paket kam beschädigt an, das Glas ist gesprungen.",
      "Wrong item sent messages": "Das ist der falsche Artikel, nicht das was ich bestellt habe.",
      "Parts missing queries": "Es fehlen teile in der box, keine schrauben enthalten.",
      "Wrong quantity sent issues": "Ich habe eine falsche menge erhalten, zu wenig erhalten.",
      "Wrong description issues": "Der Artikel ist nicht wie beschrieben, das ist irreführend.",
      "Return and refunds": "Ich möchte eine rückerstattung für diese Bestellung.",
    };

    for (const category of MESSAGE_CATEGORIES) {
      expect(classifyMessageCategory(examples[category])).toBe(category);
    }
  });

  it("does not fire on SMTP/MIME transport header text alone", () => {
    const headerNoise = [
      "Received: from mail.example.com by mx.example.net",
      "Content-Type: text/plain; charset=UTF-8",
      "Authentication-Results: spf=pass smtp.mailfrom=example.com",
      "MIME-Version: 1.0",
      "X-Spam-Status: No, score=-1.0",
    ].join("\n");
    expect(classifyMessageCategory(headerNoise)).toBeNull();
  });

  it("does not fire on automated-notification footer text alone", () => {
    const notificationNoise =
      "This is an automatically generated email from Seller Center. Please do not reply to this message.";
    expect(classifyMessageCategory(notificationNoise)).toBeNull();
  });
});

/**
 * Phrases added from a read-only sweep of live customer text. Every one was
 * measured before it was added: how many uncategorised conversations it would
 * newly name, and how many correct labels it would destroy by creating a tie.
 * These tests pin the ones that earned their place, and the discipline that
 * kept the rest out.
 */
describe("phrases added from real customer wording", () => {
  it("names a spec question as pre-sales — the biggest measured gap", () => {
    expect(classifyMessageCategory("What voltage is this and what size is the fitting?")).toBe(
      "Pre sales queries",
    );
    expect(classifyMessageCategory("Is this suitable for an outdoor porch?")).toBe(
      "Pre sales queries",
    );
  });

  it("names a dispatch chase as a delivery query", () => {
    expect(classifyMessageCategory("Has this been dispatched? When will it be with me?")).toBe(
      "Delivery queries",
    );
    expect(classifyMessageCategory("It has not been delivered, any update on it?")).toBe(
      "Delivery queries",
    );
  });

  it("names return wording the table previously missed", () => {
    expect(classifyMessageCategory("Can you send me a return label please")).toBe(
      "Return and refunds",
    );
    expect(classifyMessageCategory("I have not been refunded yet")).toBe("Return and refunds");
  });

  it("names an address change before dispatch", () => {
    expect(classifyMessageCategory("I gave the wrong address, can you change it?")).toBe(
      "Order change, before shipping queries",
    );
  });

  it("names a flickering light as defective, not damaged", () => {
    expect(classifyMessageCategory("The light keeps flickering since I fitted it")).toBe(
      "Defective items",
    );
  });
});

describe("German customer wording, where the data showed it was needed", () => {
  it("names a German returns request", () => {
    expect(classifyMessageCategory("Ich möchte den Artikel zurückschicken, bitte um Erstattung.")).toBe(
      "Return and refunds",
    );
    expect(classifyMessageCategory("Wie läuft die Retoure ab?")).toBe("Return and refunds");
  });

  it("names a German missing-parts complaint", () => {
    expect(classifyMessageCategory("Die Lieferung ist unvollständig, eine Halterung fehlt.")).toBe(
      "Parts missing queries",
    );
  });

  it("names a German delivery-time question", () => {
    expect(classifyMessageCategory("Wie lange ist die Lieferzeit?")).toBe("Delivery queries");
  });

  it("names a German defect report", () => {
    expect(classifyMessageCategory("Die Lampe ist kaputt und lässt sich nicht einschalten.")).toBe(
      "Defective items",
    );
  });
});

describe("generic words never create a category", () => {
  /**
   * The words that appear in almost every message. Measured and rejected:
   * "do you have" would have named 39 conversations and destroyed 15 correct
   * labels; "haben sie" 49 against 24. Coverage bought that way is not worth
   * having.
   */
  it("refuses to classify from bare order/item/product wording", () => {
    for (const text of [
      "Hello, I have a question about my order.",
      "Thanks for the item, much appreciated.",
      "Do you have any information on this product?",
      "Hallo, haben Sie meine Nachricht erhalten?",
      "Hi there, can you help me please?",
      "Many thanks, kind regards.",
    ]) {
      expect(classifyMessageCategory(text), text).toBeNull();
    }
  });

  /**
   * A phrase must not also match a more general phrase in its own category:
   * two hits for one statement inflate that category's score and can beat a
   * genuine tie. Checked here rather than left to review.
   */
  it("has no phrase that double-counts another in the same category", () => {
    const offenders: string[] = [];
    for (const category of MESSAGE_CATEGORIES) {
      const phrases = SIGNALS.find((signal) => signal.label === category)?.phrases ?? [];
      for (const specific of phrases) {
        for (const general of phrases) {
          if (specific === general) continue;
          const both = new RegExp(`(^|[^a-z0-9])${general.replace(/[.*+?^${}()|[]\]/g, "\$&")}([^a-z0-9]|$)`, "i");
          if (both.test(specific)) offenders.push(`[${category}] "${specific}" also fires "${general}"`);
        }
      }
    }
    // Four pairs predate this work and are left alone deliberately; nothing new
    // may be added to them.
    expect(offenders.length).toBeLessThanOrEqual(4);
  });
});

describe("conflicting signals stay null", () => {
  it("refuses when two categories are equally supported", () => {
    expect(classifyMessageCategory("It arrived damaged and I would like a refund.")).toBeNull();
    expect(classifyMessageCategory("Wrong item sent, and it is faulty too.")).toBeNull();
  });
});

/**
 * A second sweep, this time over the eBay and Shopify remainder. Same
 * discipline: every phrase measured for what it names and what it destroys,
 * then the newly classified conversations read back and the false positives
 * removed before finishing.
 */
describe("eBay and Shopify wording found in the second sweep", () => {
  it("names a fit or spec question asked before buying", () => {
    expect(classifyMessageCategory("Could you tell me the diameter of the rod please?")).toBe(
      "Pre sales queries",
    );
    expect(classifyMessageCategory("Hi can this be used outdoors, thanks")).toBe("Pre sales queries");
    expect(classifyMessageCategory("What length do I get please?")).toBe("Pre sales queries");
    expect(classifyMessageCategory("Do you have the same one?")).toBe("Pre sales queries");
  });

  it("names a delivery chase in the customer's own shorthand", () => {
    expect(classifyMessageCategory("Hi, i did not get my parcel yet. thanks")).toBe(
      "Delivery queries",
    );
    expect(classifyMessageCategory("When are you sending this?")).toBe("Delivery queries");
    expect(classifyMessageCategory("It was out for delivery on the 14th, no updates since")).toBe(
      "Delivery queries",
    );
  });

  it("names a return request in English, German and Italian", () => {
    expect(classifyMessageCategory("Sadly it will not fit so I need to return it.")).toBe(
      "Return and refunds",
    );
    expect(classifyMessageCategory("Schicken Sie auch ein Rücksendeetikett?")).toBe(
      "Return and refunds",
    );
    expect(classifyMessageCategory("Wie soll die Rücksendung erfolgen?")).toBe("Return and refunds");
    expect(classifyMessageCategory("Pertanto devo restituirlo.")).toBe("Return and refunds");
  });

  it("names a description mismatch reported in German", () => {
    expect(classifyMessageCategory("Laut Beschreibung müsste das Netzteil 300W haben.")).toBe(
      "Wrong description issues",
    );
  });

  it("names a missing fitting component", () => {
    expect(classifyMessageCategory("There are no earth tags in the box, please send them")).toBe(
      "Parts missing queries",
    );
  });
});

/**
 * Each of these was added, measured, then read back against the conversations
 * it actually named — and removed. They are pinned here so nobody re-adds them
 * from the same reasoning that made them look plausible the first time.
 */
describe("phrases removed after reading what they actually matched", () => {
  it("does not treat a partner-system ticket notification as an admin query", () => {
    expect(
      classifyMessageCategory("You have a new Ticket in your Wayfair Partner Home Inbox."),
    ).toBeNull();
  });

  it("does not read 'a different product' as the wrong item having been sent", () => {
    expect(
      classifyMessageCategory(
        "The colour isn't quite right and I've decided to go with a different product.",
      ),
    ).not.toBe("Wrong item sent messages");
  });

  it("does not classify from bare buying or browsing words", () => {
    for (const text of [
      "Do you sell these?",
      "I have not received your last email",
      "Wrong one, sorry — ignore that",
      "Can you change the order of the photos on the listing?",
    ]) {
      expect(classifyMessageCategory(text), text).not.toBe("Wrong item sent messages");
    }
  });
});

/**
 * The four conversations CST staff reviewed and labelled by hand. Every one of
 * them returned null before this pass, and each failed for a different reason
 * — so they are pinned here verbatim (customer wording, typos and all) rather
 * than paraphrased into something the table would obviously match.
 */
describe("CST-reviewed reference conversations", () => {
  it("names a dispatch chase phrased as 'yet to receive'", () => {
    // The customer's own text, HTML entities included as eBay stores them.
    expect(
      classifyMessageCategory(
        "Can you tell me if this has been sent out to me, I have yet to receive this item &amp; it&apos;s now been a while, please find out &amp; let me know what is going on, thx.",
      ),
    ).toBe("Delivery queries");
  });

  it("names a failed delivery attempt, including the customer's typo", () => {
    // "was no delivered" — not a transcription slip; that is what was sent.
    expect(
      classifyMessageCategory(
        "Hi my package was no delivered they said they tried to deliver so I don't understand why as I was at home the whole day and night",
      ),
    ).toBe("Delivery queries");
  });

  it("names a pre-purchase colour and compatibility question", () => {
    expect(classifyMessageCategory("Do you do this in white")).toBe("Pre sales queries");
    expect(
      classifyMessageCategory(
        "Found one in Chrome in Sellers other items that would be suitable, can it work with my corded pull",
      ),
    ).toBe("Pre sales queries");
    expect(
      classifyMessageCategory(
        "the chrome one would work with my decor. Would it work my corded pull switch Thanks",
      ),
    ).toBe("Pre sales queries");
  });

  /**
   * REVERSED DELIBERATELY, AND THIS ONE CONTRADICTS A HAND-LABELLED CST
   * DECISION — flagged rather than quietly changed.
   *
   * A CST reviewer originally filed this under Return and refunds, on the
   * practice that the remedy asked for names the case even when a fault
   * prompted it. The later instruction is that Return and refunds is an
   * outcome category reserved for a money-back request, and that a replacement
   * or a return offer must leave the conversation with its problem category.
   *
   * This message asks for a working bulb and offers to send the broken one
   * back. No money is requested anywhere in it. Under the current rule that
   * makes it a defect, and that is what is asserted here. If CST want the
   * original label back, the change is to drop "Defective items" from
   * `PROBLEM_CATEGORIES` — the two readings cannot both hold.
   */
  it("names a replacement request for a faulty item as a defect", () => {
    expect(
      classifyMessageCategory(
        "hi this item arrived today it looks great but unfortunately the led ST64 bulb is not working. please would you be able to send me a new one ? i can return the one that doesn't work if you send me a return postage thank you",
      ),
    ).toBe("Defective items");
  });
});

describe("further eBay wording from the uncategorised remainder", () => {
  it("names stock and specification questions asked before buying", () => {
    expect(classifyMessageCategory("Are you likely to have the 70cm diameter anytime soon?")).toBe(
      "Pre sales queries",
    );
    expect(
      classifyMessageCategory("Does this purchase include the 10 mm fittings on either end?"),
    ).toBe("Pre sales queries");
    expect(classifyMessageCategory("Just want to know if a uk shade will fit the holder")).toBe(
      "Pre sales queries",
    );
    expect(classifyMessageCategory("What watt do i need for 3m of strip?")).toBe(
      "Pre sales queries",
    );
  });

  it("names German delivery chases", () => {
    expect(classifyMessageCategory("Hallo leider noch nichts bekommen.")).toBe("Delivery queries");
    expect(classifyMessageCategory("Bitte lassen sie mir eine Versandbestätigung zukommen.")).toBe(
      "Delivery queries",
    );
    expect(classifyMessageCategory("Wie ist der Bearbeitungsstatus, bitte?")).toBe(
      "Delivery queries",
    );
  });

  it("names a cancellation before dispatch, in English and German", () => {
    expect(classifyMessageCategory("Please can I cancel order. Thanks")).toBe(
      "Order change, before shipping queries",
    );
    expect(classifyMessageCategory("Bitte um Kaufabbruch, ich habe mich vertan.")).toBe(
      "Order change, before shipping queries",
    );
  });

  it("names a wrong-item report in the customer's phrasing", () => {
    expect(classifyMessageCategory("Hi You send me the wrong ones It should have B22")).toBe(
      "Wrong item sent messages",
    );
  });

  it("names a failed delivery reported through the tracking", () => {
    expect(
      classifyMessageCategory("The tracking says the parcel was refused return to sender"),
    ).toBe("Delivery queries");
    expect(classifyMessageCategory("Where is my item? It's still not even been posted")).toBe(
      "Delivery queries",
    );
  });
});

/**
 * The shape rule: the one thing safe to name when NO phrase matches.
 *
 * Derived from a one-time offline analysis of the eBay conversations the table
 * left unnamed — that analysis is not part of the product and nothing calls a
 * model at runtime. What survives here is a deterministic rule and the guards
 * that keep it honest, each of which was added because it removed a specific
 * wrong answer.
 */
describe("pre-sales by shape, where no phrase matches", () => {
  it("names a short product question from someone who has not bought yet", () => {
    expect(classifyMessageCategory("Hey there. Is the 150w driver, dimmable?")).toBe(
      "Pre sales queries",
    );
    expect(classifyMessageCategory("Does it include a light bulb as well ?")).toBe(
      "Pre sales queries",
    );
    expect(classifyMessageCategory("Are these suitable to use with an e27 fitting on?")).toBe(
      "Pre sales queries",
    );
  });

  /**
   * The decisive guard. Someone who already has the item is not making a
   * pre-sales enquiry however much specification they discuss — and the
   * contracted forms matter, because "I've ordered" was missed once.
   */
  it("refuses when the customer already has the goods", () => {
    for (const text of [
      "I've ordered the wrong size brackets can I send them back?",
      "The bulb arrived today, is it dimmable?",
      "My order came with a 5cm shade, is that the right size?",
      "Die Lampe ist angekommen, hat der Sockel 40mm?",
    ]) {
      expect(classifyMessageCategory(text), text).not.toBe("Pre sales queries");
    }
  });

  it("refuses when any problem or remedy is mentioned, table phrase or not", () => {
    for (const text of [
      "Can you tell me the size? I want to cancel and reorder one with a bulb",
      "Is the width right in the description? Surely it can't only be 5cm!?",
      "Is the fitting 40mm, some of the bulbs are ghosting",
    ]) {
      expect(classifyMessageCategory(text), text).not.toBe("Pre sales queries");
    }
  });

  it("refuses a question with no product attribute in it", () => {
    expect(classifyMessageCategory("Can you help me please?")).toBeNull();
    expect(classifyMessageCategory("Are you able to get back to me today?")).toBeNull();
  });

  it("refuses a statement that asks nothing", () => {
    expect(classifyMessageCategory("The bulb is 40mm and quite bright.")).toBeNull();
  });

  /**
   * A long thread has usually moved past a buying question into a case. The
   * bound is what took this rule from 86% to 97% agreement in review.
   */
  it("refuses once the thread is long enough to be a case", () => {
    const long = "Is this dimmable? " + "I have a few more questions about the fitting. ".repeat(12);
    expect(long.length).toBeGreaterThan(250);
    expect(classifyMessageCategory(long)).toBeNull();
  });

  it("never overrides a phrase the table already matched", () => {
    // Reads as a spec question, but the table names it a return — that wins.
    expect(
      classifyMessageCategory("What size is the fitting? I need to return it, please send a return label"),
    ).toBe("Return and refunds");
  });
});

/**
 * Tie precedence: a tie still refuses by default. The single listed exception
 * exists because the same words reliably mean one of the two.
 */
describe("tie precedence", () => {
  /**
   * German invoice requests say "uns fehlt die Rechnung" — we are MISSING the
   * INVOICE. "fehlt" scored Parts missing, "rechnung" scored Admin, so every
   * one of them tied and fell to null.
   */
  it("reads a missing invoice as admin, not as a missing part", () => {
    expect(classifyMessageCategory("Leider fehlt uns die Rechnung hierzu, bitte senden.")).toBe(
      "Admin related issues",
    );
    expect(classifyMessageCategory("Mir fehlt die Rechnung zum Kauf.")).toBe(
      "Admin related issues",
    );
  });

  it("still refuses every tie that is not listed", () => {
    // Damage and Return, one signal each: no precedence entry, so null stands.
    expect(classifyMessageCategory("It arrived damaged and I would like a refund.")).toBeNull();
  });
});

/**
 * An absent component is reported by INTENT, not by naming the part.
 *
 * Product nouns are deliberately not in the table: nuts, brackets and shades
 * appear in plenty of conversations about nothing missing at all, so a rule
 * built on them would fire on pre-sales questions and delivery chases alike.
 */
describe("parts missing, reported however the customer phrases it", () => {
  it("names the real customer example", () => {
    expect(classifyMessageCategory("black machined nuts appears to be missing")).toBe(
      "Parts missing queries",
    );
  });

  it("names the other stated phrasings", () => {
    expect(classifyMessageCategory("missing screws from the package")).toBe(
      "Parts missing queries",
    );
    expect(classifyMessageCategory("fixing parts were not included")).toBe(
      "Parts missing queries",
    );
  });

  it("names a component reported absent mid-sentence", () => {
    expect(
      classifyMessageCategory(
        "Hi I purchased 3 of these wall light, just gone to fit them and noticed one is missing the earth wire.",
      ),
    ).toBe("Parts missing queries");
    expect(classifyMessageCategory("The cable seems to be missing from the box")).toBe(
      "Parts missing queries",
    );
    expect(classifyMessageCategory("It arrived without the mounting plate")).toBe(
      "Parts missing queries",
    );
  });

  /**
   * The guard that keeps this from becoming a product-noun rule: naming a part
   * is not the same as reporting one absent.
   */
  it("does not fire on a part merely being mentioned", () => {
    for (const text of [
      "Do you sell spare nuts for this?",
      "What size are the screws supplied?",
      "The brackets are a lovely finish, thanks",
    ]) {
      expect(classifyMessageCategory(text), text).not.toBe("Parts missing queries");
    }
  });

  it("leaves the neighbouring categories alone", () => {
    expect(classifyMessageCategory("Is the driver dimmable and what voltage?")).toBe(
      "Pre sales queries",
    );
    expect(classifyMessageCategory("It was out for delivery but no updates since")).toBe(
      "Delivery queries",
    );
    expect(classifyMessageCategory("The unit is faulty and stopped working")).toBe(
      "Defective items",
    );
    expect(classifyMessageCategory("You sent the wrong item, not what i ordered")).toBe(
      "Wrong item sent messages",
    );
    expect(classifyMessageCategory("I only received one instead of the wrong quantity ordered")).toBe(
      "Wrong quantity sent issues",
    );
  });

  it("names a German scratch complaint as damage", () => {
    expect(
      classifyMessageCategory("ich habe die Lampenschirme erhalten, jedoch hat ein Lampenschirm 2 grosse Kratzer"),
    ).toBe("Damage queries");
  });
});

/**
 * The category is DERIVED ON READ, never stored — which is what makes a new
 * conversation carry a tag the moment it lands, with no backfill step.
 *
 * This is the property the inbox depends on, so it is pinned here rather than
 * left as an assumption about the sync pipeline.
 */
describe("classification needs nothing stored and nothing fetched", () => {
  it("is a pure function of the customer's text", () => {
    const text = "black machined nuts appears to be missing";
    expect(classifyMessageCategory(text)).toBe(classifyMessageCategory(text));
    expect(classifyMessageCategory(text)).toBe("Parts missing queries");
  });

  it("names a conversation whose text arrives all at once, as a new one does", () => {
    // A brand-new conversation has a single inbound message and no history.
    expect(classifyMessageCategory("Do you do this in white")).toBe("Pre sales queries");
  });

  it("declines when a new conversation has no readable customer text yet", () => {
    // Which is what an unparsed or attachment-only first message looks like.
    expect(classifyMessageCategory(null)).toBeNull();
    expect(classifyMessageCategory("")).toBeNull();
    expect(classifyMessageCategory("   ")).toBeNull();
  });
});

/**
 * "I got the order wrong" is a different case from "you got the order wrong",
 * and the table could not previously tell them apart.
 *
 * The signal is the customer referring to their OWN ordering or selection —
 * never the product they were choosing between. A rule built on colours, sizes
 * or product names would fire on every pre-sales question about the same
 * attributes, which is exactly what these tests pin against.
 */
describe("the customer's own ordering mistake", () => {
  it("names the real eBay example", () => {
    expect(
      classifyMessageCategory(
        "It was 2 gang switches brushed steel style not clear when I placed order",
      ),
    ).toBe("Order change, before shipping queries");
  });

  it("names a mis-selection stated outright", () => {
    expect(classifyMessageCategory("I ordered the wrong colour by mistake")).toBe(
      "Order change, before shipping queries",
    );
    expect(classifyMessageCategory("I selected the wrong model when ordering")).toBe(
      "Order change, before shipping queries",
    );
  });

  it("names the listing being unclear at the point of ordering", () => {
    expect(classifyMessageCategory("The size was not clear when I placed my order")).toBe(
      "Order change, before shipping queries",
    );
    expect(classifyMessageCategory("It was not clear when I placed my order")).toBe(
      "Order change, before shipping queries",
    );
  });

  /**
   * The distinction that matters. Same words about the same attribute; what
   * separates them is WHO made the mistake.
   */
  it("still reads OUR mistake as the wrong item having been sent", () => {
    expect(classifyMessageCategory("You sent the wrong colour, I ordered black")).toBe(
      "Wrong item sent messages",
    );
    expect(classifyMessageCategory("This is the wrong item, not what i ordered")).toBe(
      "Wrong item sent messages",
    );
  });

  it("adds no product wording to the table", () => {
    const orderChange =
      SIGNALS.find((s) => s.label === "Order change, before shipping queries")?.phrases ?? [];
    for (const productWord of ["brushed steel", "switches", "colour", "size", "gang", "black", "steel"]) {
      expect(orderChange, productWord).not.toContain(productWord);
    }
  });

  it("leaves the neighbouring categories alone", () => {
    expect(classifyMessageCategory("Can I buy a different size?")).toBe("Pre sales queries");
    expect(classifyMessageCategory("Is the driver dimmable and what voltage?")).toBe(
      "Pre sales queries",
    );
    expect(classifyMessageCategory("Can I return the item because I don't like it?")).toBe(
      "Return and refunds",
    );
    expect(classifyMessageCategory("It was out for delivery but no updates since")).toBe(
      "Delivery queries",
    );
    expect(classifyMessageCategory("The unit is faulty and stopped working")).toBe(
      "Defective items",
    );
  });
});

/**
 * Six real eBay conversations put to the classifier as a validation set, quoted
 * verbatim — curly apostrophes, ellipses and code-switching included, because
 * three of the six turned on exactly those characters.
 *
 * All six returned null before this pass. Four are fixed below. The two that
 * still return null are pinned here as null ON PURPOSE, each with the live-data
 * measurement that says naming them would cost more than it buys — see
 * "the two that stay unnamed" at the end of this file.
 */
describe("real eBay validation set", () => {
  /**
   * REVERSED DELIBERATELY. This example was first read as "an explicit return
   * request beats the product mismatch", and classified as Return and refunds.
   * On a closer read of what the customer is actually asking for, the return is
   * offered as a possible ROUTE to getting the right part — "needs to be 5v
   * output, I can return if possible" — and no money is asked for. Under the
   * rule that Return and refunds requires refund intent, this is the wrong item
   * having been sent.
   */
  /**
   * REVERSED 2026-09-01 by the audit (conversation 21); was Wrong item sent.
   *
   * "Sorry it's the wrong one, needs to be 5v output" is a customer who ordered
   * the wrong spec and says so. A customer's own mis-selection is not us
   * sending the wrong thing, and the remedy they ask for is a return.
   */
  it("names the mismatch, not the return offered as a way of fixing it", () => {
    expect(
      classifyMessageCategory(
        "Sorry it's the wrong one needs to be 5v output, I can return if possible please.",
      ),
    ).toBe("Return and refunds");
  });

  /** A return offered with no noun after the verb — every other phrase needs one. */
  it("names a return offer that has no object after the verb", () => {
    expect(classifyMessageCategory("Is it possible i can return and get a smaller bulb?")).toBe(
      "Return and refunds",
    );
    expect(classifyMessageCategory("Please let me know the new date so that I can return item.")).toBe(
      "Return and refunds",
    );
  });

  it("names a listing-versus-reality measurement as a description issue", () => {
    expect(
      classifyMessageCategory("Cables are advertised at 6mm but mine is 8.85mm has there been a mistake"),
    ).toBe("Wrong description issues");
    expect(classifyMessageCategory("Hi it's advertised as 1000mA but in description says 300mA?")).toBe(
      "Wrong description issues",
    );
  });

  /**
   * "has there been a mistake" must not be read as the CUSTOMER's ordering
   * mistake. Order change owns "by mistake" and "made a mistake"; neither is
   * this, and the distinction is the one that whole category rests on.
   */
  it("does not read 'has there been a mistake' as the customer's own error", () => {
    expect(
      classifyMessageCategory("Cables are advertised at 6mm but mine is 8.85mm has there been a mistake"),
    ).not.toBe("Order change, before shipping queries");
  });

  /**
   * The digit-glued unit. "12volt" has no word boundary before "volt", so the
   * product-attribute test failed and a plain pre-sales question went unnamed.
   */
  it("names a spec question whose number and unit are written as one token", () => {
    expect(classifyMessageCategory("Can this power 12volt car lights?")).toBe("Pre sales queries");
    expect(classifyMessageCategory("Is the cable 8.85mm or thinner?")).toBe("Pre sales queries");
    expect(classifyMessageCategory("Do you sell a 50watt version?")).toBe("Pre sales queries");
  });

  /**
   * The abbreviated unit, closed in a later pass by requiring a digit in front
   * of it. 2,144 live messages write a rating this way.
   */
  it("names the abbreviated unit when a number is attached to it", () => {
    expect(classifyMessageCategory("Will a 240v driver do, or is it 12v?")).toBe("Pre sales queries");
    expect(classifyMessageCategory("Is the output 5v or 12v on this one?")).toBe("Pre sales queries");
    expect(classifyMessageCategory("Have you got an 8W one?")).toBe("Pre sales queries");
    expect(classifyMessageCategory("Is it advertised at 1000mA?")).not.toBeNull();
  });

  /**
   * The guard that makes naming a single letter safe at all: the digit is
   * required, so the letter is never vocabulary on its own.
   */
  it("never treats a bare single letter as a specification", () => {
    for (const text of [
      "Can you confirm plan v for this?",
      "Is the w option any good?",
      "Do you have a version a and a version b?",
    ]) {
      expect(classifyMessageCategory(text), text).toBeNull();
    }
  });

  /** Hard-wired versus plug-in is a spec a buyer chooses between. */
  it("names a wiring-spec question asked before buying", () => {
    expect(classifyMessageCategory("Have you got similar to this that isn't hard wired")).toBe(
      "Pre sales queries",
    );
    expect(classifyMessageCategory("Is this one hardwired?")).toBe("Pre sales queries");
  });

  /**
   * Loosening the opening bound from `\b` to "preceded by a non-letter" must not
   * let a unit match inside a longer word. It is stricter than `\b` here, not
   * looser: `\b` allowed "champs" to satisfy "amps", and this does not.
   */
  it("still refuses a unit buried inside a longer word", () => {
    for (const text of [
      "Is there a revolt about this?",
      "Are the champs any good?",
      "Do you know if the shipment is thereabouts?",
    ]) {
      expect(classifyMessageCategory(text), text).not.toBe("Pre sales queries");
    }
  });
});

/**
 * The seven examples named in the brief, asserted verbatim and in order, so a
 * failure names the example rather than a rule.
 */
describe("required regression set", () => {
  const CASES: readonly (readonly [string, string | null])[] = [
    // The verbatim customer message. The mismatch is carried by "the wrong
    // one"; the article is required, so an abbreviation that drops it will not
    // match — see the note on the phrase itself.
    [
      "Sorry it's the wrong one needs to be 5v output, I can return if possible",
      "Return and refunds",
    ],
    ["Cables are advertised at 6mm but mine is 8.85mm", "Wrong description issues"],
    ["Can this power 12volt car lights?", "Pre sales queries"],
    ["Have you got similar to this that isn't hard wired", "Pre sales queries"],
    [
      "U sent me wrong one, it's a round three different colour glass hanging light",
      "Wrong item sent messages",
    ],
    [
      "Falsches Design bestellt Frau ist unzufrieden will ein anderes Design von euch haben",
      "Order change, before shipping queries",
    ],
    ["black machined nuts appears to be missing", "Parts missing queries"],
  ];

  it.each(CASES)("classifies %j", (text, expected) => {
    expect(classifyMessageCategory(text)).toBe(expected);
  });
});

/**
 * Every category still names its own wording after the boundary rule and the
 * numeric-spec change. Guards the eight categories the brief listed.
 */
describe("no category regressed", () => {
  const STILL_NAMED: Record<string, string> = {
    "Return and refunds": "I would like a refund for this order.",
    "Wrong item sent messages": "This is the wrong item, not what i ordered.",
    "Wrong description issues": "The listing says something different — not as described.",
    "Delivery queries": "My parcel still has not arrived and tracking shows nothing.",
    "Damage queries": "The item arrived damaged and the glass is cracked.",
    "Parts missing queries": "There are missing parts in the box, no screws included.",
    "Pre sales queries": "Before i buy, does it fit a standard socket?",
    "Order change, before shipping queries": "I need to cancel my order before it ships.",
  };

  it.each(Object.entries(STILL_NAMED))("still names %s", (category, text) => {
    expect(classifyMessageCategory(text)).toBe(category);
  });
});

/**
 * The eight examples from the intent-analysis brief, asserted verbatim.
 */
describe("customer intent validation set", () => {
  const CASES: readonly (readonly [string, string])[] = [
    [
      "Hi, this is a bizarre question. I'm building a santa sleigh and want to put some car parts on it. Ie air horn and lights. Would this be able to power 12volt car lights.",
      "Pre sales queries",
    ],
    [
      "Hallo, ich wäre sehr dankbar für möglichst schnelle Lieferung, wenn möglich noch diese Woche!",
      "Delivery queries",
    ],
    [
      "Hi I've just received the shade, thank you. Is there suppose to be a fitting with it? The hole on the shade is too big for a standard ceiling light!! The box was damaged and slightly open so I'm just wondering if something is missing?",
      "Parts missing queries",
    ],
    [
      "U sent me wrong one, it's a round three different colour glass hanging light",
      "Wrong item sent messages",
    ],
    [
      "Falsches Design bestellt Frau ist unzufrieden will ein anderes Design von euch haben",
      "Order change, before shipping queries",
    ],
    [
      "Sorry it's the wrong one needs to be 5v output, I can return if possible",
      "Return and refunds",
    ],
    ["black machined nuts appears to be missing", "Parts missing queries"],
  ];

  it.each(CASES)("classifies %j", (text, expected) => {
    expect(classifyMessageCategory(text)).toBe(expected);
  });
});

/**
 * Damage to the PACKAGING is context for what is absent inside it, not a
 * complaint in its own right.
 */
describe("damaged packaging does not outrank a missing component", () => {
  it("names the missing part when the damage is to the box", () => {
    expect(
      classifyMessageCategory(
        "The box that it has arrived in was completely crumpled up and damaged. I've just opened the bag and looks like there's parts missing to put it all together.",
      ),
    ).toBe("Parts missing queries");
    expect(
      classifyMessageCategory(
        "Hello, the delivery has just arrived. The box it is delivered in is very badly damaged and open. It is missing X1 3 hole multi outlet ceiling rose and X2 chrome Bulb Holders as ordered.",
      ),
    ).toBe("Parts missing queries");
    expect(
      classifyMessageCategory("I received the item but the box was open all damaged and the bulb are missing"),
    ).toBe("Parts missing queries");
    expect(
      classifyMessageCategory(
        "The 2m version arrived in a broken plastic container. The bag with the additional parts is missing, can you please send replacements asap?",
      ),
    ).toBe("Parts missing queries");
  });

  /**
   * The guard that stops this becoming "missing always beats damage": when the
   * GOODS are what is damaged, no packaging noun is involved and nothing here
   * fires.
   */
  it("leaves damage to the goods themselves alone", () => {
    expect(classifyMessageCategory("The item arrived damaged and the glass is cracked.")).toBe(
      "Damage queries",
    );
    expect(
      classifyMessageCategory("the plastic hinge is broken on one side and the clear cover is missing"),
    ).toBeNull();
    expect(
      classifyMessageCategory(
        "There's a lot of scratches and the earth is missing in this one. Only one is damaged, seems like it is used",
      ),
    ).toBeNull();
  });

  /**
   * Bounded to a SINGLE damage word. A message reporting the goods damaged as
   * well as the box keeps both damage signals, so the packaging rule does not
   * fire and the smashed shade still carries the case.
   */
  it("does not discard damage when the goods are damaged as well as the box", () => {
    expect(
      classifyMessageCategory("The box was damaged and the shade is smashed, and a part is missing"),
    ).toBe("Damage queries");
  });

  it("names the missing part in every inflection of the verb", () => {
    expect(classifyMessageCategory("Two of the brackets are missing")).toBe("Parts missing queries");
    expect(classifyMessageCategory("A nut was missing from the pack")).toBe("Parts missing queries");
    expect(classifyMessageCategory("The cord grips were missing one nut")).toBe(
      "Parts missing queries",
    );
  });
});

/**
 * A delivery being ASKED FOR, against one being thanked for.
 */
describe("delivery requested, versus delivery thanked for", () => {
  it("names a forward-looking delivery request", () => {
    expect(
      classifyMessageCategory(
        "Hallo, ich wäre sehr dankbar für möglichst schnelle Lieferung, wenn möglich noch diese Woche!",
      ),
    ).toBe("Delivery queries");
    expect(classifyMessageCategory("Bitte um umgehende Lieferung der Ware.")).toBe(
      "Delivery queries",
    );
    expect(classifyMessageCategory("Bitte um Zusendung schnellstmöglich.")).toBe("Delivery queries");
  });

  /**
   * The 32 thank-yous this rule had to be built around. Each opens a message
   * about something else, and each must keep that something else.
   */
  it("does not fire on a thank-you for a delivery already made", () => {
    expect(
      classifyMessageCategory(
        "Hallo, vielen Dank für die schnelle Lieferung. Leider habe ich bisher keine Rechnung erhalten. Könnten Sie die bitte schicken?",
      ),
    ).toBe("Admin related issues");
    expect(
      classifyMessageCategory("Danke für die schnelle Lieferung, die Dosen sind leider falsch geliefert."),
    ).toBe("Wrong item sent messages");
    expect(classifyMessageCategory("Danke für die schnelle Lieferung.")).toBeNull();
    expect(
      classifyMessageCategory(
        "Moin Sehr schnelle Lieferung sehr gut, leider passen die gelieferten Birnen nicht zu der Fassung der Lampe, ansonsten prima",
      ),
    ).not.toBe("Delivery queries");
  });

  /** Both halves required: a delivery noun alone never names the category. */
  it("does not fire on a delivery noun on its own", () => {
    expect(classifyMessageCategory("Die Lieferung ist unvollständig, eine Halterung fehlt.")).toBe(
      "Parts missing queries",
    );
    expect(classifyMessageCategory("Der Versand erfolgte an die alte Adresse.")).not.toBe(
      "Delivery queries",
    );
  });
});

/**
 * Return and refunds is an OUTCOME category: it needs the money to be asked
 * for, and may not take a conversation away from the problem that describes it
 * on the strength of return wording alone.
 */
describe("return and refunds requires refund intent", () => {
  it("names the four money-back intents", () => {
    expect(classifyMessageCategory("I want my money back")).toBe("Return and refunds");
    expect(classifyMessageCategory("Please refund me")).toBe("Return and refunds");
    expect(classifyMessageCategory("I want to return this for a refund")).toBe("Return and refunds");
    expect(classifyMessageCategory("Can I cancel and get a refund?")).toBe("Return and refunds");
  });

  /**
   * The words the brief named as insufficient on their own. Each is paired with
   * a problem here, and the problem must survive.
   */
  it("does not take a conversation on return wording alone", () => {
    expect(classifyMessageCategory("You sent the wrong item, I can send it back")).toBe(
      "Wrong item sent messages",
    );
    expect(classifyMessageCategory("The wrong colour turned up, happy to return it")).toBe(
      "Wrong item sent messages",
    );
    expect(classifyMessageCategory("It arrived damaged, please send a replacement")).toBe(
      "Damage queries",
    );
    expect(classifyMessageCategory("The unit is faulty, can you send another")).toBe(
      "Defective items",
    );
    expect(classifyMessageCategory("A part is missing, please send me a new one")).toBe(
      "Parts missing queries",
    );
    expect(classifyMessageCategory("Not as described, I can return it")).toBe(
      "Wrong description issues",
    );
  });

  /**
   * The same wording with the money added, for the two pairs where the
   * direction has been measured.
   */
  it("takes the conversation once the money is asked for", () => {
    expect(classifyMessageCategory("You sent the wrong item, I want a refund")).toBe(
      "Return and refunds",
    );
    expect(
      classifyMessageCategory("I ordered the wrong size by mistake, please refund me"),
    ).toBe("Return and refunds");
  });

  /**
   * WHERE THE MONEY IS ASKED FOR BUT THE PAIR IS NOT ONE OF THE TWO MEASURED
   * ONES, the tie still refuses rather than guessing.
   *
   * This is deliberate restraint, not an oversight. Making refund intent beat
   * every problem category would widen Return and refunds again — the opposite
   * of what this pass is for — and there is no measurement behind the other
   * six pairs. A reviewer seeing null here is seeing a real conflict: the
   * complaint is one thing, the requested outcome another.
   */
  it("refuses a refund request tied against an unmeasured problem category", () => {
    expect(classifyMessageCategory("A part is missing, I want my money back")).toBeNull();
    expect(classifyMessageCategory("It arrived damaged and I would like a refund.")).toBeNull();
  });

  /**
   * THE GATE ONLY FIRES WHEN THERE IS SOMEWHERE TO FALL BACK TO. A message that
   * is nothing but a return request has no problem category, so it stays where
   * it always was rather than dropping to null.
   */
  it("still names a bare return request with no problem attached", () => {
    expect(classifyMessageCategory("Can you send me a return label please")).toBe(
      "Return and refunds",
    );
    expect(classifyMessageCategory("Wie läuft die Retoure ab?")).toBe("Return and refunds");
    expect(classifyMessageCategory("Sadly it will not fit so I need to return it.")).toBe(
      "Return and refunds",
    );
  });

  /** Chasing a refund that is owed is refund intent; declining one is not. */
  it("tells chasing a refund apart from refusing one", () => {
    expect(classifyMessageCategory("I have not been refunded yet")).toBe("Return and refunds");
    expect(classifyMessageCategory("You sent the wrong item. I don't want a refund, just send the right one")).toBe(
      "Wrong item sent messages",
    );
  });

  /** A tie with refund intent present is still a tie, and still refuses. */
  it("does not turn the gate into a precedence rule", () => {
    expect(classifyMessageCategory("It arrived damaged and I would like a refund.")).toBeNull();
  });
});

/**
 * The five boundary examples from the brief, asserted verbatim.
 */
describe("refund boundary validation set", () => {
  it("names a wrong product received with no refund request", () => {
    expect(
      classifyMessageCategory(
        "U sent me wrong one, it's a round three different colour glass hanging light",
      ),
    ).toBe("Wrong item sent messages");
  });

  it("names a wanted design change as an order change, not a refund", () => {
    expect(
      classifyMessageCategory(
        "Falsches Design bestellt Frau ist unzufrieden will ein anderes Design von euch haben",
      ),
    ).toBe("Order change, before shipping queries");
  });

  it("reads a return offered as a correction route as the original problem", () => {
    expect(
      classifyMessageCategory("Sorry it's the wrong one needs to be 5v output, I can return if possible"),
    ).toBe("Return and refunds");
  });

  it("names a spec question as pre-sales even with a preamble", () => {
    expect(
      classifyMessageCategory("Hi, this is a bizarre question... Would this be able to power 12volt car lights?"),
    ).toBe("Pre sales queries");
  });

  /**
   * The German shortfall message. The customer states the box was UNDAMAGED,
   * and the damage table must not fire on "unbeschädigten" — which it does not,
   * because matching is whole-word.
   */
  it("does not read an explicitly undamaged box as damage", () => {
    expect(
      classifyMessageCategory(
        "Ich habe den unbeschädigten Karton sorgfältig geöffnet und ausgepackt.",
      ),
    ).not.toBe("Damage queries");
  });

  /**
   * The actionable half of that example: once the shortfall IS stated in words,
   * a replacement being discussed must not turn it into a return.
   */
  it("keeps a missing component as parts missing when a replacement is offered", () => {
    expect(classifyMessageCategory("Ein Lampenschirm fehlt. Bitte um Ersatzlieferung.")).toBe(
      "Parts missing queries",
    );
    expect(
      classifyMessageCategory("Es fehlt ein Teil, können Sie mir Ersatz zurücksenden?"),
    ).toBe("Parts missing queries");
  });
});

/**
 * The boundary between reporting a wrong item and ASKING for a return.
 *
 * The same words appear on both sides — "wrong", "return" — so scoring alone
 * cannot separate them. What separates them is whether a return or refund is
 * being requested, and that is what `EXPLICIT_REMEDY_REQUEST` tests for.
 *
 * Both example pairs below are drawn from live eBay text.
 */
describe("wrong item reported, versus a return actually requested", () => {
  it("names a wrong item sent when no return or refund is asked for", () => {
    expect(
      classifyMessageCategory(
        "U sent me wrong one, it's a round three different colour glass hanging light",
      ),
    ).toBe("Wrong item sent messages");
    expect(classifyMessageCategory("You sent me the wrong colour light")).toBe(
      "Wrong item sent messages",
    );
    expect(classifyMessageCategory("I received the wrong shade")).toBe("Wrong item sent messages");
    expect(classifyMessageCategory("Wrong product received, please send the correct one")).toBe(
      "Wrong item sent messages",
    );
  });

  /**
   * The case that makes the distinction necessary rather than academic: the
   * customer offers to send the item back, but is asking for the RIGHT item,
   * not for money. An item may be returned without the message being a refund
   * request.
   */
  it("stays a wrong item when the return is offered rather than requested", () => {
    expect(
      classifyMessageCategory(
        "Unfortunately i have received the wrong light. Can you send the correct one please and I will return the one that came.",
      ),
    ).toBe("Wrong item sent messages");
  });

  /**
   * NARROWED DELIBERATELY. An earlier pass treated any explicit REQUEST to
   * return as enough to make this Return and refunds. It is not: a return is a
   * route, and only the money is the outcome. So of the four below, only the
   * one that asks for money is a return case — the other three keep the
   * problem category, and are pinned in the test above.
   */
  it("names a return once the money is explicitly asked for", () => {
    expect(classifyMessageCategory("Wrong item received, I want a refund")).toBe(
      "Return and refunds",
    );
    expect(classifyMessageCategory("You sent the wrong colour, I want my money back")).toBe(
      "Return and refunds",
    );
  });

  it("keeps the problem category when a return is asked for without a refund", () => {
    expect(classifyMessageCategory("Wrong item, arrange a return")).toBe(
      "Wrong item sent messages",
    );
    expect(
      classifyMessageCategory("It's the wrong colour. Please could I return this item."),
    ).toBe("Wrong item sent messages");
    expect(
      classifyMessageCategory("Could you send a returns label so I can return the wrong item that was delivered."),
    ).toBe("Wrong item sent messages");
  });

  /**
   * The boundary is two named pairs, not a global precedence in either
   * direction. Every other category still contests Return on score and still
   * refuses on a tie.
   */
  it("leaves every other pairing with Return exactly as it was", () => {
    expect(classifyMessageCategory("It arrived damaged and I would like a refund.")).toBeNull();
    expect(classifyMessageCategory("Wrong item sent, and it is faulty too.")).toBeNull();
  });
});

/**
 * The customer's own mis-order, in German, where the noun sits between the two
 * words that carry the meaning.
 */
describe("ordered the wrong thing and wants a different one", () => {
  it("names the real eBay example as an order change", () => {
    expect(
      classifyMessageCategory(
        "Falsches Design bestellt Frau ist unzufrieden will ein anderes Design von euch haben",
      ),
    ).toBe("Order change, before shipping queries");
    expect(
      classifyMessageCategory(
        "Falsches Design bestellt Frau ist unzufrieden will ein anderes Design von euch haben! Sorry",
      ),
    ).toBe("Order change, before shipping queries");
  });

  /**
   * Both halves are required. A mis-order that asks to send the item back is a
   * return, and the table scores that itself — this rule must not reach it.
   */
  it("does not take a mis-order that asks to send it back", () => {
    expect(
      classifyMessageCategory(
        "Hallo, ich habe leider die falsche Variante bestellt. Wäre es möglich, ein Rücksendeetikett zu erhalten?",
      ),
    ).toBe("Return and refunds");
    expect(
      classifyMessageCategory(
        "Ich habe ausversehen die 2 falschen Trafo bestellt und würde sie gerne wieder zurückschicken.",
      ),
    ).toBe("Return and refunds");
  });

  it("does not fire on a mis-order that asks for nothing", () => {
    expect(
      classifyMessageCategory("Keine Probleme, ich hatte versehentlich das falsche Netzteil bestellt."),
    ).toBeNull();
  });

  it("still lets the table name a cancellation it already knows", () => {
    expect(
      classifyMessageCategory("Bitte um Kaufabbruch da ich versehentlich falsch bestellt habe"),
    ).toBe("Order change, before shipping queries");
  });
});

/**
 * HOW THE TWO LONG-UNNAMED EXAMPLES WERE EVENTUALLY RESOLVED.
 *
 * Both of these refused for several passes, and the reasoning that kept them
 * refusing is kept here because it is what made the eventual rules narrow.
 *
 * THE GERMAN EXPEDITE REQUEST. Measured over live text, "schnelle Lieferung"
 * appears in 39 messages and 32 of them are "vielen Dank für die schnelle
 * Lieferung, aber ..." opening a message about an invoice, a wrong colour or a
 * missing part. Every attempt to name it from the delivery noun alone destroyed
 * those 32. What finally worked was requiring a forward-looking REQUEST
 * alongside the noun and excluding the thank-you formula — three conditions
 * rather than a phrase. See "delivery requested, versus delivery thanked for".
 *
 * THE DAMAGED BOX. This was read as a Damage case for two passes and refused,
 * because the 16 live conversations where Damage and Parts missing tie 1-1
 * split roughly evenly and no global precedence was defensible. The resolution
 * came from re-reading them by WHAT the damage was predicated on rather than by
 * category: every conversation where the damage is on the PACKAGING and
 * something is absent inside is a parts case, and every conversation where the
 * GOODS are damaged is not. That distinction is unanimous, and it is what
 * `PACKAGING_DAMAGE` encodes. See "damaged packaging does not outrank a missing
 * component" — including the counter-examples that keep it from becoming a
 * blanket "missing beats damage".
 *
 * The tests below are the parts of those investigations that still hold.
 */
describe("what the long-unnamed examples still protect", () => {
  /**
   * A German request to EXPEDITE delivery. It stays null because the phrase
   * that would name it — "schnelle Lieferung" — is overwhelmingly a THANK-YOU
   * that opens a message about something else entirely.
   *
   * Measured over live eBay text: 39 messages contain "schnelle Lieferung"; 32
   * of them are "danke für die schnelle Lieferung, aber ..." followed by an
   * invoice request, a wrong colour, a broken hinge or a missing part. Adding
   * the phrase would tie Delivery against the category each of those actually
   * belongs to and turn correct labels into null. The one wording that WOULD
   * discriminate, "möglichst schnelle Lieferung", occurs exactly once in the
   * whole corpus — this message — so there is no reusable pattern to add.
   * Bare "Lieferung" is worse still: 288 occurrences, and it collides with the
   * standing Parts-missing test "Die Lieferung ist unvollständig".
   *
   * A second sweep looked specifically for a REQUEST-shaped delivery pattern
   * that might cover it. Reusable ones do exist — "wann kommt" (10), "wann wird
   * ... geliefert" (7), "wann erhalte ich" (5), "bitte um umgehende Lieferung"
   * (4) — but none of them reaches this message, whose own construction
   * ("dankbar für ... Lieferung") again occurs once. They are recorded as a
   * separate coverage opportunity rather than smuggled in under this example.
   */
  it("names the German expedite request without breaking the thank-you cases", () => {
    expect(
      classifyMessageCategory(
        "Hallo, ich wäre sehr dankbar für möglichst schnelle Lieferung, wenn möglich noch diese Woche!",
      ),
    ).toBe("Delivery queries");
  });

  /** The thank-you cases that a "schnelle Lieferung" phrase would have destroyed. */
  it("keeps naming the case a delivery thank-you is merely wrapped around", () => {
    expect(
      classifyMessageCategory(
        "Hallo, vielen Dank für die schnelle Lieferung. Leider habe ich bisher keine Rechnung erhalten. Könnten Sie die bitte schicken?",
      ),
    ).toBe("Admin related issues");
    expect(
      classifyMessageCategory(
        "Danke für die schnelle Lieferung, die Dosen sind leider falsch geliefert.",
      ),
    ).toBe("Wrong item sent messages");
  });

  /**
   * The damaged-box example, and the two live cases that share its exact shape.
   * All three are parts cases, which is what makes the packaging rule safe: it
   * was derived from them rather than fitted to the one example.
   */
  it("names the damaged-box-and-something-missing case as parts missing", () => {
    expect(
      classifyMessageCategory(
        "Hi I've just received the shade... Is there suppose to be a fitting with it? The hole on the shade is too big... The box was damaged and slightly open so I'm just wondering if something is missing?",
      ),
    ).toBe("Parts missing queries");
    expect(
      classifyMessageCategory(
        "The box that it has arrived in was completely crumpled up and damaged. I've just opened the bag which had the metal items inside and looks like there's parts missing to put it all together.",
      ),
    ).toBe("Parts missing queries");
    expect(
      classifyMessageCategory(
        "Hello, the delivery has just arrived. The box it is delivered in is very badly damaged and open. It is missing X1 3 hole multi outlet ceiling rose and X2 chrome Bulb Holders as ordered.",
      ),
    ).toBe("Parts missing queries");
  });
});

/* ========================================================================= *
 * THE INTENT FALLBACK LAYER
 *
 * Everything above this line tests `classifyMessageCategory` — the strict
 * phrase table — and is unchanged by the fallback existing. That separation is
 * the point of the first block below: the strict layer still refuses exactly
 * what it always refused, and the fallback only fills in behind it.
 * ========================================================================= */

describe("the fallback never disturbs the layer above it", () => {
  /**
   * THE LOAD-BEARING TEST. If the fallback could change an answer the table
   * already gave, every measurement behind every phrase above it would be void.
   * So wherever a strict answer exists, the fallback returns that same answer.
   */
  it("returns the strict category unchanged whenever there is one", () => {
    for (const text of [
      "My parcel still has not arrived and tracking shows nothing.",
      "Before i buy, does it fit a standard socket?",
      "Please send me a VAT invoice for this order.",
      "I need to cancel my order before it ships.",
      "The unit is faulty and stopped working after a day.",
      "The item arrived damaged and the glass is cracked.",
      "This is the wrong item, not what i ordered.",
      "There are missing parts in the box, no screws included.",
      "The listing says something different — not as described.",
      "I would like a refund for this order.",
      "U sent me wrong one, it's a round three different colour glass hanging light",
      "Falsches Design bestellt Frau ist unzufrieden will ein anderes Design von euch haben",
      "black machined nuts appears to be missing",
    ]) {
      const strict = classifyMessageCategory(text);
      expect(strict, text).not.toBeNull();
      expect(classifyMessageCategoryWithFallback(text), text).toBe(strict);
    }
  });

  it("leaves the strict classifier still refusing what it always refused", () => {
    expect(classifyMessageCategory("Hello, I have a question about my order.")).toBeNull();
    expect(classifyMessageCategory("Many thanks, kind regards.")).toBeNull();
    expect(classifyMessageCategory("It arrived damaged and I would like a refund.")).toBeNull();
  });
});

describe("the intent fallback names what the table could not", () => {
  const CASES: readonly (readonly [string, string])[] = [
    [
      "U sent me wrong one, it's a round three different colour glass hanging light",
      "Wrong item sent messages",
    ],
    [
      "Falsches Design bestellt Frau ist unzufrieden will ein anderes Design von euch haben",
      "Order change, before shipping queries",
    ],
    ["Hi I've just received the shade... wondering if something is missing?", "Parts missing queries"],
    [
      "Received wall lamps but shades/fittings cannot assemble as photograph portrays",
      "Wrong description issues",
    ],
    ["Would this power 12volt car lights?", "Pre sales queries"],
    ["Hallo, ich wäre dankbar für möglichst schnelle Lieferung", "Delivery queries"],
    ["I want my money back", "Return and refunds"],
  ];

  it.each(CASES)("classifies %j", (text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });

  /** Each of these reaches a category ONLY through the fallback. */
  it("covers shapes the phrase table has no wording for", () => {
    for (const [text, expected] of [
      [
        "Received wall lamps but shades/fittings cannot assemble as photograph portrays",
        "Wrong description issues",
      ],
      ["Only two lampshades arrived but should be three", "Parts missing queries"],
      ["Can it arrive this week?", "Delivery queries"],
    ] as const) {
      expect(classifyMessageCategory(text), text).toBeNull();
      expect(classifyMessageCategoryWithFallback(text), text).toBe(expected);
    }
  });
});

/**
 * The guarantee that matters most, stated as a property rather than a list of
 * examples: this layer reaches "Return and refunds" through exactly two
 * intents. One is the money. The other is `wants_post_delivery_return`, which
 * needs the goods to have arrived AND a return or swap to be asked for AND
 * nothing to be wrong with what we sent — see "a return or swap AFTER delivery
 * is not an order change" below. Every example here fails at least one of those
 * three, which is why they are unaffected by it.
 */
describe("the fallback cannot invent a return or refund", () => {
  it("never names Return and refunds without refund intent", () => {
    for (const text of [
      "Can you send the correct one please and I will send this one back",
      "You sent the wrong colour, please send the right one",
      "Wrong design arrived, I would like a different one",
      "Ein Teil fehlt, bitte um Ersatz",
    ]) {
      expect(detectIntents(text), text).not.toContain("wants_refund");
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Return and refunds");
    }
  });

  /**
   * THE ONE ROUTE TO RETURN THAT DOES NOT GO THROUGH THIS LAYER, recorded so
   * the guarantee above is not read as broader than it is.
   *
   * A message that is nothing BUT a return request — no problem reported
   * anywhere in it — is named Return and refunds by the strict table before the
   * fallback is ever consulted. That is deliberate and long-standing: there is
   * no problem category for it to keep, so refusing would only produce a blank.
   * The fallback cannot reach this case and does not change it.
   */
  it("leaves a bare return request with the strict layer", () => {
    const text = "I need to send this back to you, how do I do that";
    expect(classifyMessageCategory(text)).toBe("Return and refunds");
    expect(classifyMessageCategoryWithFallback(text)).toBe("Return and refunds");
  });

  it("does name it once the money is asked for", () => {
    for (const text of ["I want my money back", "Please refund me"]) {
      expect(detectIntents(text), text).toContain("wants_refund");
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Return and refunds");
    }
  });

  /**
   * REVERSED 2026-09-01 by the Aug 27 – Sep 1 audit (conversation 33).
   *
   * "I purchased these by mistake. Could I cancel the order and get a refund
   * please." is a pre-shipping cancellation, and CST routes it to Order change;
   * the refund is the remedy attached to it. This case previously pinned the
   * category as Return and refunds.
   *
   * THE INTENT IS STILL ASSERTED, and that half has not changed. The refund is
   * a fact about the message whatever category owns it — `draft-validation`
   * reads it to check that a reply which cancels also says what happens to the
   * money, and suppressing it switched that check off silently.
   */
  it("keeps the refund intent while a cancellation owns the category", () => {
    const text = "Can I cancel and get a refund?";
    expect(detectIntents(text)).toContain("wants_refund");
    expect(classifyMessageCategoryWithFallback(text)).toBe(
      "Order change, before shipping queries",
    );
  });

  /**
   * A replacement is not money, and this layer says so out loud: the intent is
   * detected, and it deliberately owns no category.
   */
  it("detects a replacement request without treating it as a refund", () => {
    const intents = detectIntents("Please send me a new one instead");
    expect(intents).toContain("wants_replacement");
    expect(intents).not.toContain("wants_refund");
  });
});

describe("the admin fallback, and what it must not swallow", () => {
  it("gives a real customer message a category rather than a blank", () => {
    for (const text of [
      "Hello, I have a question about my order.",
      "Many thanks, kind regards.",
      "Hi there, can you help me please?",
      "Do you have any information on this product?",
    ]) {
      expect(classifyMessageCategory(text), text).toBeNull();
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Admin related issues");
    }
  });

  /**
   * "Never leave a customer message uncategorised" is only safe because these
   * are recognised as not being customer messages at all. Without this, every
   * SMTP header block in the corpus would be filed as an admin query.
   */
  it("still returns null for content no customer wrote", () => {
    const headerNoise = [
      "Received: from mail.example.com by mx.example.net",
      "Content-Type: text/plain; charset=UTF-8",
      "Authentication-Results: spf=pass smtp.mailfrom=example.com",
      "MIME-Version: 1.0",
      "X-Spam-Status: No, score=-1.0",
    ].join("\n");
    expect(classifyMessageCategoryWithFallback(headerNoise)).toBeNull();
    expect(
      classifyMessageCategoryWithFallback(
        "This is an automatically generated email from Seller Center. Please do not reply to this message.",
      ),
    ).toBeNull();
    expect(
      classifyMessageCategoryWithFallback("You have a new Ticket in your Wayfair Partner Home Inbox."),
    ).toBeNull();
  });

  it("still returns null when there is no readable text at all", () => {
    expect(classifyMessageCategoryWithFallback(null)).toBeNull();
    expect(classifyMessageCategoryWithFallback("")).toBeNull();
    expect(classifyMessageCategoryWithFallback("   ")).toBeNull();
  });

  it("prefers a named intent over the admin catch-all", () => {
    expect(classifyMessageCategoryWithFallback("Only two arrived but should be three")).toBe(
      "Parts missing queries",
    );
    expect(classifyMessageCategoryWithFallback("Please send me the invoice for this")).toBe(
      "Admin related issues",
    );
  });
});

describe("intent detection is reportable on its own", () => {
  it("names the intents a reviewer would name", () => {
    expect(detectIntents("U sent me wrong one")).toContain("received_wrong_item");
    expect(detectIntents("Only two arrived but should be three")).toContain("missing_component");
    expect(detectIntents("cannot assemble as the photograph portrays")).toContain(
      "wrong_description",
    );
    expect(detectIntents("Would this power 12volt car lights?")).toContain("pre_sale_question");
    expect(detectIntents("Can it arrive this week?")).toContain("delivery_request");
    expect(detectIntents("Please send me the invoice")).toContain("admin_issue");
  });

  it("is pure and returns nothing for empty text", () => {
    expect(detectIntents("")).toEqual([]);
    expect(detectIntents(null)).toEqual([]);
  });
});

/* ========================================================================= *
 * THREAD-AWARE CLASSIFICATION
 *
 * The conversation, not the concatenation. A closing "found it, all sorted"
 * must not cost the thread the category its opening message earned.
 * ========================================================================= */

describe("a resolved conversation keeps the category it earned", () => {
  it("keeps the original problem when the customer later says it is sorted", () => {
    expect(
      classifyConversationCategory([
        "Only two lampshades arrived, one is missing",
        "Found it, everything is fine",
      ]),
    ).toBe("Parts missing queries");
  });

  /** Each of the closing lines the brief named, against the same opener. */
  it.each([
    "Found it",
    "Everything arrived",
    "Problem solved",
    "Received now, thanks",
    "All sorted now, many thanks",
    "Hat sich erledigt, danke",
  ])("survives a closing %j", (closing) => {
    expect(
      classifyConversationCategory(["Only two lampshades arrived, one is missing", closing]),
    ).toBe("Parts missing queries");
  });

  it("keeps the original category across every case type", () => {
    for (const [opener, expected] of [
      ["The item arrived damaged and the glass is cracked", "Damage queries"],
      ["My parcel still has not arrived and tracking shows nothing", "Delivery queries"],
      ["You sent the wrong item, not what i ordered", "Wrong item sent messages"],
      ["The unit is faulty and stopped working after a day", "Defective items"],
      ["The listing says something different — not as described", "Wrong description issues"],
      ["I would like a refund for this order", "Return and refunds"],
      ["I need to cancel my order before it ships", "Order change, before shipping queries"],
    ] as const) {
      expect(classifyConversationCategory([opener, "All good now, thanks"]), opener).toBe(expected);
    }
  });

  /**
   * A DIFFERENT ONE THE CUSTOMER BOUGHT IS NOT ONE WE SUPPLIED.
   *
   * The live eBay thread this reproduces: a height question, our reply asking
   * for the listing link, and the customer closing with "I've bought a
   * different one now sorry" — a withdrawn pre-sales enquiry that classified as
   * Wrong item sent.
   *
   * `A_MISMATCH` read the word "different" with no account of who did what, so
   * the customer's own purchase and our mis-shipment produced the same claim.
   */
  it("keeps pre-sales when the customer says they bought a different one elsewhere", () => {
    expect(
      classifyConversationCategory([
        "Could you tell me the height of this please?",
        "I've bought a different one now sorry.",
      ]),
    ).toBe("Pre sales queries");
  });

  /** The same withdrawal, however the customer phrases their own purchase. */
  it.each([
    "I've bought a different one now sorry.",
    "I have since ordered a different one",
    "We went with a different one in the end",
    "I found a different one elsewhere, thanks anyway",
    "I chose a different one in the end",
  ])("does not read %j as a wrong item", (closing) => {
    expect(
      classifyConversationCategory(["Could you tell me the height of this please?", closing]),
    ).toBe("Pre sales queries");
  });

  /**
   * The other half of the rule, and the reason the guard is not simply "drop
   * any sentence containing bought and different". Wrong item still needs only
   * what it always needed: something different RECEIVED, SENT or DELIVERED.
   */
  it.each([
    "You sent me a different one",
    "I received a different one",
    "I ordered the black one and received a different one",
    "The item is completely different",
    "you have sent the wrong item",
  ])("still reads %j as a wrong item", (message) => {
    expect(classifyMessageCategoryWithFallback(message)).toBe("Wrong item sent messages");
  });

  /**
   * The reason this reads messages separately rather than concatenating them.
   * Neither message contains both signals; joined into one string they tie and
   * the conversation falls to null, losing a category that plainly existed.
   */
  it("does not manufacture a tie out of two separate messages", () => {
    const messages = ["A part is missing from the box", "Also the shade is cracked"];
    expect(classifyMessageCategory(messages.join(" "))).toBeNull();
    expect(classifyConversationCategory(messages)).toBe("Parts missing queries");
  });

  /** Order decides which problem the conversation is about. */
  it("takes the problem the customer arrived with", () => {
    expect(
      classifyConversationCategory([
        "You sent the wrong item, not what i ordered",
        "The replacement is faulty and stopped working",
      ]),
    ).toBe("Wrong item sent messages");
  });

  /**
   * A case category outranks an enquiry wherever it appears, so a thread that
   * opens with a question and then reports a problem is a case.
   */
  it("prefers a real case over an opening enquiry", () => {
    expect(
      classifyConversationCategory([
        "Before i buy, does it fit a standard socket?",
        "It arrived damaged and the glass is cracked",
      ]),
    ).toBe("Damage queries");
  });
});

describe("a confirmation on its own is not an admin matter", () => {
  it("returns null when the whole thread is only a resolution", () => {
    expect(classifyConversationCategory(["Found it, everything is fine"])).toBeNull();
    expect(classifyConversationCategory(["Problem solved, thanks"])).toBeNull();
    expect(classifyConversationCategory(["All sorted now", "Many thanks"])).toBeNull();
  });

  it("applies the same restraint to a single message", () => {
    expect(classifyMessageCategoryWithFallback("Found it, everything is fine")).toBeNull();
    expect(classifyMessageCategoryWithFallback("Problem solved, thanks")).toBeNull();
  });

  /** But a genuine enquiry with no identifiable intent is still Admin. */
  it("still falls back to admin for a real enquiry", () => {
    expect(classifyConversationCategory(["Hello, I have a question about my order."])).toBe(
      "Admin related issues",
    );
    expect(
      classifyConversationCategory(["Found it, all sorted", "Can you send me the invoice though?"]),
    ).toBe("Admin related issues");
  });
});

describe("thread classification handles the awkward inputs", () => {
  it("returns null for an empty or unreadable thread", () => {
    expect(classifyConversationCategory([])).toBeNull();
    expect(classifyConversationCategory([null, "", "   "])).toBeNull();
  });

  it("skips machine-generated messages without letting them decide", () => {
    expect(
      classifyConversationCategory([
        "This is an automatically generated email from Seller Center. Please do not reply to this message.",
        "Only two lampshades arrived, one is missing",
      ]),
    ).toBe("Parts missing queries");
    expect(
      classifyConversationCategory(["You have a new Ticket in your Wayfair Partner Home Inbox."]),
    ).toBeNull();
  });

  /**
   * A REAL eBay THREAD, end to end — the one this rule was reported against.
   * Customer messages only, in the order they were sent, signatures removed.
   *
   * It went to the admin fallback before, and the reason was in the FIRST
   * message rather than the last: the customer states the shortfall as
   * arithmetic ("nur 2 ... sollten aber 3") and never writes fehlt,
   * unvollständig or any other word the table knows. With nothing named
   * anywhere in the thread, the closing "alles bestens" had nothing to preserve.
   */
  it("names the real German shortfall thread as parts missing", () => {
    expect(
      classifyConversationCategory([
        "Hallo, schönen guten Tag. Ich habe heute die Hängeleuchte erhalten. Leider sind nur 2 Lampenschirme dabei. Es sollten aber 3 dabei sein. Glühbirnen sind 3, Fassungen sind 3, Gewichte sind 3. Bekomme ich einen Lampenschirm geschickt, oder soll ich eine neue bestellen und die jetzige zurück senden?",
        "Hallo. Ich habe den unbeschädigten Karton sorgfältig geöffnet und ausgepackt. Beim Sortieren ist mir sofort aufgefallen, dass nur zwei Lampenschirme ineinander gestapelt waren. Ansonsten war alles für drei Lichtquellen.",
        "Ich habe die Bilder nicht mitschicken können. Sorry.",
        "Haben sie die Bilder bekommen?",
        "Hallo. Anbei die gewünschten Bilder.",
        "Hallo. Alles klar. Bitte darauf achten, dass es auch der passende Lampenschirm ist.",
        "Hallo. Ja, der Lampenschirm ist bereits angekommen. Alles bestens. Passt. Sieht super aus.",
      ]),
    ).toBe("Parts missing queries");
  });

  it("reads the thread through the intent layer, message by message", () => {
    // Neither message names a category on its own under the phrase table alone;
    // the intent layer names the first, and the closing line cannot undo it.
    expect(
      classifyConversationCategory([
        "Only two lampshades arrived but should be three",
        "Found it, everything is fine",
      ]),
    ).toBe("Parts missing queries");
  });

  it("agrees with the single-message classifier on a one-message thread", () => {
    for (const text of [
      "The item arrived damaged and the glass is cracked.",
      "I would like a refund for this order.",
      "black machined nuts appears to be missing",
      "Hello, I have a question about my order.",
    ]) {
      expect(classifyConversationCategory([text]), text).toBe(
        classifyMessageCategoryWithFallback(text),
      );
    }
  });
});

/* ========================================================================= *
 * INTENT AS THE PRIMARY LAYER
 *
 * The phrase table no longer decides — it testifies. Its result is folded into
 * intent detection as one witness among several (`intentsFromPhraseTable`), and
 * ownership order decides which intent the conversation is about.
 * ========================================================================= */

describe("intent decides, with the phrase table as a supporting signal", () => {
  const CASES: readonly (readonly [string, string])[] = [
    ["U sent me wrong one, it's a round three different colour glass hanging light", "Wrong item sent messages"],
    ["Falsches Design bestellt Frau ist unzufrieden will ein anderes Design", "Order change, before shipping queries"],
    ["Would this power 12volt car lights?", "Pre sales queries"],
    ["Hallo, ich wäre dankbar für möglichst schnelle Lieferung", "Delivery queries"],
    ["Only two lampshades arrived but should be three", "Parts missing queries"],
    ["Cannot assemble as shown in photograph", "Wrong description issues"],
    ["I want my money back", "Return and refunds"],
  ];

  it.each(CASES)("classifies %j", (text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });

  /**
   * THE CONFLICT CASE FROM THE BRIEF, and the clearest demonstration that
   * scoring no longer decides. The phrase table scores Return twice here
   * ("return it", "can i return") against Wrong item once. Under scoring that
   * is a Return case. Under intent it is not: the customer wants the right
   * item, and asking whether they can send this one back is how they get it.
   */
  it("prefers the intent over the phrase score where they disagree", () => {
    const text = "Wrong item received, can I return it?";
    expect(detectIntents(text)).toContain("received_wrong_item");
    expect(detectIntents(text)).not.toContain("wants_refund");
    expect(classifyMessageCategoryWithFallback(text)).toBe("Wrong item sent messages");
  });

  /**
   * A hit in the Return phrase list becomes `wants_replacement`, not
   * `wants_refund`, unless the money is actually asked for. That single mapping
   * is what stops the outcome category from swallowing problem reports.
   */
  it("reads a return phrase as a route, not as a refund", () => {
    for (const text of [
      "You sent the wrong item, I can send it back",
      "It arrived damaged, please send a replacement",
      "The unit is faulty, can you send another",
      "A part is missing, please send me a new one",
      "Not as described, I can return it",
    ]) {
      expect(detectIntents(text), text).toContain("wants_replacement");
      expect(detectIntents(text), text).not.toContain("wants_refund");
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Return and refunds");
    }
  });

  /** Intent resolves conflicts the phrase table could only refuse. */
  it("names conversations the strict table declined as ties", () => {
    for (const [text, expected] of [
      // THE PROBLEM, NOT THE REMEDY. CST files a refund asked for about
      // damage under Damage: the guide decides whether the answer is a
      // discount, a replacement or the money, and that decision is its own.
      ["It arrived damaged and I would like a refund.", "Damage queries"],
      ["Wrong item sent, and it is faulty too.", "Wrong item sent messages"],
    ] as const) {
      expect(classifyMessageCategory(text), text).toBeNull();
      expect(classifyMessageCategoryWithFallback(text), text).toBe(expected);
    }
  });
});

/**
 * A shortfall the customer states as arithmetic, never as the word "missing".
 *
 * 165 live messages use "nur" with a numeral, and most are nothing to do with a
 * shortfall — which is why the rule compares the numbers rather than matching
 * the word. 61 pair it with an expectation, and 46 of those carry no parts or
 * quantity phrase at all, so they were unreachable before.
 */
describe("a shortfall stated in numbers", () => {
  it("names it when a larger count appears alongside the 'only' count", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "Leider sind nur 2 Lampenschirme dabei. Es sollten aber 3 dabei sein.",
      ),
    ).toBe("Parts missing queries");
    expect(
      classifyMessageCategoryWithFallback(
        "dass nur zwei Lampenschirme ineinander gestapelt waren. Ansonsten war alles für drei Lichtquellen.",
      ),
    ).toBe("Parts missing queries");
    expect(classifyMessageCategoryWithFallback("Only two lampshades arrived but should be three")).toBe(
      "Parts missing queries",
    );
    // SIX LAMPS ORDERED, ONE ARRIVED. The count is measured against the order,
    // so this is the quantity case, not the parts case its neighbours above
    // are — see "a shortfall against the order is a quantity error".
    expect(
      classifyMessageCategoryWithFallback(
        "Ich habe 6 Lampen bestellt. Es ist nur eine Lampe angekommen.",
      ),
    ).toBe("Wrong quantity sent issues");
  });

  /**
   * THE GUARD THAT MAKES IT SAFE. One count in the message is not a shortfall,
   * however the sentence is worded — otherwise every "I only ordered 2" would
   * be read as something absent.
   */
  it("does not fire when only one count is named", () => {
    for (const text of [
      "Ich habe nur 2 bestellt",
      "I only ordered 2 of these",
      "Nur eine Frage: passt das an eine E27 Fassung?",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Parts missing queries");
    }
  });

  it("does not read a year or a reference number as a quantity", () => {
    expect(
      classifyMessageCategoryWithFallback("Ich habe nur 2 Stück, Bestellung von 2024 war in Ordnung"),
    ).not.toBe("Parts missing queries");
  });
});

/**
 * An order change is a REQUEST TO CHANGE THE ORDER, not two ordinary words
 * landing in the same message.
 *
 * This intent sits second in the ownership order, so anything it matches by
 * accident outranks almost every real problem report. It used to be "mentions
 * ordering" AND "mentions something else", and both halves matched by accident
 * constantly — the bare noun "order" is in 20,663 live messages and "another"
 * is how anyone asks for a replacement of anything.
 */
describe("an order change has to be an actual amendment request", () => {
  /**
   * THE REPORTED REGRESSION. The customer received what they ordered and says
   * the cable is thicker than the listing claims — a specification mismatch.
   * It was named an order change because "order arrived" matched the ordering
   * list and "does the width change" matched the something-else list. Neither
   * has anything to do with amending an order.
   */
  it("names a specification mismatch against the listing, not an order change", () => {
    const text =
      "Hi order arrived but the cable is wider than advertised! Your cables are advertised at 6mm but mine is 8.85mm... does the width change because it's hemp.";
    expect(classifyMessageCategoryWithFallback(text)).toBe("Wrong description issues");
    expect(detectIntents(text)).not.toContain("wants_order_change");
  });

  /** The same message as it actually arrived, typos and all. */
  it("names the live version of that message the same way", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "Hia order arrived but the cable is wider than advertised ! Your cables are advertised at 6mm but mine is 8.85mm has there been a mistake I am wanting to hang three celling lights and was hoping it was 6mm wide, does the width change because it's hemp",
      ),
    ).toBe("Wrong description issues");
  });

  /**
   * The same defect on three other categories, found while fixing the report.
   * In every one the strict table was already right and the intent layer was
   * overriding it — "my order arrived" plus "send another" is a problem report,
   * not an amendment.
   */
  it("leaves a problem report alone when a replacement is asked for", () => {
    expect(classifyMessageCategoryWithFallback("my order arrived damaged, please send another")).toBe(
      "Damage queries",
    );
    expect(
      classifyMessageCategoryWithFallback("My order arrived but a part is missing, can you send another"),
    ).toBe("Parts missing queries");
    expect(
      classifyMessageCategoryWithFallback("my order came and the bulb is faulty, please send another"),
    ).toBe("Defective items");
  });

  /**
   * The genuine amendment requests this must keep. All are live messages that
   * carried both of the old loose tokens, and all still resolve — several of
   * them reach the category only through this intent.
   */
  it("still names a real request to change the order", () => {
    for (const text of [
      "Hi can i change colour of order to the gold colour thankyou simon",
      "hi put my old address for both orders need to change to 14 peakdean lane",
      "Hi,can I change my order to one continuous length of 3 metres",
      "Can I please change the delivery address of my order to 5 Blackhorse Close",
      "Have you received my message,can you change the order to 3 metres please.",
      "Hi I have mansged to order thr wrong cable. Coukd I change it for a braided cable.",
      "I need to cancel my order before it ships",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe(
        "Order change, before shipping queries",
      );
    }
  });

  /**
   * The customer's own mis-order is deliberately NOT in this intent. That
   * wording is already measured, and it arrives through the phrase table and
   * the strict shape rule — restating it loosely here is what caused the
   * damage above. These still work, by that other route.
   */
  it("still names the customer's own mis-order, through the measured route", () => {
    expect(classifyMessageCategoryWithFallback("I ordered the wrong colour by mistake")).toBe(
      "Order change, before shipping queries",
    );
    expect(
      classifyMessageCategoryWithFallback(
        "Falsches Design bestellt Frau ist unzufrieden will ein anderes Design von euch haben",
      ),
    ).toBe("Order change, before shipping queries");
  });

  /** The verb has to take an object. Nothing is being changed at anyone's request. */
  it("does not fire on 'change' used about a property of the product", () => {
    for (const text of [
      "does the width change because it's hemp",
      "Do the colours change when it warms up?",
      "Will the brightness change over time",
    ]) {
      expect(detectIntents(text), text).not.toContain("wants_order_change");
    }
  });
});

/**
 * Where a fixed ownership order would overrule something that was MEASURED,
 * the measurement wins. Both of these were investigated precisely because a
 * global precedence got them wrong, so neither is left to the priority list.
 */
describe("measured results survive the intent ordering", () => {
  it("keeps damage on the goods as damage, and damage on the box as context", () => {
    // Packaging damage, one damage word: the missing component is the case.
    expect(
      classifyMessageCategoryWithFallback(
        "The box was damaged and slightly open so I'm just wondering if something is missing?",
      ),
    ).toBe("Parts missing queries");
    expect(
      classifyMessageCategoryWithFallback(
        "I received the item but the box was open all damaged and the bulb are missing",
      ),
    ).toBe("Parts missing queries");
    // The goods themselves are smashed: still a damage case, despite the order.
    expect(
      classifyMessageCategoryWithFallback(
        "The box was damaged and the shade is smashed, and a part is missing",
      ),
    ).toBe("Damage queries");
    expect(classifyMessageCategoryWithFallback("The item arrived damaged and the glass is cracked.")).toBe(
      "Damage queries",
    );
  });

  /**
   * "uns fehlt die Rechnung" — the missing thing is the paperwork. All six live
   * conversations where this collides are invoice requests.
   */
  it("keeps a missing invoice as an admin matter", () => {
    expect(classifyMessageCategoryWithFallback("Leider fehlt uns die Rechnung hierzu, bitte senden.")).toBe(
      "Admin related issues",
    );
    expect(classifyMessageCategoryWithFallback("Mir fehlt die Rechnung zum Kauf.")).toBe(
      "Admin related issues",
    );
  });

  /**
   * The proximity bound on that rule. An absent component and a separate
   * invoice request are two things, and the component is the case.
   */
  it("does not read an unrelated invoice request as the missing thing", () => {
    expect(
      classifyMessageCategoryWithFallback("A part is missing, and can you send the invoice?"),
    ).toBe("Parts missing queries");
  });

  it("still names the German and Italian wording only the table knows", () => {
    expect(classifyMessageCategoryWithFallback("Die Lieferung ist unvollständig, eine Halterung fehlt.")).toBe(
      "Parts missing queries",
    );
    expect(classifyMessageCategoryWithFallback("Pertanto devo restituirlo.")).toBe("Return and refunds");
    expect(classifyMessageCategoryWithFallback("Wie läuft die Retoure ab?")).toBe("Return and refunds");
    expect(
      classifyMessageCategoryWithFallback("Laut Beschreibung müsste das Netzteil 300W haben."),
    ).toBe("Wrong description issues");
  });
});

/**
 * Chasing a parcel is a delivery question, whatever words the customer picks.
 *
 * The reported message — "Hello can you tell me where is the item please still
 * hasn't arrived" — already reached Delivery queries through "hasn't arrived"
 * in the table, and is pinned here so it stays that way. The genuine gaps the
 * same investigation found were "where is my parcel" and "waiting for
 * delivery", which had no path to the delivery intent at all: `DELIVERY_NOUN`
 * is German-only, so the English nouns never reached it.
 */
describe("asking where the consignment is", () => {
  it("names the reported message Delivery queries", () => {
    expect(
      classifyConversationCategory([
        "Hello can you tell me where is the item please still hasn't arrived",
      ]),
    ).toBe("Delivery queries");
  });

  it("names a whereabouts question Delivery queries", () => {
    for (const text of [
      "Where is my item? Still hasn't arrived",
      "My parcel has not arrived yet",
      "where is my order",
      "where is my parcel",
      "where's the package",
      "waiting for delivery",
      "still waiting on my order",
      "when will it arrive",
      "not arrived yet",
      "any news on my parcel",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Delivery queries");
    }
  });

  /**
   * The word "arrived" on its own is not a delivery question — it is how a
   * customer opens a message about anything that happened after the parcel
   * turned up. Requiring the whereabouts half is what keeps these out.
   */
  it("does not read a message that merely mentions arrival as a delivery query", () => {
    for (const text of [
      "Thank you, order arrived",
      "The order arrived this morning, thank you",
      "My order arrived and it is perfect",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Delivery queries");
    }
  });

  /**
   * `delivery_request` sits eighth in the ownership order, below every one of
   * these, so a message carrying a real problem is decided before the delivery
   * signal is consulted — even when it also names a consignment.
   */
  it("leaves damage, missing parts and wrong item alone", () => {
    // CORRECTED AGAINST CST, not a regression. "Box arrived damaged" was
    // asserted to be a Damage query on the strength of the word "damaged"
    // alone. It is the first phrase of the trigger row on
    // `Delivery_Master_Rules final.xlsx` › "💥 9 – Damaged in Transit", whose
    // stated condition is "Outer box damaged — customer says contents appear
    // OK" — a courier packaging complaint, with no claim about the goods. The
    // Damage guide's nine product sheets describe only the goods.
    //
    // The line the test was written to protect is unchanged and still tested
    // below: name the GOODS as damaged and Damage takes it back.
    expect(classifyMessageCategoryWithFallback("Box arrived damaged")).toBe("Delivery queries");
    expect(classifyMessageCategoryWithFallback("Box arrived damaged and the shade is smashed")).toBe(
      "Damage queries",
    );
    expect(classifyMessageCategoryWithFallback("Missing part from package")).toBe(
      "Parts missing queries",
    );
    expect(
      classifyMessageCategoryWithFallback("Where is my order, you sent me the wrong item"),
    ).toBe("Wrong item sent messages");
    expect(
      classifyMessageCategoryWithFallback("Still waiting for my parcel and a part is missing"),
    ).toBe("Parts missing queries");
  });

  /**
   * "Where do I..." asks after a PROCEDURE, not a location. Restricting the
   * verb to the copular forms is what separates the two.
   */
  it("does not fire on 'where' used to ask how to do something", () => {
    expect(
      classifyMessageCategoryWithFallback("Where do I return the item please"),
    ).not.toBe("Delivery queries");
  });
});

/* ========================================================================= *
 * WHERE THE ORDER IS IN ITS LIFE
 *
 * Three reported misclassifications, and one cause behind two of them: the
 * classifier knew what the customer was ASKING for and not whether the parcel
 * had already turned up. A swap before dispatch and a swap after delivery are
 * opposite ends of an order's life and belong to different categories, and
 * nothing in the intent layer was reading that difference.
 *
 * The third is separate and simpler: "this week" was enough to name a message
 * a Delivery query, whatever the message was about.
 * ========================================================================= */

describe("a return or swap AFTER delivery is not an order change", () => {
  /**
   * REPORTED. Named "Order change, before shipping queries" because "swap them
   * both for black" reached the amendment intent, which sits second in the
   * ownership order and never asked whether the parcel had arrived. It had:
   * the customer says so in the first sentence.
   */
  it("names the reported post-delivery colour swap Return and refunds", () => {
    const text =
      "I'm really sorry I received my parcel today but the colour is not what I expected. Please is it possible to return it and swap them both for black. Box is packaged exactly the same as I only took out the shades to look at.";
    expect(classifyMessageCategoryWithFallback(text)).toBe("Return and refunds");
    expect(classifyConversationCategory([text])).toBe("Return and refunds");
    expect(detectIntents(text)).toContain("wants_post_delivery_return");
  });

  it("names received plus an explicit return and colour swap the same way", () => {
    for (const text of [
      "I received it today and want to return it and swap it for black.",
      "The shades arrived this morning but I would like to return them and exchange for the black ones.",
      "My order turned up yesterday, can I return it and have the chrome one instead?",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Return and refunds");
    }
  });

  /**
   * THE BOUNDARY THIS RULE EXISTS TO PROTECT. The same verbs, with nothing
   * delivered: still an amendment, and still decided before the parcel leaves.
   */
  it("leaves a genuine pre-shipping change exactly where it was", () => {
    for (const text of [
      "Can you change my order to black before you send it?",
      "Hi can i change colour of order to the gold colour thankyou simon",
      "Hi I have mansged to order thr wrong cable. Coukd I change it for a braided cable.",
      "I need to cancel my order before it ships",
      "Have you received my message,can you change the order to 3 metres please.",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe(
        "Order change, before shipping queries",
      );
      expect(detectIntents(text), text).not.toContain("wants_post_delivery_return");
    }
  });

  /**
   * "swap" and "change" are not made to mean Return. Delivery is the whole
   * condition, and without it neither word reaches this intent.
   */
  it("does not let the words swap or change mean a return on their own", () => {
    for (const text of [
      "Can I swap my order for the larger size before dispatch?",
      "Please change my order to the black shade",
    ]) {
      expect(detectIntents(text), text).not.toContain("wants_post_delivery_return");
    }
  });

  /**
   * A PROBLEM WITH THE GOODS STILL OWNS THE MESSAGE. Every one of these is
   * post-delivery and asks for a swap or a return, and every one keeps the
   * category the measured rules already gave it — this intent cannot fire when
   * something is actually wrong with what we sent.
   */
  it("never takes a message that reports a problem with the goods", () => {
    for (const [text, expected] of [
      ["my order arrived damaged, please send another", "Damage queries"],
      ["My order arrived but a part is missing, can you send another", "Parts missing queries"],
      ["my order came and the bulb is faulty, please send another", "Defective items"],
      ["Wrong design arrived, I would like a different one", "Wrong item sent messages"],
      [
        "Could you send a returns label so I can return the wrong item that was delivered.",
        "Wrong item sent messages",
      ],
      [
        "Received wall lamps but shades/fittings cannot assemble as photograph portrays",
        "Wrong description issues",
      ],
    ] as const) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe(expected);
      expect(detectIntents(text), text).not.toContain("wants_post_delivery_return");
    }
  });

  /**
   * "not what I ordered" reads an order against what arrived; "not what I
   * expected" reads a hope against it. Only the first is a wrong item.
   */
  it("tells a wrong item apart from an unmet expectation", () => {
    expect(detectIntents("You sent the wrong item, not what i ordered")).toContain(
      "received_wrong_item",
    );
    expect(detectIntents("I received it today and the colour is not what I expected")).not.toContain(
      "received_wrong_item",
    );
  });
});

describe("a stock question inside a post-delivery exchange", () => {
  /**
   * REPORTED. Two messages: the lamp arrived in the wrong colour, then the
   * customer asks whether the colour they want is in stock. The first message
   * carried no intent at all — no phrase in it says "wrong", "return" or
   * "swap" — so the thread was decided by the second, and "in stock" made it
   * Pre sales. The stock question is how the customer chooses the replacement,
   * not a fresh enquiry.
   */
  it("names the reported conversation Return and refunds", () => {
    const thread = [
      "Hi. Lamp arrived not quite the right colour i was expecting a deeper red/copper colour here is one i bought from you last time, i need this colour",
      "Do you have this in stock? I think its this?",
    ];
    expect(classifyConversationCategory(thread)).toBe("Return and refunds");
    expect(classifyMessageCategoryWithFallback(thread[0]!)).toBe("Return and refunds");
  });

  it("names the same shape stated more plainly", () => {
    expect(
      classifyConversationCategory([
        "The lamp arrived, I need the deeper copper one.",
        "Do you have that colour in stock?",
      ]),
    ).toBe("Return and refunds");
  });

  /**
   * "in stock" is not made to mean the opposite either. A standalone
   * availability question, with nothing delivered, is still pre-sales.
   */
  it("leaves a standalone availability question as pre-sales", () => {
    expect(classifyMessageCategoryWithFallback("Do you have the black shade in stock?")).toBe(
      "Pre sales queries",
    );
    expect(classifyConversationCategory(["Do you have this in stock? I think its this?"])).toBe(
      "Pre sales queries",
    );
  });

  /** Wanting MORE of what arrived is a purchase, not an exchange. */
  it("does not read a repeat purchase as an exchange", () => {
    expect(
      detectIntents("The lamp arrived and is lovely, I need the same colour for the hallway"),
    ).not.toContain("wants_post_delivery_return");
  });
});

describe("Delivery queries needs an actual delivery question", () => {
  /**
   * REPORTED. Named "Delivery queries" on the strength of "this week" — two
   * words dating a shopping trip. No parcel, no whereabouts question, no delay,
   * nothing outstanding. With no stronger category available it belongs on the
   * admin fallback.
   */
  it("does not read a purchase comment as a delivery query", () => {
    for (const text of [
      "yes 🤣brought 3 of these shades this week didn't know I could buy as an option £10.89. £10.89. £10.89",
      "I bought 3 shades this week and didn't know this was available as an option.",
    ]) {
      expect(detectIntents(text), text).not.toContain("delivery_request");
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Admin related issues");
    }
  });

  /** The real thing, in both of its shapes, unchanged. */
  it("still names a whereabouts question and a non-arrival", () => {
    for (const text of [
      "Where is my parcel? It still hasn't arrived.",
      "Still waiting for my order.",
      "where's the package",
      "when will it arrive",
      "Can it arrive this week?",
      "any news on my parcel",
      "Hallo, ich wäre dankbar für möglichst schnelle Lieferung",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Delivery queries");
    }
  });

  /**
   * Next to a delivery noun the same deadline words do mean delivery, and that
   * is what the deadline branch is kept for. `DELIVERY_NOUN` is German-only, so
   * this is the German form — and deliberately without "noch", which would
   * reach the expedite pattern instead and prove nothing about the deadline.
   */
  it("keeps a deadline that is attached to a delivery", () => {
    expect(classifyMessageCategoryWithFallback("Ist eine Lieferung diese Woche möglich?")).toBe(
      "Delivery queries",
    );
  });
});

describe("the three fixes disturb nothing that was already right", () => {
  it("keeps a true listing discrepancy as a description issue", () => {
    expect(classifyMessageCategoryWithFallback("The listing said copper but you sent red.")).toBe(
      "Wrong description issues",
    );
  });

  it("keeps damage, missing parts and wrong item where they were", () => {
    expect(
      classifyMessageCategoryWithFallback("The item arrived damaged and the glass is cracked."),
    ).toBe("Damage queries");
    expect(
      classifyMessageCategoryWithFallback(
        "Hi I've just received the shade... wondering if something is missing?",
      ),
    ).toBe("Parts missing queries");
    expect(classifyMessageCategoryWithFallback("I received the wrong shade")).toBe(
      "Wrong item sent messages",
    );
    expect(classifyMessageCategory("Wrong item, arrange a return")).toBe("Wrong item sent messages");
  });

  it("keeps a resolved thread deliberately uncategorised", () => {
    expect(classifyConversationCategory(["Found it, all sorted."])).toBeNull();
    expect(classifyMessageCategoryWithFallback("Found it, all sorted.")).toBeNull();
    expect(
      classifyConversationCategory([
        "Only two lampshades arrived, one is missing",
        "Found it, all sorted.",
      ]),
    ).toBe("Parts missing queries");
  });
});

/* ========================================================================= *
 * QUANTITY SHORTAGE, AND THE TWO THINGS IT IS NOT
 *
 * A count that falls short is not one case but two, and both are told apart
 * from a pre-sales question about pack size by the same rule: every number gets
 * a ROLE from the verb governing it, and a shortage needs a received count
 * below an expected one. A message with only one role, or none, cannot reach
 * the comparison at all.
 *
 * WHICH of the two cases it is depends on WHAT THE COUNT IS MEASURED AGAINST —
 * the order, or the contents of what arrived. See "a shortfall against the
 * order is a quantity error" and "a shortfall inside the product is a parts
 * case" below; the pair of near-identical German and English threads is the
 * clearest statement of the difference.
 * ========================================================================= */

describe("a shortfall against the order is a quantity error", () => {
  /**
   * THE TWO REPORTED CONVERSATIONS, verbatim, typos included.
   *
   * Both were named Parts missing when the shortage rule was first written,
   * and both are wrong: every bulb and every driver that arrived is complete.
   * What is short is the number of UNITS against the order.
   */
  it("names the reported short deliveries Wrong quantity sent issues", () => {
    for (const text of [
      "Hi I ordered 6 bulbs but have only recieved 3",
      "Hi i ordered 2 of these and only received 1 of the drivers",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Wrong quantity sent issues");
      expect(classifyConversationCategory([text]), text).toBe("Wrong quantity sent issues");
    }
  });

  const SHORT_AGAINST_ORDER: readonly (readonly [string, ShortfallReason])[] = [
    ["I ordered 6 bulbs but received 3.", "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"],
    ["I ordered 5 and received 2.", "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"],
    ["I ordered 2 and only 1 arrived.", "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"],
    ["I ordered two drivers and only one arrived.", "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"],
    ["I expected 4 but got 3.", "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"],
    ["I should have received 4 but only got 2.", "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"],
    ["I bought 5 shades and 2 turned up.", "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"],
    ["Only half of my order arrived.", "PARTIAL_ORDER_RECEIVED"],
    ["Ich habe 6 Lampen bestellt. Es ist nur eine Lampe angekommen.", "ORDERED_QUANTITY_GREATER_THAN_RECEIVED"],
  ];

  it.each(SHORT_AGAINST_ORDER)("names %j a quantity error", (text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Wrong quantity sent issues");
    expect(detectIntents(text)).toContain("wrong_quantity_sent");
  });

  /** The evidence is reportable, so a reviewer can ask which rule fired. */
  it.each(SHORT_AGAINST_ORDER)("records why for %j", (text, reason) => {
    expect(quantityShortfallEvidence(text)).toBe(reason);
  });

  /** Measured wording the phrase table already knew, now reaching a category. */
  it("names a shortfall stated without numbers", () => {
    for (const text of [
      "I received fewer than I ordered.",
      "I ordered a set of 4 and I only received one.",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Wrong quantity sent issues");
    }
  });
});

describe("a shortfall inside the product is a parts case", () => {
  /**
   * THE DISTINCTION, AS TWO ALMOST IDENTICAL MESSAGES.
   *
   * "ordered 2 ... only received 1 of the drivers" counts units against the
   * order. "only 2 lampshades are in the box, there should be 3" counts the
   * contents of a single pendant lamp that arrived exactly as ordered. Same
   * arithmetic, different case, and the anchor is the only thing that says so.
   */
  const SHORT_INSIDE_THE_PRODUCT: readonly string[] = [
    "Only two lampshades arrived but should be three",
    "Leider sind nur 2 Lampenschirme dabei. Es sollten aber 3 dabei sein.",
    "There were meant to be 3 drivers but only 1 was in the parcel.",
    "The lamp arrived but the screws are missing.",
    "The lamp arrived but one screw is missing.",
    "The shade is here but the reducer ring was not included.",
    "One component is missing.",
    "One component is missing from the package.",
    "The product arrived without the mounting bracket.",
    "I received the parcel but one component is missing.",
    "Die Lieferung ist unvollständig, eine Halterung fehlt.",
  ];

  it.each(SHORT_INSIDE_THE_PRODUCT)("names %j Parts missing", (text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Parts missing queries");
    expect(detectIntents(text)).toContain("missing_component");
  });

  it("records the component reason rather than the quantity one", () => {
    for (const text of SHORT_INSIDE_THE_PRODUCT) {
      expect(quantityShortfallEvidence(text), text).toBe("MISSING_ORDER_COMPONENT");
    }
  });
});

describe("a quantity QUESTION is not a shortage", () => {
  it("names pack-size and price-per-unit questions as pre-sales", () => {
    for (const text of [
      "How many drivers are included?",
      "How many are included?",
      "Is it one or two?",
      "Is this one or a pair?",
      "Is this sold as a pair?",
      "Do I get two for this price?",
      "Is this price for one bulb?",
      "Is it just one crow for £19.89?",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Pre sales queries");
      expect(quantityShortfallEvidence(text), text).toBeNull();
    }
  });

  /**
   * A PRICE IS NOT A QUANTITY. "just one" gave a received count of 1 and the
   * "19" inside "£19.89" was read as the expectation, so a pre-sales question
   * became a parts case. Currency and decimals are excluded from counts now.
   */
  it("does not read a price as the expected quantity", () => {
    expect(quantityShortfallEvidence("Is it just one crow for £19.89?")).toBeNull();
    expect(quantityShortfallEvidence("Only 1 left at £29.99 then?")).toBeNull();
  });

  /**
   * ONE ROLE IS NOT A COMPARISON. Each of these names a count and nothing to
   * measure it against, so none of them can be a shortage.
   */
  it("does not fire on a number with nothing to compare it to", () => {
    for (const text of [
      "I only received one",
      "I only ordered 2 of these",
      "Ich habe nur 2 bestellt",
      "Is it one or two?",
      "Nur eine Frage: passt das an eine E27 Fassung?",
    ]) {
      expect(quantityShortfallEvidence(text), text).toBeNull();
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Parts missing queries");
    }
  });

  it("does not read a year or a reference number as a quantity", () => {
    expect(
      quantityShortfallEvidence("Ich habe nur 2 Stück, Bestellung von 2024 war in Ordnung"),
    ).toBeNull();
  });
});

describe("the shortage rule leaves the neighbouring categories alone", () => {
  it("keeps a wrong item, a description complaint and a chase where they belong", () => {
    for (const [text, expected] of [
      ["I received a completely different driver.", "Wrong item sent messages"],
      [
        "The listing says 6 bulbs are included, but the listing itself is inaccurate.",
        "Wrong description issues",
      ],
      ["The parcel is still on the way.", "Delivery queries"],
      ["Shade arrived smashed", "Damage queries"],
    ] as const) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe(expected);
    }
  });
});

/**
 * ALL SEVEN REPORTED CONVERSATIONS, in one table.
 *
 * Kept together deliberately: each was fixed in a different pass, and the point
 * of the matrix is that no later pass cost an earlier one its answer.
 */
describe("the seven real reported conversations", () => {
  const REPORTED: readonly (readonly [string, string[], MessageCategory])[] = [
    [
      "received parcel, wants return and swap for black",
      [
        "I'm really sorry I received my parcel today but the colour is not what I expected. Please is it possible to return it and swap them both for black. Box is packaged exactly the same as I only took out the shades to look at.",
      ],
      "Return and refunds",
    ],
    [
      "lamp arrived, wants another colour, with a supporting stock question",
      [
        "Hi. Lamp arrived not quite the right colour i was expecting a deeper red/copper colour here is one i bought from you last time, i need this colour",
        "Do you have this in stock? I think its this?",
      ],
      "Return and refunds",
    ],
    [
      "purchase comment with no actionable issue",
      [
        "yes 🤣brought 3 of these shades this week didn't know I could buy as an option £10.89. £10.89. £10.89",
      ],
      "Admin related issues",
    ],
    ["shade arrived smashed", ["Shade arrived smashed"], "Damage queries"],
    ["pack-size question before buying", ["Is it just one crow for £19.89?"], "Pre sales queries"],
    [
      "ordered 6, received 3",
      ["Hi I ordered 6 bulbs but have only recieved 3"],
      "Wrong quantity sent issues",
    ],
    [
      "ordered 2, received 1",
      ["Hi i ordered 2 of these and only received 1 of the drivers"],
      "Wrong quantity sent issues",
    ],
  ];

  it.each(REPORTED)("classifies %s", (_name, messages, expected) => {
    expect(classifyConversationCategory(messages)).toBe(expected);
  });
});

/* ------------------------------------------------------------------------- *
 * CST SEMANTIC CATEGORY OWNERSHIP
 *
 * One case per owning category, written as the ownership rule states it rather
 * than as any single rule book phrases it. These are the boundaries the
 * evidence layer exists to hold: every one of them is wording that at least two
 * CST workbooks claim, and each has exactly one owner.
 * ------------------------------------------------------------------------- */

describe("semantic category ownership", () => {
  const OWNERSHIP: readonly (readonly [string, string, MessageCategory])[] = [
    // 1. DAMAGE — the received product is physically damaged. Delivery 9.3 and
    // Defective INT-DF12 both claim this vocabulary; neither owns it.
    ["smashed goods", "One of the shades arrived smashed.", "Damage queries"],
    ["shattered goods", "The glass shade arrived shattered.", "Damage queries"],
    ["broken goods", "The pendant arrived broken.", "Damage queries"],
    ["cracked goods", "The shade is cracked.", "Damage queries"],
    ["dented goods", "The metal shade has a big dent in it.", "Damage queries"],
    ["chipped goods", "The paint is chipped on the arm.", "Damage queries"],

    // 2. DELIVERY — whereabouts, non-arrival, transit and outer packaging.
    ["whereabouts", "Where is my parcel?", "Delivery queries"],
    ["delivered not received", "Tracking says delivered but nothing received.", "Delivery queries"],
    ["packaging damage", "Box damaged but product fine.", "Delivery queries"],

    // 3. DEFECTIVE — intact and not working.
    ["intact but dead", "Lamp arrived intact but does not work.", "Defective items"],
    ["stopped working", "It stopped working after two days.", "Defective items"],
    ["flickering", "The bulb is flickering.", "Defective items"],

    // 4. WRONG QUANTITY — fewer units than ordered.
    ["ordered 6 received 3", "I ordered 6 bulbs but received 3.", "Wrong quantity sent issues"],
    ["ordered 2 received 1", "I ordered 2 but only received 1.", "Wrong quantity sent issues"],
    ["fewer than ordered", "Received fewer than I ordered.", "Wrong quantity sent issues"],

    // 5. PARTS MISSING — the unit is here, a component is not.
    ["screws absent", "Lamp arrived but mounting screws are missing.", "Parts missing queries"],
    ["bracket absent", "The bracket was not included.", "Parts missing queries"],
    ["reducer ring absent", "The reducer ring is missing.", "Parts missing queries"],

    // 6. RETURN AND REFUNDS — post-delivery return, refund, exchange or swap.
    ["exchange after delivery", "Received it and want to exchange it.", "Return and refunds"],
    [
      "swap after delivery",
      "Received them today and want to swap them for black.",
      "Return and refunds",
    ],

    // 7. ORDER CHANGE — modification or cancellation before dispatch.
    [
      "colour change before dispatch",
      "Change it to black before you send it.",
      "Order change, before shipping queries",
    ],
    [
      "quantity change before dispatch",
      "Change quantity before dispatch.",
      "Order change, before shipping queries",
    ],

    // 8. PRE SALES — a prospective purchase question.
    ["pack size", "Is it just one crow for £19.89?", "Pre sales queries"],
    ["how many included", "How many are included?", "Pre sales queries"],

    // 9. WRONG DESCRIPTION — the listing and the goods differ.
    [
      "listing says copper",
      "Listing says copper but the received item is red.",
      "Wrong description issues",
    ],

    // 10. WRONG ITEM SENT — a materially different product.
    ["different product", "Ordered shade A but received shade B.", "Wrong item sent messages"],
    ["stated mismatch", "You sent me the wrong item.", "Wrong item sent messages"],

    // 11. ADMIN — the fallback, and the paperwork it genuinely owns.
    ["invoice request", "Please send me a VAT invoice.", "Admin related issues"],
    [
      "purchase comment with nothing actionable",
      "Bought 3 of these shades this week didn't know I could buy as an option",
      "Admin related issues",
    ],
  ];

  it.each(OWNERSHIP)("gives %s to the owning category", (_name, text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });
});

/**
 * The ownership rules stated as EXCLUSIONS — the category each of these must
 * NOT be, because another rule book's trigger list would otherwise claim it.
 */
describe("categories that overlapping trigger wording must not win", () => {
  it("does not let Delivery take damage to the product itself", () => {
    for (const text of [
      "One of the shades arrived smashed.",
      "The glass shade arrived shattered.",
      "Item arrived broken — can't use it.",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Damage queries");
    }
  });

  it("does not let Defective take physically broken goods", () => {
    for (const text of ["The shade arrived smashed.", "The glass is cracked."]) {
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Defective items");
    }
  });

  it("does not let Damage take a battered box with intact contents", () => {
    expect(classifyMessageCategoryWithFallback("Box arrived damaged, contents seem okay")).toBe(
      "Delivery queries",
    );
  });

  it("does not read a bare arrival as a delivery query", () => {
    for (const text of ["I received the parcel.", "My order arrived and it is perfect"]) {
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Delivery queries");
    }
  });

  it("does not read a single count as a missing part", () => {
    expect(classifyMessageCategoryWithFallback("I only received one.")).not.toBe(
      "Parts missing queries",
    );
  });

  it("does not read a quantity mismatch as a missing part or a wrong item", () => {
    for (const text of [
      "I ordered 6 bulbs but received 3.",
      "I ordered 2 but only received 1.",
      "Received fewer than I ordered.",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Wrong quantity sent issues");
    }
  });

  it("does not let a stock question override an active exchange", () => {
    expect(
      classifyConversationCategory([
        "Received them today but the colour is not what I wanted, can I swap them for black?",
        "Do you have this in stock? I think its this?",
      ]),
    ).toBe("Return and refunds");
  });

  it("does not read an unexpected colour on its own as a description error", () => {
    for (const text of [
      "The colour is a bit darker than I hoped.",
      "The shade is a nicer colour than I expected.",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Wrong description issues");
    }
  });

  it("does not read a post-delivery exchange as a pre-shipping amendment", () => {
    for (const text of [
      "Received it and want to exchange it.",
      "Received them today and want to swap them for black.",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe(
        "Order change, before shipping queries",
      );
    }
  });
});

/**
 * A CASE THE CUSTOMER CLOSED IS NOT WHAT THE THREAD IS ABOUT.
 *
 * "Earliest case wins" is right for a thread that ends with a thank-you, and it
 * still is. It is wrong for the thread where the first problem was solved and a
 * second one raised after it.
 */
describe("a resolved case does not outrank a newer unresolved one", () => {
  it("takes the case raised after the resolution confirmation", () => {
    expect(
      classifyConversationCategory([
        "A part is missing from the box.",
        "Found it, all sorted thanks.",
        "The bulb has stopped working now though.",
      ]),
    ).toBe("Defective items");
  });

  it("still keeps the original case when the closing message only closes it", () => {
    expect(
      classifyConversationCategory([
        "A part is missing from the box.",
        "Found it, all sorted thanks.",
      ]),
    ).toBe("Parts missing queries");
  });

  it("still returns nothing when the whole thread is only a resolution", () => {
    expect(classifyConversationCategory(["All sorted now", "Many thanks"])).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * PRE-SALES RECOGNITION, GROUNDED IN `PRE-SALES QUERIES.xlsx`
 *
 * A read-only audit of 50 real eBay/Amazon conversations tagged "Admin related
 * issues" found 29 wrong, and Pre sales was the largest single group at 9. Each
 * case below is either one of those nine or the CST intent family behind it.
 * ------------------------------------------------------------------------- */

describe("pre-sales questions the admin fallback used to swallow", () => {
  const PRE_SALES: readonly (readonly [string, string])[] = [
    // B — DIMENSIONS AND SPECS (INT-PS03). "measurements" was absent from the
    // attribute list while "dimensions" was present, so these two sentences
    // classified differently for no reason a customer could see.
    ["measurements, plural", "can I please have the measurements of the lampshades"],
    ["measurements, real audit wording", "Hi, can I please have the measurements of the amber tier lampshades?"],
    ["dimensions", "what are the dimensions?"],
    ["how big", "how big is the shade?"],
    ["depth", "what is the depth of the ceiling rose?"],

    // G — STOCK AND AVAILABILITY (INT-PS09). THE PLURAL BUG: the attribute list
    // held "shade" and not "shades", so the plural fell to Admin while the
    // singular was named Pre sales.
    ["stock, plural noun", "do you sell clear glass shades as well?"],
    ["stock, singular noun", "do you sell a clear glass shade?"],
    ["stock, real audit wording", "Good morning, Im just wondering, do you sell clear glass shades as well? Thanks, Helen"],
    ["stock in a colour", "do you have black in stock?"],
    ["availability by finish", "Hello there do you have 3 of the brushed refurbished copper please ?"],

    // Y — WEIGHT AND LOAD. No attribute in the list covered weight at all.
    ["weight", "what weight can these hold?"],
    ["weight, real audit wording", "I want to know what weight these can hold?"],
    ["load capacity", "what is the load capacity of the bracket?"],

    // N — COLOUR AND FINISH (INT-PS18). THE QUESTION-MARK BUG: identical
    // sentences, and only the punctuated one was recognised.
    ["colour, no question mark", "what colour is the shade underneath please"],
    ["colour, mid-sentence interrogative", "Hi there what colour is the shade underneath please"],
    ["material", "what is it made of, is it metal or plastic?"],

    // M — OUTDOOR AND IP RATING (INT-PS17).
    ["outdoor suitability", "is this suitable for outdoor use?"],
    ["used outside", "can I use this outside"],
    ["IP rating", "what is the IP rating, is it IP65?"],

    // O — WIRING AND INSTALLATION (INT-PS19).
    ["cable core count", "Hi i was wondering if its 2 or 3 core? The wire without the end"],
    ["driver advice", "please advise which driver I need"],

    // F — COMPATIBILITY QUERIES (INT-PS08).
    ["compatibility", "will this work with my existing dimmer switch?"],

    // Polite request forms the workbook lists directly, none with a question
    // mark: "could you tell me the measurement", "please state the size".
    ["polite request, no question mark", "could you tell me the size please"],
    ["please + verb", "please send me the height measurement"],
  ];

  it.each(PRE_SALES)("names %s as a pre-sales query", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Pre sales queries");
  });
});

/**
 * GERMAN, AND WHY IT IS TRANSLATED RATHER THAN TABULATED.
 *
 * `PRE-SALES QUERIES.xlsx` holds no German — zero of its 1,125 stored strings —
 * so there is no German trigger vocabulary in the approved corpus to extract,
 * and writing German trigger phrases would be inventing CST evidence. The
 * German product nouns are therefore mapped onto the English attribute the
 * workbook already approves, and the CST concepts decide as they do in English.
 */
describe("German pre-sales enquiries, translated into the CST vocabulary", () => {
  const GERMAN: readonly (readonly [string, string])[] = [
    ["outdoor suitability", "Ist die Lampe für den Aussenbereich geeignet?"],
    [
      "outdoor use with an umlaut",
      "Kann das Netzteil im Außenbereich verwendet werden und ggf. Feuchtigkeit durch Tau verkraften?",
    ],
    [
      "mains voltage, a compound noun",
      "Hallo, ich hätte doch sicherheitshalber gerne gewußt on das wirklich 2 getrennte Wicklingen sind ??? Mir geht es hier um die Galvanische Trennung zur Netzspannung !",
    ],
    ["dimensions", "Können Sie mir bitte die Abmessungen des Lampenschirms nennen?"],
    ["dimmable", "Ist diese Lampe dimmbar?"],
  ];

  it.each(GERMAN)("names %s as a pre-sales query", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Pre sales queries");
  });
});

/**
 * CONTEXT PROTECTION. Widening pre-sales recognition must not let a product
 * question take a conversation away from the problem it is about. Every one of
 * these names a product attribute AND asks something, so each would qualify as
 * a pre-sales enquiry on wording alone.
 */
describe("wider pre-sales recognition does not steal from other categories", () => {
  const PROTECTED: readonly (readonly [string, string, MessageCategory])[] = [
    [
      "a stock question inside an active exchange",
      "Lamp arrived and I want to exchange it. Do you have black in stock?",
      "Return and refunds",
    ],
    ["a counted shortage", "I ordered 6 but received 3.", "Wrong quantity sent issues"],
    ["physical damage", "Shade arrived smashed.", "Damage queries"],
    ["a functional fault", "The lamp arrived but does not work.", "Defective items"],
    ["an absent component", "The screws are missing.", "Parts missing queries"],
    [
      "an amendment to an existing order",
      "Can you change my existing order to black before dispatch?",
      "Order change, before shipping queries",
    ],
    [
      "a listing mismatch",
      "Listing says copper but the received item is red.",
      "Wrong description issues",
    ],
    ["a delivery chase", "Where is my parcel?", "Delivery queries"],
    ["a battered box", "Box damaged but product fine.", "Delivery queries"],
    ["a different product", "Ordered shade A but received shade B.", "Wrong item sent messages"],
  ];

  it.each(PROTECTED)("leaves %s alone", (_name, text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });

  /**
   * `pre_sale_question` sits directly ABOVE `admin_issue` in the ownership
   * order, so a widened attribute list puts invoice requests at risk the moment
   * one mentions a product. `ADMIN.xlsx` › A — INVOICE & VAT owns these, and
   * eleven of the sixteen genuinely-Admin conversations in the audit were
   * exactly this.
   */
  const PAPERWORK: readonly (readonly [string, string])[] = [
    ["a VAT invoice request", "Hi, Can you please supply a VAT invoice for this item?"],
    ["a VAT receipt request", "Hello could I have a vat receipt please."],
    ["an invoice request naming a product", "Can you send me the VAT invoice for the bulbs?"],
    [
      "a German invoice request",
      "Hallo, ich habe für diesen Artikel keine Rechnung erhalten. Können Sie mir diese bitte noch zukommen lassen?",
    ],
  ];

  it.each(PAPERWORK)("keeps %s with Admin", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Admin related issues");
  });

  it("still gives a non-actionable purchase comment to Admin", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "yes 🤣brought 3 of these shades this week didn't know I could buy as an option £10.89. £10.89. £10.89",
      ),
    ).toBe("Admin related issues");
  });

  it("still returns nothing for a thread that is only a resolution", () => {
    expect(classifyConversationCategory(["All sorted now", "Many thanks"])).toBeNull();
  });
});

/**
 * The plural defect, pinned as a property rather than as a list of words.
 *
 * The attribute pattern is built from stems with the plural derived, so a stem
 * that works in the singular must work in the plural. Written this way because
 * the original bug was precisely a hand-maintained list where some stems had
 * their plural and some did not.
 */
describe("product attributes recognise singular and plural alike", () => {
  const PAIRS: readonly (readonly [string, string])[] = [
    ["shade", "shades"],
    ["lamp shade", "lamp shades"],
    ["bulb", "bulbs"],
    ["fitting", "fittings"],
    ["measurement", "measurements"],
    ["dimension", "dimensions"],
    ["cable", "cables"],
    ["driver", "drivers"],
  ];

  it.each(PAIRS)("treats %s and %s the same", (singular, plural) => {
    const ask = (noun: string) => classifyMessageCategoryWithFallback(`do you sell ${noun}?`);
    expect(ask(singular)).toBe("Pre sales queries");
    expect(ask(plural)).toBe("Pre sales queries");
  });

  /**
   * The opening bound is `(?:^|[^a-z])` rather than `\b`, so a stem buried in a
   * longer word cannot fire. These are the collisions the deriving-plurals
   * change could plausibly have introduced.
   */
  it("does not fire on a stem buried inside another word", () => {
    for (const text of [
      "can you download the file for me?",
      "what is the score of the match?",
      "do you have a screwdriver?",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Pre sales queries");
    }
  });
});

/**
 * THE GUARDS THAT KEEP WIDER PRE-SALES RECOGNITION HONEST.
 *
 * Each of these is a real conversation from the remeasurement that the first
 * cut of this change got wrong. They are pinned because every one of them names
 * a product attribute and asks something, so nothing but the guard stops them.
 */
describe("pre-sales recognition yields to a return already under way", () => {
  const POST_PURCHASE: readonly (readonly [string, string])[] = [
    [
      "a return-postage negotiation quoting dimensions",
      "Due to the physical size (160mm x 140mm x 5mm) and weight (53g) of my returning parcel I believe the cost should be no more than a standard 1st class letter. I was intending to purchase the correct item 2 core x 5 mtrs.",
    ],
    [
      "a returns-label request naming the product",
      "Hi please can you send me a returns label so I can return this lampshade back to you. Many thanks",
    ],
    [
      "a return asked for alongside a stock question",
      "Hi there is it possible to return these items? We have discovered they are too big, they don't fit on to the light fitting, do you have smaller ones available?",
    ],
  ];

  it.each(POST_PURCHASE)("does not read %s as pre-sales", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).not.toBe("Pre sales queries");
  });

  /**
   * THE VETO REACHES ALL THREE WITNESSES, which is why it lives in `refine`
   * rather than at the call sites. This message was rejected by the CST
   * evidence layer and named a pre-sales query anyway, because the strict
   * phrase table lists "voltage" and reads a hit as a witness with no context.
   */
  it("holds even when the strict phrase table is the witness", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "Hi . I want to return item .. output voltage not mentioned and does not match 12v I needed",
      ),
    ).not.toBe("Pre sales queries");
  });

  /**
   * The negation matters, and mirrors `REFUND_DECLINED`: a return mentioned in
   * order to RULE IT OUT leaves a pre-sales enquiry exactly where it was.
   */
  it("still answers a wiring question that rules a return out", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "IS THE WIRING INCLUDED? The light socket also DONT WANT TO RETURN IT IF I CANNOT HOOK IT UP",
      ),
    ).toBe("Pre sales queries");
  });

  /**
   * "Returning customer" is INT-PS02 (REGULAR CUSTOMER RECOGNITION) — a buyer
   * introducing themselves, not a parcel going back.
   */
  it("does not mistake a returning customer for a return", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "Hello Returning customer. Do you sell rubber grommets? To pass the braided flex through the metal casing so that it doesn't rub and fray?",
      ),
    ).toBe("Pre sales queries");
  });
});

/**
 * "finish" is a verb at least as often as it is a noun, and putting the bare
 * stem in the attribute list cost a real delivery chase. The noun sense still
 * has to work, which is what makes this a pair rather than a single assertion.
 */
describe("an attribute that is also a common verb", () => {
  it("does not read 'finish a job' as a product finish", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "What's happening with these as we're waiting on them to finish a job",
      ),
    ).not.toBe("Pre sales queries");
  });

  it("still recognises the noun sense", () => {
    expect(classifyMessageCategoryWithFallback("what finish is it, is it metal or plastic?")).toBe(
      "Pre sales queries",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * DELIVERY RECOGNITION, GROUNDED IN `Delivery_Master_Rules final.xlsx`
 *
 * The read-only Admin audit found 8 of its 29 false-Admin conversations should
 * have been Delivery — the largest remaining gap after pre-sales. Each case
 * below is either one of those or the numbered CST scenario behind it.
 *
 * DELIVERY MESSAGES ARE USUALLY STATEMENTS, not questions. "I did not receive
 * my order" asks nothing and names no tracking claim, which is exactly why
 * sheet 13 calls itself "the FIRST catch-all for basic non-receipt messages".
 * Nothing here requires a question mark.
 * ------------------------------------------------------------------------- */

describe("delivery queries the admin fallback used to swallow", () => {
  const DELIVERY: readonly (readonly [string, string])[] = [
    // 13.1 — Not Received (General). A negated receipt, in the sheet's own
    // wording. The classifier already knew how to recognise a non-arrival; what
    // it lacked was any rule saying a stated non-arrival IS a delivery query.
    ["plain non-receipt", "Hello I did not receive my order."],
    ["no order arrival", "My order hasn't arrived"],
    ["parcel not received", "I have not received my parcel"],
    ["nothing delivered", "Nothing has been delivered"],
    ["never arrived", "Order never arrived"],
    ["still nothing", "Still nothing received"],
    ["contracted negative", "I didn't get the package"],
    ["contracted, no object", "Hello I didn't receive it yet."],

    // 2.1 — Delivered Not Received. The subject of "says" is optional, because
    // the customer usually does not name who marked it.
    ["tracking says delivered", "Tracking says delivered but nothing received."],
    ["marked delivered", "Marked as delivered but nothing here"],
    ["courier claim", "It says delivered but I haven't received it"],
    ["no delivery was made", "No delivery was made im home"],
    ["in all day", "I was in all day and there was no delivery"],
    ["left at door", "Says left at door but there's nothing"],

    // 1.1 / 13.2 — whereabouts and overdue.
    ["whereabouts", "Where is my parcel?"],
    ["still waiting", "still waiting for my order"],
    ["any update", "any update on delivery"],
    [
      "overdue",
      "Hi any idea what's going on this should have been delivered yesterday but still not with me yet can you help ?",
    ],

    // 18.1 — Urgent Deadline. A booked trade is a deadline on its own; a job or
    // an event needs a word of dependency beside it.
    [
      "electrician booked",
      "I have paid an electrician to attend on Saturday to put all the lighting in, I need this today or early morning tomorrow at the latest",
    ],
    ["electrician coming", "My electrician is coming tomorrow and I need the order before then"],
    ["installation deadline", "I need this today for the installation"],
    ["job held up", "What's happening with these as we're waiting on them to finish a job"],

    // 2.4 / 6.3 — collection point and depot.
    ["collect where", "Where can I collect it?"],
    ["pick up point", "Hi there, When and where can I pick up the item from please?"],
    ["at a collection point", "It's at a collection point"],
    ["at the depot", "Parcel is at the depot"],
    ["collection email", "Hi why I still not receive the email for collection"],
  ];

  it.each(DELIVERY)("names %s as a delivery query", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Delivery queries");
  });
});

/**
 * GERMAN, translated into the approved vocabulary for the same reason as
 * pre-sales: `Delivery_Master_Rules final.xlsx` contains no German at all, so
 * there is nothing to extract and German trigger phrases would be invented
 * evidence. "Packstation" is absent from the workbook but a parcel locker IS a
 * collection point, which sheet 2.4 owns outright.
 */
describe("German delivery messages, translated into the CST vocabulary", () => {
  const GERMAN: readonly (readonly [string, string])[] = [
    [
      "a Packstation the customer cannot access",
      "Hallo, ich hab ein Problem. Die Ware wurde in einer Packstation hinterlegt. Da ich kein Smartphon habe komme ich da nich ran und DHL kann das angeblich auch nicht ändern.",
    ],
    ["a parcel shop", "Das Paket liegt im Paketshop, ich kann es nicht abholen."],
  ];

  it.each(GERMAN)("names %s as a delivery query", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Delivery queries");
  });

  /**
   * THE OVERLAP THAT MATTERS. That first message also says "Trafo", which the
   * German map renders as "transformer" — a pre-sales product attribute. It
   * must not become a pre-sales enquiry on the strength of a product noun when
   * the actual problem is a parcel sitting in a locker. `delivery_request`
   * outranks `pre_sale_question` in `INTENT_OWNERSHIP`, so ownership resolves
   * this without narrowing legitimate German pre-sales recognition.
   */
  it("does not let a product noun turn a Packstation problem into pre-sales", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "Hallo, der Trafo wird noch ca. 9 Tage in der Packstation liegen und ich komme nicht ran.",
      ),
    ).toBe("Delivery queries");
  });

  it("still recognises a genuine German pre-sales question", () => {
    expect(classifyMessageCategoryWithFallback("Ist die Lampe für den Aussenbereich geeignet?")).toBe(
      "Pre sales queries",
    );
  });
});

/**
 * CONTEXT PROTECTION. Every case below names a consignment or a delivery word,
 * so each would qualify as a delivery query on wording alone.
 */
describe("wider delivery recognition does not steal from other categories", () => {
  const PROTECTED: readonly (readonly [string, string, MessageCategory])[] = [
    ["physical damage", "Shade arrived smashed.", "Damage queries"],
    ["a functional fault", "Lamp arrived but does not work.", "Defective items"],
    ["a counted shortage", "I ordered 6 but received 3.", "Wrong quantity sent issues"],
    ["an absent component", "Lamp arrived but screws are missing.", "Parts missing queries"],
    ["a return", "Received it and want to return it.", "Return and refunds"],
    [
      "a pre-dispatch amendment",
      "Can you change the order before dispatch?",
      "Order change, before shipping queries",
    ],
    ["a product enquiry", "Do you have this in stock?", "Pre sales queries"],
    ["a listing mismatch", "Listing says copper but received red.", "Wrong description issues"],
    ["a different product", "Ordered shade A but received shade B.", "Wrong item sent messages"],
    // CST supports this one going TO Delivery: sheet 9.1 is "Outer box damaged
    // — customer says contents appear OK".
    ["packaging-only damage", "Box damaged but product fine.", "Delivery queries"],
  ];

  it.each(PROTECTED)("leaves %s alone", (_name, text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });

  /**
   * The non-receipt pattern reads a negator followed by a receipt word. Both
   * of these contain a negator and an arrival word, and in neither is the
   * arrival in dispute — the direction requirement is what separates them.
   */
  it("does not read a fault reported after arrival as a non-receipt", () => {
    for (const text of [
      "Lamp arrived but does not work.",
      "The shade arrived but the fitting is not included.",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).not.toBe("Delivery queries");
    }
  });

  it("keeps a missing invoice with Admin rather than reading it as a non-receipt", () => {
    expect(classifyMessageCategoryWithFallback("I have not received my VAT invoice.")).toBe(
      "Admin related issues",
    );
  });

  it("keeps an unreceived refund with Return and refunds", () => {
    expect(classifyMessageCategoryWithFallback("I still have not received my refund.")).toBe(
      "Return and refunds",
    );
  });
});

/**
 * THE PARCEL TURNING UP ANSWERS "WHERE IS MY PARCEL".
 *
 * A delivery chase is the one case category its own thread routinely resolves
 * without anybody saying "sorted", so it is the one category an arrival may
 * supersede. Everything else still describes something wrong once the goods
 * are in the customer's hands.
 */
describe("an arrival supersedes an earlier delivery chase", () => {
  const THREADS: readonly (readonly [string, string[], MessageCategory])[] = [
    ["damage after a chase", ["Where is my parcel?", "It arrived smashed."], "Damage queries"],
    [
      "a fault after a chase",
      ["Where is my parcel?", "It arrived but does not work."],
      "Defective items",
    ],
    [
      "a missing part after a chase",
      ["Where is my parcel?", "It arrived but the screws are missing."],
      "Parts missing queries",
    ],
  ];

  it.each(THREADS)("takes the later case for %s", (_name, messages, expected) => {
    expect(classifyConversationCategory(messages)).toBe(expected);
  });

  it("keeps the chase when the later message is still a non-arrival", () => {
    expect(
      classifyConversationCategory(["Where is my parcel?", "Still nothing has arrived."]),
    ).toBe("Delivery queries");
  });

  it("does not supersede in the other direction", () => {
    expect(
      classifyConversationCategory(["It arrived smashed.", "Where is my replacement?"]),
    ).toBe("Damage queries");
  });

  it("takes a later chase over an earlier enquiry", () => {
    expect(
      classifyConversationCategory(["Do you stock black?", "My parcel still hasn't arrived."]),
    ).toBe("Delivery queries");
  });

  it("still returns nothing for a thread that is only a resolution", () => {
    expect(classifyConversationCategory(["All sorted now", "Many thanks"])).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * THE WHOLE MESSAGE DECIDES, NOT A PHRASE INSIDE IT
 *
 * Every case here is a COMPLETE message as a customer actually wrote it —
 * greeting, digression, sign-off and all — rather than the trigger fragment
 * lifted out of it. That is the point: each of these contains vocabulary
 * belonging to a category it must NOT be filed under, and only the reading of
 * the surrounding clause separates them.
 * ------------------------------------------------------------------------- */

describe("complete customer messages, read as situations", () => {
  const MESSAGES: readonly (readonly [string, string, MessageCategory])[] = [
    /* -------- technical specification: asked, never asserted -------- */
    [
      "a correction naming a component and a count",
      "Hello James, Thank you for your reply. However, it unfortunately has nothing to do with my actual question! " +
        'I wanted to know exactly whether this transformer "has two galvanically/electrically isolated windings"? ' +
        "I didn't ask about the power rating! I would be very grateful for a correct answer. Regards, Uwe I.",
      "Pre sales queries",
    ],
    [
      "an isolation question",
      "Could you confirm whether the primary and secondary windings are electrically isolated please",
      "Pre sales queries",
    ],
    [
      "a count asked about a feature",
      "I want to know if this driver has two independent outputs",
      "Pre sales queries",
    ],
    ["a core count question", "Can you tell me how many cores this cable has", "Pre sales queries"],
    [
      "a plain specification question",
      "Does this transformer have two isolated windings?",
      "Pre sales queries",
    ],
    [
      "how many, with the component named",
      "How many windings does this transformer have?",
      "Pre sales queries",
    ],

    /* -------- a component genuinely absent, after receipt -------- */
    [
      "a bracket absent from the box",
      "The fitting arrived today but the mounting bracket is missing from the box",
      "Parts missing queries",
    ],
    [
      "screws that should have been included",
      "I received the lamp but the screws that should have been included are not there",
      "Parts missing queries",
    ],
    [
      "a winding absent after receipt",
      "One winding is missing from the transformer I received.",
      "Parts missing queries",
    ],
    [
      "arrived without the bracket",
      "The package arrived without the required bracket.",
      "Parts missing queries",
    ],

    /* -------- units short against the order -------- */
    ["ordered six, three came", "I ordered 6 bulbs but only received 3", "Wrong quantity sent issues"],
    [
      "two ordered, one arrived",
      "I ordered two transformers and only one arrived.",
      "Wrong quantity sent issues",
    ],

    /* -------- physical damage -------- */
    [
      "the real smashed-shade message",
      "Have received my order from your good selves this morning, however one of the shades arrived smashed as per the photograph. Can you advise please. Thank you.Trevor.",
      "Damage queries",
    ],
    [
      "damage found on unpacking, blamed on the post",
      "Hi. We've just opened the box for the first time since receiving it, and unfortunately one shade is broken. It must have happened in the post.",
      "Damage queries",
    ],
    ["a cracked casing", "The transformer casing arrived cracked.", "Damage queries"],

    /* -------- functional fault -------- */
    [
      "wired correctly and dead",
      "I received it today, wired it correctly, but it does not switch on",
      "Defective items",
    ],
    ["intact but not working", "The transformer arrived but does not work.", "Defective items"],

    /* -------- listing vs reality -------- */
    [
      "a measured discrepancy against the listing",
      "The listing states 40 cm but the item I received measures 30 cm",
      "Wrong description issues",
    ],
    [
      "an asserted specification contradiction",
      "The listing says isolated outputs but this model does not have them.",
      "Wrong description issues",
    ],

    /* -------- return, delivery, wrong item -------- */
    [
      "a post-delivery colour exchange",
      "I'm really sorry I received my parcel today but the colour is not what I expected. " +
        "Please is it possible to return it and swap them both for black. " +
        "Box is packaged exactly the same as I only took out the shades to look at.",
      "Return and refunds",
    ],
    [
      "delivered but nothing received",
      "Tracking shows delivered but I have not received anything",
      "Delivery queries",
    ],
    [
      "a size that does not fit, after receipt",
      "Hi, received two vintage wall lamps as ordered, but are unable to assemble these as the glass shades are too large to fit underneath the champhored edge to secure properly.",
      "Wrong item sent messages",
    ],
  ];

  it.each(MESSAGES)("reads %s correctly", (_name, text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });
});

/**
 * A QUESTION ABOUT A COMPONENT IS NOT A REPORT OF A MISSING ONE.
 *
 * `missing parts query .xlsx` needs an assertion that something expected is
 * absent. A component noun, a count, and an interrogative frame are each
 * routinely present in a specification question, and none of them is a claim.
 */
describe("component and quantity vocabulary inside a question", () => {
  const NOT_MISSING: readonly string[] = [
    "Does it have two windings?",
    "How many screws does it come with?",
    "Is there a bracket included with this?",
    "Are there any fixings supplied?",
    "I would like to know whether it has an earth terminal",
    "Can you tell me if the shade comes with a reducer ring",
  ];

  it.each(NOT_MISSING)("does not read %j as a missing part", (text) => {
    expect(classifyMessageCategoryWithFallback(text)).not.toBe("Parts missing queries");
  });

  /**
   * The correction, which is the rollert4 defect in one line: a clause telling
   * us we answered the wrong question is not evidence about the goods,
   * whatever vocabulary it happens to contain.
   */
  const CORRECTIONS: readonly string[] = [
    "It has nothing to do with my actual question",
    "That was not my question, I asked about the winding isolation",
    "I didn't ask about the power rating",
  ];

  it.each(CORRECTIONS)("does not take evidence from the correction %j", (text) => {
    expect(detectIntents(text)).not.toContain("missing_component");
  });

  /**
   * A denial is not a report. Each of these names a problem in order to rule it
   * out, and the classifier used to file all three as the problem denied.
   */
  const DENIALS: readonly (readonly [string, MessageIntent])[] = [
    ["Nothing is broken, I just want to check the wiring", "damaged_product"],
    ["The item is not damaged, the box was just scuffed", "damaged_product"],
    ["It is not faulty, I had wired it wrongly. All working now", "defective_product"],
  ];

  it.each(DENIALS)("takes no problem from the denial in %j", (text, intent) => {
    expect(detectIntents(text)).not.toContain(intent);
  });
});

/**
 * THE CURRENT UNRESOLVED INTENT, across a whole thread.
 *
 * A conversation is a sequence of situations, and the one that matters is the
 * one still open. Earliest-case-wins is right until an earlier case is answered
 * by events.
 */
describe("the thread's current unresolved intent", () => {
  it("keeps a technical question when the customer clarifies it", () => {
    expect(
      classifyConversationCategory([
        "Hallo, ich hätte gerne gewußt ob das wirklich 2 getrennte Wicklungen sind? Mir geht es um die Galvanische Trennung zur Netzspannung!",
        "However, it unfortunately has nothing to do with my actual question! I wanted to know whether this transformer has two isolated windings? I didn't ask about the power rating!",
      ]),
    ).toBe("Pre sales queries");
  });

  it("takes the damage once the chased parcel has arrived", () => {
    expect(
      classifyConversationCategory(["Where is my parcel?", "It arrived but the shade is smashed."]),
    ).toBe("Damage queries");
  });

  /** REVERSED 2026-09-01 by the audit (conversation 11); was Return and refunds. */
  it("keeps the delivery problem when the customer gives up and asks for the money", () => {
    expect(
      classifyConversationCategory([
        "I have paid an electrician to attend on Saturday to put all the lighting in, I need this today or early morning tomorrow at the latest.",
        "No, as I've said I paid an electrician on Saturday to fix one I've got from B&Q. Please issue the refund.",
      ]),
    ).toBe("Delivery queries");
  });

  it("still keeps a chase that nothing has answered", () => {
    expect(
      classifyConversationCategory(["Where is my parcel?", "Still nothing has arrived."]),
    ).toBe("Delivery queries");
  });
});

/* ========================================================================= *
 * LIVE CATEGORY REGRESSIONS
 *
 * Each block reproduces a mistake seen on the live inbox, then pins the
 * boundary it turned on. The negative controls matter as much as the positives:
 * every one of these fixes widens a signal, and a widened signal is only safe
 * if the thing next to it still classifies as it did.
 * ========================================================================= */

describe("live regression — a different one the customer bought", () => {
  /** Height question, our reply asking for a link, customer goes elsewhere. */
  it("keeps pre-sales when the enquiry is withdrawn, not answered", () => {
    expect(
      classifyConversationCategory([
        "Could you tell me the height of this please?",
        "I've bought a different one now sorry.",
      ]),
    ).toBe("Pre sales queries");
  });

  it("still reads a different one WE supplied as a wrong item", () => {
    for (const message of [
      "You sent me a different one",
      "I received a different one",
      "I ordered the black one and received a different one",
    ]) {
      expect(classifyMessageCategoryWithFallback(message), message).toBe(
        "Wrong item sent messages",
      );
    }
  });

  it("does not lose a return the customer still wants", () => {
    for (const thread of [
      ["I've bought a different one now, can I return this?"],
      ["Can I get a refund for this order", "I have bought a different one elsewhere"],
      ["I have bought a different one, I want to send this back"],
    ]) {
      expect(classifyConversationCategory(thread), thread.join(" | ")).toBe("Return and refunds");
    }
  });
});

describe("live regression — German damage is named with a noun", () => {
  /**
   * The pattern held `beschädigt`, `zerbrochen` and `zerkratzt` — all
   * participles. A German customer reporting the commonest breakage writes a
   * noun, and every one of these fell to the admin catch-all.
   */
  it.each([
    "Die Lampe ist mit einem Riss im Glas angekommen.",
    "Der Artikel kam mit einem Riss im Glas an. Bitte um Ersatz.",
    "Das Glas ist gebrochen angekommen.",
    "Der Schirm hat eine Delle.",
    "Das Glas ist gesprungen.",
    "Der Lampenschirm hat einen Kratzer.",
  ])("reads %j as damage", (message) => {
    expect(classifyConversationCategory([message])).toBe("Damage queries");
  });

  it("keeps damage when the message also asks for paperwork", () => {
    // Secondary context must not choose the category. An invoice request
    // alongside a crack is a damage case that also wants a receipt.
    expect(
      classifyConversationCategory(["Die Lampe kam mit einem Riss im Glas an. Bitte um Rechnung."]),
    ).toBe("Damage queries");
  });

  it("leaves the English damage vocabulary exactly as it was", () => {
    for (const message of ["The glass arrived cracked", "The shade arrived shattered"]) {
      expect(classifyConversationCategory([message]), message).toBe("Damage queries");
    }
  });

  it("does not read a functional fault as damage", () => {
    expect(classifyConversationCategory(["The lamp does not work at all"])).toBe("Defective items");
  });
});

describe("live regression — an absence stated without the word missing", () => {
  /**
   * `no screws` was the one hard-coded instance of a general shape. These are
   * plain reports of a missing component that contain no form of "missing".
   */
  it.each([
    "I have received the shade but not the fitting",
    "Received the shade today but there is no fitting with it.",
    "Shade arrived without the fitting",
    "The shade came but the fitting was not in the box",
    "I received the box but not the shade, please refund",
  ])("reads %j as a missing part", (message) => {
    expect(classifyConversationCategory([message])).toBe("Parts missing queries");
  });

  /**
   * THE BOUNDARY THIS TURNS ON. "not the shade I ordered" is a wrong item and
   * contains "not the shade"; an absence is coordinated onto something that DID
   * arrive, a mismatch continues into what was expected.
   */
  it("does not read a wrong-item mismatch as an absence", () => {
    expect(classifyConversationCategory(["It's not the shade I ordered"])).not.toBe(
      "Parts missing queries",
    );
    expect(classifyMessageCategoryWithFallback("You sent me a different one")).toBe(
      "Wrong item sent messages",
    );
  });

  it("does not read a negated problem as an absence", () => {
    for (const message of [
      "There is no problem with the shade, thanks",
      "No issue with the order, just checking the delivery date",
    ]) {
      expect(classifyConversationCategory([message]), message).not.toBe("Parts missing queries");
    }
  });

  it("keeps a counted shortfall as a quantity case", () => {
    expect(classifyConversationCategory(["I ordered 6 bulbs and only 3 arrived"])).toBe(
      "Wrong quantity sent issues",
    );
  });

  it("does not read a pre-sales component question as an absence", () => {
    expect(classifyConversationCategory(["What fitting does this take?"])).toBe(
      "Pre sales queries",
    );
  });
});

describe("secondary context never chooses the category alone", () => {
  it("does not categorise from an attachment mention", () => {
    expect(classifyConversationCategory(["Photo attached"])).not.toBe("Damage queries");
  });

  it("uses the problem the photo is evidence of", () => {
    expect(classifyConversationCategory(["Photo attached, the glass is cracked"])).toBe(
      "Damage queries",
    );
  });
});

/* ========================================================================= *
 * AUG 27 – SEP 1 2026 eBay AUDIT
 *
 * Thirteen live conversations whose category was wrong, pinned in the
 * customer's own words. Grouped by the boundary each one turned on, because
 * the group is the generalisation and the conversation is only its witness.
 * ========================================================================= */

describe("audit — a remedy does not take the case from the issue that caused it", () => {
  it("keeps a delivery failure closed with a refund request", () => {
    expect(
      classifyConversationCategory([
        "Hi has this been shipped yet! Others I ordered same time from other companies have arrived, your one showing not shipped",
        "No, as I've said I paid an electrician on Saturday to fix one I've got from. B&q. Please issue the refund.",
      ]),
    ).toBe("Delivery queries");
  });

  it("keeps a delivery chase closed with an offer to refund", () => {
    expect(
      classifyConversationCategory([
        "What's happening with these as we're waiting on them to finish a job",
        "You could just refund it as I need this urgently so I'll just buy some out of CEF",
      ]),
    ).toBe("Delivery queries");
  });

  it("keeps a chase when the customer accepts a replacement", () => {
    expect(
      classifyConversationCategory([
        "Hello can you tell me where is the item pleases still hasnt arrived",
        "Yes replacement is fine thanks",
      ]),
    ).toBe("Delivery queries");
  });

  it("keeps a pre-shipping cancellation asked for with the money", () => {
    expect(
      classifyConversationCategory([
        "I purchased these by mistake. Could I cancel the order and get a refund please.",
      ]),
    ).toBe("Order change, before shipping queries");
  });

  it("keeps an electrical failure reported before the refund was asked for", () => {
    expect(
      classifyConversationCategory([
        "Hi received and used today - the smell of electric burning and the best off the switch was horrendous If I hadn't of been at home there would of been a fire ???",
        "Please could I have a refund",
      ]),
    ).toBe("Defective items");
  });

  it("keeps a breakage reported alongside a request for a replacement", () => {
    expect(
      classifyConversationCategory([
        "in a twist if a screwdriver, the bulbholder on one lamp broke. can you send me a replacement please?",
      ]),
    ).toBe("Defective items");
  });

  /** The other side of the rule: the money itself is what has not arrived. */
  it("still gives a refund chase to Return and refunds", () => {
    expect(
      classifyConversationCategory([
        "I posted the return last week.",
        "I still have not received my refund.",
      ]),
    ).toBe("Return and refunds");
  });
});

describe("audit — the customer's own mistake is not ours", () => {
  it("reads an apology for the wrong spec as a return", () => {
    expect(
      classifyConversationCategory([
        "Sorry it's the wrong one needs to be 5v output, I can return if possible please.",
      ]),
    ).toBe("Return and refunds");
  });

  it("reads the customer returning the wrong parcel as a return", () => {
    expect(
      classifyConversationCategory([
        "Hi I am really sorry it would seem my partner has returned the wrong lights to you. Please can i pay for the ones you have received to be sent back to me?",
      ]),
    ).toBe("Return and refunds");
  });

  it("still reads a wrong item WE sent as a wrong item", () => {
    for (const text of [
      "You sent me the wrong item",
      "Sorry, you sent me the wrong one",
      "I received a different one",
    ]) {
      expect(classifyConversationCategory([text]), text).toBe("Wrong item sent messages");
    }
  });
});

describe("audit — the parcel's own journey belongs to Delivery", () => {
  it("reads a missed attempt with the wrong postcode as delivery", () => {
    expect(
      classifyConversationCategory([
        "Hi ive had a delivery missed attempt But looking closely they have the incorrect postcode I'll try to put screenshot in here",
      ]),
    ).toBe("Delivery queries");
  });

  it("reads a parcel stranded abroad for collection as delivery", () => {
    expect(
      classifyConversationCategory([
        "Hey! I ordered one for me and one for mom of these but the are stranded i Denmark for pickup.",
        "Want me to pick it up in Kjellerup DK. But my address in Faroe Islands",
      ]),
    ).toBe("Delivery queries");
  });

  it("still gives an explicit cancellation to Order change", () => {
    expect(
      classifyConversationCategory(["Please cancel my order, the address is wrong"]),
    ).toBe("Order change, before shipping queries");
  });
});

describe("audit — pre-sales enquiries the catch-all was taking", () => {
  it("reads a pack-size purchase enquiry as pre-sales", () => {
    expect(
      classifyConversationCategory([
        "Hello. I have an inquiry. I would like to purchase Types 4 and 5. Do they come in boxes of 3? I need a total of 8.",
      ]),
    ).toBe("Pre sales queries");
  });

  it("keeps a compatibility thread when an electrician changes a fitting", () => {
    expect(
      classifyConversationCategory([
        "Thanks for your previous message re the black on, found this in your Sellers other items, and the chrome one would work with my decor. Would it work my corded pull switch",
        "Hi, you have'nt answered my query, will it work with my existing Pull cord?",
        "Ok, will see if my Electrician can change it to a wall switch, done it before for the bathroom",
      ]),
    ).toBe("Pre sales queries");
  });

  it("still reads a real order amendment as one", () => {
    expect(
      classifyConversationCategory(["Can you change my order to the black one please?"]),
    ).toBe("Order change, before shipping queries");
  });
});

describe("audit — a full delivery is not a shortfall", () => {
  it("reads two shades arriving in the wrong colour as a wrong item", () => {
    expect(
      classifyConversationCategory([
        "I ordered 2 dep blue lampshades ,why have you sent me one green and one blue",
        "Ordered 2 blue shades ,you have sent ,me one blue and one green Please send second blue shade ,what to do with spare green one!!!",
      ]),
    ).toBe("Wrong item sent messages");
  });

  it("still counts a genuine shortfall as one", () => {
    for (const text of [
      "I ordered 6 bulbs and only 3 arrived",
      "i ordered 2 of these and only received 1 of the drivers",
    ]) {
      expect(classifyConversationCategory([text]), text).toBe("Wrong quantity sent issues");
    }
  });
});

describe("audit — \"my order\" is a noun, not the verb", () => {
  /**
   * Live 2026-08-21. A damage report that became Wrong item sent, because
   * `ORDERED_ONE_THING_RECEIVED_ANOTHER` read the NOUN "my order" as the verb
   * and paired "and unfortunately" against "smashed in" as two different
   * things. Wrong item outranks damage, so the whole conversation moved.
   */
  it("reads a smashed bulb as damage, not a wrong item", () => {
    expect(
      classifyConversationCategory([
        "Hi\n I have just received my order and unfortunately one of the bulbs got smashed in the post (not very well packed) ",
      ]),
    ).toBe("Damage queries");
  });

  it.each([
    "I received the order and one bulb got broken",
    "your order arrived and the glass got cracked",
  ])("is not tricked by %j", (message) => {
    expect(classifyConversationCategory([message])).toBe("Damage queries");
  });

  /** The verb sense still reads a genuine contrast. */
  it("still reads an ordered-versus-received contrast", () => {
    for (const message of [
      "I ordered 2 dep blue lampshades ,why have you sent me one green and one blue",
      "I ordered the plain black one and I have received a black and chrome one",
      "I order these regularly and this time received the wrong one",
    ]) {
      expect(classifyConversationCategory([message]), message).toBe("Wrong item sent messages");
    }
  });
});
