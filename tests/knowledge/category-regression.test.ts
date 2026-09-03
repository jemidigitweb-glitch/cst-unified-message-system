import { describe, expect, it } from "vitest";

import {
  classifyConversationCategory,
  classifyMessageCategory,
  classifyMessageCategoryWithFallback,
  detectIntents,
  quantityShortfallEvidence,
  readConversation,
  semanticsOf,
} from "@/lib/knowledge/message-category";
import { speechActOf } from "@/lib/knowledge/message-semantics";

/**
 * THE CATEGORY REGRESSION SET.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `message-category.test.ts`. That file
 * grew alongside the classifier and tests it layer by layer — the phrase table,
 * the intent layer, the corpus. This one is organised by PROVENANCE instead:
 * every case here is a judgement that was made once, at some cost, and could be
 * silently undone by a later change. Roughly thirty of them existed only as
 * prose in the source comments of `message-category.ts`, with nothing executable
 * behind them; the audit of 2026-09-02 found that out by reading the comments
 * and discovering that some of what they promised was no longer true.
 *
 * FOUR SECTIONS, AND THE ORDER IS DELIBERATE:
 *
 *   1. Fixes converted from source comments. Behaviour that was already correct
 *      and now cannot regress without a test failing.
 *   2. The four conversations reported as WRONG, with the category they should
 *      have had. These failed before the conversation-level reading landed.
 *   3. Conversations that were already RIGHT and are near the changes. A fix
 *      that breaks one of these has traded one failure for another.
 *   4. Negative controls: vocabulary that must never assert a problem.
 *
 * NO CUSTOMER DATA. Every address, postcode and email here is fabricated, and
 * the shapes are preserved because the shape is what several of these tests are
 * about. Buyer names and order references are not reproduced at all;
 * conversations are identified by their internal id only, which is meaningless
 * outside the application database. `tests/guards/no-customer-data.test.ts`
 * enforces this over everything that is committed.
 */

/* ========================================================================= *
 * 1. HARD-WON FIXES, CONVERTED FROM SOURCE COMMENTS
 *
 * Each of these is documented in `message-category.ts` or
 * `message-semantics.ts` as a specific misreading that was found and corrected.
 * Until now the record was a comment; a comment does not fail a build.
 * ========================================================================= */

describe("damage on the packaging versus damage to the goods", () => {
  /** `NOT_PAST_A_CONTRAST` — the window may not cross "but". */
  it("keeps the shade's breakage off the box when a contrast word separates them", () => {
    expect(
      classifyMessageCategoryWithFallback("The box was fine but the glass shade inside is smashed"),
    ).toBe("Damage queries");
  });

  /** The clause window stops at a comma, not only at a full stop. */
  it("keeps the shade's breakage off the box across a clause boundary", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "we've just opened the box for the first time since receiving it, and unfortunately one shade is broken",
      ),
    ).toBe("Damage queries");
  });

  /** `scuffed` had to be a packaging word or this read as damage to the goods. */
  it("reads a scuffed box with intact contents as a delivery matter", () => {
    expect(
      classifyMessageCategoryWithFallback("the item is not damaged, the box was just scuffed"),
    ).toBe("Delivery queries");
  });

  /** A battered box around an absent component is a parts case. */
  it("reads a damaged box with something missing inside as parts missing", () => {
    expect(
      classifyMessageCategoryWithFallback("the box was open all damaged and the bulb are missing"),
    ).toBe("Parts missing queries");
  });

  /** The counter-example that keeps the packaging rule narrow: no packaging noun. */
  it("keeps damage to the goods when no packaging is named", () => {
    expect(
      classifyMessageCategoryWithFallback("a lot of scratches and the earth is missing"),
    ).toBe("Damage queries");
  });

  /**
   * ADDED 2026-09-02. `damageIsOnlyOnThePackaging` now gates the physical-damage
   * CLAIM as well as the CST evidence, because that claim decides the
   * conversation's issue.
   */
  it("reads a crushed box with intact contents as a delivery matter", () => {
    expect(
      classifyConversationCategory(["The box arrived crushed.", "Everything inside seems fine though."]),
    ).toBe("Delivery queries");
    expect(semanticsOf("The box arrived crushed.").claims.physical_damage).toBe("not_stated");
  });
});

describe("a problem has to be claimed, not merely mentioned", () => {
  /** A denial is not a report. */
  it("does not read a denial as damage", () => {
    expect(
      classifyMessageCategoryWithFallback("Nothing is broken, I just want to check the wiring"),
    ).not.toBe("Damage queries");
  });

  /**
   * The strict table must never claim a wrong item from a customer retracting
   * their own previous message. Pinned at the layer the guard actually protects.
   */
  it("does not read a retraction as a wrong item in the phrase table", () => {
    expect(classifyMessageCategory("Wrong one, sorry — ignore that")).not.toBe(
      "Wrong item sent messages",
    );
  });

  /** A clause disclaiming the subject is not evidence, whatever it contains. */
  it("does not read a correction as a missing part", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "However, it unfortunately has nothing to do with my actual question! I wanted to know whether this transformer has two isolated windings.",
      ),
    ).not.toBe("Parts missing queries");
  });

  /** A hedged report is still a report — INT-MP07. */
  it("reads a hedged absence as a report and not a question", () => {
    expect(classifyMessageCategoryWithFallback("I'm just wondering if something is missing?")).toBe(
      "Parts missing queries",
    );
  });

  /** A wh-word that is a relative pronoun does not make a diagnosis a question. */
  it("reads a diagnosis containing 'which' as an assertion", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "yours is constant voltage which is probably causing the led to pulse",
      ),
    ).toBe("Defective items");
  });
});

describe("the remedy does not take the case from the issue behind it", () => {
  it("keeps a wrong item when a return is only offered", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "you sent the wrong one, I can return it if you send the right one",
      ),
    ).toBe("Wrong item sent messages");
  });

  it("keeps a wrong item when the money is asked for as well", () => {
    expect(
      classifyMessageCategoryWithFallback("you sent the wrong one, I want my money back"),
    ).toBe("Wrong item sent messages");
  });

  it("keeps a wrong item when the return is the route to the right one", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "Can you send the correct one please and I will return the one I received",
      ),
    ).toBe("Wrong item sent messages");
  });

  /** `deferRefund` — a cancellation asked for with the money is an amendment. */
  it("keeps a pre-shipping cancellation asked for with the money", () => {
    expect(
      classifyConversationCategory([
        "I purchased these by mistake. Could I cancel the order and get a refund please.",
      ]),
    ).toBe("Order change, before shipping queries");
  });

  /** The other side of the same rule: the money itself is what has not arrived. */
  it("gives a refund chase to Return and refunds", () => {
    expect(
      classifyConversationCategory([
        "I posted the return last week.",
        "I still have not received my refund.",
      ]),
    ).toBe("Return and refunds");
  });

  /**
   * ADDED 2026-09-02. `HAS_NOT_ARRIVED` matches "have not received my refund"
   * word for word, and the thing that has not turned up is the money.
   */
  it("does not read a refund chase as a parcel that never came", () => {
    expect(semanticsOf("I still have not received my refund.").event).not.toBe("parcel_not_received");
  });
});

describe("pre-sales questions the catch-all used to take", () => {
  /** A question whose interrogative is not the first word. */
  it("names a mid-sentence interrogative as pre-sales", () => {
    expect(
      classifyMessageCategoryWithFallback("Hi there what colour is the shade underneath please"),
    ).toBe("Pre sales queries");
  });

  /** A polite request is a question — `PRE-SALES QUERIES.xlsx` › B. */
  it("names a polite request for a measurement as pre-sales", () => {
    expect(
      classifyMessageCategoryWithFallback("can I please have the measurements of the lampshades"),
    ).toBe("Pre sales queries");
  });

  /** Plurals are derived from the stem, so `shades` reaches the same rule as `shade`. */
  it("names a plural product noun as pre-sales", () => {
    expect(classifyMessageCategoryWithFallback("do you sell clear glass shades as well?")).toBe(
      "Pre sales queries",
    );
  });

  /** `finish` is deliberately absent from the attribute stems: it is a verb here. */
  it("does not read 'finish a job' as a product finish", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "what's happening with these as we're waiting on them to finish a job",
      ),
    ).not.toBe("Pre sales queries");
  });

  /** An electrician named inside a specification question is not a delivery deadline. */
  it("keeps a bathroom suitability question in pre-sales", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "Can you please let me know if this is suitable for bathroom as our electrician is refusing to fit this fitting.",
      ),
    ).toBe("Pre sales queries");
  });

  /** `ALREADY_IN_USE` — you cannot connect something you have not received. */
  it("reads a fault reported by somebody already using the product", () => {
    expect(
      classifyMessageCategoryWithFallback("Connected to 12v led light and it is pulsing - what say you?"),
    ).toBe("Defective items");
  });
});

describe("German and the admin fallback", () => {
  /** The thank-you formula that opens a message about something else. */
  it("names a German invoice request behind a thank-you as admin", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "Vielen Dank für die schnelle Lieferung, aber uns fehlt die Rechnung",
      ),
    ).toBe("Admin related issues");
  });

  /** `TIE_PRECEDENCE`: `fehlt` fires Parts missing and `Rechnung` fires Admin. */
  it("names a German invoice request as admin and not a missing part", () => {
    expect(classifyMessageCategoryWithFallback("Hallo leider fehlt uns die Rechnung hierzu")).toBe(
      "Admin related issues",
    );
  });

  /** An admin word inside a courier complaint must not reach the catch-all. */
  it("keeps a late-delivery complaint out of admin", () => {
    expect(classifyMessageCategoryWithFallback("I paid for next day and it's a week late")).toBe(
      "Delivery queries",
    );
  });

  /** `GOODS_CONFIRMED_ARRIVED` — a substitute bought elsewhere is not our parcel. */
  it("does not read a substitute bought elsewhere as our delivery arriving", () => {
    expect(
      classifyMessageCategoryWithFallback(
        "I paid an electrician on Saturday to fix one I've got from B&Q",
      ),
    ).toBe("Delivery queries");
  });
});

describe("a conversation keeps the category it earned", () => {
  it("keeps a parts case a closing confirmation cannot outvote", () => {
    expect(
      classifyConversationCategory(["Only two lampshades arrived, one is missing", "Found it, all sorted"]),
    ).toBe("Parts missing queries");
  });

  it("moves to the problem raised after the resolution", () => {
    expect(
      classifyConversationCategory([
        "a part is missing",
        "found it, all sorted",
        "now the bulb doesn't work",
      ]),
    ).toBe("Defective items");
  });

  it("lets an arrival supersede the chase that preceded it", () => {
    expect(
      classifyConversationCategory(["Where is my parcel?", "It arrived but the shade is smashed."]),
    ).toBe("Damage queries");
  });

  it("names nothing at all for a thread that is only a resolution", () => {
    expect(classifyConversationCategory(["Found it, everything is fine"])).toBeNull();
  });
});

/* ========================================================================= *
 * 2. THE REPORTED MISCLASSIFICATIONS
 *
 * Four live eBay conversations the audit of 2026-09-02 found wrong, in the
 * customer's own words with every identifier fabricated. Each failed before the
 * conversation-level reading; the comment on each records what it turned on.
 * ========================================================================= */

describe("reported: conversations the audit found miscategorised", () => {
  /**
   * 32274 — was Damage queries.
   *
   * Two failures compounding. We asked the customer to confirm their address;
   * `dent\w*` matched the town in their reply and asserted damage. Meanwhile
   * the opening message — the plainest possible delivered-not-received report —
   * reached no delivery signal at all, so the fabricated damage was the only
   * case category in the thread.
   */
  it("32274 — a parcel marked delivered, and an address we asked for", () => {
    expect(
      classifyConversationCategory([
        "Hello, my item is saying delivered, but picture is not at my house, could you please check the address you sent it too \nThanks Wayne",
        "Yes it is 8 Sample Close, haughton green , Denton, M00 0AA\nRegards Wayne",
        "Hi, did you manage to track down where the bulb was delivered \nRegards Wayne",
      ]),
    ).toBe("Delivery queries");
  });

  /**
   * 36983 — was Defective items.
   *
   * "it won't work for the item I wanted it for" is a statement about
   * SUITABILITY, and `INT-DF05` — a rule whose own condition reads "TRANSFORMER
   * / DRIVER Not working" — matched it as a functional fault. `semanticsOf` had
   * recorded `functional_fault: "not_stated"` all along.
   */
  it("36983 — goods that are simply unsuitable, returned for a refund", () => {
    const text =
      "Hi. I have received my order but only just opened it because I have been away. I had no idea that it would be so thick and because it is, it won't work for the item I wanted it for. Can I please return it and receive a refund? I look forward to hearing from you.  Many thanks. ";
    expect(classifyConversationCategory([text])).toBe("Return and refunds");
    expect(semanticsOf(text).claims.functional_fault).toBe("not_stated");
  });

  /**
   * 36788 — was Delivery queries.
   *
   * The customer asked for an invoice and then sent the billing address we
   * asked for. Their company name contains the word "depot", which reached a
   * collection-point rule, and the address message outvoted the request.
   */
  it("36788 — an invoice request, and a company name containing 'depot'", () => {
    expect(
      classifyConversationCategory([
        "Can we please have an invoice buyer@example.com ",
        "Motor parts depot, Unit A1 Sample Business Park, Sample Road, Upton, Wirral, United Kingdom, CH00 0AA",
      ]),
    ).toBe("Admin related issues");
  });

  /**
   * 36855 — was Return and refunds.
   *
   * The buyer's phone typed "refund" for "red". They are asking whether a 36cm
   * shade comes with a reducer plate, and the second message — in which they
   * say in as many words that they did not write "refund" — raised the refund
   * intent a second time.
   */
  it("36855 — a predictive-text typo inside a product question", () => {
    expect(
      classifyConversationCategory([
        "Hello does the big rustic refund (36cm diameter) come with a reduced plate?\nRegards Steve ",
        "Refund = red colour, apologies predictive text strikes again ",
      ]),
    ).toBe("Pre sales queries");
  });
});

/* ------------------------------------------------------------------------- *
 * THE TWO CONVERSATIONS REPORTED ON 2026-09-03
 * ------------------------------------------------------------------------- */

describe("reported: a delivery problem that gets located is still a delivery query", () => {
  /**
   * THE LIVE THREAD, AND WHY ONLY ONE MESSAGE OF IT COUNTS.
   *
   * The customer raised the delivery problem as an eBay case rather than as a
   * message, so the stored thread is our reply followed by their answer to it.
   * `readConversation` discards outbound turns before anything is decided —
   * deliberately, so a customer's case is never graded on words we wrote — which
   * left the whole conversation resting on the one inbound sentence. It named
   * nothing and the thread went to the admin catch-all.
   *
   * It does name something: where the parcel went. A consignment left somewhere
   * other than the delivery address is Delivery's subject, and the customer
   * having since walked to the petrol station and collected it is the ANSWER to
   * the query, not a different query.
   */
  const FOUND_AT_THE_PETROL_STATION =
    "Thanks for the reply they missed placed it at the petrol station good product thank you!";

  it("reads the live thread as a delivery query, from the customer's turn alone", () => {
    expect(
      readConversation([
        {
          direction: "outbound",
          text: "Hello,\n\nThank you for your message.\n\nAccording to the courier tracking, the parcel is showing as delivered.\n\nPlease check the attached delivery images for proof and have another look around the indicated delivery location, any safe places, or with nearby staff/neighbours if applicable.\n\nKind regards,\nJames",
        },
        { direction: "inbound", text: FOUND_AT_THE_PETROL_STATION },
      ]).category,
    ).toBe("Delivery queries");
  });

  it("reads the customer's confirmation on its own as a delivery query", () => {
    expect(classifyMessageCategoryWithFallback(FOUND_AT_THE_PETROL_STATION)).toBe(
      "Delivery queries",
    );
    expect(detectIntents(FOUND_AT_THE_PETROL_STATION)).toContain("delivery_request");
  });

  /**
   * THE RULE, STATED OVER A WHOLE THREAD. A parcel delivered to the wrong place
   * and later found is a delivery query from the first message to the last: the
   * customer confirming they have it does not move the conversation to another
   * category, and it does not empty it either.
   */
  it("keeps the category when the customer later confirms they found it", () => {
    expect(
      classifyConversationCategory([
        "Hello, my item is saying delivered but it is not at my house, it must have been left somewhere else.",
        FOUND_AT_THE_PETROL_STATION,
      ]),
    ).toBe("Delivery queries");

    expect(
      classifyConversationCategory([
        "My parcel has not arrived, the tracking says it was delivered on Tuesday.",
        "All sorted, I found it round at the neighbour's. Thanks!",
      ]),
    ).toBe("Delivery queries");
  });

  /** The same thing said by a customer who is still looking for it. */
  it.each([
    "The driver left it at the petrol station",
    "The courier left it with a neighbour and never told us",
    "It looks like they misplaced it at the sorting office",
    "The parcel was misdelivered",
  ])("reads %s as a delivery query", (text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Delivery queries");
  });

  /**
   * NEGATIVE CONTROLS. "Misplaced" and "left it somewhere" are ordinary English
   * about the customer's own belongings, and neither is a delivery matter until
   * a delivery location is named.
   */
  it.each([
    ["the customer losing their own paperwork", "I have misplaced the instructions that came with it"],
    ["the customer putting it away", "I left it in the loft for now"],
  ])("does not read %s as a delivery problem", (_name, text) => {
    expect(detectIntents(text)).not.toContain("delivery_request");
    expect(classifyMessageCategoryWithFallback(text)).not.toBe("Delivery queries");
  });
});

describe("reported: only one of the units ordered was delivered", () => {
  /**
   * THE REPORTED CONVERSATION. One message, and every counting rule declined it:
   * one count, so there is no arithmetic; the count is the subject rather than
   * the object of the verb, so the "only received one X" shape misses; and the
   * customer never writes missing, short or absent. It fell to the admin
   * catch-all, so an agent saw no case at all on a shipment that is short.
   */
  const ONLY_ONE_PENDANT = "Hi\nOnly 1 pendant was delivered.";

  it("names a quantity error, not an admin matter", () => {
    expect(classifyConversationCategory([ONLY_ONE_PENDANT])).toBe("Wrong quantity sent issues");
    expect(semanticsOf(ONLY_ONE_PENDANT).event).toBe("quantity_mismatch");
    expect(quantityShortfallEvidence(ONLY_ONE_PENDANT)).toBe(
      "ORDERED_QUANTITY_GREATER_THAN_RECEIVED",
    );
  });

  /**
   * IT IS NOT ANY OF THE THREE CATEGORIES IT COULD PLAUSIBLY DRIFT TO. The
   * delivery happened, so it is not a Delivery query; the customer asks for
   * nothing back, so it is not a Return; and nothing is broken.
   */
  it.each(["Delivery queries", "Return and refunds", "Damage queries"])(
    "is not %s",
    (category) => {
      expect(classifyConversationCategory([ONLY_ONE_PENDANT])).not.toBe(category);
    },
  );

  /** The shapes a shortfall against the order is stated in, confirmed together. */
  it.each([
    ["only X delivered", "Only 1 pendant was delivered"],
    ["only X delivered, plural", "Only 2 of the lights have been delivered"],
    ["counted against the order", "I ordered 6 bulbs but only received 3."],
    ["the count named both ways", "I ordered two transformers and only one arrived."],
    ["received fewer than ordered", "I have received fewer than I ordered"],
    ["part of the order", "Only half of my order arrived"],
    ["German", "Ich habe 6 Lampen bestellt. Es ist nur eine Lampe angekommen."],
  ])("reads %s as a quantity error", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Wrong quantity sent issues");
  });

  /**
   * THE PARTS CASES ARE UNTOUCHED, and this is the line the fix had to not cross.
   * A count measured against what the BOX should hold is a component absent from
   * goods that did arrive, and stays one — whether the expectation is stated in
   * English, in German, or not counted at all.
   */
  it.each([
    ["a shade short of the set", "Only two lampshades arrived but should be three"],
    ["the same in German", "Leider sind nur 2 Lampenschirme dabei. Es sollten aber 3 dabei sein."],
    ["a component named, not counted", "I received my lampshades but there was only one white plastic reducer."],
  ])("still reads %s as a parts case", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Parts missing queries");
  });

  /** Neither a delivery still to come nor a delivery date is a shortfall. */
  it.each([
    ["a future delivery", "Only 1 will be delivered next week"],
    ["a delivery date", "Only 2 days ago the parcel was delivered"],
  ])("does not read %s as a short one", (_name, text) => {
    expect(quantityShortfallEvidence(text)).toBeNull();
  });
});

describe("reported: an after-sales request is never a pre-sales enquiry", () => {
  /**
   * hairt_89 (conversation 37026) — was Pre sales queries.
   *
   * NOT A REGRESSION FROM THE CONVERSATION-LEVEL WORK: it read Pre sales before
   * that change and after it. The cause is older and sits in `clausesOf`.
   *
   * The message is one clause — no full stop, no comma, no contrast word — so
   * `INTERROGATIVE_FRAME` matched "Could you" at the front of it and the
   * breakage stated at the end came back as `asked` rather than `asserted`. A
   * problem the customer REPORTED read as one they were ENQUIRING about, and an
   * existing customer asking for a replacement part was filed as a buyer who
   * had not purchased anything. A reason is now its own clause.
   */
  const HAIRT_89 =
    "Could you send me another screw on piece that holds shade to pendant as one on pendant was broken";

  it("does not read a replacement request with its reason as pre-sales", () => {
    expect(classifyConversationCategory([HAIRT_89])).not.toBe("Pre sales queries");
  });

  it("asserts the breakage rather than asking about it", () => {
    expect(semanticsOf(HAIRT_89).claims.physical_damage).toBe("asserted");
  });

  /**
   * The same shape with the other causal subordinator, which needs no
   * disambiguation and splits on the word alone.
   */
  it("does not read 'because' + a report as pre-sales", () => {
    expect(
      classifyConversationCategory(["Can you send another part because the item arrived broken"]),
    ).not.toBe("Pre sales queries");
    expect(
      semanticsOf("Can you send another part because the item arrived broken").claims.physical_damage,
    ).toBe("asserted");
  });

  /**
   * THE OTHER SIDE OF THE BOUNDARY. A buyer who reports nothing wrong is still
   * making an enquiry, and splitting on a reason must not change that.
   */
  it("leaves a purchase enquiry for a spare part alone", () => {
    expect(
      classifyConversationCategory(["Do you sell replacement parts?"]),
    ).toBe("Pre sales queries");
  });

  /**
   * `as` IS A PREPOSITION FAR MORE OFTEN THAN A SUBORDINATOR, and splitting a
   * bare one would cut the description claim in half. These are the phrases that
   * must survive the new boundary intact.
   */
  it.each([
    ["a description claim", "The item is not as described in the listing", "Wrong description issues"],
    ["a listing measurement", "Cables are advertised at 6mm but mine is 8.85mm has there been a mistake", "Wrong description issues"],
    ["a photograph reference", "one of the shades arrived smashed as per the photograph. Can you advise", "Damage queries"],
    ["a temporal 'since'", "we've just opened the box for the first time since receiving it, and unfortunately one shade is broken", "Damage queries"],
  ])("keeps %s intact", (_name, text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });

  /**
   * "SOLD AS NEW" IS A CONDITION, NOT A DESCRIPTION CLAIM.
   *
   * Exposed by the clause fix rather than caused by it: the reason clause used
   * to be joined to "I feel this is the minimum acceptable resolution", whose
   * "is the" accidentally matched the interrogative frame and suppressed the
   * claim. Splitting correctly removed the accident, and a ten-message damage
   * complaint moved to Wrong description on the sale terms.
   */
  it("does not read the sale condition as a description mismatch", () => {
    expect(
      semanticsOf(
        "the items were sold as new and under the ebay guarantee they should have arrived free from damage and defects",
      ).claims.listing_mismatch,
    ).toBe("not_stated");
  });

  it("still reads a genuine 'advertised as' mismatch", () => {
    expect(
      semanticsOf("Hi its advertised as 1000mA but in description says 300mA?").claims.listing_mismatch,
    ).not.toBe("not_stated");
  });
});

describe("reported: the customer's own selection is not our error", () => {
  /**
   * moopo_95 (conversations 75 and 76) — was Wrong item sent messages.
   *
   * "I've ordered wrong width size. Can I return" is a customer returning a
   * size THEY chose. Two things hid that. `CUSTOMER_OWNS_THE_MISTAKE` was
   * written as `ordered THE wrong`, and customers drop the article when an
   * adjective follows — "ordered wrong width size" — while `I've` leaves no
   * space for the `\s+` the pattern expected after the pronoun. So the
   * wrong-item claim stood, and the thread read as us having shipped the wrong
   * thing.
   *
   * With the claim correctly suppressed the message then landed on Pre sales,
   * because "width" and "size" are product attributes and nothing recognised
   * "Can I return" as a return: `RETURN_UNDER_WAY` knew "want to return" and
   * "return it" but not the bare request, which the strict phrase table has
   * always treated as Return and refunds.
   */
  it("reads a customer's own wrong size as a return", () => {
    expect(
      classifyConversationCategory(["I ordered wrong width size, can I return"]),
    ).toBe("Return and refunds");
  });

  it("reads the reported thread as a return", () => {
    expect(
      classifyConversationCategory([
        "Hi\nUnfortunately as with other order\nI've ordered wrong width size\nCan I return\nThanks",
        "Hi\nWe returned the above to you and it was delivered back on 30th July\nAwaiting refund\nThankyou",
      ]),
    ).toBe("Return and refunds");
  });

  /**
   * THE OTHER SIDE, AND THE WHOLE POINT OF THE BOUNDARY. Wrong item sent needs
   * evidence that WE supplied something different: our verb, or a receipt set
   * against what was ordered. Neither of these names the customer as the
   * chooser, so neither may be softened.
   */
  it("still reads our verb as a wrong item", () => {
    expect(classifyConversationCategory(["You sent wrong width size"])).toBe(
      "Wrong item sent messages",
    );
    expect(classifyConversationCategory(["You sent the wrong size"])).toBe(
      "Wrong item sent messages",
    );
  });

  it("still reads a receipt of the wrong thing as a wrong item", () => {
    expect(classifyConversationCategory(["I received wrong colour"])).toBe(
      "Wrong item sent messages",
    );
    expect(classifyConversationCategory(["Received black instead of white"])).toBe(
      "Wrong item sent messages",
    );
    expect(classifyConversationCategory(["Ordered 40cm but received 30cm"])).toBe(
      "Wrong item sent messages",
    );
  });

  /**
   * `bekommen` is the German for the first of the three supply verbs and was
   * the one missing. The mismatch itself is named in the second message —
   * "Fotos vom falschen Netzteil" — while the RECEIPT that makes it ours rather
   * than the customer's mis-order is in the first. Without `bekommen` the
   * thread reached no supply at all, the wrong-item claim was discarded as a
   * mis-order, and a seller error was filed as a plain refund.
   *
   * Both messages are needed, which is the point: the evidence for a wrong item
   * is routinely spread across a thread rather than stated in one breath.
   */
  it("reads the German ordered-versus-received contrast as a wrong item", () => {
    expect(
      classifyConversationCategory([
        "Guten Tag ich habe bei ihnen ein Netzteil 24v 20a bestellt aber ein Netzteil mit 12v und 40a bekommen",
        "Hallo im Anhang sende ich ihnen die Fotos vom falschen Netzteil Mit freundlichen Grüßen",
      ]),
    ).toBe("Wrong item sent messages");
  });

  /** The supply verb on its own, at the layer that reads it. */
  it("counts 'bekommen' as a receipt", () => {
    expect(
      semanticsOf("ich habe ein Netzteil 24v bestellt aber ein Netzteil mit 12v bekommen").journey,
    ).not.toBe("prospective");
  });

  /** The claim itself, at the layer that decides it. */
  it.each([
    ["the customer chose it", "I ordered wrong width size, can I return", "not_stated"],
    ["the customer chose it, with the article", "I ordered the wrong size", "not_stated"],
    ["we sent it", "You sent wrong width size", "asserted"],
    ["they received it", "I received wrong colour", "asserted"],
  ])("%s", (_name, text, expected) => {
    expect(semanticsOf(text).claims.wrong_item).toBe(expected);
  });

  /**
   * WHAT MUST NOT MOVE WITH IT. A cancellation before dispatch is still an
   * order change — the goods have not gone anywhere, so nothing is coming
   * back — and a customer who simply does not like what arrived is still a
   * return rather than a seller error.
   */
  it("keeps a pre-shipping cancellation asked for with the money", () => {
    expect(
      classifyConversationCategory([
        "I purchased these by mistake. Could I cancel the order and get a refund please.",
      ]),
    ).toBe("Order change, before shipping queries");
  });

  it("keeps a change of mind as a return", () => {
    expect(
      classifyConversationCategory([
        "Please can I return these? There's nothing wrong with them I just didn't understand the size codes and these are way too big.",
      ]),
    ).toBe("Return and refunds");
  });

  /**
   * A RETURN IS NOT A DELIVERY CHASE, and this is where that rule finally
   * bites. Once "Can I return" is recognised, a thread arranging a return stops
   * deferring to the pre-dispatch amendment rule that a mis-order otherwise
   * triggers.
   */
  it("keeps a return label request as a return", () => {
    expect(
      classifyConversationCategory([
        "Sorry, the instructions were not provided so we bought another locally. Please send us the returns label please",
      ]),
    ).toBe("Return and refunds");
  });
});

/* ========================================================================= *
 * 3. THE TWO AXES
 *
 * The conversation reading separates what went wrong from what the customer
 * wants done, and the issue always outranks the remedy.
 * ========================================================================= */

describe("issue and requested action are read separately", () => {
  const turns = (...texts: string[]) =>
    texts.map((text) => ({ direction: "inbound" as const, text }));

  it("names the issue and the action independently", () => {
    const reading = readConversation(turns("One of the shades arrived smashed, please refund me"));
    expect(reading.issue).toBe("physical_damage");
    expect(reading.requestedAction).toBe("refund_or_return");
    expect(reading.category).toBe("Damage queries");
  });

  it("gives the category to the remedy only when no issue was reported", () => {
    const reading = readConversation(
      turns("I have received it and it is simply too big for the space. Can I have a refund?"),
    );
    expect(reading.issue).toBe("none");
    expect(reading.requestedAction).toBe("refund_or_return");
    expect(reading.category).toBe("Return and refunds");
  });

  /* ----------------------------------------------------------------------- *
   * THE ISSUE OUTRANKS THE REMEDY EVEN WHERE ONLY THE OTHER WITNESSES SAW IT
   *
   * The issue axis reads ONE witness — `semanticsOf(...).event`. Three others
   * can name a problem and reach the thread only through the positional
   * reading, which used to sit BELOW `ACTION_CATEGORY`: the moment a customer
   * said what they wanted done, the layers that had seen the problem were never
   * asked. Measured over 1,335 live eBay threads, 51 of the 362 messages
   * carrying a problem intent had `event: "none"`.
   * ----------------------------------------------------------------------- */

  it("keeps damage when the refund is asked for in a later message", () => {
    expect(classifyConversationCategory(["The item arrived with two dents.", "I want a refund."])).toBe(
      "Damage queries",
    );
    expect(classifyConversationCategory(["The item arrived with two dents. I want a refund."])).toBe(
      "Damage queries",
    );
  });

  it("keeps a late parcel when the refund is asked for alongside it", () => {
    expect(classifyConversationCategory(["My parcel is late. Please refund me."])).toBe(
      "Delivery queries",
    );
    expect(classifyConversationCategory(["My parcel is late.", "Please refund me."])).toBe(
      "Delivery queries",
    );
  });

  it("keeps a wrong item when the customer asks to return it", () => {
    expect(
      classifyConversationCategory(["You sent the wrong colour. I want to return it."]),
    ).toBe("Wrong item sent messages");
    expect(
      classifyConversationCategory(["You sent the wrong colour.", "I want to return it."]),
    ).toBe("Wrong item sent messages");
  });

  /**
   * THE CASE THE ISSUE AXIS CANNOT SEE AT ALL. German fault vocabulary reaches
   * the intent layer and not `semanticsOf`'s claim concepts, so before this the
   * refund in the second message took the thread.
   */
  it("keeps a fault only the intent layer saw, over a refund asked for later", () => {
    expect(
      classifyConversationCategory([
        "Nach kurzer Betriebsdauer ist der Led Treiber defekt.",
        "Ich bitte um Rückerstattung.",
      ]),
    ).toBe("Defective items");
  });

  /**
   * THE BOUND THAT MAKES THE PROMOTION SAFE. A problem named and a remedy asked
   * for in the SAME message is already arbitrated by `refine`,
   * `ownedIntentCategory` and the strict table's own Return gate, and those
   * judgements are measured. Promoting the positional reading there would
   * promote its false positives with it — both of these are goods that are
   * perfectly fine and unsuitable for the buyer, and both name a "problem" that
   * `semanticsOf` had already refused.
   */
  it("does not promote a same-message problem the claim reading refused", () => {
    // `INT-DF05` reads "won't work" as a fault; `functional_fault` is not_stated.
    expect(
      classifyConversationCategory([
        "Hi. I have received my order but only just opened it because I have been away. I had no idea that it would be so thick and because it is, it won't work for the item I wanted it for. Can I please return it and receive a refund?",
      ]),
    ).toBe("Return and refunds");
    // The measurement-mismatch rows read "too big" as a wrong item.
    expect(
      classifyConversationCategory([
        "I have received it and it is simply too big for the space. Can I have a refund?",
      ]),
    ).toBe("Return and refunds");
  });

  /** A remedy with no problem behind it anywhere is still the remedy's case. */
  it.each([
    ["a plain refund request", "Please refund me"],
    ["a plain return request", "I want to return this item"],
    ["a return with nothing wrong", "I'd like to return my purchase, nothing wrong with the item at all"],
    ["the customer's own mis-order", "I ordered the wrong size by mistake, can I return it"],
  ])("gives %s to Return and refunds", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Return and refunds");
  });

  /**
   * A REFUND CHASED IS RETURN'S OWN CASE, however it is phrased. "When will my
   * refund arrive?" is word for word the shape of a parcel chase, and the thing
   * being chased is the money — Delivery is the one category that cannot answer
   * it. The past tense of sending goods back was missing outright.
   */
  it.each([
    ["a refund chased as a question", "When will my refund arrive?"],
    ["a refund chased by location", "Where is my refund?"],
    ["a refund chased by duration", "How long does a refund take?"],
    ["a return already posted", "I sent it back already"],
    ["a return posted last week", "I posted it back last week"],
    ["a return announced", "Hello. No thank you. All goods will be sent back. Thanks"],
  ])("gives %s to Return and refunds", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Return and refunds");
  });

  /** And a parcel chase is still a parcel chase — the money test is predicated. */
  it.each([
    ["a parcel chased as a question", "When will my parcel arrive?"],
    ["a dispatch chase", "When will you dispatch my order?"],
    ["a plain non-arrival", "My parcel has not arrived"],
    ["a late parcel", "My parcel is late"],
  ])("gives %s to Delivery queries", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Delivery queries");
  });

  /** Lateness is bounded to the consignment: neither a reply nor the money. */
  it("does not read a late reply or a late refund as a delivery problem", () => {
    expect(detectIntents("Sorry for the late reply. Is this suitable for a bathroom?")).not.toContain(
      "delivery_request",
    );
    expect(
      classifyConversationCategory(["I posted the return last week and my refund is late"]),
    ).toBe("Return and refunds");
  });

  /* ----------------------------------------------------------------------- *
   * TWO CONVERSATIONS REPORTED FROM THE LIVE INBOX, 2026-09-03
   * ----------------------------------------------------------------------- */

  /**
   * A DING IS A DENT. The whole thread turned on one word nobody had written
   * down: `dents` was in the damage vocabulary and `dings` was not, so the
   * opening report named nothing and the thread was decided by the customer's
   * closing message — where they say they will get a local replacement — and
   * came out as Return and refunds.
   */
  it("reads two dings as damage, and keeps the thread on it", () => {
    expect(
      readConversation([
        {
          direction: "inbound",
          text: "Hi, one of the items came with two dings (see photo). How do you want to proceed this?",
        },
        {
          direction: "outbound",
          text: "Hello,\n\nWe're sorry to hear that one of the items arrived with two dents. If you are happy to keep the item, we can offer you a 12% partial refund as a goodwill gesture.\n\nKind regards,\nJames",
        },
        {
          direction: "inbound",
          text: "Hi James, don't worry about it. I shall get a local replacement, ok. Cheers.",
        },
      ]).category,
    ).toBe("Damage queries");
    expect(semanticsOf("one of the items came with two dings").claims.physical_damage).toBe(
      "asserted",
    );
  });

  /** A chime is not a dent. */
  it("does not read a ding dong as damage", () => {
    expect(semanticsOf("Does this come with a ding dong chime?").claims.physical_damage).toBe(
      "not_stated",
    );
  });

  /**
   * THE MISMATCH STATED AS A SUBSTITUTION, with neither "wrong" nor
   * "different" in it. The second message on its own was an admin catch-all.
   */
  it("reads a finish supplied in place of the one ordered as a wrong item", () => {
    expect(
      classifyConversationCategory([
        "I ordered 2 of these fittings whilst i decorate a bedrooms. I used the first one but have just got around to opening the other one for the next bedroom and the bulb holder is black instead of being chrome",
        "should have had satin nikel lamp holder but was sent black on one of them",
      ]),
    ).toBe("Wrong item sent messages");

    for (const text of [
      "the bulb holder is black instead of being chrome",
      "should have had satin nikel lamp holder but was sent black on one of them",
    ]) {
      expect(classifyMessageCategoryWithFallback(text), text).toBe("Wrong item sent messages");
    }
  });

  /**
   * "SHOULD HAVE" IS HOW EVERY CATEGORY STATES WHAT WAS DUE. These three are the
   * pinned conversations the first version of the substitution rule broke, and
   * they are what the contrast bound exists for.
   */
  it.each([
    ["a count short of the order", "I should have received 4 but only got 2.", "Wrong quantity sent issues"],
    [
      "a component that should have been in the box",
      "the screws that should have been included are not there",
      "Parts missing queries",
    ],
    ["a parcel overdue", "This is overdue, it should have arrived last week", "Delivery queries"],
    [
      "a non-arrival stated as a contrast",
      "It should have been delivered on Tuesday but nothing was sent",
      "Delivery queries",
    ],
  ])("keeps %s out of the wrong-item claim", (_name, text, expected) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe(expected);
  });

  /** "Instead of" between two remedies names no mismatch. */
  it("does not read a choice between remedies as a wrong item", () => {
    expect(
      semanticsOf("Could I have a refund instead of a replacement please").claims.wrong_item,
    ).toBe("not_stated");
  });

  /* ----------------------------------------------------------------------- *
   * AN AUXILIARY IS ONLY A QUESTION WHERE IT OPENS ONE
   *
   * `INTERROGATIVE_FRAME` matched an auxiliary followed by a pronoun or a
   * determiner ANYWHERE in the clause, so `is the` / `are the` / `was the` in a
   * plain statement made the whole clause a question. Every wrong-item report
   * written that way came back `asked` rather than `asserted`, `semanticsOf`
   * recorded no event, and the issue axis was blind to the family.
   * ----------------------------------------------------------------------- */

  it.each([
    "They are the wrong colour",
    "This is the wrong size",
    "The item is the wrong colour",
    "The ceiling roses are the wrong ones",
    "It was the wrong type sent again",
    "The shades are the wrong size",
  ])("reads %j as a report of a wrong item", (text) => {
    expect(speechActOf(text)).toBe("assertion");
    expect(semanticsOf(text).claims.wrong_item).toBe("asserted");
    expect(semanticsOf(text).event).toBe("wrong_item_supplied");
    expect(classifyConversationCategory([text])).toBe("Wrong item sent messages");
  });

  /**
   * THE INVERSION STILL READS. What makes an auxiliary interrogative is that it
   * moves in FRONT of its subject, which is exactly what the anchor now
   * requires — including where the customer omits the question mark, and where
   * the question opens a later clause rather than the message.
   */
  it.each([
    ["a wh-question", "What colour did I order?"],
    ["an inverted auxiliary", "Is this the correct size?"],
    ["a modal request", "Can I change the colour?"],
    ["no question mark", "Is this suitable for a bathroom"],
    ["an auxiliary with no mark", "Does this come with a bulb"],
    ["a question in a later clause", "Thanks for that, is this suitable for outdoors"],
  ])("still reads %s as a question", (_name, text) => {
    expect(speechActOf(text)).toBe("question");
  });

  /** And the claim a question raises is still `asked`, never a report. */
  it("does not read a question about the size as a wrong item", () => {
    expect(semanticsOf("Is this the correct size?").claims.wrong_item).not.toBe("asserted");
    expect(classifyConversationCategory(["Is this the correct size?"])).not.toBe(
      "Wrong item sent messages",
    );
  });

  /* ----------------------------------------------------------------------- *
   * A BUYER WHO HAS NOT BOUGHT YET
   *
   * `looksPreSales` required the message to name a physical ATTRIBUTE — colour,
   * material, wattage, size — so the two things every buyer actually says first
   * reached nothing: that they are trying to buy, and what it costs.
   * ----------------------------------------------------------------------- */

  it("reads a buyer asking about a listing's pictures and price as pre-sales", () => {
    expect(
      classifyConversationCategory([
        "Hi I am trying to buy the hook. There is a problem with pictures showing property. Can you fix it?",
        "This one I need.",
        "What is the price?",
      ]),
    ).toBe("Pre sales queries");
  });

  /**
   * "PROBLEM", "PICTURE" AND "PROPERTY" MAY NOT OVERRIDE PURCHASE INTENT. A
   * buyer reporting that a listing's images are broken is shopping, not raising
   * a case about goods they do not have.
   */
  it.each([
    ["a stated intention to buy", "Hi I am trying to buy the hook. Can you fix the pictures?"],
    ["a price question", "What is the price?"],
    ["the price asked informally", "How much is this one?"],
    ["a purchase being considered", "I am looking to buy this, does it come in black?"],
  ])("reads %s as pre-sales", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).toBe("Pre sales queries");
  });

  /**
   * BUT ASKING SOMETHING IS STILL REQUIRED, and a future purchase mentioned
   * inside an after-sales message claims nothing. This is the pinned
   * return-postage negotiation, which names a size, a weight and an intention
   * to purchase, and asks for none of them.
   */
  it.each([
    [
      "a return-postage negotiation",
      "Due to the physical size (160mm x 140mm x 5mm) and weight (53g) of my returning parcel I believe the cost should be no more than a standard 1st class letter. I was intending to purchase the correct item 2 core x 5 mtrs.",
    ],
    ["goods already bought", "I bought this last week and the price has now dropped"],
  ])("does not read %s as pre-sales", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).not.toBe("Pre sales queries");
  });

  /* ----------------------------------------------------------------------- *
   * ADMIN IS A CASE, NOT A CATCH-ALL
   *
   * Admin was the last step of both readings — "if nothing matched, say Admin"
   * — and that made it the largest category in the system: 379 of 1,335 live
   * eBay threads, 28%, almost none of it an admin matter. It was the classifier
   * saying "I don't know" in a word that means something else, and it buried
   * the real invoice and account queries an agent filters for.
   * ----------------------------------------------------------------------- */

  it.each([
    ["a price enquiry", "How much is this?", "Pre sales queries"],
    [
      "a buyer reporting a broken listing image",
      "I am trying to buy this item, but the image is not showing properly",
      "Pre sales queries",
    ],
    ["a quantity shortfall", "Only 1 pendant was delivered", "Wrong quantity sent issues"],
    ["a delivery enquiry", "Parcel has not arrived", "Delivery queries"],
    ["a whereabouts question", "Where is my parcel?", "Delivery queries"],
    ["damage reported", "One of the shades arrived smashed", "Damage queries"],
  ])("does not send %s to Admin", (_name, text, expected) => {
    expect(classifyConversationCategory([text])).toBe(expected);
  });

  /** What Admin genuinely owns, and still does. */
  it.each([
    ["a VAT invoice request", "Can I have a VAT invoice for this order please"],
    ["a receipt request", "Please send me a receipt for my purchase"],
    ["a German invoice request", "Können Sie mir bitte eine Rechnung zusenden?"],
    ["account access", "I cannot log in to my account to see the order"],
    ["a payment problem", "The payment has been taken twice"],
    ["an order reference query", "Can you confirm the order number for this purchase"],
  ])("still names %s as an admin matter", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Admin related issues");
  });

  /**
   * AND NOTHING IS LEFT UNCATEGORISED. Gating the fallback itself on admin
   * evidence was tried on 2026-09-03 and reverted the same day: it left real
   * customer messages with no category, and a blank hides a conversation from
   * every filter in the inbox. Admin stays the residue; what changed is how
   * little reaches it, because the categories above it now claim what is theirs.
   */
  it.each([
    ["a bare greeting", "Many thanks, kind regards."],
    ["an unexplained question", "Hello, I have a question about my order."],
    ["a chatty remark", "I bought 3 shades this week and didn't know this was available as an option."],
  ])("still gives %s a category rather than a blank", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Admin related issues");
  });

  /* ----------------------------------------------------------------------- *
   * A CUSTOMER INTENT ALWAYS BEATS THE ADMIN RESIDUE
   *
   * Three live shapes that fell to Admin because no witness recognised them —
   * not because Admin outranked anything. Admin is already last; what these
   * needed was for their own category to claim them first.
   * ----------------------------------------------------------------------- */

  /**
   * A CHANGE OF MIND, IN ENGLISH. `ORDERED_THE_WRONG_THING` is German-only, so
   * the English form of "I have thought about it again and want something else"
   * reached nothing. Which category it is depends on the order's state: an
   * amendment while we still hold it, a return once we do not.
   */
  it("reads a change of mind as an amendment before shipping", () => {
    expect(classifyConversationCategory(["Just realised I need different cable"])).toBe(
      "Order change, before shipping queries",
    );
  });

  it("reads the same change of mind after delivery as a return", () => {
    expect(
      classifyConversationCategory([
        "Just realised I need different cable, the order arrived yesterday",
      ]),
    ).toBe("Return and refunds");
  });

  it("reads an accidental order the customer has cancelled as an amendment", () => {
    expect(
      classifyConversationCategory([
        "I have just placed an order accidentally and requested to cancel",
      ]),
    ).toBe("Order change, before shipping queries");
  });

  /**
   * A CANCELLATION IS AN AMENDMENT, AND A DOCUMENT IS ADMIN. The pair, pinned
   * together: the line between them is what the customer wants done, and a
   * polite "please could you confirm asap" attached to a cancellation does not
   * make it an administrative query.
   */
  it.each([
    [
      "a cancellation with a confirmation chased",
      "I have just placed an order accidentally and requested to cancel. Please could you confirm asap?",
      "Order change, before shipping queries",
    ],
    ["a bare cancellation request", "Can you cancel my order please?", "Order change, before shipping queries"],
    ["a VAT invoice request", "Can you send me a VAT invoice?", "Admin related issues"],
  ])("reads %s correctly", (_name, text, expected) => {
    expect(classifyConversationCategory([text])).toBe(expected);
  });

  /**
   * HAVING BOUGHT ONCE DOES NOT END THE CONVERSATION. `ALREADY_PURCHASED` vetoes
   * a pre-sales reading as soon as a customer says they bought something — a
   * guard against after-sales problems that could not tell a problem from a
   * compliment, so a happy customer about to spend more was an admin matter.
   */
  it.each([
    ["asking for a longer one", "I just purchased one was great, do you have another one longer?"],
    ["asking to buy more", "Lamps are great thanks, I would like to buy four more if possible, thanks"],
  ])("reads %s as pre-sales", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Pre sales queries");
  });

  /**
   * AND THE VETO STILL DOES ITS REAL WORK. Each of these asks for another one
   * too, and each names a problem first — which is the case, and not an enquiry.
   */
  it.each([
    ["a wrong item", "I received the wrong one, do you have another one?", "Wrong item sent messages"],
    ["damage", "It arrived broken, have you got a bigger one?", "Damage queries"],
    ["a return", "I want to return this, do you have a bigger one?", "Return and refunds"],
  ])("keeps %s out of pre-sales", (_name, text, expected) => {
    expect(classifyConversationCategory([text])).toBe(expected);
  });

  /**
   * A REALISATION IS REQUIRED FOR THE CHANGE OF MIND, and this is why: a bare
   * "I need a different one" is what a customer says about goods that arrived
   * broken, and `wants_order_change` sits ABOVE every problem intent.
   */
  it.each([
    ["a fault", "The bulb is broken, I need a different one"],
    ["damage with a realisation attached", "It arrived damaged and I realised I need a different size anyway"],
  ])("does not read %s as an order change", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Damage queries");
  });

  /**
   * GERMAN HELD TO A STRICTER STANDARD THAN ENGLISH, in two places, and both
   * were sitting in the Admin residue. The English side has never needed an
   * equivalent of "yet" to read a non-arrival, and an address complaint has
   * been a delivery matter here since the pattern was written.
   */
  it.each([
    ["a plain German non-delivery", "Artikel wurde nicht geliefert", "Delivery queries"],
    ["German goods that did not arrive", "Die Ware ist nicht angekommen", "Delivery queries"],
    [
      "a German delivery-address complaint",
      "Hallo, Die Lieferadresse ist verkehrt ! Das Paket soll in die Musterstrasse 31",
      "Delivery queries",
    ],
    ["the form that already worked", "Ich habe die Ware noch nicht erhalten", "Delivery queries"],
  ])("names %s", (_name, text, expected) => {
    expect(classifyConversationCategory([text])).toBe(expected);
  });

  /** And an arrival is still an arrival. */
  it("does not read a German arrival as a non-delivery", () => {
    expect(classifyConversationCategory(["Danke, die Ware ist angekommen"])).not.toBe(
      "Delivery queries",
    );
  });

  /**
   * WHAT HAS NOT ARRIVED HAS TO BE THE PARCEL. Dropping the "noch" requirement
   * immediately claimed an invoice request — the customer has the goods and
   * wants the paperwork, which is Admin's case and the one thing Delivery
   * cannot answer. German puts the noun in front of the negation.
   */
  it.each([
    [
      "invoices chased for goods already received",
      "Sehr geehrte Damen und Herren, leider habe ich zu meinen bestellten Artikeln die Rechnungen nicht erhalten. Bitte senden Sie mir noch die Rechnungen.",
    ],
    ["a single invoice chased", "Ich habe die Rechnung noch nicht erhalten"],
  ])("gives %s to Admin, not Delivery", (_name, text) => {
    expect(classifyConversationCategory([text])).toBe("Admin related issues");
  });

  /** But a parcel missing alongside the paperwork is still the parcel's case. */
  it("keeps the parcel when both it and the invoice are outstanding", () => {
    expect(
      classifyConversationCategory(["Die Ware ist nicht angekommen und die Rechnung fehlt auch"]),
    ).toBe("Delivery queries");
  });

  /** The distinction the task set out, stated as one pair. */
  it("separates an unsuitable item from a broken one, both asking for a refund", () => {
    expect(classifyConversationCategory(["Item arrived broken, please refund"])).toBe("Damage queries");
    expect(
      classifyConversationCategory([
        "I received it and it is unsuitable for what I need, please refund",
      ]),
    ).toBe("Return and refunds");
  });

  it("names a parcel marked delivered but not received as delivery", () => {
    expect(classifyConversationCategory(["Parcel says delivered but it is not at my address"])).toBe(
      "Delivery queries",
    );
  });

  it("names a request for paperwork as admin", () => {
    expect(classifyConversationCategory(["Please provide an invoice for this order"])).toBe(
      "Admin related issues",
    );
  });

  /** Our own replies are history: they may not contribute an issue or an action. */
  it("ignores our replies entirely", () => {
    const withReply = readConversation([
      { direction: "inbound", text: "Please provide an invoice for this order" },
      { direction: "outbound", text: "Sorry your shade arrived smashed, we will refund you today." },
    ]);
    expect(withReply.issue).toBe("none");
    expect(withReply.category).toBe("Admin related issues");
  });

  it("takes the latest stated action, and the earliest owning issue", () => {
    const reading = readConversation(
      turns("The glass arrived cracked.", "Actually, could you just send a replacement instead?"),
    );
    expect(reading.issue).toBe("physical_damage");
    expect(reading.category).toBe("Damage queries");
  });
});

/* ========================================================================= *
 * 4. NEGATIVE CONTROLS
 *
 * Vocabulary that shares a root with a problem word but describes something
 * else entirely. Every one of these was a live misclassification.
 * ========================================================================= */

describe("negative controls: words that must never assert damage", () => {
  const NOT_DAMAGE = [
    // A town, inside an address the customer sent because we asked for it.
    ["a town name", "Yes it is 8 Sample Close, haughton green , Denton, M00 0AA"],
    // A product feature, and the opposite of the claim.
    ["a product feature", "Is the glass shatterproof?"],
    // A glass finish in the catalogue.
    ["a product finish", "Do you have this in a crackle finish?"],
    // An adjective describing the customer's trade.
    ["a trade", "I work at a dental practice, do you ship here?"],
    // German for a dental laboratory.
    ["a German business", "Wir sind ein Dentallabor und brauchen gute Beleuchtung"],
  ] as const;

  it.each(NOT_DAMAGE)("does not assert damage from %s", (_name, text) => {
    expect(semanticsOf(text).claims.physical_damage).toBe("not_stated");
  });

  it.each(NOT_DAMAGE)("does not categorise %s as damage", (_name, text) => {
    expect(classifyMessageCategoryWithFallback(text)).not.toBe("Damage queries");
  });

  /** The inflections that must still be read as damage. */
  it.each([
    "There is a dent in the shade",
    "The shade arrived dented",
    "Two of them have dents",
    "The glass is cracked",
    "It arrived shattered",
    "The metal is scratched",
  ])("still reads %s as damage", (text) => {
    expect(semanticsOf(text).claims.physical_damage).toBe("asserted");
  });
});

describe("negative controls: refund intent needs an actual request or chase", () => {
  it.each([
    ["a typo inside a product question", "Hello does the big rustic refund (36cm diameter) come with a reduced plate?"],
    ["the customer correcting their own typo", "Refund = red colour, apologies predictive text strikes again"],
    ["a refund being declined", "I don't want a refund, just send the right one"],
  ])("does not read %s as a refund request", (_name, text) => {
    expect(semanticsOf(text).requestedAction).not.toBe("refund_or_return");
  });

  it.each([
    ["a plain request", "Please refund me for this order"],
    ["a polite request", "Can I please return it and receive a refund?"],
    ["a stated want", "I would like a full refund"],
    ["the idiom", "I just want my money back"],
    ["a chase", "I posted the return last week and still have not received my refund"],
    ["German", "Bitte um Rückerstattung des Kaufpreises"],
    ["Italian", "Vorrei un rimborso per questo articolo"],
  ])("still reads %s as a refund request", (_name, text) => {
    expect(semanticsOf(text).requestedAction).toBe("refund_or_return");
  });
});

describe("negative controls: an address confirmation carries no category", () => {
  it.each([
    ["a business address", "Motor parts depot, Unit A1 Sample Business Park, Sample Road, Upton, Wirral, CH00 0AA"],
    ["a home address", "Yes it is 8 Sample Close, haughton green , Denton, M00 0AA"],
  ])("does not let %s decide the conversation", (_name, address) => {
    expect(classifyConversationCategory(["Please send me an invoice", address])).toBe(
      "Admin related issues",
    );
  });

  /** But an address alongside a real report is still a real report. */
  it("keeps a problem stated alongside an address", () => {
    expect(
      classifyConversationCategory([
        "My parcel has not arrived. My address is 8 Sample Close, Denton, M00 0AA",
      ]),
    ).toBe("Delivery queries");
  });
});
