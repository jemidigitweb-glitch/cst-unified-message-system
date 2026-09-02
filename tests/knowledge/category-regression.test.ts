import { describe, expect, it } from "vitest";

import {
  classifyConversationCategory,
  classifyMessageCategory,
  classifyMessageCategoryWithFallback,
  readConversation,
  semanticsOf,
} from "@/lib/knowledge/message-category";

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
