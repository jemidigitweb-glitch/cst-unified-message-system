import { describe, expect, it } from "vitest";

import { buildDraftInput } from "@/lib/ai/draft-assembly";
import { cstInstructions, marketplaceClause, restrictedInstructions } from "@/lib/ai/instructions";
import type { DraftRequest } from "@/lib/ai/provider";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * The customer-facing wording rules, asserted on what the model is actually told.
 *
 * WHAT THESE CAN AND CANNOT PROVE. A draft is written by a model, so no unit
 * test can assert the sentence it will produce. What is testable — and what
 * every failure traced in the investigation came down to — is whether the
 * instruction the model receives asks for the right thing and still forbids the
 * wrong thing. So these assert the composed prompt: the guidance is present, the
 * internal context it governs is unchanged, and none of the standing safety text
 * moved.
 *
 * The fixtures are the two real cases from the live store: the canopy/backplate
 * enquiry (conversation 51360) and the colour-options enquiry on the same
 * listing. No customer text or order number is reproduced.
 */

const message = (text: string): ConversationMessageView =>
  ({
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-09-01 09:00:00",
    bodyText: text,
    bodyDecodeStatus: "decoded",
    attachments: [],
  }) as unknown as ConversationMessageView;

/** The real question, paraphrased: canopy diameter and which brass finish. */
const CANOPY = [message("Is the 10.5 cm the diameter of the canopy? Are these shiny brass or antique brass?")];

/** The facts behind that reply — a catalogue dimension and a listing option set. */
const CANOPY_FACTS: VerifiedFact[] = [
  { name: "listing_title", value: "Ceiling Rose Pendant Kit" },
  { name: "listing_options_colour", value: "Yellow Brass, Black & Yellow Brass, Black" },
  { name: "backplate_diameter_mm", value: "100" },
  { name: "finish", value: "Antique Yellow Brass" },
];

const request = (facts: VerifiedFact[] = CANOPY_FACTS): DraftRequest => ({
  messages: CANOPY,
  marketplace: "ebay",
  listingItemRef: "123456789012",
  facts,
});

const instructions = cstInstructions("ebay");
const composed = instructions + buildDraftInput(request());

/**
 * The WRITING section alone.
 *
 * Several assertions below are about what this change did NOT introduce, and
 * they have to be scoped. "escalation", "recipient" and "transport" all appear
 * legitimately elsewhere in the standing instruction — the first in the CST
 * project text, the other two in the sentence saying there is no transport —
 * so asserting their absence across the whole thing would fail on text that
 * predates this work and must stay.
 */
const writingBlock = instructions.slice(
  instructions.indexOf("WRITING THE REPLY."),
  instructions.indexOf("SOURCES. In \"sources_used\""),
);

/* ------------------------------------------------------------------ A */

describe("A. the canopy case: a verified dimension is stated, not attributed", () => {
  it("asks for the fact to be given as a fact about the product", () => {
    expect(instructions).toContain("WRITE FROM THE CUSTOMER'S SIDE, IN ORDINARY PRODUCT LANGUAGE");
    expect(instructions).toContain('"the dimensions are"');
  });

  it.each([
    '"it is listed as"',
    '"the listing says"',
    '"according to the listing"',
    '"the listing offers"',
    "\"the listing's options\"",
  ])("names %s as wording to avoid", (phrase) => {
    expect(instructions).toContain(phrase);
    // Each appears inside the prohibition sentence, after the word "never".
    const sentence = instructions.slice(
      instructions.indexOf("WRITE FROM THE CUSTOMER'S SIDE"),
      instructions.indexOf("AN INTERNAL STEP IS NOT A SENTENCE"),
    );
    expect(sentence.indexOf(phrase)).toBeGreaterThan(sentence.indexOf("never"));
  });

  it("still puts the verified dimension in front of the model", () => {
    expect(composed).toContain("backplate_diameter_mm: 100");
  });

  it("forbids naming the field the fact came from", () => {
    expect(instructions).toContain("nor the name of any field, source or system");
  });
});

/* ------------------------------------------------------------------ B */

describe("B. colour options are given in natural language", () => {
  it("prescribes the natural form", () => {
    expect(instructions).toContain('"the available colours are"');
  });

  it("still supplies the option set, under its own internal name", () => {
    expect(composed).toContain(
      "listing_options_colour: Yellow Brass, Black & Yellow Brass, Black",
    );
  });

  it("keeps the standing rule that options are the listing's, not the customer's", () => {
    // Unchanged from before this work: an option list must never be read as
    // what this customer has. The wording rule must not have displaced it.
    expect(composed).toContain(
      "lists what THE LISTING OFFERS, not what this customer bought or received",
    );
  });
});

/* ------------------------------------------------------------------ C */

describe("C. an internal check is not narrated to the customer", () => {
  it("states the principle", () => {
    expect(instructions).toContain("AN INTERNAL STEP IS NOT A SENTENCE");
    expect(instructions).toContain(
      '"Check with the product, merchandising, postage or account team" is an instruction to us',
    );
  });

  it("forbids naming an internal team or an in-flight check", () => {
    expect(instructions).toContain("never write that another team must confirm something");
    expect(instructions).toContain("that a check is under way, or name an internal team");
  });

  it("keeps the exception where a rule requires telling the customer", () => {
    expect(instructions).toContain("unless the rule says to tell them");
  });
});

/* ------------------------------------------------------------------ D */

describe("D. no unauthorised commercial or safety prohibition", () => {
  it("forbids inventing one", () => {
    expect(instructions).toContain(
      "Do not tell a customer not to buy, not to use or not to connect something unless the rule for this case requires that warning",
    );
  });

  it("does not itself encourage any such warning", () => {
    // The only occurrences are inside the prohibition above.
    const encouragements = instructions.match(/do not (buy|purchase|use|connect)/gi) ?? [];
    expect(encouragements.length).toBeLessThanOrEqual(1);
  });

  /**
   * PS-F2 requirements are untouched. This is the line the investigation drew:
   * the rule genuinely requires the electrician advice and the "cannot confirm
   * compatibility" statement, and nothing here may weaken either.
   */
  it("says nothing about electricians, compatibility or escalation", () => {
    for (const forbidden of ["electrician", "compatib", "escalat", "product team must"]) {
      expect(writingBlock.toLowerCase()).not.toContain(forbidden);
    }
  });
});

/* ------------------------------------------------------------------ E */

describe("E. legitimate listing references remain possible", () => {
  it("permits the word where the question needs it", () => {
    expect(instructions).toContain('Say "listing" only where the question needs it');
  });

  it.each([
    ["PS-B1 signposting", "pointing them to where a detail appears"],
    ["PS-Q1 dropdown guidance", "telling them which option to select"],
    ["a link to another item", "asking for a link to a DIFFERENT item"],
  ])("names %s as a permitted case", (_label, clause) => {
    expect(instructions).toContain(clause);
  });

  it("does not ban the token outright", () => {
    expect(instructions).not.toMatch(/never (say|write|use) (the word )?"?listing/i);
    // And the internal context still uses it freely — see H.
    expect(composed).toContain("Marketplace listing reference:");
  });
});

/* ------------------------------------------------------------------ F */

describe("F. a conflict between two verified facts survives the rewrite", () => {
  /** The real shape: a ~100 mm backplate beside a 120 mm ceiling rose. */
  const CONFLICTING: VerifiedFact[] = [
    { name: "backplate_diameter_mm", value: "100" },
    { name: "ceiling_rose_diameter_mm", value: "120" },
  ];

  it("instructs the model to state the disagreement rather than resolve it", () => {
    expect(instructions).toContain("WHERE TWO VERIFIED FACTS DISAGREE, SAY SO");
    expect(instructions).toContain("Never pick one, average them, or leave the difference out");
  });

  it("requires both values, the note and the review flag", () => {
    expect(instructions).toContain("Give both values in plain words");
    expect(instructions).toContain('record the conflict in "missing_information"');
    expect(instructions).toContain('set "requires_review" to true');
  });

  it("puts both conflicting values in front of the model, neither dropped", () => {
    const input = buildDraftInput(request(CONFLICTING));
    expect(input).toContain("backplate_diameter_mm: 100");
    expect(input).toContain("ceiling_rose_diameter_mm: 120");
  });

  it("does not let the natural-language rule out-rank the conflict rule", () => {
    // Stated AFTER the wording guidance, so it is read as qualifying it.
    expect(instructions.indexOf("WHERE TWO VERIFIED FACTS DISAGREE")).toBeGreaterThan(
      instructions.indexOf("WRITE FROM THE CUSTOMER'S SIDE"),
    );
  });
});

/* ------------------------------------------------------------------ G */

describe("G. grounding is unchanged", () => {
  it("keeps NEVER_INVENT word for word", () => {
    expect(instructions).toContain(
      "You must NEVER state, imply, guess or reconstruct:\n- an order number, SKU, product name, specification or price",
    );
    expect(instructions).toContain(
      "CUSTOMER-STATED IS NOT VERIFIED. Anything the customer typed is customer-stated.",
    );
    expect(instructions).toContain("Only the VERIFIED CONTEXT block is verified.");
    expect(instructions).toContain(
      "A MISSING FACT NARROWS THE ANSWER, IT DOES NOT REPLACE IT.",
    );
  });

  it("keeps the other standing sections intact", () => {
    for (const anchor of [
      "HOW TO USE THE KNOWLEDGE BASE.",
      "WHAT THIS TEAM HAS ALREADY SAID IN THIS THREAD.",
      "AT LEAST ONE CST SOURCE IS REQUIRED.",
      "You never send anything. There is no recipient and no transport",
    ]) {
      expect(instructions).toContain(anchor);
    }
  });

  it("leaves the restricted (no-knowledge) instruction alone", () => {
    const restricted = restrictedInstructions("ebay");
    expect(restricted).toContain("THE CST KNOWLEDGE BASE IS NOT AVAILABLE FOR THIS DRAFT.");
    expect(restricted).not.toContain("WRITE FROM THE CUSTOMER'S SIDE");
  });

  it("leaves the marketplace clause alone", () => {
    expect(marketplaceClause("ebay")).toContain("Write a reply for EBAY ONLY.");
  });
});

/* ------------------------------------------------------------------ H */

describe("H. internal context and provenance are untouched", () => {
  it.each([
    "listing_title: Ceiling Rose Pendant Kit",
    "listing_options_colour: Yellow Brass, Black & Yellow Brass, Black",
    "Marketplace listing reference: 123456789012",
  ])("still sends %s to the model", (line) => {
    expect(composed).toContain(line);
  });

  it("keeps the fact names exactly as the resolvers emit them", () => {
    for (const name of ["listing_title", "listing_options_colour", "backplate_diameter_mm"]) {
      expect(composed).toContain(`- ${name}: `);
    }
  });

  it("still requires verified facts to be cited as sources", () => {
    expect(instructions).toContain('Record verified facts you used with kind "verified_fact"');
  });

  it("adds nothing that could transmit a reply", () => {
    for (const forbidden of ["send the reply", "recipient", "transport", "dispatch this message"]) {
      expect(writingBlock.toLowerCase()).not.toContain(forbidden);
    }
    // And the standing no-send sentence is still there, untouched.
    expect(instructions).toContain(
      "You never send anything. There is no recipient and no transport; a human reviews every draft.",
    );
  });
});
