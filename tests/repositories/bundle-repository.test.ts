import { describe, expect, it } from "vitest";

import {
  type Queryable,
  findComponentAttributes,
  findComponentTitles,
  findDecompositions,
  findVariantSkus,
} from "@/lib/repositories/bundle-repository";

function fake(rows: unknown[]) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

const COMBO = "CRSF100CH+PHCHPCRCH+LSMS320GY";

describe("findVariantSkus", () => {
  it("reads child rows only, scoped to item and sub-account", async () => {
    const { calls, client } = fake([{ sku: COMBO }]);

    await findVariantSkus(client, { itemId: "168440651522", subSourceId: 1 });

    expect(calls[0]!.values).toEqual(["168440651522", 1]);
    expect(calls[0]!.text).toContain("el.item_id = $1");
    expect(calls[0]!.text).toContain("el.sub_source = $2::int");
    // The parent row's sku is a placeholder on 4,752 of 31,100 listings.
    expect(calls[0]!.text).toContain("el.is_child = 1");
    expect(calls[0]!.text).not.toContain("is_parent");
  });

  it("returns the stored strings untouched", async () => {
    const { client } = fake([{ sku: COMBO }, { sku: "ENC8740" }]);
    expect(await findVariantSkus(client, { itemId: "1", subSourceId: 1 })).toEqual([COMBO, "ENC8740"]);
  });
});

describe("findDecompositions", () => {
  it("joins item_sku to order_combo and never touches real_sku", async () => {
    const { calls, client } = fake([
      { variant_sku: COMBO, line_id: "1234646", component_sku: "CRSF100CH" },
    ]);

    await findDecompositions(client, [COMBO]);

    expect(calls[0]!.text).toContain("oii.item_sku = ANY($1::text[])");
    expect(calls[0]!.text).toContain("oc.order_item_info_id = oii.id");
    // `real_sku` carries warehouse suffixes (…-DE) and would fragment a bundle.
    expect(calls[0]!.text).not.toContain("real_sku");
  });

  it("selects no order-specific column", async () => {
    const { calls, client } = fake([]);
    await findDecompositions(client, [COMBO]);

    for (const forbidden of ["oc.qty", "oc.color", "oc.image", "item_price", "item_quantity"]) {
      expect(calls[0]!.text).not.toContain(forbidden);
    }
  });

  it("passes the combo SKU whole, as a bound parameter, never split on +", async () => {
    const { calls, client } = fake([]);
    await findDecompositions(client, [COMBO]);

    expect(calls[0]!.values![0]).toEqual([COMBO]);
    expect(calls[0]!.text).not.toContain(COMBO);
    expect(calls[0]!.text).not.toContain("+");
  });

  it("issues no query when there are no variants", async () => {
    const { calls, client } = fake([]);
    expect(await findDecompositions(client, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("findComponentAttributes", () => {
  it("matches component SKUs exactly and excludes the blocked patterns", async () => {
    const { calls, client } = fake([{ sku: "CRSF100CH", attribute_key: "diameter_mm", value: "100" }]);

    await findComponentAttributes(client, {
      componentSkus: ["CRSF100CH"],
      blockedKeyPatterns: ["^amz_"],
    });

    expect(calls[0]!.text).toContain("s.sku = ANY($1::text[])");
    expect(calls[0]!.text).toContain("a.key !~* ALL($2::text[])");
    expect(calls[0]!.text).not.toMatch(/upper\s*\(\s*s\.sku/i);
    expect(calls[0]!.text).not.toMatch(/btrim\s*\(\s*s\.sku/i);
    expect(calls[0]!.values).toEqual([["CRSF100CH"], ["^amz_"]]);
  });

  it("refuses an empty blocked-pattern list rather than admitting every column", async () => {
    const { calls, client } = fake([]);
    expect(
      await findComponentAttributes(client, { componentSkus: ["X"], blockedKeyPatterns: [] }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("findComponentTitles", () => {
  it("returns one title per SKU and drops blanks", async () => {
    const { client } = fake([
      { sku: "CRSF100CH", title: "Chrome Ceiling Rose" },
      { sku: "PHCHPCRCH", title: "   " },
    ]);

    const titles = await findComponentTitles(client, ["CRSF100CH", "PHCHPCRCH"]);

    expect(titles.get("CRSF100CH")).toBe("Chrome Ceiling Rose");
    expect(titles.has("PHCHPCRCH")).toBe(false);
  });
});
