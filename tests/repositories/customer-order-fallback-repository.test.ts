import { describe, expect, it } from "vitest";

import {
  type Queryable,
  findSoleSameStorefrontOrder,
} from "@/lib/repositories/customer-order-fallback-repository";

/**
 * Layer 2's read: the same buyer's orders on the SAME storefront.
 *
 * The property that matters most is a refusal. Two orders must produce nothing
 * — not the newest, not the first — because a wrong order number in front of a
 * customer reads exactly like a right one.
 *
 * Synthetic fixtures throughout; nothing real is named here or in the source.
 */

type Call = { text: string; values?: unknown[] };

function fake(rows: unknown[]) {
  const calls: Call[] = [];
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    order_number: "AA-00000-00001",
    order_date: "2026-01-05 10:00:00",
    order_status: "Completed",
    storefront_id: 4,
    storefront_name: "Storefront Four",
    listing_match: false,
    order_line_count: 1,
    order_item_ref: "222222222222",
    order_sku: "PSHYOS4BRBM+SPUPBM+SLDO210BM",
    order_product_title: "Ceiling Rose Strap Bracket Plate",
    ...overrides,
  };
}

const OPTIONS = {
  buyerUsername: "buyer-handle",
  subSourceId: 4,
  currentListingItemRef: "111111111111",
};

/* ------------------------------------------------------------------------- *
 * EXACTLY ONE, OR NOTHING
 * ------------------------------------------------------------------------- */

describe("it names one order or refuses", () => {
  /** 2. The whole point of layer 2. */
  it("returns the order when the buyer has exactly one on this storefront", async () => {
    const { client } = fake([row()]);
    const order = await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(order?.orderNumber).toBe("AA-00000-00001");
    expect(order?.storefrontId).toBe(4);
    expect(order?.storefrontName).toBe("Storefront Four");
    expect(order?.orderStatus).toBe("Completed");
  });

  /** 5. NO AUTO-SELECTION. Two orders is a refusal, not a shortlist. */
  it("returns nothing when the buyer has more than one", async () => {
    const { client } = fake([row(), row({ order_number: "AA-00000-00002" })]);
    expect(await findSoleSameStorefrontOrder(client, OPTIONS)).toBeNull();
  });

  it("returns nothing when the buyer has none", async () => {
    const { client } = fake([]);
    expect(await findSoleSameStorefrontOrder(client, OPTIONS)).toBeNull();
  });

  /**
   * THERE IS NOTHING TO RANK WITH, and that is how the refusal is guaranteed
   * rather than merely intended. An ORDER BY here would be the first step
   * towards "just take the newest".
   */
  it("has no ordering clause at all", async () => {
    const { calls, client } = fake([row()]);
    await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(calls[0]!.text).not.toMatch(/\bORDER BY\b/i);
    expect(calls[0]!.text).not.toMatch(/\bDESC\b|\bASC\b/i);
    // It reads only as far as the question needs: one to answer, two to refuse.
    expect(calls[0]!.text).toContain("LIMIT 2");
  });

  it("refuses a single row it cannot identify", async () => {
    for (const broken of [{ order_number: "   " }, { order_number: null }, { storefront_id: null }]) {
      const { client } = fake([row(broken)]);
      expect(await findSoleSameStorefrontOrder(client, OPTIONS), JSON.stringify(broken)).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * THE PREDICATES
 * ------------------------------------------------------------------------- */

describe("it drops exactly one predicate from the matcher", () => {
  /** 10. Buyer and storefront are the matcher's own, unchanged. */
  it("keeps the exact buyer and the same storefront", async () => {
    const { calls, client } = fake([row()]);
    await findSoleSameStorefrontOrder(client, OPTIONS);
    const sql = calls[0]!.text;
    expect(sql).toContain("ci.ebay_buyer_id = $4");
    expect(sql).toContain("o.sub_source_id = $2::int");
    expect(sql).toContain("ss.source_id = $1::int");
    expect(calls[0]!.values).toEqual([2, 4, "111111111111", "buyer-handle"]);
    // Identity is never loosened to find more history.
    expect(sql).not.toMatch(/lower\s*\(\s*ci\.ebay_buyer_id/i);
    expect(sql).not.toMatch(/ci\.ebay_buyer_id\s+(?:I?LIKE|~)/i);
  });

  /** The item is dropped from the WHERE — that is the definition of layer 2. */
  it("does not require the listing, but does report whether it matched", async () => {
    const { calls, client } = fake([row()]);
    const order = await findSoleSameStorefrontOrder(client, OPTIONS);
    const sql = calls[0]!.text;
    // The OUTER where clause carries no item requirement. Sliced deliberately:
    // the item appears twice elsewhere — in the correlated EXISTS that computes
    // `listing_match`, and in the LATERAL that reads the order's own line — and
    // both are reported VALUES, not filters on which orders are returned.
    const outerWhere = sql.slice(sql.indexOf("WHERE ss.source_id"), sql.indexOf("LIMIT"));
    expect(outerWhere).not.toMatch(/item_id/);
    expect(outerWhere).toContain("ci.ebay_buyer_id");
    // ...and the relationship is read from the data rather than assumed.
    expect(sql).toMatch(/EXISTS\s*\([\s\S]*?order_item_info[\s\S]*?item_id = \$3/);
    expect(order?.listingMatch).toBe(false);
  });

  /** 3 and 4. The flag is the data's answer, not a constant. */
  it("reports a listing match when the data says so", async () => {
    const { client } = fake([row({ listing_match: true })]);
    expect((await findSoleSameStorefrontOrder(client, OPTIONS))?.listingMatch).toBe(true);
  });

  /** One order is one row: nothing can fan a single order into a refusal. */
  it("asks whether the buyer is on the order rather than joining to them", async () => {
    const { calls, client } = fake([row()]);
    await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(calls[0]!.text).toMatch(/EXISTS\s*\(\s*SELECT 1\s*FROM customers\.customer_info/);
    expect(calls[0]!.text).not.toContain("JOIN customers.customer_info");
    expect(calls[0]!.text).not.toContain("DISTINCT ON");
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT IT WILL NOT CARRY
 * ------------------------------------------------------------------------- */

describe("it carries the ordered product, but never a parcel", () => {
  /** 2, 3. The order's OWN item and SKU, from the order's own line. */
  it("returns the ordered item, SKU and title for a single-line order", async () => {
    const { client } = fake([row()]);
    const order = await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(Object.keys(order!).sort()).toEqual([
      "listingMatch",
      "orderDate",
      "orderItemRef",
      "orderLineCount",
      "orderNumber",
      "orderProductTitle",
      "orderSku",
      "orderStatus",
      "storefrontId",
      "storefrontName",
    ]);
    expect(order?.orderItemRef).toBe("222222222222");
    expect(order?.orderProductTitle).toBe("Ceiling Rose Strap Bracket Plate");
    expect(order?.orderLineCount).toBe(1);
  });

  /**
   * 3. THE SKU IS THE ORDER LINE'S, and `real_sku` wins where the source
   * recorded a corrected value — the precedence the strict matcher applies.
   */
  it("reads the SKU from order_item_info, preferring the corrected one", async () => {
    const { calls, client } = fake([row()]);
    await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(calls[0]!.text).toContain("order_management.order_item_info");
    expect(calls[0]!.text).toContain("coalesce(oii.real_sku, oii.item_sku)");
  });

  /** 9. ONE SKU, BYTE FOR BYTE — never split on `+`, never trimmed. */
  it("returns a combo SKU exactly as stored", async () => {
    const stored = "PSHYOS4BRBM+SPUPBM+SLDO210BM";
    const { client } = fake([row({ order_sku: stored })]);
    const returned = (await findSoleSameStorefrontOrder(client, OPTIONS))?.orderSku;
    expect(returned).toBe(stored);
    expect(returned).toContain("+");
    // Whitespace inside the value survives too: the blank check trims to TEST,
    // never to produce, so nothing on this path can alter a stored identifier.
    const spaced = "A B+C D";
    const second = fake([row({ order_sku: spaced })]);
    expect((await findSoleSameStorefrontOrder(second.client, OPTIONS))?.orderSku).toBe(spaced);
  });

  /**
   * 10. THE DATABASE REFUSES TO PICK A LINE. On a multi-line order the query's
   * own `CASE WHEN line_count = 1` returns null for the item, SKU and title, so
   * no code above it can choose one even by accident.
   */
  it("nulls the product in SQL when the order has several lines", async () => {
    const { calls, client } = fake([
      row({
        order_line_count: 4,
        order_item_ref: null,
        order_sku: null,
        order_product_title: null,
      }),
    ]);
    const order = await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(order?.orderLineCount).toBe(4);
    expect(order?.orderItemRef).toBeNull();
    expect(order?.orderSku).toBeNull();
    expect(order?.orderProductTitle).toBeNull();
    // The guard is in the statement, not only in the mapping above.
    expect(calls[0]!.text).toContain("CASE WHEN count(*) = 1");
  });

  /** No parcel, ever: there is no field to carry one. */
  it("selects no tracking, carrier, address or refund column", async () => {
    const { calls, client } = fake([row()]);
    await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(calls[0]!.text).not.toMatch(/tracking|carrier|address|refund|shipment/i);
  });

  /** 11. It reads. It never writes. */
  it("issues only a SELECT", async () => {
    const { calls, client } = fake([row()]);
    await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(calls[0]!.text.trimStart().startsWith("SELECT")).toBe(true);
    expect(calls[0]!.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  });

  it("keeps the stored date as text, never a parsed value", async () => {
    const { client } = fake([row({ order_date: "2026-01-05 10:00:00" })]);
    const order = await findSoleSameStorefrontOrder(client, OPTIONS);
    expect(order?.orderDate).toBe("2026-01-05 10:00:00");
  });
});
