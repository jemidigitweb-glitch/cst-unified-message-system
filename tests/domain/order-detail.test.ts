import { describe, expect, it } from "vitest";

import type { VerifiedFact } from "@/lib/domain/draft";
import {
  ORDER_DETAIL_FIELDS,
  type ConversationOrderContext,
  type OrderCandidate,
  type OrderDetail,
  type SourceOrderDetail,
  DISPATCH_STATUS_BY_SHIPMENT_STATUS,
  dispatchStatusFrom,
  orderDetailFromCandidate,
  orderDetailFromFacts,
  orderDetailFromSource,
  orderDetailsFrom,
} from "@/lib/domain/order";

/**
 * One format, however many orders matched.
 *
 * These tests exist to hold three properties that are easy to break by
 * accident and impossible to spot in review: every block has the same fields,
 * a field nothing recorded stays blank, and no block ever borrows a value from
 * another block.
 */

const conversationContext: ConversationOrderContext = {
  buyer: "kraskir24",
  market: "eBay",
};

const singleOrderFacts: VerifiedFact[] = [
  { name: "order_number", value: "ORD-1001" },
  { name: "order_status", value: "Dispatched" },
  { name: "order_date", value: "2026-08-01 10:00:00" },
  { name: "tracking_number", value: "TRK-1" },
  { name: "delivery_courier", value: "Royal Mail" },
  { name: "delivery_address", value: "1 Test Street, Testville, Testshire, TE5 7ST" },
  { name: "sku", value: "REAL-SKU-1" },
  { name: "product_title", value: "Synthetic Widget" },
];

function candidate(overrides: Partial<OrderCandidate> = {}): OrderCandidate {
  return {
    orderNumber: "ORD-1001",
    orderDate: "2026-08-01 10:00:00",
    orderStatus: "Dispatched",
    listingItemRef: "166239358700",
    ...overrides,
  };
}

describe("the field list", () => {
  it("is the requested order, and the same list for every block", () => {
    expect(ORDER_DETAIL_FIELDS.map((field) => field.label)).toEqual([
      "Order No",
      "Buyer",
      "Customer name",
      "Seller",
      "Date",
      "Total",
      "Status",
      "Tracking",
      "Shipment status",
      "Dispatch status",
      "Courier",
      "Delivery address",
      "Marketplace",
      "SKU",
      "Product details",
      "Listing reference",
    ]);
  });

  it("covers every field of an order detail, so no value can be silently unrendered", () => {
    const detail = orderDetailFromFacts(singleOrderFacts, conversationContext);
    expect(ORDER_DETAIL_FIELDS.map((field) => field.key).sort()).toEqual(
      (Object.keys(detail) as (keyof OrderDetail)[]).sort(),
    );
  });
});

describe("a single resolved order", () => {
  it("renders one block carrying every verified fact", () => {
    const [detail] = orderDetailsFrom(
      { facts: singleOrderFacts, candidates: [], orders: [] },
      conversationContext,
    );

    expect(detail).toEqual<OrderDetail>({
      orderNumber: "ORD-1001",
      buyer: "kraskir24",
      customerName: null,
      seller: null,
      date: "2026-08-01 10:00:00",
      total: null,
      status: "Dispatched",
      tracking: "TRK-1",
      shipmentStatus: null,
      dispatchStatus: null,
      courier: "Royal Mail",
      deliveryAddress: "1 Test Street, Testville, Testshire, TE5 7ST",
      market: "eBay",
      sku: "REAL-SKU-1",
      productDetails: "Synthetic Widget",
      listingReference: null,
      });
  });

  it("produces exactly one block", () => {
    expect(
      orderDetailsFrom({ facts: singleOrderFacts, candidates: [], orders: [] }, conversationContext),
    ).toHaveLength(1);
  });

  /**
   * The resolver returns only the facts the source actually recorded -- an
   * order with no shipment yields no tracking_number fact at all. That must
   * come through as a blank field, not as a missing row or a stand-in value.
   */
  it("leaves a fact the resolver did not return blank", () => {
    const withoutShipment = singleOrderFacts.filter(
      (fact) => !["tracking_number", "delivery_courier", "delivery_address"].includes(fact.name),
    );

    const detail = orderDetailFromFacts(withoutShipment, conversationContext);

    expect(detail.tracking).toBeNull();
    expect(detail.courier).toBeNull();
    expect(detail.deliveryAddress).toBeNull();
    expect(detail.orderNumber).toBe("ORD-1001");
  });

  it("treats an empty or whitespace value as not recorded", () => {
    const detail = orderDetailFromFacts(
      [{ name: "order_number", value: "   " }],
      { buyer: "", market: null },
    );
    expect(detail.orderNumber).toBeNull();
    expect(detail.buyer).toBeNull();
    expect(detail.market).toBeNull();
  });

  /**
   * Nothing in the pipeline captures a customer name, a seller identity, an
   * order total or a shipment state. Each stays blank rather than being
   * derived from something that happens to be nearby.
   */
  it("invents no customer name, seller, total or tracking status", () => {
    const detail = orderDetailFromFacts(singleOrderFacts, conversationContext);
    expect(detail.customerName).toBeNull();
    expect(detail.seller).toBeNull();
    expect(detail.total).toBeNull();
    expect(detail.shipmentStatus).toBeNull();
  });
});

describe("several matching orders", () => {
  const candidates = [
    candidate({ orderNumber: "ORD-1001" }),
    candidate({ orderNumber: "ORD-1002", orderDate: "2026-08-10 09:30:00", orderStatus: "New" }),
    candidate({ orderNumber: "ORD-1003", orderDate: null, orderStatus: null }),
  ];

  it("renders one block per order, never one merged block", () => {
    const details = orderDetailsFrom({ facts: [], candidates, orders: [] }, conversationContext);

    expect(details).toHaveLength(3);
    expect(details.map((detail) => detail.orderNumber)).toEqual([
      "ORD-1001",
      "ORD-1002",
      "ORD-1003",
    ]);
  });

  it("gives every block the same fields as a single-order block", () => {
    const single = orderDetailFromFacts(singleOrderFacts, conversationContext);
    for (const detail of orderDetailsFrom({ facts: [], candidates, orders: [] }, conversationContext)) {
      expect(Object.keys(detail).sort()).toEqual(Object.keys(single).sort());
    }
  });

  it("blanks what a candidate never recorded, rather than borrowing it", () => {
    const [first] = orderDetailsFrom({ facts: [], candidates, orders: [] }, conversationContext);

    expect(first).toEqual<OrderDetail>({
      orderNumber: "ORD-1001",
      buyer: "kraskir24",
      customerName: null,
      seller: null,
      date: "2026-08-01 10:00:00",
      total: null,
      status: "Dispatched",
      tracking: null,
      shipmentStatus: null,
      dispatchStatus: null,
      courier: null,
      deliveryAddress: null,
      market: "eBay",
      sku: null,
      productDetails: null,
      listingReference: null,
      });
  });

  /**
   * The merge this must never perform: one order has a tracking number, the
   * others do not, and a "helpful" fill would put the first order's shipment
   * against all three.
   */
  it("never copies a value from one order into another", () => {
    const details = orderDetailsFrom(
      {
        facts: [],
        orders: [],
        candidates: [
          candidate({ orderNumber: "ORD-1001", orderStatus: "Dispatched" }),
          candidate({ orderNumber: "ORD-1002", orderStatus: null, orderDate: null }),
        ],
      },
      conversationContext,
    );

    expect(details[1]!.status).toBeNull();
    expect(details[1]!.date).toBeNull();
    expect(details[1]!.tracking).toBeNull();
    expect(details[1]!.orderNumber).toBe("ORD-1002");
  });

  it("keeps the buyer and market on every block, because both are what matched", () => {
    for (const detail of orderDetailsFrom({ facts: [], candidates, orders: [] }, conversationContext)) {
      expect(detail.buyer).toBe("kraskir24");
      expect(detail.market).toBe("eBay");
    }
  });

  it("carries no listing reference into a block, since a listing id is not an order field", () => {
    const detail = orderDetailFromCandidate(candidate(), conversationContext);
    expect(JSON.stringify(detail)).not.toContain("166239358700");
  });
});

describe("nothing matched", () => {
  it("produces no blocks at all, rather than one blank block", () => {
    expect(orderDetailsFrom({ facts: [], candidates: [], orders: [] }, conversationContext)).toEqual([]);
  });

  it("omits the buyer where the stored reference is not a verified identity", () => {
    const detail = orderDetailFromCandidate(candidate(), { buyer: null, market: "Temu" });
    expect(detail.buyer).toBeNull();
    expect(detail.market).toBe("Temu");
  });
});

/**
 * The live source read is what fills the block. These tests hold the mapping
 * that made the blank fields go away, and the two places it must still refuse
 * to fill.
 */
const sourceOrderFixture: SourceOrderDetail = {
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
};

describe("an order read live from the source", () => {
  const sourceOrder = sourceOrderFixture;

  it("fills every field the source recorded", () => {
    const [detail] = orderDetailsFrom(
      { facts: [], candidates: [], orders: [sourceOrder] },
      conversationContext,
    );

    expect(detail).toEqual<OrderDetail>({
      orderNumber: "ORD-1001",
      buyer: "kraskir24",
      customerName: "Test Person",
      seller: "test_storefront",
      date: "2026-08-01 10:00:00",
      total: "34.99",
      status: "Completed",
      tracking: "TRK-1",
      shipmentStatus: "Completed",
      dispatchStatus: "Dispatched",
      courier: "Royal Mail",
      deliveryAddress: "1 Test Street, Testville, Testshire, TE5 7ST",
      market: "eBay",
      sku: "REAL-SKU-1",
      productDetails: "Synthetic Widget",
      listingReference: "166239358700",
      });
  });

  it("leaves blank whatever the source did not record", () => {
    const detail = orderDetailFromSource(
      {
        ...sourceOrder,
        customerName: null,
        orderTotal: null,
        trackingNumber: null,
        shipmentStatus: null,
        carrierName: null,
        deliveryAddress: null,
        sku: null,
        productTitle: null,
      },
      conversationContext,
    );

    expect(detail.customerName).toBeNull();
    expect(detail.total).toBeNull();
    expect(detail.tracking).toBeNull();
    expect(detail.shipmentStatus).toBeNull();
    expect(detail.courier).toBeNull();
    expect(detail.deliveryAddress).toBeNull();
    expect(detail.sku).toBeNull();
    expect(detail.productDetails).toBeNull();
    // ...while what it did record is untouched.
    expect(detail.orderNumber).toBe("ORD-1001");
    expect(detail.seller).toBe("test_storefront");
  });

  it("renders one block per matching order, filled independently", () => {
    const details = orderDetailsFrom(
      {
        facts: [],
        candidates: [],
        orders: [
          sourceOrder,
          {
            ...sourceOrder,
            orderNumber: "ORD-1002",
            trackingNumber: null,
            shipmentStatus: "New",
            carrierName: null,
            orderTotal: "12.50",
          },
        ],
      },
      conversationContext,
    );

    expect(details).toHaveLength(2);
    expect(details[0]!.tracking).toBe("TRK-1");
    // The second order has no shipment; the first order's must not leak into it.
    expect(details[1]!.tracking).toBeNull();
    expect(details[1]!.courier).toBeNull();
    expect(details[1]!.total).toBe("12.50");
  });

  /**
   * Precedence, and why it matters: the live rows are the only source carrying
   * a customer name, seller or total, so whenever they exist they are what is
   * shown -- never spliced together with the thinner cached views of the same
   * orders.
   */
  it("is preferred over the cached candidates and facts, and never blended with them", () => {
    const details = orderDetailsFrom(
      { facts: singleOrderFacts, candidates: [candidate()], orders: [sourceOrder] },
      conversationContext,
    );

    expect(details).toHaveLength(1);
    expect(details[0]!.customerName).toBe("Test Person");
    expect(details[0]!.total).toBe("34.99");
  });

  it("falls back to the cached view when the source read returned nothing", () => {
    const details = orderDetailsFrom(
      { facts: singleOrderFacts, candidates: [], orders: [] },
      conversationContext,
    );

    expect(details).toHaveLength(1);
    expect(details[0]!.orderNumber).toBe("ORD-1001");
    expect(details[0]!.customerName).toBeNull();
  });

  it("adds no currency symbol to the total, because the source stores none", () => {
    const detail = orderDetailFromSource(sourceOrder, conversationContext);
    expect(detail.total).toBe("34.99");
    expect(detail.total).not.toMatch(/[£$€]/);
  });
});

/**
 * Dispatch status restates the shipment record in the reviewer's words. Both
 * are shown together, so the plain-English version can never be mistaken for a
 * value the source recorded — and it must never grow a delivery meaning,
 * because no delivery data exists.
 */
describe("dispatch status beside shipment status", () => {
  const cases: [string, string][] = [
    ["Completed", "Dispatched"],
    ["New", "Not dispatched"],
    ["Cancelled", "Dispatch cancelled"],
  ];

  it.each(cases)("maps shipment.status %s to %s, keeping the original", (stored, expected) => {
    expect(dispatchStatusFrom(stored)).toBe(expected);

    const detail = orderDetailFromSource(
      { ...sourceOrderFixture, shipmentStatus: stored },
      conversationContext,
    );
    expect(detail.shipmentStatus).toBe(stored);
    expect(detail.dispatchStatus).toBe(expected);
  });

  it("shows both fields, in that order, in the one shared field list", () => {
    const labels = ORDER_DETAIL_FIELDS.map((field) => field.label);
    expect(labels).toContain("Shipment status");
    expect(labels).toContain("Dispatch status");
    expect(labels.indexOf("Shipment status")).toBeLessThan(labels.indexOf("Dispatch status"));
  });

  /**
   * No Delivered, In transit or Out for delivery: the source has no delivery
   * data at all, so any such value would be invented.
   */
  it("never produces a delivery state", () => {
    const produced = Object.values(DISPATCH_STATUS_BY_SHIPMENT_STATUS);
    expect(produced).toEqual(["Dispatched", "Not dispatched", "Dispatch cancelled"]);
    for (const value of produced) {
      expect(value).not.toMatch(/deliver|transit|arriv|out for/i);
    }
  });

  it("leaves an unrecognised or missing status blank rather than guessing", () => {
    for (const unknown of ["Delivered", "Pending", "", "  ", "completed"]) {
      expect(dispatchStatusFrom(unknown), unknown).toBeNull();
    }
    expect(dispatchStatusFrom(null)).toBeNull();
  });

  it("keeps the raw value visible even when it cannot be translated", () => {
    const detail = orderDetailFromSource(
      { ...sourceOrderFixture, shipmentStatus: "SomethingNew" },
      conversationContext,
    );
    expect(detail.shipmentStatus).toBe("SomethingNew");
    expect(detail.dispatchStatus).toBeNull();
  });

  it("leaves both blank for a cached or candidate order, which carries no shipment record", () => {
    const fromCandidate = orderDetailFromCandidate(candidate(), conversationContext);
    expect(fromCandidate.shipmentStatus).toBeNull();
    expect(fromCandidate.dispatchStatus).toBeNull();

    const fromFacts = orderDetailFromFacts(singleOrderFacts, conversationContext);
    expect(fromFacts.shipmentStatus).toBeNull();
    expect(fromFacts.dispatchStatus).toBeNull();
  });
});
