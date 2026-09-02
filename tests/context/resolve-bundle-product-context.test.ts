import { describe, expect, it } from "vitest";

import { resolveBundleProductContext } from "@/lib/context/resolve-bundle-product-context";
import type { Queryable as SourceQueryable } from "@/lib/repositories/bundle-repository";

/**
 * The bundle resolver's safety rules.
 *
 * Every fixture below mirrors the shape of the real listing that motivated this
 * work: two components shared by every option, one that changes with the option,
 * and a shared component with no product record.
 */

type Row = Record<string, unknown>;

/**
 * Answers the four statements by the table each names, so a test cannot pass
 * because the queries happened to be issued in the order it assumed.
 */
function fakeClient(input: {
  variants?: string[];
  decompositions?: { variant: string; line: string; component: string }[];
  attributes?: { sku: string; key: string; value: string | null }[];
  titles?: { sku: string; title: string }[];
}) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      const rows: Row[] = config.text.includes("listings.ebay_listings")
        ? (input.variants ?? []).map((sku) => ({ sku }))
        : config.text.includes("order_management.order_combo")
          ? (input.decompositions ?? []).map((d) => ({
              variant_sku: d.variant,
              line_id: d.line,
              component_sku: d.component,
            }))
          : config.text.includes("configurator.components_sot_skus")
            ? (input.attributes ?? []).map((a) => ({
                sku: a.sku,
                attribute_key: a.key,
                value: a.value,
              }))
            : config.text.includes("inventory.products")
              ? (input.titles ?? [])
              : [];
      return { rows };
    },
  };
  return { calls, client };
}

const conversation = { marketplace: "ebay", subSourceId: 1, listingItemRef: "168440651522" };

const GREY = "CRSF100CH+PHCHPCRCH+LSMS320GY";
const RED = "CRSF100CH+PHCHPCRCH+LSMS320RE";

/** Two options sharing a rose and a holder, differing only in the shade. */
const TWO_OPTIONS = [
  { variant: GREY, line: "1", component: "CRSF100CH" },
  { variant: GREY, line: "1", component: "PHCHPCRCH" },
  { variant: GREY, line: "1", component: "LSMS320GY" },
  { variant: RED, line: "2", component: "CRSF100CH" },
  { variant: RED, line: "2", component: "PHCHPCRCH" },
  { variant: RED, line: "2", component: "LSMS320RE" },
];

/** Shades that agree on every dimension and differ only in colour. */
const SHADE_ATTRIBUTES = [
  { sku: "LSMS320GY", key: "diameter_mm", value: "320" },
  { sku: "LSMS320GY", key: "ring_size_mm", value: "42" },
  { sku: "LSMS320GY", key: "outer_colour", value: "Grey" },
  { sku: "LSMS320RE", key: "diameter_mm", value: "320" },
  { sku: "LSMS320RE", key: "ring_size_mm", value: "42" },
  { sku: "LSMS320RE", key: "outer_colour", value: "Red" },
];

const ROSE_ATTRIBUTES = [
  { sku: "CRSF100CH", key: "diameter_mm", value: "100" },
  { sku: "CRSF100CH", key: "material_primary", value: "Metal" },
  { sku: "CRSF100CH", key: "parts_list", value: "Ceiling rose; Backplate; Cord grip" },
];

describe("a stable bundle", () => {
  const complete = {
    variants: [GREY, RED],
    decompositions: TWO_OPTIONS,
    attributes: [
      ...ROSE_ATTRIBUTES,
      ...SHADE_ATTRIBUTES,
      { sku: "PHCHPCRCH", key: "bulb_base_type", value: "E27" },
    ],
    titles: [{ sku: "CRSF100CH", title: "Chrome Ceiling Rose" }],
  };

  it("resolves, naming only the components shared by every option", async () => {
    const { client } = fakeClient(complete);
    const bundle = (await resolveBundleProductContext(client, conversation))!;

    expect(bundle.variantCount).toBe(2);
    expect(bundle.common.map((c) => c.sku)).toEqual(["CRSF100CH", "PHCHPCRCH"]);
    expect(bundle.listingItemRef).toBe("168440651522");
  });

  it("keeps each component's attributes in its own block, never merged", async () => {
    const { client } = fakeClient(complete);
    const bundle = (await resolveBundleProductContext(client, conversation))!;

    const rose = bundle.common.find((c) => c.sku === "CRSF100CH")!;
    expect(rose.title).toBe("Chrome Ceiling Rose");
    expect(rose.attributes).toContainEqual({ key: "diameter_mm", value: "100" });

    // The shade's diameter is 320. Both exist; neither overwrote the other.
    expect(bundle.varyingAgreement).toContainEqual({ key: "diameter_mm", value: "320" });
  });

  it("emits only what every option agrees on, so colour is dropped", async () => {
    const { client } = fakeClient(complete);
    const bundle = (await resolveBundleProductContext(client, conversation))!;

    const keys = bundle.varyingAgreement.map((a) => a.key);
    expect(keys).toContain("diameter_mm");
    expect(keys).toContain("ring_size_mm");
    expect(keys).not.toContain("outer_colour");
  });

  it("is marked complete when every component has a record", async () => {
    const { client } = fakeClient(complete);
    const bundle = (await resolveBundleProductContext(client, conversation))!;

    expect(bundle.complete).toBe(true);
    expect(bundle.componentsWithoutRecord).toEqual([]);
    const rose = bundle.common.find((c) => c.sku === "CRSF100CH")!;
    expect(rose.attributes.map((a) => a.key)).toContain("parts_list");
  });
});

describe("an unstable bundle", () => {
  it("drops a variant whose history disagrees with itself", async () => {
    const { client } = fakeClient({
      variants: [GREY, RED],
      decompositions: [
        ...TWO_OPTIONS,
        // The same variant, a different order, a different component set.
        { variant: GREY, line: "9", component: "CRSF100CH" },
        { variant: GREY, line: "9", component: "SOMETHING-ELSE" },
      ],
      attributes: [...ROSE_ATTRIBUTES, ...SHADE_ATTRIBUTES],
    });

    const bundle = (await resolveBundleProductContext(client, conversation))!;

    // Only the red option survived, so nothing "varies" and the shade's own
    // attributes are common to the single remaining option.
    expect(bundle.variantCount).toBe(1);
    expect(bundle.common.map((c) => c.sku)).toEqual(["CRSF100CH", "LSMS320RE", "PHCHPCRCH"]);
  });

  it("returns null when every variant's history disagrees", async () => {
    const { client } = fakeClient({
      variants: [GREY],
      decompositions: [
        { variant: GREY, line: "1", component: "CRSF100CH" },
        { variant: GREY, line: "2", component: "SOMETHING-ELSE" },
      ],
      attributes: ROSE_ATTRIBUTES,
    });

    expect(await resolveBundleProductContext(client, conversation)).toBeNull();
  });
});

describe("completeness", () => {
  const missingRecord = {
    variants: [GREY, RED],
    decompositions: TWO_OPTIONS,
    // PHCHPCRCH has no attributes at all — no product record.
    attributes: [...ROSE_ATTRIBUTES, ...SHADE_ATTRIBUTES],
    titles: [{ sku: "PHCHPCRCH", title: "E27 Pendant Lamp Bulb Holder" }],
  };

  it("marks the bundle incomplete and names the gap", async () => {
    const { client } = fakeClient(missingRecord);
    const bundle = (await resolveBundleProductContext(client, conversation))!;

    expect(bundle.complete).toBe(false);
    expect(bundle.componentsWithoutRecord).toEqual(["PHCHPCRCH"]);
  });

  it("suppresses every included-contents attribute across the whole bundle", async () => {
    const { client } = fakeClient(missingRecord);
    const bundle = (await resolveBundleProductContext(client, conversation))!;

    const rose = bundle.common.find((c) => c.sku === "CRSF100CH")!;
    expect(rose.attributes.map((a) => a.key)).not.toContain("parts_list");
    // The rose's other facts survive: only the contents claim is unsafe.
    expect(rose.attributes.map((a) => a.key)).toContain("diameter_mm");
  });

  it("still names the component that has no record, so the gap is visible", async () => {
    const { client } = fakeClient(missingRecord);
    const bundle = (await resolveBundleProductContext(client, conversation))!;

    const holder = bundle.common.find((c) => c.sku === "PHCHPCRCH")!;
    expect(holder.attributes).toEqual([]);
    expect(holder.title).toBe("E27 Pendant Lamp Bulb Holder");
  });

  it("suppresses a varying component's parts_list too", async () => {
    const { client } = fakeClient({
      ...missingRecord,
      attributes: [
        ...ROSE_ATTRIBUTES,
        { sku: "LSMS320GY", key: "parts_list", value: "Lampshade, Reducer Ring" },
        { sku: "LSMS320RE", key: "parts_list", value: "Lampshade, Reducer Ring" },
      ],
    });
    const bundle = (await resolveBundleProductContext(client, conversation))!;

    expect(bundle.varyingAgreement.map((a) => a.key)).not.toContain("parts_list");
  });
});

describe("variant agreement edge cases", () => {
  it("drops a key when one option's varying part disagrees with itself", async () => {
    // A "with bulb" option: its varying part is a shade AND a bulb, and both
    // define product_type differently.
    const WITH_BULB = "ENC8740";
    const { client } = fakeClient({
      variants: [GREY, WITH_BULB],
      decompositions: [
        { variant: GREY, line: "1", component: "CRSF100CH" },
        { variant: GREY, line: "1", component: "LSMS320GY" },
        { variant: WITH_BULB, line: "2", component: "CRSF100CH" },
        { variant: WITH_BULB, line: "2", component: "LSMS320GY" },
        { variant: WITH_BULB, line: "2", component: "LDMST64E274" },
      ],
      attributes: [
        ...ROSE_ATTRIBUTES,
        { sku: "LSMS320GY", key: "product_type", value: "Lighting Accessory" },
        { sku: "LSMS320GY", key: "ring_size_mm", value: "42" },
        { sku: "LDMST64E274", key: "product_type", value: "Bulb" },
      ],
    });

    const bundle = (await resolveBundleProductContext(client, conversation))!;
    const keys = bundle.varyingAgreement.map((a) => a.key);

    expect(keys).not.toContain("product_type");
    // ring_size_mm is defined by only one option, so it cannot be claimed of both.
    expect(keys).not.toContain("ring_size_mm");
  });

  it("drops a key absent from one option", async () => {
    const { client } = fakeClient({
      variants: [GREY, RED],
      decompositions: TWO_OPTIONS,
      attributes: [
        ...ROSE_ATTRIBUTES,
        { sku: "LSMS320GY", key: "diameter_mm", value: "320" },
        { sku: "LSMS320GY", key: "shade_shape", value: "Temple Dome" },
        { sku: "LSMS320RE", key: "diameter_mm", value: "320" },
      ],
    });

    const bundle = (await resolveBundleProductContext(client, conversation))!;
    const keys = bundle.varyingAgreement.map((a) => a.key);

    expect(keys).toContain("diameter_mm");
    expect(keys).not.toContain("shade_shape");
  });

  it("rejects [VERIFY] and empty values like the single-SKU resolver", async () => {
    const { client } = fakeClient({
      variants: [GREY, RED],
      decompositions: TWO_OPTIONS,
      attributes: [
        { sku: "CRSF100CH", key: "diameter_mm", value: "100" },
        { sku: "CRSF100CH", key: "height_mm", value: "[VERIFY]" },
        { sku: "CRSF100CH", key: "material_primary", value: "   " },
      ],
    });

    const bundle = (await resolveBundleProductContext(client, conversation))!;
    const rose = bundle.common.find((c) => c.sku === "CRSF100CH")!;

    expect(rose.attributes.map((a) => a.key)).toEqual(["diameter_mm"]);
  });
});

describe("scope", () => {
  it.each(["amazon", "shopify", "temu", "bandq"])("returns null for %s and queries nothing", async (marketplace) => {
    const { calls, client } = fakeClient({ variants: [GREY], decompositions: TWO_OPTIONS });
    expect(await resolveBundleProductContext(client, { ...conversation, marketplace })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["no sub-account", { subSourceId: null }],
    ["no listing reference", { listingItemRef: null }],
    ["a blank listing reference", { listingItemRef: "  " }],
  ])("returns null and queries nothing for %s", async (_label, overrides) => {
    const { calls, client } = fakeClient({ variants: [GREY], decompositions: TWO_OPTIONS });
    expect(await resolveBundleProductContext(client, { ...conversation, ...overrides })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null for a listing with no child rows", async () => {
    const { client } = fakeClient({ variants: [] });
    expect(await resolveBundleProductContext(client, conversation)).toBeNull();
  });

  it("returns null when no variant has ever been sold", async () => {
    const { client } = fakeClient({ variants: [GREY], decompositions: [] });
    expect(await resolveBundleProductContext(client, conversation)).toBeNull();
  });

  it("returns null when no component has a product record", async () => {
    const { client } = fakeClient({ variants: [GREY, RED], decompositions: TWO_OPTIONS, attributes: [] });
    expect(await resolveBundleProductContext(client, conversation)).toBeNull();
  });
});
