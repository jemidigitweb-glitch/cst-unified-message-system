import { describe, expect, it } from "vitest";

import {
  type Writable,
  getContextItems,
  getContextSnapshot,
  saveAmbiguousSnapshot,
  saveNoOrderSnapshot,
  saveSingleOrderSnapshot,
} from "@/lib/repositories/context-snapshot-repository";

function fake(responses: unknown[][]) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let index = 0;
  const client: Writable = {
    query: async (config) => {
      calls.push(config);
      return { rows: responses[index++] ?? [] };
    },
  };
  return { calls, client };
}

/** Always throws, to prove a write failure is caught rather than propagated. */
function failingClient(): Writable {
  return {
    query: async () => {
      throw new Error("synthetic connection failure");
    },
  };
}

describe("getContextSnapshot / getContextItems", () => {
  it("returns null when no snapshot has ever been recorded for the conversation", async () => {
    const { client } = fake([[]]);
    expect(await getContextSnapshot(client, "32103")).toBeNull();
  });

  it("returns the stored snapshot row", async () => {
    const row = {
      id: "1",
      conversation_id: "32103",
      resolution: "single_order",
      sub_source_id: 1,
      order_number: "ORD-1001",
      order_date: "2026-08-01",
      order_status_summary: "Dispatched",
      listing_item_ref: "166239358700",
      verification_method: "deterministic_single",
    };
    const { client } = fake([[row]]);
    expect(await getContextSnapshot(client, "32103")).toEqual(row);
  });

  it("reads context_items scoped to the snapshot id", async () => {
    const { calls, client } = fake([[{ id: "9", exact_sku: "SKU-1", product_title: "Widget", image_url: null }]]);
    const items = await getContextItems(client, "1");
    expect(calls[0]!.values).toEqual(["1"]);
    expect(items).toHaveLength(1);
    expect(items[0]!.exact_sku).toBe("SKU-1");
  });
});

describe("saveSingleOrderSnapshot", () => {
  const baseInput = {
    conversationId: "32103",
    subSourceId: 1,
    orderNumber: "ORD-1001",
    orderDate: "2026-08-01",
    orderStatusSummary: "Dispatched",
    trackingNumber: "TRK-1",
    deliveryCourier: "Royal Mail",
    deliveryAddress: "1 Test Street, Testville, Testshire, TE5 7ST",
    orderRowId: "501",
    listingItemRef: "166239358700",
  };

  it("upserts the snapshot as single_order / deterministic_single, never user_confirmed", async () => {
    const { calls, client } = fake([[{ id: "1" }]]);

    const result = await saveSingleOrderSnapshot(client, { ...baseInput, item: null });

    expect(result).toEqual({ saved: true });
    expect(calls[0]!.text).toContain("'single_order'");
    expect(calls[0]!.text).toContain("'deterministic_single'");
    expect(calls[0]!.values).toEqual([
      "32103",
      1,
      "ORD-1001",
      "2026-08-01",
      "Dispatched",
      "TRK-1",
      "Royal Mail",
      "1 Test Street, Testville, Testshire, TE5 7ST",
      ["501"],
      "166239358700",
    ]);
  });

  it("persists the shipment facts (tracking number, courier, address) alongside the order facts", async () => {
    const { calls, client } = fake([[{ id: "1" }]]);

    await saveSingleOrderSnapshot(client, { ...baseInput, item: null });

    expect(calls[0]!.text).toContain("tracking_number");
    expect(calls[0]!.text).toContain("delivery_courier");
    expect(calls[0]!.text).toContain("delivery_address");
    expect(calls[0]!.values).toContain("TRK-1");
    expect(calls[0]!.values).toContain("Royal Mail");
    expect(calls[0]!.values).toContain("1 Test Street, Testville, Testshire, TE5 7ST");
  });

  it("skips the item insert entirely when there is no verified SKU, rather than storing a placeholder", async () => {
    const { calls, client } = fake([[{ id: "1" }]]);

    await saveSingleOrderSnapshot(client, { ...baseInput, item: null });

    // upsert snapshot, delete old items -- and nothing else.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toContain("DELETE FROM cst_app.context_items");
  });

  it("inserts the item row when a verified SKU is present", async () => {
    const { calls, client } = fake([[{ id: "1" }]]);

    await saveSingleOrderSnapshot(client, {
      ...baseInput,
      item: {
        exactSku: "REAL-SKU-1",
        productTitle: "Synthetic Widget",
        imageUrl: "https://example.test/widget.png",
        sourceOrderItemId: "9001",
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[2]!.text).toContain("INSERT INTO cst_app.context_items");
    expect(calls[2]!.values).toEqual([
      "1",
      "REAL-SKU-1",
      "Synthetic Widget",
      null,
      "https://example.test/widget.png",
      "9001",
      "501",
    ]);
  });

  it("never throws: a write failure is caught and reported as not saved", async () => {
    const result = await saveSingleOrderSnapshot(failingClient(), { ...baseInput, item: null });
    expect(result).toEqual({ saved: false });
  });
});

describe("saveAmbiguousSnapshot", () => {
  it("clears any order identity on the snapshot and records every candidate", async () => {
    const { calls, client } = fake([[], [], []]);
    const candidates = [
      {
        subSourceId: 1,
        orderNumber: "ORD-1001",
        orderDate: "2026-08-01",
        orderStatusSummary: "Dispatched",
        orderRowId: "501",
        listingItemRef: "266102089152",
      },
      {
        subSourceId: 1,
        orderNumber: "ORD-1002",
        orderDate: "2026-08-10",
        orderStatusSummary: "New",
        orderRowId: "502",
        listingItemRef: "266102089152",
      },
    ];

    const result = await saveAmbiguousSnapshot(client, "9999", candidates);

    expect(result).toEqual({ saved: true });
    expect(calls[0]!.text).toContain("'ambiguous'");
    expect(calls[1]!.text).toContain("DELETE FROM cst_app.context_order_candidates");
    expect(calls[2]!.values).toEqual(["9999", 1, "ORD-1001", "2026-08-01", "Dispatched", ["501"], 1, "266102089152"]);
    expect(calls[3]!.values).toEqual(["9999", 1, "ORD-1002", "2026-08-10", "New", ["502"], 1, "266102089152"]);
  });

  it("clears a previously-stored tracking number, courier and address on the snapshot itself", async () => {
    // A conversation that flips from single_order to ambiguous (a re-resolve
    // after a new order appeared) must not leave the old shipment facts
    // sitting on the row -- the widened CHECK forbids it, and a stale value
    // there would be read back as verified on any future no-op branch.
    const { calls, client } = fake([[]]);
    await saveAmbiguousSnapshot(client, "9999", []);
    expect(calls[0]!.text).toContain("tracking_number       = NULL");
    expect(calls[0]!.text).toContain("delivery_courier      = NULL");
    expect(calls[0]!.text).toContain("delivery_address      = NULL");
  });

  it("never throws: a write failure is caught and reported as not saved", async () => {
    const result = await saveAmbiguousSnapshot(failingClient(), "9999", []);
    expect(result).toEqual({ saved: false });
  });
});

describe("saveNoOrderSnapshot", () => {
  it("upserts the snapshot as no_order with no verification", async () => {
    const { calls, client } = fake([[]]);
    const result = await saveNoOrderSnapshot(client, "32104");
    expect(result).toEqual({ saved: true });
    expect(calls[0]!.text).toContain("'no_order'");
    expect(calls[0]!.values).toEqual(["32104"]);
  });

  it("clears a previously-stored tracking number, courier and address on the snapshot itself", async () => {
    const { calls, client } = fake([[]]);
    await saveNoOrderSnapshot(client, "32104");
    expect(calls[0]!.text).toContain("tracking_number       = NULL");
    expect(calls[0]!.text).toContain("delivery_courier      = NULL");
    expect(calls[0]!.text).toContain("delivery_address      = NULL");
  });

  it("never throws: a write failure is caught and reported as not saved", async () => {
    const result = await saveNoOrderSnapshot(failingClient(), "32104");
    expect(result).toEqual({ saved: false });
  });
});
