import { describe, expect, it } from "vitest";

import { contextBlocks, verifiedBundleBlock } from "@/lib/ai/draft-assembly";
import type { DraftRequest } from "@/lib/ai/provider";
import type { BundleContext } from "@/lib/domain/bundle-context";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * The incomplete-bundle guidance, and the retraction it must never cause.
 *
 * THE THREAD THIS IS BUILT FROM IS REAL. A customer asked what the lampshade
 * comes with; the team answered "1 x metal lampshade and 1 x reducer plate",
 * which the order system's own decomposition confirms is right. Because the
 * reducer plate `RPR44WH` has no product record, the bundle resolved as
 * incomplete — and the draft opened by retracting the team's correct reply.
 *
 * The completeness gate was right. Only the wording was wrong.
 */

function message(text: string, direction: "inbound" | "outbound"): ConversationMessageView {
  return {
    id: direction === "inbound" ? "1" : "2",
    direction,
    sourceTimestamp: "2026-09-01 09:00:00",
    bodyText: text,
    bodyDecodeStatus: "decoded",
    attachments: [],
  } as unknown as ConversationMessageView;
}

const CUSTOMER_ASKED = message(
  "Could you let me know exactly what parts this lampshade comes with?",
  "inbound",
);

/** The team's own earlier answer, which the decomposition confirms is correct. */
const WE_ALREADY_ANSWERED = message(
  "This listing is for the lampshade only. It includes: 1 x metal lampshade, 1 x reducer plate.",
  "outbound",
);

/** Modelled on item 305682162344: one common component, no product record for it. */
const INCOMPLETE: BundleContext = {
  listingItemRef: "305682162344",
  variantCount: 50,
  common: [
    { sku: "RPR44WH", title: "Plastic Lamp Shade White Reducer Ring", attributes: [] },
  ],
  varyingAgreement: [
    { key: "fitting_type", value: "Easy Fit" },
    { key: "bulb_base_compat", value: "E26 / E27" },
    { key: "reducer_ring_included", value: "Y" },
  ],
  complete: false,
  componentsWithoutRecord: ["RPR44WH"],
};

const COMPLETE: BundleContext = {
  ...INCOMPLETE,
  common: [
    {
      sku: "RPR44WH",
      title: "Plastic Lamp Shade White Reducer Ring",
      attributes: [{ key: "material_primary", value: "Plastic" }],
    },
  ],
  complete: true,
  componentsWithoutRecord: [],
};

function request(messages: ConversationMessageView[], bundle: BundleContext | null): DraftRequest {
  return { messages, marketplace: "ebay", listingItemRef: "305682162344", facts: [], bundle };
}

/** Every phrasing the model actually produced, or would plausibly reach for. */
const RETRACTION_PHRASES = [
  "correction",
  "one correction",
  "to clarify my previous message",
  "ignore my previous message",
  "please disregard",
  "the previous information was incorrect",
  "do not rely on",
];

/* ------------------------------------------------------------------ */

describe("1. an earlier CST reply exists, and the bundle is incomplete", () => {
  const blocks = () => contextBlocks(request([CUSTOMER_ASKED, WE_ALREADY_ANSWERED], INCOMPLETE));

  it("tells the model the earlier reply stands and is authoritative", () => {
    const text = blocks();

    expect(text).toContain("WHAT THIS TEAM HAS ALREADY TOLD THIS CUSTOMER IN THIS THREAD STANDS");
    expect(text).toContain("treat them as authoritative and assume they were right");
  });

  it("forbids retracting, correcting or contradicting it", () => {
    const text = blocks();

    expect(text).toContain(
      "NEVER retract, correct, contradict, walk back, apologise for, or cast doubt on anything already sent",
    );
  });

  it.each(RETRACTION_PHRASES)("names %o as a phrase never to write", (phrase) => {
    expect(blocks().toLowerCase()).toContain(phrase.toLowerCase());
  });

  it("frames a thinner block as our gap, not their error", () => {
    const text = blocks();

    expect(text).toContain("that is a gap in THIS block, not an error in that reply");
    expect(text).toContain("Silence is correct; a public retraction is not");
  });

  it("still stops any NEW package-contents claim", () => {
    const text = blocks();

    expect(text).toContain("INCOMPLETE: RPR44WH has no verified product record");
    expect(text).toContain("Do not state, list or imply what the package contains");
    expect(text).toContain("do not describe the missing component");
  });

  it("says the limit is not itself news for the customer", () => {
    expect(blocks()).toContain("It is not a finding, not a discovery, and not something to tell the customer about");
  });
});

describe("2. an incomplete bundle with a new package question and no earlier reply", () => {
  const blocks = () => contextBlocks(request([CUSTOMER_ASKED], INCOMPLETE));

  it("still forbids unsupported package claims", () => {
    const text = blocks();

    expect(text).toContain("INCOMPLETE: RPR44WH has no verified product record");
    expect(text).toContain("Do not state, list or imply what the package contains");
    expect(text).toContain("do not present any component's own parts list as the bundle's");
  });

  /**
   * A first-contact thread has nothing to retract. Telling it not to retract a
   * message that does not exist is a sentence spent on nothing.
   */
  it("omits the retraction clause, which has nothing to protect", () => {
    const text = blocks();

    expect(text).not.toContain("WHAT THIS TEAM HAS ALREADY TOLD THIS CUSTOMER");
    expect(text).not.toContain("NEVER retract");
  });

  it("still leaves the verified facts available to answer from", () => {
    const text = blocks();

    expect(text).toContain("fitting_type: Easy Fit");
    expect(text).toContain("bulb_base_compat: E26 / E27");
    expect(text).toContain("reducer_ring_included: Y");
  });
});

describe("3. the existing safety behaviour is unchanged", () => {
  it("adds no incomplete guidance at all when the bundle is complete", () => {
    const text = contextBlocks(request([CUSTOMER_ASKED, WE_ALREADY_ANSWERED], COMPLETE));

    expect(text).toContain("you may say what the package contains");
    expect(text).not.toContain("INCOMPLETE:");
    expect(text).not.toContain("NEVER retract");
  });

  it("keeps the option and merge warnings on both complete and incomplete bundles", () => {
    for (const bundle of [INCOMPLETE, COMPLETE]) {
      const block = verifiedBundleBlock(bundle, true)!;
      expect(block).toContain("NEVER state or imply which option, colour or finish the customer has");
      expect(block).toContain("never merge them or apply one component's");
    }
  });

  it("omits the block entirely when there is no bundle", () => {
    expect(verifiedBundleBlock(null, true)).toBeNull();
    expect(contextBlocks(request([CUSTOMER_ASKED, WE_ALREADY_ANSWERED], null))).not.toContain(
      "VERIFIED CONTEXT — BUNDLE COMPONENTS:",
    );
  });

  it("defaults to the quieter block when the caller says nothing about replies", () => {
    expect(verifiedBundleBlock(INCOMPLETE)!).not.toContain("NEVER retract");
  });
});
