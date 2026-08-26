import { describe, expect, it } from "vitest";

import {
  type CandidateOrder,
  type Queryable,
  findCandidateEbayOrders,
} from "@/lib/repositories/order-context-repository";

/** Synthetic rows only. No real customer or order data appears in any test. */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    order_row_id: "501",
    order_item_info_id: "9001",
    order_number: "ORD-1001",
    order_date: "2026-08-01 10:00:00",
    order_status: "Dispatched",
    item_sku: "LISTING-SKU-1",
    real_sku: "REAL-SKU-1",
    item_title: "Synthetic Widget",
    item_img: "https://example.test/widget.png",
    address_line_1: "1 Test Street",
    address_line_2: null,
    address_line_3: null,
    city: "Testville",
    region: "Testshire",
    postcode: "TE5 7ST",
    tracking_number: "TRK-1",
    carrier_name: "Royal Mail Tracked 48",
    carrier: "Royal Mail",
    ...overrides,
  };
}

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

describe("findCandidateEbayOrders", () => {
  it("scopes the query to eBay's platform (source_id), the sub-account, item and buyer", async () => {
    const { calls, client } = fake([orderRow()]);

    await findCandidateEbayOrders(client, {
      subSourceId: 1,
      itemId: "166239358700",
      buyerUsername: "kraskir24",
    });

    expect(calls).toHaveLength(1);
    // 2 is EBAY_SOURCE_ID, from order_management.sub_source.source_id -- not a
    // market_place/country code, which is a region table shared with Amazon.
    expect(calls[0]!.values).toEqual([2, 1, "166239358700", "kraskir24"]);
    expect(calls[0]!.text).toContain("JOIN order_management.sub_source ss ON ss.id = o.sub_source_id");
    expect(calls[0]!.text).toContain("ss.source_id = $1::int");
    expect(calls[0]!.text).toContain("o.sub_source_id = $2::int");
    expect(calls[0]!.text).toContain("oii.item_id = $3");
    expect(calls[0]!.text).toContain("ci.ebay_buyer_id = $4");
    expect(calls[0]!.text).toContain("DISTINCT ON (o.id)");
  });

  it("maps a matched row into a CandidateOrder, preferring the corrected SKU and carrier brand", async () => {
    const { client } = fake([orderRow()]);

    const [order] = await findCandidateEbayOrders(client, {
      subSourceId: 1,
      itemId: "166239358700",
      buyerUsername: "kraskir24",
    });

    expect(order).toEqual<CandidateOrder>({
      orderRowId: "501",
      orderItemInfoId: "9001",
      orderNumber: "ORD-1001",
      orderDate: "2026-08-01 10:00:00",
      orderStatus: "Dispatched",
      sku: "REAL-SKU-1",
      productTitle: "Synthetic Widget",
      productImageUrl: "https://example.test/widget.png",
      addressLine1: "1 Test Street",
      addressLine2: null,
      addressLine3: null,
      city: "Testville",
      region: "Testshire",
      postcode: "TE5 7ST",
      trackingNumber: "TRK-1",
      carrierName: "Royal Mail",
    });
  });

  it("falls back to the listing SKU and the service name when the preferred fields are absent", async () => {
    const { client } = fake([orderRow({ real_sku: null, carrier: null })]);

    const [order] = await findCandidateEbayOrders(client, {
      subSourceId: 1,
      itemId: "166239358700",
      buyerUsername: "kraskir24",
    });

    expect(order!.sku).toBe("LISTING-SKU-1");
    expect(order!.carrierName).toBe("Royal Mail Tracked 48");
  });

  it("returns one CandidateOrder per matching order, as the caller uses the count to detect ambiguity", async () => {
    const { client } = fake([
      orderRow({ order_row_id: "501", order_number: "ORD-1001" }),
      orderRow({ order_row_id: "502", order_number: "ORD-1002" }),
    ]);

    const orders = await findCandidateEbayOrders(client, {
      subSourceId: 1,
      itemId: "266102089152",
      buyerUsername: "blessedbe",
    });

    expect(orders).toHaveLength(2);
    expect(orders.map((o) => o.orderNumber)).toEqual(["ORD-1001", "ORD-1002"]);
  });

  it("returns an empty array when nothing matches", async () => {
    const { client } = fake([]);

    const orders = await findCandidateEbayOrders(client, {
      subSourceId: 1,
      itemId: "no-such-item",
      buyerUsername: "nobody",
    });

    expect(orders).toEqual([]);
  });
});
