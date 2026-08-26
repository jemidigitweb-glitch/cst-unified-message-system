import { describe, expect, it } from "vitest";

import { resolveEbayOrderContext } from "@/lib/context/resolve-order-context";
import type { Queryable as SourceQueryable } from "@/lib/repositories/order-context-repository";
import type { Writable as AppWritable } from "@/lib/repositories/context-snapshot-repository";

type Call = { text: string; values?: unknown[] };

/**
 * A fake `cst_app` client that dispatches by which statement ran, not by call
 * order -- the orchestrator's control flow (does a snapshot already exist? is
 * there one candidate or several?) decides which statements run at all, so a
 * position-indexed fake would be too brittle to express every branch.
 */
function fakeAppClient(options: {
  existingSnapshot?: unknown;
  existingItems?: unknown[];
} = {}) {
  const calls: Call[] = [];
  const client: AppWritable = {
    query: async (config) => {
      calls.push(config);
      const { text } = config;
      if (text.includes("FROM cst_app.context_snapshots") && text.startsWith("\nSELECT")) {
        return { rows: options.existingSnapshot ? [options.existingSnapshot] : [] };
      }
      if (text.includes("FROM cst_app.context_items") && text.includes("SELECT")) {
        return { rows: options.existingItems ?? [] };
      }
      if (text.includes("INSERT INTO cst_app.context_snapshots")) {
        return { rows: [{ id: "1" }] };
      }
      return { rows: [] };
    },
  };
  return { calls, client };
}

function fakeSourceClient(rows: unknown[]) {
  const calls: Call[] = [];
  const client: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      return { rows };
    },
  };
  return { calls, client };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
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

const baseConversation = {
  id: "32103",
  marketplace: "ebay",
  subSourceId: 1,
  counterpartyRef: "kraskir24",
  listingItemRef: "166239358700",
};

describe("resolveEbayOrderContext — non-eBay short-circuit", () => {
  it("returns no facts and touches neither database for a non-eBay conversation", async () => {
    const { calls: appCalls, client: appClient } = fakeAppClient();
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayOrderContext(sourceClient, appClient, {
      ...baseConversation,
      marketplace: "amazon",
    });

    expect(facts).toEqual([]);
    expect(appCalls).toHaveLength(0);
    expect(sourceCalls).toHaveLength(0);
  });
});

describe("resolveEbayOrderContext — cached snapshot", () => {
  it("reads a cached single_order snapshot back from context_items, never re-querying the source", async () => {
    const { client: appClient } = fakeAppClient({
      existingSnapshot: {
        id: "1",
        conversation_id: "32103",
        resolution: "single_order",
        sub_source_id: 1,
        order_number: "ORD-1001",
        order_date: "2026-08-01",
        order_status_summary: "Dispatched",
        tracking_number: "TRK-1",
        delivery_courier: "Royal Mail",
        delivery_address: "1 Test Street, Testville, Testshire, TE5 7ST",
        listing_item_ref: "166239358700",
        verification_method: "deterministic_single",
      },
      existingItems: [{ id: "9", exact_sku: "REAL-SKU-1", product_title: "Synthetic Widget", image_url: null }],
    });
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayOrderContext(sourceClient, appClient, baseConversation);

    expect(sourceCalls).toHaveLength(0);
    expect(facts).toEqual(
      expect.arrayContaining([
        { name: "order_number", value: "ORD-1001" },
        { name: "order_status", value: "Dispatched" },
        { name: "order_date", value: "2026-08-01" },
        { name: "tracking_number", value: "TRK-1" },
        { name: "delivery_courier", value: "Royal Mail" },
        { name: "delivery_address", value: "1 Test Street, Testville, Testshire, TE5 7ST" },
        { name: "sku", value: "REAL-SKU-1" },
        { name: "product_title", value: "Synthetic Widget" },
      ]),
    );
    // All eight fact names, and no others -- a cached read must not be a
    // narrower answer than the first resolution that produced it.
    expect(facts).toHaveLength(8);
  });

  it("returns no facts for a cached ambiguous snapshot, and does not re-resolve it", async () => {
    const { client: appClient } = fakeAppClient({
      existingSnapshot: {
        id: "2",
        conversation_id: "32103",
        resolution: "ambiguous",
        sub_source_id: null,
        order_number: null,
        order_date: null,
        order_status_summary: null,
        listing_item_ref: null,
        verification_method: "none",
      },
    });
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayOrderContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([]);
    expect(sourceCalls).toHaveLength(0);
  });
});

describe("resolveEbayOrderContext — first-time resolution", () => {
  it("records no_order and returns no facts when the conversation has no verified buyer or item reference", async () => {
    const { calls: appCalls, client: appClient } = fakeAppClient();
    const { calls: sourceCalls, client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayOrderContext(sourceClient, appClient, {
      ...baseConversation,
      listingItemRef: null,
    });

    expect(facts).toEqual([]);
    expect(sourceCalls).toHaveLength(0);
    expect(appCalls.some((c) => c.text.includes("'no_order'"))).toBe(true);
  });

  it("records no_order and returns no facts when zero orders match", async () => {
    const { calls: appCalls, client: appClient } = fakeAppClient();
    const { client: sourceClient } = fakeSourceClient([]);

    const facts = await resolveEbayOrderContext(sourceClient, appClient, baseConversation);

    expect(facts).toEqual([]);
    expect(appCalls.some((c) => c.text.includes("'no_order'"))).toBe(true);
  });

  it("resolves a single match to deterministic_single and returns exactly the eight-fact vocabulary, correctly grounded", async () => {
    const { calls: appCalls, client: appClient } = fakeAppClient();
    const { client: sourceClient } = fakeSourceClient([candidateRow()]);

    const facts = await resolveEbayOrderContext(sourceClient, appClient, baseConversation);

    const singleOrderCall = appCalls.find((c) => c.text.includes("'single_order'"));
    expect(singleOrderCall).toBeDefined();
    expect(singleOrderCall!.text).toContain("'deterministic_single'");

    expect(facts).toEqual(
      expect.arrayContaining([
        { name: "order_number", value: "ORD-1001" },
        { name: "order_status", value: "Dispatched" },
        { name: "order_date", value: "2026-08-01 10:00:00" },
        { name: "tracking_number", value: "TRK-1" },
        { name: "delivery_courier", value: "Royal Mail" },
        {
          name: "delivery_address",
          value: "1 Test Street, Testville, Testshire, TE5 7ST",
        },
        { name: "sku", value: "REAL-SKU-1" },
        { name: "product_title", value: "Synthetic Widget" },
      ]),
    );
    expect(facts).toHaveLength(8);
    expect(new Set(facts.map((f) => f.name)).size).toBe(8);
  });

  it("marks ambiguous and returns no facts when more than one order matches, never guessing", async () => {
    const { calls: appCalls, client: appClient } = fakeAppClient();
    const { client: sourceClient } = fakeSourceClient([
      candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
      candidateRow({ order_row_id: "502", order_number: "ORD-1002" }),
      candidateRow({ order_row_id: "503", order_number: "ORD-1003" }),
    ]);

    const facts = await resolveEbayOrderContext(sourceClient, appClient, {
      ...baseConversation,
      counterpartyRef: "blessedbe",
      listingItemRef: "266102089152",
    });

    expect(facts).toEqual([]);
    const ambiguousCall = appCalls.find((c) => c.text.includes("'ambiguous'"));
    expect(ambiguousCall).toBeDefined();
    const candidateInserts = appCalls.filter((c) => c.text.includes("INSERT INTO cst_app.context_order_candidates"));
    expect(candidateInserts).toHaveLength(3);
  });
});

/**
 * A stateful fake that behaves like the real UPSERT ... ON CONFLICT
 * (conversation_id) DO UPDATE: one row per conversation, second write
 * replaces the first rather than adding to it. This is what lets the round
 * trip below prove "first resolution stores everything, a second read
 * returns exactly that, and there is still only one row" against the actual
 * SQL text and parameter order the repository sends -- not a re-statement of
 * what the repository is supposed to do.
 */
function statefulAppClient() {
  let snapshot: Record<string, unknown> | null = null;
  let items: Record<string, unknown>[] = [];
  let nextSnapshotId = 1;
  const inserts: string[] = [];

  const client: AppWritable = {
    query: async (config) => {
      const { text, values = [] } = config;

      if (text.includes("FROM cst_app.context_snapshots") && text.startsWith("\nSELECT")) {
        return { rows: snapshot ? [snapshot] : [] };
      }
      if (text.includes("FROM cst_app.context_items") && text.includes("SELECT")) {
        return { rows: items };
      }
      if (text.includes("INSERT INTO cst_app.context_snapshots") && text.includes("'single_order'")) {
        inserts.push("snapshot");
        const id = snapshot ? (snapshot.id as string) : String(nextSnapshotId++);
        snapshot = {
          id,
          conversation_id: values[0],
          resolution: "single_order",
          sub_source_id: values[1],
          order_number: values[2],
          order_date: values[3],
          order_status_summary: values[4],
          tracking_number: values[5],
          delivery_courier: values[6],
          delivery_address: values[7],
          listing_item_ref: values[9],
          verification_method: "deterministic_single",
        };
        return { rows: [{ id }] };
      }
      if (text.includes("DELETE FROM cst_app.context_items")) {
        items = [];
        return { rows: [] };
      }
      if (text.includes("INSERT INTO cst_app.context_items")) {
        inserts.push("item");
        items = [{ id: "1", exact_sku: values[1], product_title: values[2], image_url: values[4] }];
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { client, insertCount: () => inserts.filter((k) => k === "snapshot").length };
}

describe("resolveEbayOrderContext — first resolution then cached read, round trip", () => {
  it("stores all eight facts on first resolution and returns the identical set on a cached re-read, with no duplicate row", async () => {
    const { client: appClient, insertCount } = statefulAppClient();
    const { client: sourceClient } = fakeSourceClient([candidateRow()]);

    const first = await resolveEbayOrderContext(sourceClient, appClient, baseConversation);
    expect(first).toHaveLength(8);
    expect(new Set(first.map((f) => f.name))).toEqual(
      new Set([
        "order_number",
        "order_status",
        "order_date",
        "tracking_number",
        "delivery_courier",
        "delivery_address",
        "sku",
        "product_title",
      ]),
    );

    // A source that would now answer differently (or error) proves the
    // second call never reaches it -- the cached snapshot is authoritative.
    const second = await resolveEbayOrderContext(
      { query: async () => { throw new Error("must not query the source on a cached read"); } },
      appClient,
      baseConversation,
    );

    expect(second).toEqual(first);
    expect(insertCount()).toBe(1);
  });
});
