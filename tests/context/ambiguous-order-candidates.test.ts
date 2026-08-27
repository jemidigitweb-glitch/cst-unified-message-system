import { describe, expect, it } from "vitest";

import { resolveEbayOrderContext } from "@/lib/context/resolve-order-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { OrderCandidate } from "@/lib/domain/order";
import {
  type Writable as AppWritable,
  getOrderCandidates,
} from "@/lib/repositories/context-snapshot-repository";
import type { Queryable as SourceQueryable } from "@/lib/repositories/order-context-repository";

/**
 * The round trip behind the ambiguous sidebar: the resolver writes candidates,
 * and the new reader reads back exactly those, while the facts it hands the
 * draft pipeline stay empty.
 *
 * Asserted against a stateful fake that behaves like the real tables -- the
 * resolver's own SQL goes in, the repository's own SQL comes out -- rather
 * than by handing the reader rows the writer never produced. The point is that
 * the two halves agree on the same stored data; a fixture shared between them
 * would prove only that the fixture is self-consistent.
 */

type Call = { text: string; values?: unknown[] };

function statefulAppClient() {
  const calls: Call[] = [];
  let snapshot: Record<string, unknown> | null = null;
  let candidates: Record<string, unknown>[] = [];
  let items: Record<string, unknown>[] = [];

  const client: AppWritable = {
    query: async (config) => {
      calls.push(config);
      const { text, values = [] } = config;

      if (text.includes("FROM cst_app.context_snapshots") && text.startsWith("\nSELECT")) {
        return { rows: snapshot ? [snapshot] : [] };
      }
      if (text.includes("FROM cst_app.context_items") && text.includes("SELECT")) {
        return { rows: items };
      }
      if (text.includes("FROM cst_app.context_order_candidates") && text.includes("SELECT")) {
        return { rows: candidates };
      }

      if (text.includes("INSERT INTO cst_app.context_snapshots")) {
        // Mirrors the real CHECK: an unresolved snapshot carries no order.
        const resolution = text.includes("'single_order'")
          ? "single_order"
          : text.includes("'ambiguous'")
            ? "ambiguous"
            : "no_order";
        snapshot =
          resolution === "single_order"
            ? {
                id: "1",
                conversation_id: values[0],
                resolution,
                sub_source_id: values[1],
                order_number: values[2],
                order_date: values[3],
                order_status_summary: values[4],
                tracking_number: values[5],
                delivery_courier: values[6],
                delivery_address: values[7],
                listing_item_ref: values[9],
                verification_method: "deterministic_single",
              }
            : {
                id: "1",
                conversation_id: values[0],
                resolution,
                sub_source_id: null,
                order_number: null,
                order_date: null,
                order_status_summary: null,
                tracking_number: null,
                delivery_courier: null,
                delivery_address: null,
                listing_item_ref: null,
                verification_method: "none",
              };
        return { rows: [{ id: "1" }] };
      }

      if (text.includes("DELETE FROM cst_app.context_order_candidates")) {
        candidates = [];
        return { rows: [] };
      }
      if (text.includes("INSERT INTO cst_app.context_order_candidates")) {
        candidates.push({
          order_number: values[2],
          order_date: values[3],
          order_status_summary: values[4],
          listing_item_ref: values[7],
        });
        return { rows: [] };
      }

      if (text.includes("DELETE FROM cst_app.context_items")) {
        items = [];
        return { rows: [] };
      }
      if (text.includes("INSERT INTO cst_app.context_items")) {
        items.push({ id: "1", exact_sku: values[1], product_title: values[2], image_url: values[4] });
        return { rows: [] };
      }

      return { rows: [] };
    },
  };

  return { calls, client, resolution: () => snapshot?.resolution ?? null };
}

function fakeSourceClient(rows: unknown[]): SourceQueryable {
  return { query: async () => ({ rows }) };
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

describe("an ambiguous conversation has candidates to display", () => {
  it("stores every matching order and reads back exactly those, with no facts", async () => {
    const { client: appClient, resolution } = statefulAppClient();
    const sourceClient = fakeSourceClient([
      candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
      candidateRow({
        order_row_id: "502",
        order_number: "ORD-1002",
        order_date: "2026-08-10 09:30:00",
        order_status: "New",
      }),
    ]);

    const facts = await resolveEbayOrderContext(sourceClient, appClient, baseConversation);
    const displayed = await getOrderCandidates(appClient, baseConversation.id);

    expect(facts).toEqual([]);
    expect(resolution()).toBe("ambiguous");
    expect(displayed).toEqual<OrderCandidate[]>([
      {
        orderNumber: "ORD-1001",
        orderDate: "2026-08-01 10:00:00",
        orderStatus: "Dispatched",
        listingItemRef: "166239358700",
      },
      {
        orderNumber: "ORD-1002",
        orderDate: "2026-08-10 09:30:00",
        orderStatus: "New",
        listingItemRef: "166239358700",
      },
    ]);
  });

  it("displays every candidate, never a chosen or truncated subset", async () => {
    const { client: appClient } = statefulAppClient();
    const sourceClient = fakeSourceClient([
      candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
      candidateRow({ order_row_id: "502", order_number: "ORD-1002" }),
      candidateRow({ order_row_id: "503", order_number: "ORD-1003" }),
    ]);

    await resolveEbayOrderContext(sourceClient, appClient, baseConversation);
    const displayed = await getOrderCandidates(appClient, baseConversation.id);

    expect(displayed.map((candidate) => candidate.orderNumber)).toEqual([
      "ORD-1001",
      "ORD-1002",
      "ORD-1003",
    ]);
  });

  /**
   * A candidate is a verified order, but not a verified statement about this
   * conversation. Nothing may promote one into the grounding list -- so a
   * candidate carries no SKU, product title, tracking number or address, and
   * has no `{name, value}` shape for the fact list to absorb.
   */
  it("carries nothing a draft could state as fact", async () => {
    const { client: appClient } = statefulAppClient();
    const sourceClient = fakeSourceClient([
      candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
      candidateRow({ order_row_id: "502", order_number: "ORD-1002" }),
    ]);

    await resolveEbayOrderContext(sourceClient, appClient, baseConversation);
    const displayed = await getOrderCandidates(appClient, baseConversation.id);

    for (const candidate of displayed) {
      expect(Object.keys(candidate).sort()).toEqual([
        "listingItemRef",
        "orderDate",
        "orderNumber",
        "orderStatus",
      ]);
      const serialised = JSON.stringify(candidate);
      for (const leaked of ["REAL-SKU-1", "Synthetic Widget", "TRK-1", "Royal Mail", "Test Street"]) {
        expect(serialised, `${leaked} must not reach a candidate`).not.toContain(leaked);
      }
    }
  });

  it("keeps candidates out of the fact list even when both are read together", async () => {
    const { client: appClient } = statefulAppClient();
    const sourceClient = fakeSourceClient([
      candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
      candidateRow({ order_row_id: "502", order_number: "ORD-1002" }),
    ]);

    const facts: VerifiedFact[] = await resolveEbayOrderContext(
      sourceClient,
      appClient,
      baseConversation,
    );
    const displayed = await getOrderCandidates(appClient, baseConversation.id);

    expect(displayed.length).toBe(2);
    expect(facts).toHaveLength(0);
    // The order numbers exist, and are nowhere the model can see them.
    expect(JSON.stringify(facts)).not.toContain("ORD-1001");
  });
});

describe("a single verified order is unchanged", () => {
  it("still returns all eight facts", async () => {
    const { client: appClient, resolution } = statefulAppClient();

    const facts = await resolveEbayOrderContext(
      fakeSourceClient([candidateRow()]),
      appClient,
      baseConversation,
    );

    expect(resolution()).toBe("single_order");
    expect(facts).toEqual(
      expect.arrayContaining<VerifiedFact>([
        { name: "order_number", value: "ORD-1001" },
        { name: "order_status", value: "Dispatched" },
        { name: "order_date", value: "2026-08-01 10:00:00" },
        { name: "tracking_number", value: "TRK-1" },
        { name: "delivery_courier", value: "Royal Mail" },
        { name: "delivery_address", value: "1 Test Street, Testville, Testshire, TE5 7ST" },
        { name: "sku", value: "REAL-SKU-1" },
        { name: "product_title", value: "Synthetic Widget" },
      ]),
    );
    expect(facts).toHaveLength(8);
  });

  it("records no candidate, so the sidebar has nothing ambiguous to show", async () => {
    const { client: appClient } = statefulAppClient();

    await resolveEbayOrderContext(fakeSourceClient([candidateRow()]), appClient, baseConversation);

    expect(await getOrderCandidates(appClient, baseConversation.id)).toEqual([]);
  });

  it("leaves a no-order conversation with neither facts nor candidates", async () => {
    const { client: appClient, resolution } = statefulAppClient();

    const facts = await resolveEbayOrderContext(fakeSourceClient([]), appClient, baseConversation);

    expect(facts).toEqual([]);
    expect(resolution()).toBe("no_order");
    expect(await getOrderCandidates(appClient, baseConversation.id)).toEqual([]);
  });
});

describe("reading candidates adds no resolution work", () => {
  it("queries the source once, on the resolution, and never again for the display read", async () => {
    const { client: appClient } = statefulAppClient();
    let sourceQueries = 0;
    const sourceClient: SourceQueryable = {
      query: async () => {
        sourceQueries += 1;
        return {
          rows: [
            candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
            candidateRow({ order_row_id: "502", order_number: "ORD-1002" }),
          ],
        };
      },
    };

    await resolveEbayOrderContext(sourceClient, appClient, baseConversation);
    await getOrderCandidates(appClient, baseConversation.id);
    await getOrderCandidates(appClient, baseConversation.id);

    expect(sourceQueries).toBe(1);
  });

  it("survives a second resolve of the same conversation without doubling the list", async () => {
    const { client: appClient } = statefulAppClient();
    const sourceClient = fakeSourceClient([
      candidateRow({ order_row_id: "501", order_number: "ORD-1001" }),
      candidateRow({ order_row_id: "502", order_number: "ORD-1002" }),
    ]);

    // The second call finds the cached ambiguous snapshot and returns without
    // touching the source or the candidates -- the same early return that
    // already stops a second draft generation re-querying the source.
    await resolveEbayOrderContext(sourceClient, appClient, baseConversation);
    await resolveEbayOrderContext(sourceClient, appClient, baseConversation);

    expect(await getOrderCandidates(appClient, baseConversation.id)).toHaveLength(2);
  });
});
