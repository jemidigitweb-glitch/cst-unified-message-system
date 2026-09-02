import { describe, expect, it } from "vitest";

import { contextBlocks } from "@/lib/ai/draft-assembly";
import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import type { DraftRequest } from "@/lib/ai/provider";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * What a pre-sale draft is TOLD about the facts it was given.
 *
 * Three additions are covered here: the thread category as internal guidance,
 * the rule about answering from verified facts before asking, and the narrower
 * rule that keeps electrical questions off products with no electrical
 * interface. Each is confined to the drafts it applies to, and the last test in
 * every group is the one proving what it does NOT touch.
 */

function message(text: string, direction: "inbound" | "outbound" = "inbound"): ConversationMessageView {
  return {
    id: "1",
    direction,
    sourceTimestamp: "2026-09-01 09:00:00",
    bodyText: text,
    bodyDecodeStatus: "decoded",
    attachments: [],
  } as unknown as ConversationMessageView;
}

function request(messages: ConversationMessageView[], facts: VerifiedFact[]): DraftRequest {
  return { messages, marketplace: "ebay", listingItemRef: "168166397166", facts };
}

/** Live SOT values for LSFT220BC — a lampshade, which needs no electrician. */
const LAMPSHADE: VerifiedFact[] = [
  { name: "sku", value: "LSFT220BC" },
  { name: "product_type", value: "Lighting Accessory" },
  { name: "product_name", value: "Industrial Metal Cone Lampshade – Brushed Copper" },
  { name: "diameter_mm", value: "220" },
  { name: "fitting_type", value: "Easy Fit" },
  { name: "req_electrician", value: "N" },
  { name: "cap_elec_req", value: "N" },
  { name: "table_lamp", value: "Y" },
  { name: "ceiling_light", value: "Y" },
  { name: "parts_list", value: "Lampshade, Reducer Ring" },
  { name: "reducer_ring_included", value: "Y" },
  { name: "bulb_base_compat", value: "E26 / E27" },
];

/** Live SOT values for a bulb — an electrical product. */
const BULB: VerifiedFact[] = [
  { name: "sku", value: "LDA60B224CW" },
  { name: "product_type", value: "Bulb" },
  { name: "dimmable", value: "N" },
  { name: "cap_dimmable", value: "N" },
  { name: "wattage_w", value: "4" },
];

/** A ceiling rose — electrical installation is Recommended, not N. */
const CEILING_ROSE: VerifiedFact[] = [
  { name: "sku", value: "CRSF100GY" },
  { name: "req_electrician", value: "Recommended" },
  { name: "cap_elec_req", value: "Y" },
  { name: "diameter_mm", value: "100" },
];

/** Exactly what a resolved order contributes. */
const ORDER_FACTS: VerifiedFact[] = [
  { name: "order_number", value: "11-11111-11111" },
  { name: "order_status", value: "Dispatched" },
  { name: "tracking_number", value: "TRK-1" },
  { name: "delivery_courier", value: "Royal Mail" },
  { name: "sku", value: "CRSF100GY" },
  { name: "product_title", value: "100mm Metal Ceiling Rose" },
];

/* ------------------------------------------------------------------ */

describe("the thread category as internal guidance", () => {
  it("reaches the model, under a heading that is not VERIFIED", () => {
    const blocks = contextBlocks(
      request([message("Can this be used on a table lamp as well or just a ceiling shade?")], LAMPSHADE),
    );

    expect(blocks).toContain("INTERNAL GUIDANCE — MESSAGE CATEGORY: Pre sales queries");
    expect(blocks).not.toContain("VERIFIED CONTEXT — MESSAGE CATEGORY");
  });

  it("tells the model plainly never to mention it", () => {
    const blocks = contextBlocks(request([message("Are these bulbs dimmable?")], BULB));

    expect(blocks).toContain("NEVER mention it");
    expect(blocks).toContain("do not refer to a classification");
    expect(blocks).toContain("The customer reads a reply from the team and nothing else.");
  });

  it("lets the customer's own words win where the two disagree", () => {
    const blocks = contextBlocks(request([message("Are these bulbs dimmable?")], BULB));
    expect(blocks).toContain("the customer's own words win");
  });

  /**
   * The predictive-text case. `readConversation` sees through "refund = red
   * colour" and reads a pre-sales enquiry; before this the model saw only the
   * word "refund" and retrieved the returns rules.
   */
  it("carries the classifier's reading through a predictive-text error", () => {
    const blocks = contextBlocks(
      request(
        [
          message(
            "Hello does the big rustic refund (36cm diameter) come with a reduced plate?\nRefund = red colour, apologies predictive text strikes again",
          ),
        ],
        LAMPSHADE,
      ),
    );

    expect(blocks).toContain("INTERNAL GUIDANCE — MESSAGE CATEGORY: Pre sales queries");
    expect(blocks).not.toContain("Return and refunds");
  });

  it("is omitted entirely when the thread yields no category", () => {
    const blocks = contextBlocks(request([], LAMPSHADE));
    expect(blocks).not.toContain("INTERNAL GUIDANCE — MESSAGE CATEGORY");
  });
});

describe("answering from verified facts before asking", () => {
  it("states the rule when a product record was resolved", () => {
    const blocks = contextBlocks(request([message("What size is it?")], LAMPSHADE));

    expect(blocks).toContain("USING THE VERIFIED PRODUCT INFORMATION YOU HAVE BEEN GIVEN");
    expect(blocks).toContain("answer it directly");
    expect(blocks).toContain("Do not ask the customer for something already stated there");
    expect(blocks).toContain("ask for the minimum still missing");
  });

  it("keeps the rule inside the product block, never the order one", () => {
    const blocks = contextBlocks(request([message("What size is it?")], LAMPSHADE));
    const [orderHalf] = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:");
    expect(orderHalf).not.toContain("USING THE VERIFIED PRODUCT INFORMATION");
  });

  it("is absent when no product facts resolved", () => {
    const blocks = contextBlocks(request([message("Where is my parcel?")], []));
    expect(blocks).not.toContain("USING THE VERIFIED PRODUCT INFORMATION");
  });
});

describe("electrical questions on passive products", () => {
  it("forbids asking a lampshade buyer for voltage or wattage", () => {
    const blocks = contextBlocks(
      request([message("Is this compatible with my lighting fixture?")], LAMPSHADE),
    );

    expect(blocks).toContain("This product needs no electrical installation");
    expect(blocks).toContain("Do NOT ask this customer for voltage, wattage");
    // The CST rule is scoped, not removed: the applicable details are still asked for.
    expect(blocks).toContain("ask only for the ones that do apply");
  });

  it.each([
    ["a bulb", BULB],
    ["a ceiling rose", CEILING_ROSE],
  ])("leaves the compatibility rules untouched for %s", (_label, facts) => {
    const blocks = contextBlocks(request([message("Will this work with my dimmer?")], facts));

    expect(blocks).toContain("USING THE VERIFIED PRODUCT INFORMATION YOU HAVE BEEN GIVEN");
    expect(blocks).not.toContain("This product needs no electrical installation");
  });
});

describe("post-sale conversations are untouched", () => {
  const asked = [message("Where is my order?")];

  it("adds no product-usage rule when only an order resolved", () => {
    const blocks = contextBlocks(request(asked, ORDER_FACTS));

    expect(blocks).not.toContain("USING THE VERIFIED PRODUCT INFORMATION");
    expect(blocks).not.toContain("This product needs no electrical installation");
  });

  it("leaves the order and product blocks byte-identical", () => {
    const withOrder = contextBlocks(request(asked, ORDER_FACTS));
    const category = withOrder.split("\n\nVERIFIED CONTEXT — ORDER:")[0]!;

    // Everything after the new guidance block is exactly what it was before.
    expect(withOrder.slice(category.length + 2)).toBe(
      [
        "VERIFIED CONTEXT — ORDER:",
        "- order_number: 11-11111-11111",
        "- order_status: Dispatched",
        "- tracking_number: TRK-1",
        "- delivery_courier: Royal Mail",
        "",
        "VERIFIED CONTEXT — PRODUCT/SKU:",
        "- Marketplace listing reference: 168166397166 (this is a listing id, NOT a SKU and NOT a product name — do not describe the product from it)",
        "- sku: CRSF100GY",
        "- product_title: 100mm Metal Ceiling Rose",
      ].join("\n"),
    );
  });
});

describe("provenance for boolean SOT attributes", () => {
  const provenance = (reply: string, facts: VerifiedFact[]) =>
    validateDraftAccuracy({
      reply,
      facts,
      messages: [message("Are these bulbs dimmable?")],
      knowledgeAvailable: true,
    }).findings.filter((f) => f.issue === "specification_needs_confirmation");

  it("flags an answer taken from dimmable = N", () => {
    const found = provenance("No, this bulb is not dimmable and cannot be used with a dimmer switch.", BULB);

    expect(found).toHaveLength(1);
    expect(found[0]!.verifiedFact).toContain("dimmable = N");
  });

  it("flags an answer taken from table_lamp = Y", () => {
    const found = provenance("Yes, it can be used on a table lamp as well as a ceiling light.", LAMPSHADE);

    expect(found).toHaveLength(1);
    expect(found[0]!.verifiedFact).toContain("table_lamp = Y");
    expect(found[0]!.verifiedFact).toContain("ceiling_light = Y");
  });

  it("flags an answer taken from reducer_ring_included = Y", () => {
    const found = provenance("It comes with a reducer ring in the box.", [
      { name: "sku", value: "LSFT220BC" },
      { name: "reducer_ring_included", value: "Y" },
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]!.verifiedFact).toBe("reducer_ring_included = Y");
  });

  /**
   * "Please switch off the power before fitting" is a sentence these drafts
   * write constantly. `switch_included` must not attach itself to it.
   */
  it("does not attach a short subject to ordinary prose", () => {
    const found = provenance("Please switch off the power before fitting, and let the bulb cool.", [
      { name: "sku", value: "CRSF100GY" },
      { name: "switch_included", value: "N" },
      { name: "hook_included", value: "N" },
      { name: "led_only", value: "Y" },
    ]);

    expect(found).toEqual([]);
  });

  it("never reads Y or N as a word in the reply", () => {
    const found = provenance("Yes, your order is on its way.", [
      { name: "sku", value: "LSFT220BC" },
      { name: "reducer_ring_included", value: "Y" },
    ]);

    expect(found).toEqual([]);
  });

  it("stays minor, and still buys no regeneration", () => {
    const result = validateDraftAccuracy({
      reply: "No, this bulb is not dimmable.",
      facts: BULB,
      messages: [message("Are these bulbs dimmable?")],
      knowledgeAvailable: true,
    });

    expect(result.regenerationWarranted).toBe(false);
    expect(result.corrections).toEqual([]);
    expect(result.notes.some((note) => note.includes("Confirm before use"))).toBe(true);
  });
});
