import { describe, expect, it } from "vitest";

import {
  MESSAGE_CATEGORIES,
  SIGNALS,
  classifyConversationCategory,
  classifyMessageCategory,
  classifyMessageCategoryWithFallback,
  detectIntents,
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
  it("names the mismatch, not the return offered as a way of fixing it", () => {
    expect(
      classifyMessageCategory(
        "Sorry it's the wrong one needs to be 5v output, I can return if possible please.",
      ),
    ).toBe("Wrong item sent messages");
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
      "Wrong item sent messages",
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
      "Wrong item sent messages",
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
    ).toBe("Wrong item sent messages");
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
 * examples: this layer reaches "Return and refunds" through exactly one intent,
 * and that intent is the money.
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
    for (const text of [
      "I want my money back",
      "Please refund me",
      "Can I cancel and get a refund?",
    ]) {
      expect(detectIntents(text), text).toContain("wants_refund");
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Return and refunds");
    }
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
      ["It arrived damaged and I would like a refund.", "Return and refunds"],
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
    expect(
      classifyMessageCategoryWithFallback(
        "Ich habe 6 Lampen bestellt. Es ist nur eine Lampe angekommen.",
      ),
    ).toBe("Parts missing queries");
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
