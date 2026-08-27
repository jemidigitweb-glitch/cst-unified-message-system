import { describe, expect, it } from "vitest";

import type { SourceOrderDetail } from "@/lib/domain/order";
import {
  EVIDENCE_CLOSEST_BEFORE,
  EVIDENCE_ORDER_NUMBER,
  EVIDENCE_SAME_BUYER,
  EVIDENCE_SAME_LISTING,
  EVIDENCE_SKU,
  EVIDENCE_TRACKING,
  type EvidenceMessage,
  matchEvidenceFor,
  orderByNearest,
} from "@/lib/domain/order-match-evidence";

/**
 * Evidence is only worth showing if a reviewer can trust every line of it. The
 * failure that matters is a false one: "Order number found in message" beside
 * an order the customer never mentioned sends someone to the wrong purchase
 * with more confidence than no evidence at all.
 */

function order(overrides: Partial<SourceOrderDetail> = {}): SourceOrderDetail {
  return {
    orderNumber: "00-00000-00000",
    orderDate: "2026-08-01 10:00:00",
    orderStatus: "Completed",
    orderTotal: "34.99",
    customerName: "Test Person",
    sellerName: "test_storefront",
    trackingNumber: "AB123456789GB",
    shipmentStatus: "Completed",
    carrierName: "Royal Mail",
    deliveryAddress: "1 Test Street, Testville, TE5 7ST",
    listingItemRef: "166239358700",
    sku: "REAL-SKU-0001",
    productTitle: "Synthetic Widget",
    ...overrides,
  };
}

function inbound(bodyText: string | null, sourceTimestamp = "2026-08-15 09:00:00"): EvidenceMessage {
  return { direction: "inbound", sourceTimestamp, bodyText, bodyDecodeStatus: "decoded" };
}

function outbound(bodyText: string, sourceTimestamp = "2026-08-16 09:00:00"): EvidenceMessage {
  return { direction: "outbound", sourceTimestamp, bodyText, bodyDecodeStatus: "decoded" };
}

const twoOrders = [
  order({ orderNumber: "00-00000-00000" }),
  order({
    orderNumber: "12-34567-89012",
    orderDate: "2026-08-09 12:00:00",
    trackingNumber: "ZZ987654321GB",
    sku: "REAL-SKU-0002",
  }),
];

describe("what every matching order has in common", () => {
  it("states the buyer and listing on each, because that is what the lookup matched on", () => {
    const evidence = matchEvidenceFor(twoOrders, [inbound("Hello, where is my parcel?")]);

    expect(evidence).toHaveLength(2);
    for (const entry of evidence) {
      expect(entry.reasons).toContain(EVIDENCE_SAME_BUYER);
      expect(entry.reasons).toContain(EVIDENCE_SAME_LISTING);
    }
  });

  it("keys each entry to the order it explains, in the order given", () => {
    const evidence = matchEvidenceFor(twoOrders, [inbound("Hello")]);
    expect(evidence.map((entry) => entry.orderNumber)).toEqual([
      "00-00000-00000",
      "12-34567-89012",
    ]);
  });
});

describe("an identifier the customer quoted", () => {
  it("credits the order whose number appears in the message, and only that one", () => {
    const evidence = matchEvidenceFor(twoOrders, [
      inbound("Hi, I'm asking about order 00-00000-00000 please."),
    ]);

    expect(evidence[0]!.reasons).toContain(EVIDENCE_ORDER_NUMBER);
    expect(evidence[1]!.reasons).not.toContain(EVIDENCE_ORDER_NUMBER);
  });

  it("matches through different separators and spacing", () => {
    for (const written of ["00 00000 00000", "0000000 00000", "00/00000/00000"]) {
      const evidence = matchEvidenceFor(twoOrders, [inbound(`Order ${written}, any update?`)]);
      expect(evidence[0]!.reasons, written).toContain(EVIDENCE_ORDER_NUMBER);
    }
  });

  it("credits the order whose tracking number appears in the message", () => {
    const evidence = matchEvidenceFor(twoOrders, [
      inbound("Tracking ZZ987654321GB says nothing has moved."),
    ]);

    expect(evidence[1]!.reasons).toContain(EVIDENCE_TRACKING);
    expect(evidence[0]!.reasons).not.toContain(EVIDENCE_TRACKING);
  });

  /**
   * A previous CST reply routinely quotes an order number. Reading it back
   * would be the system matching against its own words and reporting it as the
   * customer having identified their order.
   */
  it("ignores anything quoted in an outbound reply", () => {
    const evidence = matchEvidenceFor(twoOrders, [
      inbound("Hello, any news?"),
      outbound("Your order 00-00000-00000 was dispatched, tracking AB123456789GB."),
    ]);

    for (const entry of evidence) {
      expect(entry.reasons).not.toContain(EVIDENCE_ORDER_NUMBER);
      expect(entry.reasons).not.toContain(EVIDENCE_TRACKING);
    }
  });

  it("ignores a message body that could not be decoded", () => {
    const evidence = matchEvidenceFor(twoOrders, [
      { direction: "inbound", sourceTimestamp: "2026-08-15 09:00:00", bodyText: "order 00-00000-00000", bodyDecodeStatus: "undecodable" },
    ]);
    expect(evidence[0]!.reasons).not.toContain(EVIDENCE_ORDER_NUMBER);
  });

  it("ignores a missing or empty body rather than treating it as a weak signal", () => {
    for (const body of [null, "   "]) {
      const evidence = matchEvidenceFor(twoOrders, [inbound(body)]);
      expect(evidence[0]!.reasons).not.toContain(EVIDENCE_ORDER_NUMBER);
    }
  });

  /**
   * A short identifier hits inside unrelated words and reference numbers. A
   * containment match is only meaningful when the needle is long enough that
   * finding it means the customer typed it.
   */
  it("refuses to match an identifier too short to be distinctive", () => {
    const shortSku = [order({ sku: "AB1" }), order({ orderNumber: "12-34567-89012", sku: "XY2" })];
    const evidence = matchEvidenceFor(shortSku, [inbound("ab1 xy2 — is this right?")]);
    for (const entry of evidence) {
      expect(entry.reasons).not.toContain(EVIDENCE_SKU);
    }
  });
});

describe("product and SKU", () => {
  it("credits the order whose SKU the customer named", () => {
    const evidence = matchEvidenceFor(twoOrders, [inbound("I ordered REAL-SKU-0002 in white.")]);

    expect(evidence[1]!.reasons).toContain(EVIDENCE_SKU);
    expect(evidence[0]!.reasons).not.toContain(EVIDENCE_SKU);
  });

  /**
   * Where every matching order carries the same SKU, the line would appear on
   * all of them — true of everything, and so distinguishing nothing, while
   * reading to a reviewer as though it had narrowed something down.
   */
  it("offers no SKU evidence when every matching order has the same SKU", () => {
    const sameSku = [
      order({ orderNumber: "00-00000-00000", sku: "REAL-SKU-0001" }),
      order({ orderNumber: "12-34567-89012", sku: "REAL-SKU-0001" }),
    ];
    const evidence = matchEvidenceFor(sameSku, [inbound("REAL-SKU-0001 arrived damaged")]);

    for (const entry of evidence) {
      expect(entry.reasons).not.toContain(EVIDENCE_SKU);
    }
  });
});

describe("order date against the message date", () => {
  it("credits the order placed most recently before the customer wrote", () => {
    const evidence = matchEvidenceFor(twoOrders, [inbound("Any update?", "2026-08-15 09:00:00")]);

    // 09 Aug is nearer to 15 Aug than 01 Aug, and both precede it.
    expect(evidence[1]!.reasons).toContain(EVIDENCE_CLOSEST_BEFORE);
    expect(evidence[0]!.reasons).not.toContain(EVIDENCE_CLOSEST_BEFORE);
  });

  it("never credits an order placed after the message it supposedly concerns", () => {
    const evidence = matchEvidenceFor(
      [
        order({ orderNumber: "00-00000-00000", orderDate: "2026-08-01 10:00:00" }),
        order({ orderNumber: "12-34567-89012", orderDate: "2026-08-20 10:00:00" }),
      ],
      [inbound("Any update?", "2026-08-15 09:00:00")],
    );

    expect(evidence[0]!.reasons).toContain(EVIDENCE_CLOSEST_BEFORE);
    expect(evidence[1]!.reasons).not.toContain(EVIDENCE_CLOSEST_BEFORE);
  });

  it("uses the FIRST inbound message, not the latest", () => {
    const evidence = matchEvidenceFor(twoOrders, [
      inbound("First contact", "2026-08-05 09:00:00"),
      inbound("Chasing this up", "2026-09-01 09:00:00"),
    ]);

    // Only the 01 Aug order predates the first message; the 09 Aug one does not.
    expect(evidence[0]!.reasons).toContain(EVIDENCE_CLOSEST_BEFORE);
    expect(evidence[1]!.reasons).not.toContain(EVIDENCE_CLOSEST_BEFORE);
  });

  /**
   * Two orders on the same date is exactly the case a reviewer must look at.
   * Awarding the line to whichever happened to sort first would hide it.
   */
  it("credits neither order when two share the closest date", () => {
    const tied = [
      order({ orderNumber: "00-00000-00000", orderDate: "2026-08-01 10:00:00" }),
      order({ orderNumber: "12-34567-89012", orderDate: "2026-08-01 10:00:00" }),
    ];
    const evidence = matchEvidenceFor(tied, [inbound("Any update?", "2026-08-15 09:00:00")]);

    for (const entry of evidence) {
      expect(entry.reasons).not.toContain(EVIDENCE_CLOSEST_BEFORE);
    }
  });

  it("credits nobody when no order predates the message or no message exists", () => {
    const future = [order({ orderDate: "2026-09-01 10:00:00" })];
    expect(matchEvidenceFor(future, [inbound("Hi", "2026-08-15 09:00:00")])[0]!.reasons).not.toContain(
      EVIDENCE_CLOSEST_BEFORE,
    );
    expect(matchEvidenceFor(twoOrders, [])[0]!.reasons).not.toContain(EVIDENCE_CLOSEST_BEFORE);
    expect(matchEvidenceFor(twoOrders, [outbound("only a reply")])[0]!.reasons).not.toContain(
      EVIDENCE_CLOSEST_BEFORE,
    );
  });

  it("treats an order with no recorded date as having none, not as the earliest", () => {
    const undated = [
      order({ orderNumber: "00-00000-00000", orderDate: null }),
      order({ orderNumber: "12-34567-89012", orderDate: "2026-08-09 12:00:00" }),
    ];
    const evidence = matchEvidenceFor(undated, [inbound("Any update?", "2026-08-15 09:00:00")]);

    expect(evidence[0]!.reasons).not.toContain(EVIDENCE_CLOSEST_BEFORE);
    expect(evidence[1]!.reasons).toContain(EVIDENCE_CLOSEST_BEFORE);
  });
});

describe("evidence decides nothing", () => {
  /**
   * Two orders equally consistent with the message is a real outcome, and the
   * honest rendering is to say so twice rather than promote one.
   */
  it("gives both orders the same evidence when both genuinely match", () => {
    const bothQuoted = matchEvidenceFor(twoOrders, [
      inbound("I have orders 00-00000-00000 and 12-34567-89012 — which shipped?"),
    ]);

    expect(bothQuoted[0]!.reasons).toContain(EVIDENCE_ORDER_NUMBER);
    expect(bothQuoted[1]!.reasons).toContain(EVIDENCE_ORDER_NUMBER);
  });

  it("reorders nothing and drops nothing", () => {
    const evidence = matchEvidenceFor(twoOrders, [
      inbound("about order 12-34567-89012"),
    ]);
    // The order with more evidence is still second, exactly where it was given.
    expect(evidence.map((entry) => entry.orderNumber)).toEqual([
      "00-00000-00000",
      "12-34567-89012",
    ]);
  });

  it("returns sentences a reviewer can check, never order values", () => {
    const evidence = matchEvidenceFor(twoOrders, [
      inbound("order 00-00000-00000, tracking AB123456789GB, sku REAL-SKU-0001"),
    ]);

    for (const entry of evidence) {
      for (const reason of entry.reasons) {
        // No order number, tracking number, SKU, address or name is restated
        // as evidence text -- a reason says what matched, not what it matched.
        expect(reason).not.toMatch(/\d{4}/);
        expect(reason).not.toContain("REAL-SKU");
        expect(reason).not.toContain("Test Person");
        expect(reason).not.toContain("Test Street");
      }
    }
  });

  it("has no shape a verified fact could be built from", () => {
    const [entry] = matchEvidenceFor(twoOrders, [inbound("Hello")]);
    expect(entry).not.toHaveProperty("name");
    expect(entry).not.toHaveProperty("value");
    expect(Object.keys(entry!).sort()).toEqual(["orderNumber", "reasons"]);
  });
});

/**
 * Nearest first: the order a customer writing today is most likely asking
 * about, at the top. An ordering, never a choice.
 */
describe("nearest order first", () => {
  const wroteAt = "2026-08-15 09:00:00";

  it("puts the most recent order placed before the message first", () => {
    const sorted = orderByNearest(
      [
        order({ orderNumber: "A", orderDate: "2026-07-01 10:00:00" }),
        order({ orderNumber: "B", orderDate: "2026-08-09 12:00:00" }),
        order({ orderNumber: "C", orderDate: "2026-08-02 12:00:00" }),
      ],
      [inbound("Any update?", wroteAt)],
    );

    expect(sorted.map((entry) => entry.orderNumber)).toEqual(["B", "C", "A"]);
  });

  /**
   * An order placed after the message cannot be what it was about, but it is
   * still this buyer's order and is shown rather than dropped.
   */
  it("puts orders placed after the message last, soonest first, and hides none", () => {
    const sorted = orderByNearest(
      [
        order({ orderNumber: "LATER", orderDate: "2026-09-20 10:00:00" }),
        order({ orderNumber: "BEFORE", orderDate: "2026-08-01 10:00:00" }),
        order({ orderNumber: "SOON_AFTER", orderDate: "2026-08-16 10:00:00" }),
      ],
      [inbound("Any update?", wroteAt)],
    );

    expect(sorted.map((entry) => entry.orderNumber)).toEqual(["BEFORE", "SOON_AFTER", "LATER"]);
  });

  it("puts orders with no recorded date last, in the order given", () => {
    const sorted = orderByNearest(
      [
        order({ orderNumber: "UNDATED_1", orderDate: null }),
        order({ orderNumber: "DATED", orderDate: "2026-08-01 10:00:00" }),
        order({ orderNumber: "UNDATED_2", orderDate: null }),
      ],
      [inbound("Any update?", wroteAt)],
    );

    expect(sorted.map((entry) => entry.orderNumber)).toEqual(["DATED", "UNDATED_1", "UNDATED_2"]);
  });

  it("keeps two orders sharing a date in the order the source returned them", () => {
    const sorted = orderByNearest(
      [
        order({ orderNumber: "FIRST", orderDate: "2026-08-01 10:00:00" }),
        order({ orderNumber: "SECOND", orderDate: "2026-08-01 10:00:00" }),
      ],
      [inbound("Any update?", wroteAt)],
    );

    expect(sorted.map((entry) => entry.orderNumber)).toEqual(["FIRST", "SECOND"]);
  });

  it("falls back to most recent first when there is no customer message to compare against", () => {
    const sorted = orderByNearest(
      [
        order({ orderNumber: "OLD", orderDate: "2026-07-01 10:00:00" }),
        order({ orderNumber: "NEW", orderDate: "2026-08-09 12:00:00" }),
      ],
      [],
    );

    expect(sorted.map((entry) => entry.orderNumber)).toEqual(["NEW", "OLD"]);
  });

  it("drops nothing and duplicates nothing", () => {
    const input = [
      order({ orderNumber: "A", orderDate: "2026-07-01 10:00:00" }),
      order({ orderNumber: "B", orderDate: null }),
      order({ orderNumber: "C", orderDate: "2026-09-20 10:00:00" }),
    ];
    const sorted = orderByNearest(input, [inbound("Hi", wroteAt)]);

    expect(sorted).toHaveLength(input.length);
    expect(new Set(sorted.map((entry) => entry.orderNumber))).toEqual(new Set(["A", "B", "C"]));
  });

  it("leaves the input array untouched", () => {
    const input = [
      order({ orderNumber: "A", orderDate: "2026-07-01 10:00:00" }),
      order({ orderNumber: "B", orderDate: "2026-08-09 12:00:00" }),
    ];
    orderByNearest(input, [inbound("Hi", wroteAt)]);
    expect(input.map((entry) => entry.orderNumber)).toEqual(["A", "B"]);
  });
});
