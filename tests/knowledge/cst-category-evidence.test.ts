import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONCEPT_OWNER,
  CST_EVIDENCE,
  CST_TRIGGER_SOURCES,
  collectCategoryEvidence,
} from "@/lib/knowledge/cst-category-evidence";
import { APPROVED_KNOWLEDGE_FILES, FORBIDDEN_KNOWLEDGE_FILES } from "@/lib/knowledge/knowledge-files";
import {
  MESSAGE_CATEGORIES,
  explainMessageCategory,
  resolveEvidenceOwnership,
} from "@/lib/knowledge/message-category";

const KNOWLEDGE_DIR = join(process.cwd(), "Knowledge-source");

/**
 * The evidence map claims to be an extract of eleven specific workbooks. These
 * are the checks that keep that claim true rather than aspirational — a renamed
 * or removed workbook has to fail here, loudly, instead of leaving a category
 * quietly sourced from nothing.
 */
describe("the eleven CST evidence sources", () => {
  it("names exactly one workbook per category, and covers all eleven", () => {
    expect(CST_TRIGGER_SOURCES).toHaveLength(11);

    const categories = CST_TRIGGER_SOURCES.map((source) => source.category);
    expect(new Set(categories).size).toBe(11);
    expect([...categories].sort()).toEqual([...MESSAGE_CATEGORIES].sort());
  });

  it("names workbooks that exist on disk", () => {
    for (const source of CST_TRIGGER_SOURCES) {
      expect(existsSync(join(KNOWLEDGE_DIR, source.file)), source.file).toBe(true);
    }
  });

  /**
   * The allowlist in `knowledge-files.ts` is the one place that decides which
   * CST documents may be used at all. Sourcing a classifier from a file outside
   * it would route around that decision.
   */
  it("only uses workbooks on the approved list, and never the customer file", () => {
    const approved = new Set(APPROVED_KNOWLEDGE_FILES.map((name) => name.trim().toLowerCase()));
    const forbidden = new Set(FORBIDDEN_KNOWLEDGE_FILES.map((name) => name.trim().toLowerCase()));

    for (const source of CST_TRIGGER_SOURCES) {
      const key = source.file.trim().toLowerCase();
      expect(approved.has(key), source.file).toBe(true);
      expect(forbidden.has(key), source.file).toBe(false);
    }
  });

  /**
   * The heading is recorded as the workbook writes it, NOT normalised to a
   * common wording. Ten workbooks say some form of "Trigger Keywords" and the
   * Damage guide says "What Customer Typically Says"; flattening that
   * difference away is what previously made the Damage guide look as though it
   * had no trigger vocabulary at all.
   */
  it("records each workbook's own heading, including the Damage guide's", () => {
    for (const source of CST_TRIGGER_SOURCES) {
      expect(source.heading.trim(), source.file).not.toBe("");
      expect(source.sheet.trim(), source.file).not.toBe("");
    }

    const damage = CST_TRIGGER_SOURCES.find((source) => source.category === "Damage queries");
    expect(damage?.file).toBe("DAMAGE DECISION GUIDE.xlsx");
    expect(damage?.heading).toBe("What Customer Typically Says");
  });
});

describe("the evidence map", () => {
  it("gives every concept exactly one owning category", () => {
    for (const evidence of CST_EVIDENCE) {
      expect(CONCEPT_OWNER[evidence.concept], evidence.id).toBeDefined();
      expect(MESSAGE_CATEGORIES).toContain(CONCEPT_OWNER[evidence.concept]);
    }
  });

  it("uses unique ids and cites a workbook, sheet, condition and phrases for each", () => {
    const ids = CST_EVIDENCE.map((evidence) => evidence.id);
    expect(new Set(ids).size).toBe(ids.length);

    const files = new Set(CST_TRIGGER_SOURCES.map((source) => source.file));
    for (const evidence of CST_EVIDENCE) {
      expect(files.has(evidence.file), `${evidence.id} cites ${evidence.file}`).toBe(true);
      expect(evidence.sheet.trim(), evidence.id).not.toBe("");
      expect(evidence.condition.trim(), evidence.id).not.toBe("");
      expect(evidence.phrases.length, evidence.id).toBeGreaterThan(0);
    }
  });

  /**
   * A global regex carries `lastIndex` between calls, so the same message would
   * match on one call and not the next. Classification has to be a pure
   * function of the text.
   */
  it("holds no global patterns, so matching is order-independent", () => {
    for (const evidence of CST_EVIDENCE) {
      expect(evidence.pattern.global, evidence.id).toBe(false);
      expect(evidence.pattern.ignoreCase, evidence.id).toBe(true);
    }
  });

  it("is deterministic — the same text gives the same evidence every time", () => {
    const text = "The shade arrived smashed and the box was crushed";
    expect(collectCategoryEvidence(text)).toEqual(collectCategoryEvidence(text));
  });
});

/**
 * OVERLAP RESOLUTION. Several rule books legitimately claim the same wording,
 * and the point of the ownership layer is that this is resolved rather than
 * scored or treated as a document conflict.
 */
describe("resolving an overlap between rule books", () => {
  it("gives physically damaged goods to Damage, and records what it rejected", () => {
    const { upheld, rejected } = resolveEvidenceOwnership("One of the shades arrived smashed.");

    expect(upheld.map((match) => match.concept)).toContain("PHYSICAL_PRODUCT_DAMAGE");
    expect(upheld.find((match) => match.concept === "PHYSICAL_PRODUCT_DAMAGE")?.sourceFile).toBe(
      "DAMAGE DECISION GUIDE.xlsx",
    );
    // Delivery's own 9.3 row claims "item smashed / shattered"; it is not
    // upheld here because no packaging is named.
    expect(upheld.map((match) => match.category)).not.toContain("Delivery queries");
    expect(rejected.every((match) => match.rejectedBecause !== undefined)).toBe(true);
  });

  it("gives a battered box with intact contents to Delivery, and says why", () => {
    const { upheld, rejected } = resolveEvidenceOwnership("Box damaged but product fine.");

    expect(upheld.map((match) => match.concept)).toContain("PACKAGING_OR_TRANSIT_DAMAGE");
    expect(upheld.map((match) => match.concept)).not.toContain("PHYSICAL_PRODUCT_DAMAGE");
    expect(
      rejected.filter((match) => match.rejectedBecause === "DAMAGE_IS_ON_THE_PACKAGING").length,
    ).toBeGreaterThan(0);
  });

  it("hands the box back to Damage once the goods are named as damaged too", () => {
    const { upheld } = resolveEvidenceOwnership("The box was damaged and the shade is smashed.");

    expect(upheld.map((match) => match.concept)).toContain("PHYSICAL_PRODUCT_DAMAGE");
    expect(upheld.map((match) => match.concept)).not.toContain("PACKAGING_OR_TRANSIT_DAMAGE");
  });

  /**
   * `Wrong item sent  final.xlsx` INT-WI16 claims "received fewer", "one short"
   * and "missing from order" — correct inside that book, wrong as a
   * cross-category claim. The condition on the ordered/received shape is what
   * keeps a counted shortage with Wrong quantity.
   */
  it("keeps a counted shortage away from Wrong item", () => {
    const { upheld, rejected } = resolveEvidenceOwnership("I ordered 6 bulbs but have only recieved 3");

    expect(upheld.map((match) => match.category)).not.toContain("Wrong item sent messages");
    expect(rejected.map((match) => match.rejectedBecause)).toContain("COUNTED_AGAINST_THE_ORDER");
  });

  /**
   * The ordered/received shape is not the claim on its own. "I ordered on
   * Monday but received it Friday" has the shape and names no second product,
   * and INT-WI09's phrases are all about a product or attribute differing.
   */
  it("does not read an ordered/received sentence about timing as a wrong item", () => {
    const { upheld, rejected } = resolveEvidenceOwnership(
      "I ordered on Monday but received it Friday",
    );

    expect(upheld.map((match) => match.category)).not.toContain("Wrong item sent messages");
    expect(rejected.map((match) => match.rejectedBecause)).toContain("NO_SECOND_THING_NAMED");
  });

  /**
   * `ORDER BEFORRE SHIPPING And cancelation .xlsx` INT-OS08 claims the entire
   * delivery-chase vocabulary — "where is my parcel", "hasn't arrived" — under
   * a condition (a restricted-price order flagged internally) that no incoming
   * message can satisfy. A blind merge would file every delivery chase as a
   * pre-dispatch amendment.
   */
  it("does not let an amendment rule claim a delivery chase", () => {
    const { upheld } = resolveEvidenceOwnership("Where is my parcel? It still hasn't arrived.");

    expect(upheld.map((match) => match.concept)).toContain("CONSIGNMENT_WHEREABOUTS");
    expect(upheld.map((match) => match.concept)).not.toContain("PRE_DISPATCH_AMENDMENT");
  });

  it("does not read a stock question as pre-sales once the goods have arrived", () => {
    const { upheld, rejected } = resolveEvidenceOwnership(
      "The lamp arrived today. Do you have it in black in stock?",
    );

    expect(upheld.map((match) => match.concept)).not.toContain("PRE_PURCHASE_ENQUIRY");
    expect(rejected.map((match) => match.rejectedBecause)).toContain("GOODS_ALREADY_DELIVERED");
  });

  it("leaves a genuine pre-sales stock question alone", () => {
    const { upheld } = resolveEvidenceOwnership("Do you have these in stock in black?");

    expect(upheld.map((match) => match.concept)).toContain("PRE_PURCHASE_ENQUIRY");
  });

  /**
   * Each pre-sales enquiry should cite the CST intent family it belongs to, not
   * merely land in the right category. The id is the workbook's own, so a
   * reviewer can open 🔑 TRIGGER KEYWORDS and read the row.
   */
  it.each([
    ["INT-PS03", "what are the measurements of the shade?"],
    ["INT-PS04", "what voltage is the driver?"],
    ["INT-PS08", "will this work with my existing dimmer?"],
    ["INT-PS09", "do you sell these in copper?"],
    ["INT-PS17", "is this suitable for outdoor use?"],
    ["INT-PS18", "what finish is it, is it metal or plastic?"],
    ["INT-PS19", "which driver do I need for this?"],
    ["INT-PS20", "what size shade fits this pendant?"],
    ["INT-PS-Y", "what weight can it hold?"],
  ])("cites %s for its own intent family", (id, text) => {
    const cited = resolveEvidenceOwnership(text).upheld.filter(
      (match) => match.category === "Pre sales queries",
    );

    expect(cited.map((match) => match.id)).toContain(id);
    expect(cited.every((match) => match.sourceFile === "PRE-SALES QUERIES.xlsx")).toBe(true);
  });

  /**
   * Delivery scenarios are numbered rather than given INT ids, so the evidence
   * cites the sheet number. A reviewer can open the workbook at that sheet and
   * read the trigger row.
   */
  it.each([
    ["DEL-13.1", "CONSIGNMENT_NOT_RECEIVED", "Hello I did not receive my order."],
    ["DEL-13.2", "CONSIGNMENT_NOT_RECEIVED", "This should have been delivered yesterday."],
    ["DEL-2.1", "DELIVERED_NOT_RECEIVED", "Marked as delivered but nothing here"],
    ["DEL-2.4", "COLLECTION_POINT_QUERY", "Parcel is at the depot"],
    ["DEL-18.1", "URGENT_DELIVERY_DEADLINE", "My electrician is coming tomorrow"],
    ["DEL-1.1", "CONSIGNMENT_WHEREABOUTS", "Where is my parcel?"],
  ])("cites %s for %s", (id, concept, text) => {
    const cited = resolveEvidenceOwnership(text).upheld.filter(
      (match) => match.category === "Delivery queries",
    );

    expect(cited.map((match) => match.id)).toContain(id);
    expect(cited.find((match) => match.id === id)?.concept).toBe(concept);
    expect(cited.every((match) => match.sourceFile === "Delivery_Master_Rules final.xlsx")).toBe(
      true,
    );
  });

  /**
   * Sheet 13 is the catch-all for basic non-receipt, and its conditions are
   * what keep it from claiming every sentence containing "not received".
   */
  it.each([
    ["a missing invoice", "I have not received my VAT invoice.", "THE_MISSING_THING_IS_PAPERWORK"],
    ["an unreceived refund", "I have not received my refund.", "A_RETURN_IS_UNDER_WAY"],
  ])("rejects %s from the non-receipt scenario", (_name, text, rejection) => {
    const { upheld, rejected } = resolveEvidenceOwnership(text);

    expect(upheld.map((match) => match.id)).not.toContain("DEL-13.1");
    expect(rejected.filter((m) => m.id === "DEL-13.1").map((m) => m.rejectedBecause)).toContain(
      rejection,
    );
  });

  /**
   * The workbooks are English-only — verified, not assumed — so German messages
   * are translated into their vocabulary rather than matched against invented
   * German trigger phrases. The point of the translation is that the German
   * message resolves to the SAME approved row an English one does.
   */
  it("resolves a German enquiry to the English CST row it belongs to", () => {
    const { upheld } = resolveEvidenceOwnership("Ist die Lampe für den Aussenbereich geeignet?");
    const cited = upheld.find((match) => match.id === "INT-PS17");

    expect(cited).toBeDefined();
    expect(cited?.sourceFile).toBe("PRE-SALES QUERIES.xlsx");
    expect(cited?.sourceSheet).toContain("OUTDOOR AND IP RATING");
  });

  /**
   * `missing parts query .xlsx` INT-MP04 lists a bare "missing", which German
   * invoice requests ("uns fehlt die Rechnung") match. Admin owns the
   * paperwork, and the strict layer has carried a precedence entry for exactly
   * this collision for as long as the collision has existed.
   */
  it("does not read a missing invoice as a missing part", () => {
    const { upheld, rejected } = resolveEvidenceOwnership("Uns fehlt die Rechnung für die Bestellung.");

    expect(upheld.map((match) => match.concept)).not.toContain("ABSENT_COMPONENT");
    expect(rejected.map((match) => match.rejectedBecause)).toContain("THE_MISSING_THING_IS_PAPERWORK");
  });
});

/**
 * PROVENANCE. The point of grounding the classifier in the rule books is that a
 * reviewer can check it — which needs the workbook, the sheet and the reason,
 * and needs them without carrying customer text or document contents along.
 */
describe("explaining a classification", () => {
  it("names the category, the CST source and the ownership reason", () => {
    const explained = explainMessageCategory("One of the shades arrived smashed.");

    expect(explained.category).toBe("Damage queries");
    expect(explained.reason).toBe("PHYSICAL_PRODUCT_DAMAGE");

    const damage = explained.evidence.find((match) => match.category === "Damage queries");
    expect(damage?.sourceFile).toBe("DAMAGE DECISION GUIDE.xlsx");
    expect(damage?.sourceSheet).toContain("Glass Lampshade");
    expect(damage?.condition).toContain("Broken or shattered");
    expect(damage?.matched.toLowerCase()).toBe("smashed");
  });

  it("carries no message body — only the matched fragment", () => {
    const message =
      "Hello, my name is on the order and the reference is 12345, one of the shades arrived smashed.";
    const explained = explainMessageCategory(message);

    for (const match of [...explained.evidence, ...explained.rejected]) {
      expect(match.matched.length).toBeLessThanOrEqual(60);
      expect(message).not.toBe(match.matched);
      expect(match.matched).not.toContain("12345");
    }
  });

  it("still explains a category the intent layer named without CST evidence", () => {
    const explained = explainMessageCategory("Please cancel my order before it ships.");

    expect(explained.category).toBe("Order change, before shipping queries");
    expect(explained.reason).toBe("PRE_DISPATCH_AMENDMENT");
  });

  it("reports machine-generated content rather than classifying it", () => {
    const explained = explainMessageCategory("This is an automated notification. Do not reply.");

    expect(explained.category).toBeNull();
    expect(explained.reason).toBe("NOT_FROM_A_CUSTOMER");
  });

  it("returns nothing for empty text", () => {
    expect(explainMessageCategory("   ")).toEqual({
      category: null,
      intents: [],
      evidence: [],
      rejected: [],
      reason: "NO_CUSTOMER_TEXT",
      corpus: { admitted: [], refused: [], signals: [], category: null },
      // An empty message raises no claim and requests nothing, which the
      // semantic reading has to say rather than omit.
      semantics: {
        journey: "unknown",
        event: "none",
        requestedAction: "none",
        speechAct: "assertion",
        claims: {
          physical_damage: "not_stated",
          functional_fault: "not_stated",
          absent_component: "not_stated",
          listing_mismatch: "not_stated",
          wrong_item: "not_stated",
        },
      },
    });
  });

  /**
   * The whole-message reading is the thing to look at first when a category is
   * wrong, so it has to say something a person can act on. rollert4 is the case
   * it was built for: a customer correcting our answer, asserting no absence
   * whatever, previously filed as a missing part because "nothing to do with my
   * actual question" contained an absence fragment.
   */
  it("reads a technical correction as a specification question, not a missing part", () => {
    const explained = explainMessageCategory(
      "However, it unfortunately has nothing to do with my actual question! " +
        "I wanted to know exactly whether this transformer has two galvanically/electrically isolated windings? " +
        "I didn't ask about the power rating!",
    );

    expect(explained.category).toBe("Pre sales queries");
    expect(explained.semantics.requestedAction).toBe("technical_specification");
    expect(explained.semantics.claims.absent_component).not.toBe("asserted");
  });

  it("reads a smashed shade as an asserted damage claim", () => {
    const explained = explainMessageCategory(
      "Have received my order this morning, however one of the shades arrived smashed as per the photograph. Can you advise please.",
    );

    expect(explained.category).toBe("Damage queries");
    expect(explained.semantics.journey).toBe("received");
    expect(explained.semantics.claims.physical_damage).toBe("asserted");
    expect(explained.semantics.claims.listing_mismatch).not.toBe("asserted");
  });

  it("reads a specification question as asked rather than asserted", () => {
    const explained = explainMessageCategory("Does this transformer have two isolated windings?");

    expect(explained.semantics.requestedAction).toBe("technical_specification");
    expect(explained.semantics.claims.absent_component).not.toBe("asserted");
  });
});
