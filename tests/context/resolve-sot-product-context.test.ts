import { describe, expect, it } from "vitest";

import {
  BLOCKED_SOT_ATTRIBUTE_PATTERNS,
  resolveSotProductContext,
  sotAttributeIsStatable,
} from "@/lib/context/resolve-sot-product-context";
import type { Queryable as SourceQueryable } from "@/lib/repositories/sot-product-repository";

/**
 * The names `contextBlocks()` routes into the RETURN block. Restated here rather
 * than imported because that constant is private to `draft-assembly.ts` and
 * exporting it would mean editing a file this work must not touch.
 */
const RETURN_FACT_NAMES = ["return_status", "return_reason", "return_evidence_available"];

type Call = { text: string; values?: unknown[] };

/**
 * Answers the two statements the repository issues, by matching on the table
 * each one names rather than on call order — so a test cannot pass because the
 * queries happened to be issued in the order it assumed.
 */
function fakeSourceClient(parentRows: unknown[], attributeRows: unknown[] = []) {
  const calls: Call[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      if (config.text.includes("listings.ebay_listings")) return { rows: parentRows };
      if (config.text.includes("configurator.components_sot_skus")) return { rows: attributeRows };
      return { rows: [] };
    },
  };
  return { calls, client };
}

const conversation = {
  marketplace: "ebay",
  subSourceId: 1,
  listingItemRef: "166872810291",
};

function attributeRow(key: string, value: string | null, label = key) {
  return {
    sot_sku_id: "12",
    sku: "LSDO210BM",
    source_tab: "lampshade",
    synced_at: "2026-08-20 06:41:56",
    attribute_key: key,
    attribute_label: label,
    value,
  };
}

describe("resolveSotProductContext", () => {
  it("returns the SKU and every statable attribute when the parent SKU matches SOT", async () => {
    const { client } = fakeSourceClient(
      [{ sku: "LSDO210BM" }],
      [
        attributeRow("product_name", "Industrial Metal Cone Lampshade"),
        attributeRow("diameter_mm", "220"),
        attributeRow("bulb_base_compat", "E26 / E27"),
        attributeRow("reducer_ring_included", "Y"),
      ],
    );

    const facts = await resolveSotProductContext(client, conversation);

    expect(facts).toEqual([
      { name: "sku", value: "LSDO210BM" },
      { name: "product_name", value: "Industrial Metal Cone Lampshade" },
      { name: "diameter_mm", value: "220" },
      { name: "bulb_base_compat", value: "E26 / E27" },
      { name: "reducer_ring_included", value: "Y" },
    ]);
  });

  it("states values exactly as stored -- no rounding, unit conversion or expansion", async () => {
    const { client } = fakeSourceClient(
      [{ sku: "LSDO210BM" }],
      [attributeRow("diameter_mm", "220"), attributeRow("reducer_ring_included", "Y")],
    );

    const facts = await resolveSotProductContext(client, conversation);

    expect(facts.find((f) => f.name === "diameter_mm")!.value).toBe("220");
    expect(facts.find((f) => f.name === "reducer_ring_included")!.value).toBe("Y");
  });

  it("returns nothing when the parent SKU has no SOT record", async () => {
    const { client } = fakeSourceClient([{ sku: "NOT-IN-SOT" }], []);

    expect(await resolveSotProductContext(client, conversation)).toEqual([]);
  });

  it("returns nothing when the listing has no parent row", async () => {
    const { client } = fakeSourceClient([]);

    expect(await resolveSotProductContext(client, conversation)).toEqual([]);
  });

  it("returns nothing rather than choosing when the listing has several parent SKUs", async () => {
    const { client } = fakeSourceClient([{ sku: "LSDO210BM" }, { sku: "LSDO210WH" }]);

    expect(await resolveSotProductContext(client, conversation)).toEqual([]);
  });

  describe("the [VERIFY] sentinel", () => {
    it("drops a bare [VERIFY] cell", async () => {
      const { client } = fakeSourceClient(
        [{ sku: "LSDO210BM" }],
        [attributeRow("diameter_mm", "220"), attributeRow("bottom_diameter_mm", "[VERIFY]")],
      );

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts.map((f) => f.name)).toEqual(["sku", "diameter_mm"]);
    });

    /**
     * 433 SOT cells carry the marker EMBEDDED in otherwise-real text —
     * "Kitchen, Dining, Hallway [VERIFY]". An equality check would publish
     * those as facts, which is the case the marker exists to prevent.
     */
    it("drops a value with [VERIFY] embedded in real-looking text", async () => {
      const { client } = fakeSourceClient(
        [{ sku: "LSDO210BM" }],
        [
          attributeRow("diameter_mm", "220"),
          attributeRow("parts_list", "Lampshade, Reducer Ring [VERIFY]"),
        ],
      );

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts.map((f) => f.name)).toEqual(["sku", "diameter_mm"]);
    });

    it("returns nothing at all when every whitelisted cell is unverified", async () => {
      const { client } = fakeSourceClient(
        [{ sku: "LSDO210BM" }],
        [attributeRow("diameter_mm", "[VERIFY]"), attributeRow("product_name", "[VERIFY]")],
      );

      // Not even the SKU: a heading with nothing under it is worse than silence.
      expect(await resolveSotProductContext(client, conversation)).toEqual([]);
    });

    it("drops empty and whitespace-only cells", async () => {
      const { client } = fakeSourceClient(
        [{ sku: "LSDO210BM" }],
        [
          attributeRow("diameter_mm", "220"),
          attributeRow("height_mm", null),
          attributeRow("outer_colour", "   "),
        ],
      );

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts.map((f) => f.name)).toEqual(["sku", "diameter_mm"]);
    });
  });

  describe("scope", () => {
    it.each(["amazon", "shopify", "temu", "bandq"])(
      "returns nothing for %s and issues no query",
      async (marketplace) => {
        const { calls, client } = fakeSourceClient([{ sku: "LSDO210BM" }], [attributeRow("diameter_mm", "220")]);

        const facts = await resolveSotProductContext(client, { ...conversation, marketplace });

        expect(facts).toEqual([]);
        expect(calls).toHaveLength(0);
      },
    );

    it.each([
      ["no sub-account", { subSourceId: null }],
      ["no listing reference", { listingItemRef: null }],
      ["a blank listing reference", { listingItemRef: "   " }],
    ])("returns nothing and issues no query for %s", async (_label, overrides) => {
      const { calls, client } = fakeSourceClient([{ sku: "LSDO210BM" }], [attributeRow("diameter_mm", "220")]);

      const facts = await resolveSotProductContext(client, { ...conversation, ...overrides });

      expect(facts).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe("attribute selection", () => {
    it("hands the blocked patterns to the database as bound parameters", async () => {
      const { calls, client } = fakeSourceClient([{ sku: "LSDO210BM" }], [attributeRow("diameter_mm", "220")]);

      await resolveSotProductContext(client, conversation);

      expect(calls[1]!.values![1]).toEqual(BLOCKED_SOT_ATTRIBUTE_PATTERNS);
      expect(BLOCKED_SOT_ATTRIBUTE_PATTERNS.length).toBeGreaterThan(0);
    });

    /**
     * THE POINT OF THE REDESIGN. `table_lamp` was not in the old allowlist, so a
     * customer asking "can this be used on a table lamp?" got a request for
     * their voltage. Nothing about these names is registered anywhere in the
     * codebase — they flow because they are not blocked.
     */
    it.each([
      ["table_lamp", "Y"],
      ["ceiling_light", "N"],
      ["cap_bathroom_ip44", "Y"],
      ["compat_pendant_holder", "Y"],
      ["heat_resistance_c", "60"],
      ["beam_angle_deg", "300"],
      ["colour_temp_k", "2700"],
      ["a_brand_new_column_nobody_has_added_yet", "42mm"],
    ])("lets %s through with no code change", async (key, value) => {
      const { client } = fakeSourceClient([{ sku: "LSDO210BM" }], [attributeRow(key, value)]);

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts).toEqual([
        { name: "sku", value: "LSDO210BM" },
        { name: key, value },
      ]);
    });

    it("sends Y and N exactly as stored, never as a phrase", async () => {
      const { client } = fakeSourceClient([{ sku: "LSDO210BM" }], [attributeRow("table_lamp", "Y")]);

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts[1]).toEqual({ name: "table_lamp", value: "Y" });
      expect(JSON.stringify(facts)).not.toMatch(/suitable|can be used|yes|no\b/i);
    });

    it.each([
      "total_stock",
      "stock_count",
      "monthly_rev_gbp",
      "max_bid_gbp",
      "postage_cost_rm_gbp",
      "fba_fulfilment_fee_gbp",
      "amazon_acos_pct",
      "ebay_ctr",
      "buy_box",
      "voc_avg_rating",
      "warranty_months",
      "return_reason_1",
      "objection_1",
      "restricted_claims",
      "rel_1_target",
      "amazon_asin",
      "ebay_item_id",
      "shopify_handle",
      "eb_ledsone_uk",
      "amz_dcvoltage_de",
      "shp_besbet_uk",
      "b_q_ledsone_uk",
      "img_link",
      "img_main",
      "listings_col_37",
      "listing_images",
      "ce_cert_id",
      "weee_reg",
      "hs_code",
      "product_status",
      "negative_keywords",
      "ppc_term_1",
      "seo_meta_desc",
      "amazon_bullet_1",
      "social_caption",
      "royal_mail_format",
      "chargeable_weight_kg",
      "units_per_outer",
      "pkg_label_required",
      "google_product_category",
    ])("blocks %s", (key) => {
      expect(sotAttributeIsStatable(key)).toBe(false);
    });

    /**
     * The families are broad on purpose, so it matters that they do not swallow
     * genuine specifications. `switch_rating_a` and `current_rating_a` are the
     * reason `rating` is not a blocked word, and `outer_colour` is the reason
     * `outer` is not.
     */
    it.each([
      "diameter_mm",
      "height_mm",
      "material_primary",
      "outer_colour",
      "inner_colour",
      "switch_rating_a",
      "current_rating_a",
      "voltage_rating_v",
      "max_load_w",
      "style_category",
      "room_suitability",
      "finish_code",
      "country_of_origin",
      "rohs_compliant",
      "energy_class",
      "halogen_free",
      "pack_qty",
      "qty_per_pack",
      "pkg_material",
      "packaged_weight_g",
      "table_lamp",
      "bulb_base_compat",
    ])("still allows %s", (key) => {
      expect(sotAttributeIsStatable(key)).toBe(true);
    });

    /**
     * Fact names decide which half of the prompt a value lands in.
     * `contextBlocks()` buckets by matching /order|refund|tracking|delivery/i
     * against the NAME. A SOT column called `delivery_note` would silently be
     * presented as an order fact — so the blocked families must cover it.
     */
    it.each(["order_status", "refund_note", "tracking_ref", "delivery_window"])(
      "blocks %s, which would otherwise be filed as an order fact",
      (key) => {
        expect(key).toMatch(/order|refund|tracking|delivery/i);
        expect(sotAttributeIsStatable(key)).toBe(false);
      },
    );

    it("blocks every name the return block owns", () => {
      for (const key of RETURN_FACT_NAMES) {
        expect(sotAttributeIsStatable(key)).toBe(false);
      }
    });
  });

  describe("value shape, independent of the column name", () => {
    it.each([
      ["a link", "https://i.ebayimg.com/images/g/a/s-l1600.jpg"],
      ["a bare www link", "www.example.com/spec"],
      ["a price", "£24.99"],
      ["a price with a code", "24.99 GBP"],
    ])("blocks %s even under an innocent column name", async (_label, value) => {
      const { client } = fakeSourceClient(
        [{ sku: "LSDO210BM" }],
        [attributeRow("diameter_mm", "220"), attributeRow("some_new_column", value)],
      );

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts.map((f) => f.name)).toEqual(["sku", "diameter_mm"]);
    });

    it("blocks a value longer than any real specification", async () => {
      const { client } = fakeSourceClient(
        [{ sku: "LSDO210BM" }],
        [attributeRow("diameter_mm", "220"), attributeRow("some_new_column", "x".repeat(301))],
      );

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts.map((f) => f.name)).toEqual(["sku", "diameter_mm"]);
    });

    it("keeps the longest real specification observed live", async () => {
      const partsList =
        "Ceiling rose; Backplate; Cord grip; Terminal block; 2 long screws with 2 washers & 2 wallplugs (fix backplate/bracket to ceiling); 2 small screws (fix ceiling rose to backplate/bracket); Earth wire";
      const { client } = fakeSourceClient(
        [{ sku: "LSDO210BM" }],
        [attributeRow("parts_list", partsList)],
      );

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts[1]).toEqual({ name: "parts_list", value: partsList });
    });
  });

  /**
   * `ungroundedClaims` in `lib/domain/draft.ts` concatenates fact names AND
   * values, then allows a prohibited claim when the claim's first word appears.
   * A catalogue value carrying one of those words would weaken that check.
   * No SOT value matches today; this keeps a future sheet edit from changing
   * that silently.
   */
  it("drops a value that would disarm the prohibited-claim check", async () => {
    const { client } = fakeSourceClient(
      [{ sku: "LSDO210BM" }],
      [
        attributeRow("diameter_mm", "220"),
        attributeRow("parts_list", "Shade, spare ring — replacement parts included"),
      ],
    );

    const facts = await resolveSotProductContext(client, conversation);

    expect(facts.map((f) => f.name)).toEqual(["sku", "diameter_mm"]);
  });

  describe("SKU atomicity", () => {
    it("matches a combo SKU whole and states it verbatim when SOT holds it", async () => {
      const combo = "PSHYOS4BRBM+SPUPBM+LSDO210BM";
      const { calls, client } = fakeSourceClient(
        [{ sku: combo }],
        [{ ...attributeRow("diameter_mm", "220"), sku: combo }],
      );

      const facts = await resolveSotProductContext(client, conversation);

      expect(calls[1]!.values![0]).toBe(combo);
      expect(facts[0]).toEqual({ name: "sku", value: combo });
    });

    it("never splits a combo SKU on + when SOT does not hold it", async () => {
      const combo = "PSHYOS4BRBM+SPUPBM+LSDO210BM";
      const { calls, client } = fakeSourceClient([{ sku: combo }], []);

      const facts = await resolveSotProductContext(client, conversation);

      expect(facts).toEqual([]);
      // One lookup, on the whole string -- no second attempt on a component.
      expect(calls).toHaveLength(2);
      expect(calls[1]!.values![0]).toBe(combo);
    });
  });
});
