import { describe, expect, it } from "vitest";

import { contextBlocks, verifiedBundleBlock } from "@/lib/ai/draft-assembly";
import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import type { DraftRequest } from "@/lib/ai/provider";
import type { BundleContext } from "@/lib/domain/bundle-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * The bundle block, through the live prompt builder.
 *
 * Proves it lands where it should, says what it must, and — the part that
 * matters most — leaves every conversation that is not a bundle byte-identical.
 */

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

const ASKED = [message("What parts does this come with, and will it fit my fixture?")];

function request(facts: VerifiedFact[], bundle?: BundleContext | null): DraftRequest {
  return {
    messages: ASKED,
    marketplace: "ebay",
    listingItemRef: "168440651522",
    facts,
    ...(bundle === undefined ? {} : { bundle }),
  };
}

/** Modelled on the real listing: shared rose + holder, shade varies by colour. */
const INCOMPLETE: BundleContext = {
  listingItemRef: "168440651522",
  variantCount: 10,
  common: [
    {
      sku: "CRSF100CH",
      title: "Chrome Colour Vintage Ceiling Rose 100mm",
      attributes: [
        { key: "diameter_mm", value: "100" },
        { key: "material_primary", value: "Metal" },
        { key: "max_load_w", value: "60W" },
      ],
    },
    { sku: "PHCHPCRCH", title: "E27 Pendant Lamp Bulb Holder - Chrome", attributes: [] },
  ],
  varyingAgreement: [
    { key: "diameter_mm", value: "320" },
    { key: "ring_size_mm", value: "42" },
    { key: "reducer_ring_included", value: "Y" },
  ],
  complete: false,
  componentsWithoutRecord: ["PHCHPCRCH"],
};

const COMPLETE: BundleContext = {
  ...INCOMPLETE,
  common: [
    INCOMPLETE.common[0]!,
    {
      sku: "PHCHPCRCH",
      title: "E27 Pendant Lamp Bulb Holder - Chrome",
      attributes: [{ key: "bulb_base_type", value: "E27" }],
    },
  ],
  complete: true,
  componentsWithoutRecord: [],
};

describe("the bundle block in the prompt", () => {
  it("appears under its own VERIFIED heading, after the product block", () => {
    const blocks = contextBlocks(request([], INCOMPLETE));

    expect(blocks).toContain("VERIFIED CONTEXT — BUNDLE COMPONENTS:");
    expect(blocks.indexOf("VERIFIED CONTEXT — PRODUCT/SKU:")).toBeLessThan(
      blocks.indexOf("VERIFIED CONTEXT — BUNDLE COMPONENTS:"),
    );
  });

  it("keeps each component's attributes under its own SKU, unflattened", () => {
    const block = verifiedBundleBlock(INCOMPLETE)!;

    expect(block).toContain("- COMPONENT CRSF100CH — Chrome Colour Vintage Ceiling Rose 100mm");
    expect(block).toContain("    diameter_mm: 100");
    // The shade's diameter is 320 and sits in its own section. Both survive.
    expect(block).toContain("    diameter_mm: 320");
    expect(block).toContain("never merge them or apply one component's");
  });

  it("names a component that has no record instead of hiding it", () => {
    const block = verifiedBundleBlock(INCOMPLETE)!;

    expect(block).toContain("- COMPONENT PHCHPCRCH — E27 Pendant Lamp Bulb Holder - Chrome");
    expect(block).toContain("(no verified product record — state nothing about this component)");
  });

  it("forbids a package-contents claim when a component is undescribed", () => {
    const block = verifiedBundleBlock(INCOMPLETE)!;

    expect(block).toContain("INCOMPLETE: PHCHPCRCH has no verified product record");
    expect(block).toContain("Do not state, list or imply what the package contains");
    expect(block).toContain("do not present any component's own parts list as the bundle's");
  });

  it("permits it once every component is described", () => {
    const block = verifiedBundleBlock(COMPLETE)!;

    expect(block).toContain("you may say what the package contains");
    expect(block).not.toContain("INCOMPLETE:");
  });

  it("forbids attributing an option to the customer", () => {
    const block = verifiedBundleBlock(INCOMPLETE)!;

    expect(block).toContain("NEVER state or imply which option, colour or finish the customer has");
    expect(block).toContain("Anything the options differ on has been left out deliberately");
  });

  it("keeps the order block untouched — no order is still no order", () => {
    const blocks = contextBlocks(request([], INCOMPLETE));
    const orderHalf = blocks.split("VERIFIED CONTEXT — PRODUCT/SKU:")[0]!;

    expect(orderHalf).toContain("no order has been resolved and verified");
    expect(orderHalf).not.toContain("COMPONENT");
  });
});

describe("conversations that are not bundles", () => {
  it("omits the block entirely when there is no bundle", () => {
    expect(verifiedBundleBlock(null)).toBeNull();
    expect(verifiedBundleBlock(undefined)).toBeNull();
  });

  it("leaves the prompt byte-identical when the field is absent", () => {
    expect(contextBlocks(request([], null))).toBe(contextBlocks(request([])));
  });

  /** A listing that resolved to one product never reaches the bundle path. */
  it("leaves a single-SKU pre-sale draft byte-identical", () => {
    const sotFacts: VerifiedFact[] = [
      { name: "sku", value: "LSFT220BC" },
      { name: "diameter_mm", value: "220" },
      { name: "fitting_type", value: "Easy Fit" },
    ];

    expect(contextBlocks(request(sotFacts, null))).toBe(contextBlocks(request(sotFacts)));
    expect(contextBlocks(request(sotFacts))).not.toContain("VERIFIED CONTEXT — BUNDLE COMPONENTS:");
  });

  it("leaves a post-sale draft byte-identical", () => {
    const orderFacts: VerifiedFact[] = [
      { name: "order_number", value: "11-11111-11111" },
      { name: "order_status", value: "Dispatched" },
      { name: "sku", value: "CRSF100GY" },
      { name: "product_title", value: "100mm Metal Ceiling Rose" },
    ];

    expect(contextBlocks(request(orderFacts, null))).toBe(contextBlocks(request(orderFacts)));
    expect(contextBlocks(request(orderFacts))).not.toContain("VERIFIED CONTEXT — BUNDLE COMPONENTS:");
  });
});

/**
 * The gap this closed, found by running a real conversation rather than by
 * reading the code: the "answer before asking" rule was gated on product facts,
 * and a bundle listing has none — its components travel in their own block. So
 * the listings the bundle resolver exists to serve were the only ones getting no
 * guidance, and the live draft duly asked a lampshade buyer for their voltage.
 */
describe("the usage rule reaches bundle-only conversations", () => {
  const PASSIVE_BUNDLE: BundleContext = {
    ...INCOMPLETE,
    varyingAgreement: [
      ...INCOMPLETE.varyingAgreement,
      { key: "req_electrician", value: "N" },
      { key: "cap_elec_req", value: "N" },
    ],
  };

  it("states the answer-first rule when the only facts are a bundle's", () => {
    const blocks = contextBlocks(request([], INCOMPLETE));

    expect(blocks).toContain("USING THE VERIFIED PRODUCT INFORMATION YOU HAVE BEEN GIVEN");
    expect(blocks).toContain("answer it directly");
  });

  it("forbids the voltage and wattage ask when the bundle says the product is passive", () => {
    const blocks = contextBlocks(request([], PASSIVE_BUNDLE));

    expect(blocks).toContain("This product needs no electrical installation");
    expect(blocks).toContain("Do NOT ask this customer for voltage, wattage");
  });

  it("leaves the compatibility rules alone for a bundle with no passive flag", () => {
    const blocks = contextBlocks(request([], INCOMPLETE));
    expect(blocks).not.toContain("This product needs no electrical installation");
  });

  it("still adds nothing when there is neither a bundle nor product facts", () => {
    expect(contextBlocks(request([], null))).not.toContain("USING THE VERIFIED PRODUCT INFORMATION");
  });
});

describe("provenance covers bundle attributes", () => {
  const provenance = (reply: string, bundle: BundleContext | null) =>
    validateDraftAccuracy({
      reply,
      facts: [],
      messages: ASKED,
      knowledgeAvailable: true,
      bundle,
    }).findings.filter((f) => f.issue === "specification_needs_confirmation");

  it("flags a reply quoting a common component's specification", () => {
    const found = provenance("The ceiling rose is 100 mm across and rated to 60W.", INCOMPLETE);

    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("minor");
    expect(found[0]!.verifiedFact).toContain("diameter_mm = 100");
  });

  it("flags a reply quoting an agreed varying attribute", () => {
    const found = provenance("The shade has a 42 mm ring and includes a reducer ring.", INCOMPLETE);

    expect(found).toHaveLength(1);
    expect(found[0]!.verifiedFact).toContain("ring_size_mm = 42");
  });

  it("stays silent when nothing from the bundle was quoted", () => {
    expect(provenance("Thanks for your message — I'll look into that today.", INCOMPLETE)).toEqual([]);
  });

  it("stays silent when there is no bundle", () => {
    expect(provenance("The ceiling rose is 100 mm across.", null)).toEqual([]);
  });
});
