import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDraftInput, validateDraft } from "@/lib/ai/draft-assembly";
import type { DraftRequest } from "@/lib/ai/provider";
import type { BundleContext } from "@/lib/domain/bundle-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";

/**
 * The catalogue of the PURCHASED product, from the prompt to the audit trail.
 *
 * Two halves, and both were broken by the same omission.
 *
 *   what the model sees   the ordered SKU's components must reach the OpenAI
 *                         input, under the product headings and never under
 *                         ORDER.
 *   what the record says  a citation naming one of those attributes must
 *                         survive validation and be stored. Measured before
 *                         this fix: across all 441 generated revisions in the
 *                         live store, 440 recorded a CST document and NOT ONE
 *                         recorded a product-sheet attribute — on a system
 *                         whose product answers come from the product sheet.
 *                         The provenance was being dropped at exactly the point
 *                         it was meant to be captured.
 */

const ROOT = join(__dirname, "..", "..");

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

const ASKED = [message("What is meant to be in the box, and what fitting does it take?")];

/** The order resolved, so these are the facts the order contributed. */
const ORDER_FACTS: VerifiedFact[] = [
  { name: "order_number", value: "99-99999-99999" },
  { name: "order_status", value: "Dispatched" },
  { name: "sku", value: "ENC693" },
  { name: "product_title", value: "Pendant Light Set" },
];

/** What `resolveBundleProductContextForSku` returns for that ordered SKU. */
const PURCHASED: BundleContext = {
  listingItemRef: null,
  orderedSku: "ENC693",
  variantCount: 1,
  common: [
    {
      sku: "CRFF500BM",
      title: "500mm Flush Ceiling Plate",
      attributes: [
        { key: "diameter_mm", value: "500" },
        { key: "material_primary", value: "Metal" },
        { key: "parts_list", value: "Ceiling plate; Backplate; Fixings" },
      ],
    },
    {
      sku: "PHCH1BMRBM",
      title: "Pendant Holder",
      attributes: [{ key: "fitting_type", value: "Side Fitting" }],
    },
  ],
  varyingAgreement: [],
  complete: true,
  componentsWithoutRecord: [],
};

function request(bundle?: BundleContext | null, facts: VerifiedFact[] = ORDER_FACTS): DraftRequest {
  return {
    messages: ASKED,
    marketplace: "ebay",
    listingItemRef: "267187442474",
    facts,
    ...(bundle === undefined ? {} : { bundle }),
  };
}

/** A model response citing one CST rule and one verified fact. */
function replyCiting(ref: string, kind: "verified_fact" | "cst_document" = "verified_fact") {
  return JSON.stringify({
    draft_reply: "The set includes the ceiling plate, backplate and fixings.",
    sources_used: [
      { kind: "cst_document", ref: "PRE-P26-5", label: "Pre-sales" },
      { kind, ref, label: ref },
    ],
    missing_information: [],
    requires_review: false,
  });
}

const factRefs = (result: ReturnType<typeof validateDraft>) =>
  result.result.sources_used.filter((s) => s.kind === "verified_fact").map((s) => s.ref);

/* ------------------------------------------------------------------ */

describe("the purchased product's catalogue reaches the OpenAI input", () => {
  const input = buildDraftInput(request(PURCHASED));

  it("carries every ordered component's attributes", () => {
    expect(input).toContain("VERIFIED CONTEXT — BUNDLE COMPONENTS");
    expect(input).toContain("COMPONENT CRFF500BM");
    expect(input).toContain("diameter_mm: 500");
    expect(input).toContain("fitting_type: Side Fitting");
  });

  it("states the package contents, because every ordered component is described", () => {
    expect(input).toContain("parts_list: Ceiling plate; Backplate; Fixings");
    expect(input).toContain("you may say what the package contains");
  });

  it("puts them in the product half, never under the ORDER heading", () => {
    const orderBlock = input.slice(
      input.indexOf("VERIFIED CONTEXT — ORDER:"),
      input.indexOf("VERIFIED CONTEXT — PRODUCT/SKU:"),
    );
    for (const value of ["diameter_mm", "parts_list", "fitting_type"]) {
      expect(orderBlock, `${value} must not be presented as an order fact`).not.toContain(value);
    }
  });

  it("switches on the answer-first rule, so the model uses them before asking", () => {
    expect(input).toContain("USING THE VERIFIED PRODUCT INFORMATION YOU HAVE BEEN GIVEN");
  });

  it("leaves a conversation with no bundle byte-identical", () => {
    expect(buildDraftInput(request(null))).toBe(buildDraftInput(request()));
  });
});

describe("a suppressed attribute never reaches the model, and so never becomes a source", () => {
  const INCOMPLETE: BundleContext = {
    ...PURCHASED,
    common: [
      // parts_list already removed by the resolver, because a component below
      // has no record. This is the state the prompt builder receives.
      {
        ...PURCHASED.common[0]!,
        attributes: PURCHASED.common[0]!.attributes.filter((a) => a.key !== "parts_list"),
      },
      { sku: "LDMST64E274", title: null, attributes: [] },
    ],
    complete: false,
    componentsWithoutRecord: ["LDMST64E274"],
  };

  it("is absent from the input", () => {
    const input = buildDraftInput(request(INCOMPLETE));
    expect(input).not.toContain("parts_list");
    expect(input).toContain("do NOT know the full package contents");
  });

  it("is rejected as a citation, because it was never supplied", () => {
    const result = validateDraft(replyCiting("parts_list"), request(INCOMPLETE), undefined);
    expect(factRefs(result)).toEqual([]);
  });
});

describe("source tracking corresponds to what was actually supplied", () => {
  it("keeps a citation naming an attribute from the bundle block", () => {
    const result = validateDraft(replyCiting("parts_list"), request(PURCHASED), undefined);
    expect(factRefs(result)).toEqual(["parts_list"]);
  });

  it("keeps one naming an attribute of a second component", () => {
    const result = validateDraft(replyCiting("fitting_type"), request(PURCHASED), undefined);
    expect(factRefs(result)).toEqual(["fitting_type"]);
  });

  it("keeps a citation naming an ordinary verified fact, as before", () => {
    const result = validateDraft(replyCiting("order_status"), request(PURCHASED), undefined);
    expect(factRefs(result)).toEqual(["order_status"]);
  });

  it("still drops a fact name the model invented", () => {
    const result = validateDraft(replyCiting("tensile_strength_mpa"), request(PURCHASED), undefined);
    expect(factRefs(result)).toEqual([]);
  });

  it("still drops a bundle attribute name on a request that had no bundle", () => {
    const result = validateDraft(replyCiting("parts_list"), request(null), undefined);
    expect(factRefs(result)).toEqual([]);
  });

  it("admits an attribute the variants agreed on, on the listing-keyed path", () => {
    const listingKeyed: BundleContext = {
      listingItemRef: "168440651522",
      orderedSku: null,
      variantCount: 8,
      common: [{ sku: "CRSF100CH", title: null, attributes: [] }],
      varyingAgreement: [{ key: "ring_size_mm", value: "42" }],
      complete: false,
      componentsWithoutRecord: ["CRSF100CH"],
    };
    const result = validateDraft(replyCiting("ring_size_mm"), request(listingKeyed), undefined);
    expect(factRefs(result)).toEqual(["ring_size_mm"]);
  });

  it("does not touch how CST document citations are checked", () => {
    const result = validateDraft(
      replyCiting("RETREF-GFR-9", "cst_document"),
      request(PURCHASED),
      new Set(["PRE-P26-5"]),
    );
    expect(result.result.sources_used.map((s) => s.ref)).toEqual(["PRE-P26-5"]);
  });

  /**
   * A bundle attribute may be RECORDED as a source. It may not GROUND a refund,
   * tracking or delivery claim — that remains `request.facts` alone, and the
   * widening above must not have leaked into it.
   */
  it("does not let a bundle attribute ground a prohibited claim", () => {
    const bundle: BundleContext = {
      ...PURCHASED,
      common: [
        {
          sku: "CRFF500BM",
          title: null,
          attributes: [{ key: "diameter_mm", value: "500" }],
        },
      ],
    };
    const result = validateDraft(
      JSON.stringify({
        draft_reply: "We have processed your refund today.",
        sources_used: [{ kind: "verified_fact", ref: "diameter_mm", label: "d" }],
        missing_information: [],
        requires_review: false,
      }),
      request(bundle, []),
      undefined,
    );
    expect(result.requiresReview).toBe(true);
  });
});

/**
 * The composition rules live in `verifiedFactsFor`, which is module-private to
 * the route. Asserted against source, matching how the rest of this suite
 * guards route-level behaviour.
 */
describe("the draft route reads the catalogue against the purchased product", () => {
  const route = readFileSync(
    join(ROOT, "app", "api", "conversations", "[conversationId]", "draft", "route.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  it("tries the exact-SKU catalogue lookup first, unchanged", () => {
    expect(route).toContain("resolveSotProductContextForSku(sourcePool, purchasedSku)");
    expect(route).toContain("if (productFacts.length === 0)");
  });

  it("falls back to the ordered SKU's own components, not the listing's variants", () => {
    expect(route).toContain("resolveBundleProductContextForSku(sourcePool, purchasedSku)");
  });

  it("keeps the listing-keyed path for a conversation with no purchased SKU", () => {
    expect(route).toContain("resolveBundleProductContext(sourcePool, conversation)");
    expect(route).toContain("purchasedSku === null");
  });

  it("adds no further try/catch: every lookup is still guarded separately", () => {
    expect(
      route.match(/console\.error\("\[draft\] [a-z ]+ (context |order |selection )?resolution failed/g),
    ).toHaveLength(7);
  });

  it("still writes nothing of its own and still cannot send", () => {
    for (const forbidden of ["sendMessage", "transmit", "DELETE FROM", "INSERT INTO"]) {
      expect(route).not.toContain(forbidden);
    }
  });
});
