import { describe, expect, it } from "vitest";

import { MESSAGE_CATEGORIES, SIGNALS, classifyMessageCategory } from "@/lib/knowledge/message-category";

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
   * A fault prompted this, but CST files it under the remedy the customer
   * asked for. Before, the faulty-item signal and the return signal tied 1-1
   * and it fell to null.
   */
  it("names a replacement request as a return, not as a defect", () => {
    expect(
      classifyMessageCategory(
        "hi this item arrived today it looks great but unfortunately the led ST64 bulb is not working. please would you be able to send me a new one ? i can return the one that doesn't work if you send me a return postage thank you",
      ),
    ).toBe("Return and refunds");
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
