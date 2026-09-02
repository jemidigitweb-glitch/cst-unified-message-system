import { describe, expect, it } from "vitest";

import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import { withDraftValidation } from "@/lib/ai/validated-draft-provider";
import type { DraftOutcome, DraftProvider, DraftRequest } from "@/lib/ai/provider";

import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * The SOT provenance finding.
 *
 * A draft that states a specification taken from the product data sheet reads
 * exactly like one that states a specification taken from the order record.
 * This finding is what tells the reviewer which it was. It must fire when a
 * specification is quoted, stay silent otherwise, never reach a post-sale
 * conversation, and never buy a second model call.
 */

/** Real values, from the live SOT record for CRSF100GY (ceiling rose). */
const SOT_FACTS: VerifiedFact[] = [
  { name: "sku", value: "CRSF100GY" },
  { name: "product_type", value: "Ceiling Rose" },
  { name: "product_name", value: "100mm Metal Ceiling Rose with Cord Grip" },
  { name: "diameter_mm", value: "100" },
  { name: "height_mm", value: "25" },
  { name: "fitting_type", value: "Side Fitting" },
  { name: "material_primary", value: "Metal" },
  { name: "ip_rating", value: "IP20" },
  {
    name: "parts_list",
    value: "Ceiling rose; Backplate; Cord grip; Terminal block; Earth wire",
  },
];

/** The eight names the order resolver can produce, and nothing else. */
const ORDER_FACTS: VerifiedFact[] = [
  { name: "order_number", value: "11-11111-11111" },
  { name: "order_status", value: "Dispatched" },
  { name: "order_date", value: "2026-08-25" },
  { name: "tracking_number", value: "TRK-1" },
  { name: "delivery_courier", value: "Royal Mail" },
  { name: "delivery_address", value: "1 Test Street, Testville, TE5 7ST" },
  { name: "sku", value: "CRSF100GY" },
  { name: "product_title", value: "100mm Metal Ceiling Rose" },
];

function message(text: string): ConversationMessageView {
  return {
    id: "1",
    direction: "inbound",
    sourceTimestamp: "2026-09-01 09:00:00",
    bodyText: text,
    bodyDecodeStatus: "decoded",
    attachments: [],
  } as unknown as ConversationMessageView;
}

const ASKED = [message("Before I buy — what diameter is this and what is it made of?")];

function check(reply: string, facts: VerifiedFact[]) {
  return validateDraftAccuracy({ reply, facts, messages: ASKED, knowledgeAvailable: true });
}

const provenance = (result: ReturnType<typeof check>) =>
  result.findings.filter((f) => f.issue === "specification_needs_confirmation");

/* ------------------------------------------------------------------ */

describe("1. a SOT-backed specification draft", () => {
  const reply = "Hi, thanks for your message. The ceiling rose is 100 mm in diameter and is made of metal.";

  it("raises exactly one minor provenance finding", () => {
    const found = provenance(check(reply, SOT_FACTS));

    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("minor");
  });

  it("carries the required note and the facts behind it", () => {
    const finding = provenance(check(reply, SOT_FACTS))[0]!;

    expect(finding.regenerationReason).toBe(
      "Product specification is sourced from SOT product data. Confirm before use.",
    );
    expect(finding.verifiedFact).toContain("diameter_mm = 100");
    expect(finding.verifiedFact).toContain("material_primary = Metal");
    expect(finding.ruleThatApplies).toBe(
      "Product specifications come from the SOT product data sheet",
    );
  });

  it("quotes the sentence a reviewer has to confirm", () => {
    const finding = provenance(check(reply, SOT_FACTS))[0]!;
    expect(finding.incorrectStatement).toContain("100 mm in diameter");
  });

  it("does not pass, and does not buy a regeneration", () => {
    const result = check(reply, SOT_FACTS);

    expect(result.passed).toBe(false);
    expect(result.regenerationWarranted).toBe(false);
    expect(result.corrections).toEqual([]);
    expect(result.notes.some((note) => note.includes("Confirm before use"))).toBe(true);
  });

  it("reaches the reviewer as requiresReview = true, through the existing gate", async () => {
    const outcome: DraftOutcome = {
      result: {
        draft_reply: reply,
        sources_used: [{ kind: "cst_document", ref: "PRE-P26-5", label: "Pre-sales" }],
        missing_information: [],
        requires_review: false,
      },
      requiresReview: false,
      missingInformation: [],
      model: "test-model",
      provider: "openai",
      knowledgeAvailable: true,
    };

    let calls = 0;
    const provider: DraftProvider = {
      name: "openai",
      model: "test-model",
      async generate() {
        calls += 1;
        return outcome;
      },
    };

    const request: DraftRequest = {
      messages: ASKED,
      marketplace: "ebay",
      listingItemRef: "123776402567",
      facts: SOT_FACTS,
    };

    const gated = await withDraftValidation(provider).generate(request);

    // Was false out of the provider; the gate turned it on.
    expect(outcome.requiresReview).toBe(false);
    expect(gated.requiresReview).toBe(true);
    expect(gated.missingInformation.some((note) => note.includes("Confirm before use"))).toBe(true);
    // No second call: a minor finding must never cost a regeneration.
    expect(calls).toBe(1);
    // The reply the reviewer sees is byte-for-byte what the model wrote.
    expect(gated.result.draft_reply).toBe(reply);
  });

  it("fires on a compatibility answer, not only on dimensions", () => {
    const facts: VerifiedFact[] = [
      { name: "sku", value: "LSFT220BC" },
      { name: "bulb_base_compat", value: "E26 / E27" },
    ];
    const found = provenance(
      check("Yes — the shade takes an E27 bulb, so yours will fit.", facts),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.verifiedFact).toBe("bulb_base_compat = E26 / E27");
  });
});

describe("2. drafts that must be left alone", () => {
  it("stays silent when SOT facts were supplied but no specification was quoted", () => {
    const reply =
      "Thanks for getting in touch about the ceiling rose. I'll check that and come back to you shortly.";
    expect(provenance(check(reply, SOT_FACTS))).toEqual([]);
  });

  it("stays silent on a draft with no facts at all", () => {
    const reply = "Hi, we're checking the listing details and will confirm shortly.";
    const result = check(reply, []);

    expect(provenance(result)).toEqual([]);
  });

  /**
   * `reducer_ring_included` is stored as "Y". A one-character token appears in
   * almost every sentence, so it must never raise this on its own.
   */
  it("cannot be triggered by a single-letter stored value", () => {
    const facts: VerifiedFact[] = [{ name: "reducer_ring_included", value: "Y" }];
    expect(provenance(check("Yes, your order is on its way.", facts))).toEqual([]);
  });

  /**
   * "Ceiling rose" is the first item of `parts_list` AND the whole of
   * `product_type`. A reply naming the product is being polite, not quoting a
   * specification.
   */
  it("does not fire when the reply only names the product", () => {
    const reply = "Thanks for your message about the ceiling rose — I'll look into it today.";
    expect(provenance(check(reply, SOT_FACTS))).toEqual([]);
  });

  it("does not match a number embedded in a longer one", () => {
    const facts: VerifiedFact[] = [
      { name: "sku", value: "X" },
      { name: "diameter_mm", value: "100" },
    ];
    expect(provenance(check("Your reference is 1002 and we will be in touch.", facts))).toEqual([]);
  });
});

describe("3. post-sale conversations", () => {
  it("never fires on the order resolver's fact vocabulary", () => {
    const reply =
      "Your order 11-11111-11111 was dispatched on 25 August with Royal Mail, tracking TRK-1.";
    expect(provenance(check(reply, ORDER_FACTS))).toEqual([]);
  });

  it("stays silent even when the reply quotes a dimension from the product title", () => {
    // `product_title` is an order fact, not a SOT specification. The 100 here
    // came from the listing title, and nothing in this check may claim it came
    // from the sheet.
    const reply = "Your 100mm Metal Ceiling Rose was dispatched on 25 August.";
    expect(provenance(check(reply, ORDER_FACTS))).toEqual([]);
  });

  /**
   * The order resolver's vocabulary is closed and every one of its names must be
   * recognised as NOT from the sheet, or a post-sale draft would be flagged.
   */
  it("treats every order fact name as non-SOT", () => {
    const reply = "It is 100 mm.";
    for (const fact of ORDER_FACTS) {
      expect(
        provenance(check(reply, [{ name: fact.name, value: "100" }])),
        `${fact.name} must not read as a sheet specification`,
      ).toEqual([]);
    }
  });

  it("treats every return fact name as non-SOT", () => {
    const reply = "It is 100 mm.";
    for (const name of ["return_status", "return_reason", "return_evidence_available"]) {
      expect(provenance(check(reply, [{ name, value: "100" }])), name).toEqual([]);
    }
  });
});

describe("4. an extensible resolver cannot outrun this check", () => {
  /**
   * The resolver admits new sheet columns with no code change. This check
   * therefore identifies SOT facts by EXCLUSION — anything that is not one of
   * the eleven closed order/return names. A name nobody has ever seen must
   * still raise the finding.
   */
  it.each([
    "table_lamp",
    "beam_angle_deg",
    "heat_resistance_c",
    "a_brand_new_column_nobody_has_added_yet",
  ])("raises the finding for the newly admitted attribute %s", (name) => {
    const found = provenance(check("It is 100 mm.", [{ name, value: "100" }]));
    expect(found).toHaveLength(1);
    expect(found[0]!.verifiedFact).toBe(`${name} = 100`);
  });

  it("still treats product_name and product_type as identification, not specification", () => {
    const reply = "It is 100 mm.";
    for (const name of ["sku", "product_name", "product_type"]) {
      expect(provenance(check(reply, [{ name, value: "100" }])), name).toEqual([]);
    }
  });
});

describe("5. cost", () => {
  it("stays inside the existing validation budget on a post-sale draft", () => {
    const before = performance.now();
    validateDraftAccuracy({
      reply: "Your order was dispatched on 25 August with Royal Mail.",
      facts: ORDER_FACTS,
      messages: ASKED,
      knowledgeAvailable: true,
    });
    expect(performance.now() - before).toBeLessThan(50);
  });

  it("stays inside the same budget on a SOT-backed draft", () => {
    const before = performance.now();
    validateDraftAccuracy({
      reply: "The ceiling rose is 100 mm in diameter, 25 mm high, made of metal, rated IP20.",
      facts: SOT_FACTS,
      messages: ASKED,
      knowledgeAvailable: true,
    });
    expect(performance.now() - before).toBeLessThan(50);
  });
});
