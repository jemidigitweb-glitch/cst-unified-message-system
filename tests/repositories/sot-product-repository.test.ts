import { describe, expect, it } from "vitest";

import {
  type Queryable,
  type SotProduct,
  findSotProductForListing,
} from "@/lib/repositories/sot-product-repository";

const BLOCKED = ["(^|_)(stock|price)(_|$)", "^amz_"];

/**
 * A two-statement client: the first call answers the parent-SKU query, the
 * second the attribute query. Every issued statement is recorded so the tests
 * can assert on the SQL itself, not only on what came back.
 */
function fake(parentRows: unknown[], attributeRows: unknown[] = []) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows: calls.length === 1 ? parentRows : attributeRows };
    },
  };
  return { calls, client };
}

function attributeRow(overrides: Record<string, unknown> = {}) {
  return {
    sot_sku_id: "12",
    sku: "LSDO210BM",
    source_tab: "lampshade",
    synced_at: "2026-08-20 06:41:56",
    attribute_key: "diameter_mm",
    attribute_label: "Diameter_mm",
    value: "220",
    ...overrides,
  };
}

describe("findSotProductForListing", () => {
  it("scopes the listing lookup to item_id, sub_source and the parent row only", async () => {
    const { calls, client } = fake([{ sku: "LSDO210BM" }], [attributeRow()]);

    await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(calls[0]!.values).toEqual(["166872810291", 1]);
    expect(calls[0]!.text).toContain("el.item_id = $1");
    expect(calls[0]!.text).toContain("el.sub_source = $2::int");
    expect(calls[0]!.text).toContain("el.is_parent = 1");
  });

  it("matches the SOT SKU exactly -- no upper, no btrim, no case-fold", async () => {
    const { calls, client } = fake([{ sku: "LSDO210BM" }], [attributeRow()]);

    await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(calls[1]!.text).toContain("s.sku = $1");
    expect(calls[1]!.text).not.toMatch(/upper\s*\(\s*s\.sku/i);
    expect(calls[1]!.text).not.toMatch(/lower\s*\(\s*s\.sku/i);
    expect(calls[1]!.text).not.toMatch(/btrim\s*\(\s*s\.sku/i);
    // The SKU travels as a parameter, never interpolated into the statement.
    expect(calls[1]!.values![0]).toBe("LSDO210BM");
    expect(calls[1]!.text).not.toContain("LSDO210BM");
  });

  it("excludes the caller's blocked patterns in SQL, as bound parameters", async () => {
    const { calls, client } = fake([{ sku: "LSDO210BM" }], [attributeRow()]);

    await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    // "matches none of them", case-insensitively.
    expect(calls[1]!.text).toContain("a.key !~* ALL($2::text[])");
    expect(calls[1]!.values![1]).toEqual(BLOCKED);
    // The patterns travel as data, never interpolated into the statement.
    expect(calls[1]!.text).not.toContain("^amz_");
  });

  it("returns the record with its sync stamp and every requested attribute", async () => {
    const { client } = fake(
      [{ sku: "LSDO210BM" }],
      [
        attributeRow({ attribute_key: "product_name", attribute_label: "Product_Name", value: "Cone Lampshade" }),
        attributeRow(),
      ],
    );

    const product = await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(product).toEqual<SotProduct>({
      sku: "LSDO210BM",
      syncedAt: "2026-08-20 06:41:56",
      sourceTab: "lampshade",
      attributes: [
        { key: "product_name", label: "Product_Name", value: "Cone Lampshade" },
        { key: "diameter_mm", label: "Diameter_mm", value: "220" },
      ],
    });
  });

  it("reads values faithfully -- a [VERIFY] cell is returned, not filtered here", async () => {
    const { client } = fake([{ sku: "LSDO210BM" }], [attributeRow({ value: "[VERIFY]" })]);

    const product = await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(product!.attributes[0]!.value).toBe("[VERIFY]");
  });

  it("returns null when the listing has no parent row", async () => {
    const { calls, client } = fake([]);

    const product = await findSotProductForListing(client, {
      itemId: "no-such-item",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(product).toBeNull();
    // The attribute query is never issued -- there is nothing to look up.
    expect(calls).toHaveLength(1);
  });

  it("returns null rather than choosing when a listing carries several parent SKUs", async () => {
    const { calls, client } = fake([{ sku: "LSDO210BM" }, { sku: "LSDO210WH" }]);

    const product = await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(product).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null when the SKU has no SOT row", async () => {
    const { client } = fake([{ sku: "NOT-IN-SOT" }], []);

    const product = await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(product).toBeNull();
  });

  it("returns null rather than merging when rows span two SOT records", async () => {
    const { client } = fake(
      [{ sku: "LSDO210BM" }],
      [attributeRow({ sot_sku_id: "12" }), attributeRow({ sot_sku_id: "13" })],
    );

    const product = await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(product).toBeNull();
  });

  /**
   * An empty pattern list means "block nothing", which would admit every
   * commercial column in the sheet. Refusing is safer than obeying.
   */
  it("issues no query at all when the caller supplied no blocked patterns", async () => {
    const { calls, client } = fake([{ sku: "LSDO210BM" }]);

    const product = await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: [],
    });

    expect(product).toBeNull();
    expect(calls).toHaveLength(0);
  });

  /**
   * A combo SKU is ONE opaque identifier — see `lib/domain/sku.ts`. It must
   * reach the SOT match whole, never split on `+` and never partially matched.
   */
  it("passes a combo SKU through whole, never split on +", async () => {
    const combo = "PSHYOS4BRBM+SPUPBM+LSDO210BM";
    const { calls, client } = fake([{ sku: combo }], []);

    const product = await findSotProductForListing(client, {
      itemId: "166872810291",
      subSourceId: 1,
      blockedKeyPatterns: BLOCKED,
    });

    expect(calls[1]!.values![0]).toBe(combo);
    // No SOT row under that exact string, so nothing is stated about it.
    expect(product).toBeNull();
  });
});
