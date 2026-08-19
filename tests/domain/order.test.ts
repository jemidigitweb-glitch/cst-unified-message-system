import { describe, expect, it } from "vitest";

import {
  ACTIVE_ORDER_STATUSES,
  TERMINATED_ORDER_STATUSES,
  isActiveOrderStatus,
  isTerminatedOrderStatus,
  logicalOrderKeyOf,
  mayUseOrderFacts,
} from "@/lib/domain/order";

describe("logical order identity", () => {
  it("keys on (sub_source_id, order_id), not a single orders.id", () => {
    // Placeholder digits only — never a real marketplace order number.
    expect(logicalOrderKeyOf({ subSourceId: 1, orderId: "00-00000-00000" })).toBe(
      "1:00-00000-00000",
    );
  });

  it("distinguishes the same order number across different sub_sources", () => {
    const a = logicalOrderKeyOf({ subSourceId: 1, orderId: "X-1" });
    const b = logicalOrderKeyOf({ subSourceId: 27, orderId: "X-1" });
    expect(a).not.toBe(b);
  });
});

describe("order status classification", () => {
  it("keeps refunded orders context-relevant", () => {
    expect(isActiveOrderStatus("Refunded")).toBe(true);
    expect(isTerminatedOrderStatus("Refunded")).toBe(false);
  });

  it("classifies the full active set", () => {
    for (const status of ACTIVE_ORDER_STATUSES) {
      expect(isActiveOrderStatus(status)).toBe(true);
      expect(isTerminatedOrderStatus(status)).toBe(false);
    }
  });

  it("treats only Deleted and Cancelled as terminated", () => {
    expect(TERMINATED_ORDER_STATUSES).toEqual(["Deleted", "Cancelled"]);
    for (const status of TERMINATED_ORDER_STATUSES) {
      expect(isTerminatedOrderStatus(status)).toBe(true);
      expect(isActiveOrderStatus(status)).toBe(false);
    }
  });

  it("does not classify an unknown status as active", () => {
    expect(isActiveOrderStatus("Shipped")).toBe(false);
  });
});

describe("grounding AI facts on order context", () => {
  it("permits order facts only when exactly one order resolved", () => {
    expect(mayUseOrderFacts("single_order")).toBe(true);
  });

  it("blocks order facts when the context is ambiguous or absent", () => {
    expect(mayUseOrderFacts("ambiguous")).toBe(false);
    expect(mayUseOrderFacts("no_order")).toBe(false);
    expect(mayUseOrderFacts("needs_context")).toBe(false);
    expect(mayUseOrderFacts("terminated_order")).toBe(false);
  });
});
