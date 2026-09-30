import { describe, expect, it } from "vitest";

import {
  resolveBundleProductContext,
  resolveBundleProductContextForSku,
} from "@/lib/context/resolve-bundle-product-context";
import type { Queryable as SourceQueryable } from "@/lib/repositories/bundle-repository";

/**
 * Resolving the catalogue from the SKU THE CUSTOMER BOUGHT.
 *
 * THE FAILURE THIS FIXES, traced on a live conversation. The order named an
 * opaque sellable SKU with no product-sheet row of its own. `order_combo` held
 * its decomposition — stably, across twenty order lines — into four components,
 * every one of which had a full sheet record. Nothing read it: the exact-SKU
 * lookup found no sheet row and the fallback went back to the LISTING, whose
 * three variants included a component with no record. `complete` therefore came
 * out false and `parts_list` was suppressed, on a customer asking what was in
 * their box, over a gap in a variant they had not bought.
 *
 * The fixtures below are that shape. Component SKUs are catalogue identifiers,
 * not customer data; no order number, buyer or message text appears anywhere.
 */

type Row = Record<string, unknown>;

/** The traced ordered SKU: opaque, and absent from the product sheet. */
const ORDERED = "ENC693";

/** What `order_combo` recorded for it. Four components, all described. */
const COMPONENTS = ["CRFF500BM", "LDMST64E274", "LSCY210BM", "PHCH1BMRBM"];

/**
 * Answers each statement by the table it names, so a test cannot pass because
 * the queries happened to be issued in the order it assumed. Mirrors the fake
 * in `resolve-bundle-product-context.test.ts`.
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

/** The same four components on every one of three order lines. */
const STABLE = [1, 2, 3].flatMap((line) =>
  COMPONENTS.map((component) => ({ variant: ORDERED, line: String(line), component })),
);

const DESCRIBED = [
  { sku: "CRFF500BM", key: "diameter_mm", value: "500" },
  { sku: "CRFF500BM", key: "material_primary", value: "Metal" },
  { sku: "CRFF500BM", key: "parts_list", value: "Ceiling plate; Backplate; Fixings" },
  { sku: "LDMST64E274", key: "bulb_base_type", value: "E27" },
  { sku: "LSCY210BM", key: "diameter_mm", value: "210" },
  { sku: "LSCY210BM", key: "shade_ring_thread", value: "E27" },
  { sku: "PHCH1BMRBM", key: "fitting_type", value: "Side Fitting" },
];

const COMPLETE = { decompositions: STABLE, attributes: DESCRIBED };

/* ------------------------------------------------------------------ */

describe("the ENC693 shape: an ordered SKU with no sheet row of its own", () => {
  it("resolves the catalogue from its recorded components", async () => {
    const { client } = fakeClient(COMPLETE);
    const bundle = (await resolveBundleProductContextForSku(client, ORDERED))!;

    expect(bundle).not.toBeNull();
    expect(bundle.common.map((component) => component.sku)).toEqual([...COMPONENTS].sort());
  });

  it("names the ordered SKU as the provenance, and no listing", async () => {
    const { client } = fakeClient(COMPLETE);
    const bundle = (await resolveBundleProductContextForSku(client, ORDERED))!;

    expect(bundle.orderedSku).toBe(ORDERED);
    expect(bundle.listingItemRef).toBeNull();
  });

  it("never asks the listing table anything", async () => {
    const { calls, client } = fakeClient(COMPLETE);
    await resolveBundleProductContextForSku(client, ORDERED);

    expect(calls.some((call) => call.text.includes("listings.ebay_listings"))).toBe(false);
  });

  it("is one product, so there is nothing to intersect away", async () => {
    const { client } = fakeClient(COMPLETE);
    const bundle = (await resolveBundleProductContextForSku(client, ORDERED))!;

    expect(bundle.variantCount).toBe(1);
    expect(bundle.varyingAgreement).toEqual([]);
  });

  it("keeps each component's attributes in its own block, never merged", async () => {
    const { client } = fakeClient(COMPLETE);
    const bundle = (await resolveBundleProductContextForSku(client, ORDERED))!;

    const plate = bundle.common.find((component) => component.sku === "CRFF500BM")!;
    const shade = bundle.common.find((component) => component.sku === "LSCY210BM")!;

    // Both carry diameter_mm with different values. Neither overwrote the other.
    expect(plate.attributes).toContainEqual({ key: "diameter_mm", value: "500" });
    expect(shade.attributes).toContainEqual({ key: "diameter_mm", value: "210" });
  });
});

describe("completeness is computed over the PURCHASED components", () => {
  it("permits the parts list when every ordered component is described", async () => {
    const { client } = fakeClient(COMPLETE);
    const bundle = (await resolveBundleProductContextForSku(client, ORDERED))!;

    expect(bundle.complete).toBe(true);
    expect(bundle.componentsWithoutRecord).toEqual([]);
    const plate = bundle.common.find((component) => component.sku === "CRFF500BM")!;
    expect(plate.attributes.map((attribute) => attribute.key)).toContain("parts_list");
  });

  /**
   * THE HEART OF THE BUG. Under the old listing-keyed path this same purchase
   * lost its parts list because ANOTHER variant of the listing carried an
   * undescribed component. The two assertions here are the before and the after,
   * on identical component records.
   */
  it("is not dragged down by a component of a variant the customer did not buy", async () => {
    const OTHER = "LSCY210RE";
    const listingKeyed = fakeClient({
      variants: [ORDERED, "ENC694"],
      decompositions: [
        ...COMPONENTS.map((component) => ({ variant: ORDERED, line: "1", component })),
        // The other option swaps the shade for one with no product record.
        ...["CRFF500BM", "LDMST64E274", OTHER, "PHCH1BMRBM"].map((component) => ({
          variant: "ENC694",
          line: "2",
          component,
        })),
      ],
      attributes: DESCRIBED,
    });
    const fromListing = (await resolveBundleProductContext(listingKeyed.client, {
      marketplace: "ebay",
      subSourceId: 1,
      listingItemRef: "165261757862",
    }))!;

    expect(fromListing.complete).toBe(false);
    expect(fromListing.componentsWithoutRecord).toContain(OTHER);
    for (const component of fromListing.common) {
      expect(component.attributes.map((attribute) => attribute.key)).not.toContain("parts_list");
    }

    // The same purchase, resolved from the order's own SKU.
    const { client } = fakeClient(COMPLETE);
    const fromOrder = (await resolveBundleProductContextForSku(client, ORDERED))!;
    expect(fromOrder.complete).toBe(true);
    expect(
      fromOrder.common.flatMap((component) => component.attributes.map((a) => a.key)),
    ).toContain("parts_list");
  });

  it("still suppresses the parts list when an ORDERED component has no record", async () => {
    const { client } = fakeClient({
      decompositions: STABLE,
      // PHCH1BMRBM described nowhere.
      attributes: DESCRIBED.filter((attribute) => attribute.sku !== "PHCH1BMRBM"),
    });
    const bundle = (await resolveBundleProductContextForSku(client, ORDERED))!;

    expect(bundle.complete).toBe(false);
    expect(bundle.componentsWithoutRecord).toEqual(["PHCH1BMRBM"]);
    for (const component of bundle.common) {
      expect(component.attributes.map((attribute) => attribute.key)).not.toContain("parts_list");
    }
    // The dimensions survive: only what is IN THE BOX is withheld.
    const plate = bundle.common.find((component) => component.sku === "CRFF500BM")!;
    expect(plate.attributes).toContainEqual({ key: "diameter_mm", value: "500" });
  });
});

describe("it refuses rather than guesses", () => {
  it("returns nothing when the SKU has no recorded decomposition", async () => {
    const { client } = fakeClient({ decompositions: [] });
    expect(await resolveBundleProductContextForSku(client, ORDERED)).toBeNull();
  });

  it("returns nothing when the decomposition disagrees with itself across lines", async () => {
    const { client } = fakeClient({
      decompositions: [
        ...COMPONENTS.map((component) => ({ variant: ORDERED, line: "1", component })),
        // The same SKU, picked a different way on another order.
        ...["CRFF500BM", "LSCY210BM"].map((component) => ({
          variant: ORDERED,
          line: "2",
          component,
        })),
      ],
      attributes: DESCRIBED,
    });
    expect(await resolveBundleProductContextForSku(client, ORDERED)).toBeNull();
  });

  it("returns nothing when no ordered component has a product record", async () => {
    const { client } = fakeClient({ decompositions: STABLE, attributes: [] });
    expect(await resolveBundleProductContextForSku(client, ORDERED)).toBeNull();
  });

  it.each([["", "empty"], ["   ", "whitespace"]])(
    "issues no query at all for a %s SKU (%s)",
    async (sku) => {
      const { calls, client } = fakeClient(COMPLETE);
      expect(await resolveBundleProductContextForSku(client, sku)).toBeNull();
      expect(calls).toEqual([]);
    },
  );

  /**
   * A component reaches a customer's draft only because THEIR order line
   * recorded it. The repository query is keyed on this SKU, so a foreign row
   * cannot arrive today — this pins the invariant the rest of the function
   * depends on, against the day that query is widened for another caller.
   */
  it("drops a component recorded against a different SKU", async () => {
    const { client } = fakeClient({
      decompositions: [
        ...COMPONENTS.map((component) => ({ variant: ORDERED, line: "1", component })),
        { variant: "ENC999", line: "9", component: "SOMEONE-ELSES-PART" },
      ],
      attributes: [
        ...DESCRIBED,
        { sku: "SOMEONE-ELSES-PART", key: "diameter_mm", value: "999" },
      ],
    });
    const bundle = (await resolveBundleProductContextForSku(client, ORDERED))!;

    expect(bundle.common.map((component) => component.sku)).not.toContain("SOMEONE-ELSES-PART");
    expect(
      bundle.common.flatMap((component) => component.attributes.map((a) => a.value)),
    ).not.toContain("999");
  });
});

describe("SKU atomicity", () => {
  const COMBO = "PSHYOS4BRBM+SPUPBM+SLDO210BM";

  it("sends a combo SKU to the database whole, as one bound value", async () => {
    const { calls, client } = fakeClient({
      decompositions: ["SPUPBM", "SLDO210BM"].map((component) => ({
        variant: COMBO,
        line: "1",
        component,
      })),
      attributes: [
        { sku: "SPUPBM", key: "material_primary", value: "Metal" },
        { sku: "SLDO210BM", key: "diameter_mm", value: "210" },
      ],
    });
    await resolveBundleProductContextForSku(client, COMBO);

    const decomposition = calls.find((call) =>
      call.text.includes("order_management.order_combo"),
    )!;
    expect(decomposition.values).toEqual([[COMBO]]);
  });

  it("takes its components only from order_combo, never from the string", async () => {
    const { client } = fakeClient({
      decompositions: ["SPUPBM", "SLDO210BM"].map((component) => ({
        variant: COMBO,
        line: "1",
        component,
      })),
      attributes: [
        { sku: "SPUPBM", key: "material_primary", value: "Metal" },
        { sku: "SLDO210BM", key: "diameter_mm", value: "210" },
      ],
    });
    const bundle = (await resolveBundleProductContextForSku(client, COMBO))!;

    // Two components, because that is what the order system recorded — NOT the
    // three the string appears to name.
    expect(bundle.common.map((component) => component.sku)).toEqual(["SLDO210BM", "SPUPBM"]);
    expect(bundle.common.map((component) => component.sku)).not.toContain("PSHYOS4BRBM");
    expect(bundle.orderedSku).toBe(COMBO);
  });

  it.each([
    "PSHYOS4BRBM+SPUPBM+SLDO210BM",
    "CRSF100BM-DE",
    "LS_CY_210_BM",
    "ENC693/2",
    "Small Curvy Pendant light",
  ])("passes %s through unsplit and unnormalised", async (sku) => {
    const { calls, client } = fakeClient({ decompositions: [] });
    await resolveBundleProductContextForSku(client, sku);

    const decomposition = calls.find((call) =>
      call.text.includes("order_management.order_combo"),
    )!;
    expect(decomposition.values).toEqual([[sku]]);
  });

  it("contains no splitting, normalising or case-folding of a SKU", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "context", "resolve-bundle-product-context.ts"),
      "utf8",
    )
      // Comments name these operations in order to forbid them; strip first.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");

    for (const forbidden of [".split(", "toUpperCase", "toLowerCase", "normalize", "replace("]) {
      expect(source, `${forbidden} must not appear on a SKU path`).not.toContain(forbidden);
    }
  });
});

describe("the listing-keyed resolver is unchanged", () => {
  it("still resolves from the listing and names it", async () => {
    const GREY = "CRSF100CH+PHCHPCRCH+LSMS320GY";
    const RED = "CRSF100CH+PHCHPCRCH+LSMS320RE";
    const { client } = fakeClient({
      variants: [GREY, RED],
      decompositions: [
        ...["CRSF100CH", "PHCHPCRCH", "LSMS320GY"].map((component) => ({
          variant: GREY,
          line: "1",
          component,
        })),
        ...["CRSF100CH", "PHCHPCRCH", "LSMS320RE"].map((component) => ({
          variant: RED,
          line: "2",
          component,
        })),
      ],
      attributes: [
        { sku: "CRSF100CH", key: "diameter_mm", value: "100" },
        { sku: "PHCHPCRCH", key: "bulb_base_type", value: "E27" },
        { sku: "LSMS320GY", key: "diameter_mm", value: "320" },
        { sku: "LSMS320RE", key: "diameter_mm", value: "320" },
      ],
    });
    const bundle = (await resolveBundleProductContext(client, {
      marketplace: "ebay",
      subSourceId: 1,
      listingItemRef: "168440651522",
    }))!;

    expect(bundle.listingItemRef).toBe("168440651522");
    expect(bundle.orderedSku).toBeNull();
    expect(bundle.variantCount).toBe(2);
    // Still intersects, because on a pre-sale enquiry nothing knows the option.
    expect(bundle.varyingAgreement).toContainEqual({ key: "diameter_mm", value: "320" });
  });
});
