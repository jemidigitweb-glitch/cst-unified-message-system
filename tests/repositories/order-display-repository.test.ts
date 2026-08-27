import { describe, expect, it } from "vitest";

import type { SourceOrderDetail } from "@/lib/domain/order";
import { loadOrderDisplayDetails } from "@/lib/context/load-order-display";
import {
  type Queryable,
  findOrderDetailsForDisplay,
} from "@/lib/repositories/order-display-repository";

/**
 * The display query is the grounding query's twin: same join, same keys, wider
 * SELECT. These tests hold that relationship, because the moment the two
 * disagree the sidebar starts showing orders the resolver never matched.
 */

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

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    order_number: "ORD-1001",
    order_date: "2026-08-01 10:00:00",
    order_status: "Completed",
    order_total: "34.99",
    first_name: "Test",
    last_name: "Person",
    address_name: "Test Person",
    seller_name: "test_storefront",
    seller_company: "Test Company",
    tracking_number: "TRK-1",
    shipment_status: "Completed",
    carrier_name: "ROYAL MAIL TRACKED 48",
    carrier: "Royal Mail",
    address_line_1: "1 Test Street",
    address_line_2: null,
    address_line_3: null,
    city: "Testville",
    region: "Testshire",
    postcode: "TE5 7ST",
    listing_item_ref: "166239358700",
    item_sku: "LISTING-SKU-1",
    real_sku: "REAL-SKU-1",
    item_title: "Synthetic Widget",
    ...overrides,
  };
}

const lookup = { subSourceId: 1, itemId: "166239358700", buyerUsername: "kraskir24" };

describe("findOrderDetailsForDisplay", () => {
  it("matches on the same four keys as the grounding query", async () => {
    const { calls, client } = fake([]);
    await findOrderDetailsForDisplay(client, lookup);

    const sql = calls[0]!.text;
    expect(sql).toContain("WHERE ss.source_id = $1::int");
    expect(sql).toContain("AND o.sub_source_id = $2::int");
    expect(sql).toContain("AND oii.item_id = $3");
    expect(sql).toContain("AND ci.ebay_buyer_id = $4");
    expect(calls[0]!.values).toEqual([2, 1, "166239358700", "kraskir24"]);
  });

  /**
   * `orders.market_place` is a country FK, not a platform code -- filtering on
   * it silently dropped every non-UK order the last time it was tried. eBay is
   * identified by `sub_source.source_id`, exactly as the grounding query does.
   */
  it("identifies eBay by sub_source.source_id, never by the region column", async () => {
    const { calls, client } = fake([]);
    await findOrderDetailsForDisplay(client, lookup);
    expect(calls[0]!.text).not.toContain("market_place");
  });

  it("returns one row per order, so several matches stay several", async () => {
    const { client } = fake([
      sourceRow({ order_number: "ORD-1001" }),
      sourceRow({ order_number: "ORD-1002" }),
    ]);
    const orders = await findOrderDetailsForDisplay(client, lookup);

    expect(orders.map((order) => order.orderNumber)).toEqual(["ORD-1001", "ORD-1002"]);
  });

  it("maps a row into the display fields, preferring the corrected SKU and carrier brand", async () => {
    const { client } = fake([sourceRow()]);
    const [order] = await findOrderDetailsForDisplay(client, lookup);

    expect(order).toEqual<SourceOrderDetail>({
      orderNumber: "ORD-1001",
      orderDate: "2026-08-01 10:00:00",
      orderStatus: "Completed",
      orderTotal: "34.99",
      customerName: "Test Person",
      sellerName: "test_storefront",
      trackingNumber: "TRK-1",
      shipmentStatus: "Completed",
      carrierName: "Royal Mail",
      deliveryAddress: "1 Test Street, Testville, Testshire, TE5 7ST",
      listingItemRef: "166239358700",
      sku: "REAL-SKU-1",
      productTitle: "Synthetic Widget",
    });
  });

  it("falls back to the address name for a customer with no first/last name", async () => {
    const { client } = fake([sourceRow({ first_name: null, last_name: "  " })]);
    const [order] = await findOrderDetailsForDisplay(client, lookup);
    expect(order!.customerName).toBe("Test Person");
  });

  it("leaves the customer name blank when the source recorded none at all", async () => {
    const { client } = fake([
      sourceRow({ first_name: null, last_name: null, address_name: null }),
    ]);
    const [order] = await findOrderDetailsForDisplay(client, lookup);
    expect(order!.customerName).toBeNull();
  });

  it("falls back to the trading name when a storefront handle is missing", async () => {
    const { client } = fake([sourceRow({ seller_name: null })]);
    const [order] = await findOrderDetailsForDisplay(client, lookup);
    expect(order!.sellerName).toBe("Test Company");
  });

  it("omits an address line the source left empty, and blanks an address with none", async () => {
    const { client } = fake([sourceRow({ address_line_1: "  ", city: null })]);
    const [withGaps] = await findOrderDetailsForDisplay(client, lookup);
    expect(withGaps!.deliveryAddress).toBe("Testshire, TE5 7ST");

    const { client: empty } = fake([
      sourceRow({
        address_line_1: null,
        address_line_2: null,
        address_line_3: null,
        city: null,
        region: null,
        postcode: null,
      }),
    ]);
    const [withNone] = await findOrderDetailsForDisplay(empty, lookup);
    expect(withNone!.deliveryAddress).toBeNull();
  });

  it("returns the total as the source recorded it, with no currency invented", async () => {
    const { client } = fake([sourceRow({ order_total: "1234.50" })]);
    const [order] = await findOrderDetailsForDisplay(client, lookup);
    expect(order!.orderTotal).toBe("1234.50");
  });

  it("reads and never writes", async () => {
    const { calls, client } = fake([sourceRow()]);
    await findOrderDetailsForDisplay(client, lookup);

    expect(calls).toHaveLength(1);
    const sql = calls[0]!.text.toUpperCase();
    expect(sql.startsWith("\nSELECT")).toBe(true);
    // Matched as statements, not as substrings: `SHIPMENT_CREATED_AT` contains
    // the letters of CREATE and is not a DDL statement.
    for (const statement of [
      "INSERT INTO",
      "UPDATE ",
      "DELETE FROM",
      "ALTER TABLE",
      "CREATE TABLE",
      "DROP TABLE",
    ]) {
      expect(sql).not.toContain(statement);
    }
  });
});

describe("loadOrderDisplayDetails", () => {
  const conversation = {
    marketplace: "ebay",
    subSourceId: 1,
    counterpartyRef: "kraskir24",
    listingItemRef: "166239358700",
  };

  it("looks up the orders for a complete eBay conversation", async () => {
    const { calls, client } = fake([sourceRow()]);
    const orders = await loadOrderDisplayDetails(client, conversation);

    expect(orders).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("queries nothing for a marketplace this display does not cover", async () => {
    const { calls, client } = fake([sourceRow()]);
    const orders = await loadOrderDisplayDetails(client, {
      ...conversation,
      marketplace: "amazon",
    });

    expect(orders).toEqual([]);
    expect(calls).toEqual([]);
  });

  /**
   * Without all three keys the query has no way to match: it would either find
   * nothing or, with a blank buyer, match far too much.
   */
  it("queries nothing when a matching key is missing", async () => {
    for (const incomplete of [
      { ...conversation, subSourceId: null },
      { ...conversation, listingItemRef: null },
      { ...conversation, listingItemRef: "   " },
    ]) {
      const { calls, client } = fake([sourceRow()]);
      expect(await loadOrderDisplayDetails(client, incomplete)).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it("writes nothing anywhere: it takes only the read-only source client", async () => {
    const { calls, client } = fake([sourceRow()]);
    await loadOrderDisplayDetails(client, conversation);
    expect(calls.every((call) => call.text.trimStart().startsWith("SELECT"))).toBe(true);
  });
});
