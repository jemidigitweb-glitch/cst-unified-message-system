import { describe, expect, it } from "vitest";

import { ALLOWED_FACT_NAMES } from "@/lib/context/resolve-order-context";
import { resolveSelectedOrderContext } from "@/lib/context/resolve-selected-order-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { Queryable as SourceQueryable } from "@/lib/repositories/order-context-repository";

/**
 * A reviewer's choice is an INPUT to one generation, and the only thing
 * standing between "they clicked an order" and "the model states that order's
 * tracking number as fact" is this module. So it is tested for what it
 * refuses at least as hard as for what it returns.
 */

function fakeSourceClient(rows: unknown[]) {
  const calls: { text: string; values?: unknown[] }[] = [];
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
    order_number: "00-00000-00000",
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

const conversation = {
  marketplace: "ebay",
  subSourceId: 1,
  counterpartyRef: "kraskir24",
  listingItemRef: "166239358700",
};

const twoCandidates = [
  candidateRow({ order_row_id: "501", order_number: "00-00000-00000" }),
  candidateRow({
    order_row_id: "502",
    order_number: "12-34567-89012",
    order_date: "2026-08-09 12:00:00",
    order_status: "Completed",
    tracking_number: "TRK-2",
    real_sku: "REAL-SKU-2",
    item_title: "Other Widget",
  }),
];

describe("the selected order becomes verified facts", () => {
  it("returns the chosen order's eight facts", async () => {
    const { client } = fakeSourceClient(twoCandidates);

    const facts = await resolveSelectedOrderContext(client, conversation, "12-34567-89012");

    expect(facts).toEqual<VerifiedFact[]>([
      { name: "order_number", value: "12-34567-89012" },
      { name: "order_status", value: "Completed" },
      { name: "order_date", value: "2026-08-09 12:00:00" },
      { name: "tracking_number", value: "TRK-2" },
      { name: "delivery_courier", value: "Royal Mail" },
      { name: "delivery_address", value: "1 Test Street, Testville, Testshire, TE5 7ST" },
      { name: "sku", value: "REAL-SKU-2" },
      { name: "product_title", value: "Other Widget" },
    ]);
  });

  /**
   * The chosen order's facts must be indistinguishable from what the resolver
   * would have produced had this match been unambiguous — same names, same
   * vocabulary — or the prompt buckets them differently and the grounding
   * checks stop recognising them.
   */
  it("uses only the resolver's own fact vocabulary", async () => {
    const { client } = fakeSourceClient(twoCandidates);
    const facts = await resolveSelectedOrderContext(client, conversation, "00-00000-00000");

    for (const fact of facts) {
      expect(ALLOWED_FACT_NAMES as readonly string[]).toContain(fact.name);
    }
    expect(new Set(facts.map((fact) => fact.name)).size).toBe(facts.length);
  });

  it("carries nothing from the order that was not chosen", async () => {
    const { client } = fakeSourceClient(twoCandidates);
    const facts = await resolveSelectedOrderContext(client, conversation, "00-00000-00000");

    const serialised = JSON.stringify(facts);
    for (const other of ["12-34567-89012", "TRK-2", "REAL-SKU-2", "Other Widget", "Completed"]) {
      expect(serialised, `${other} belongs to the other order`).not.toContain(other);
    }
  });

  it("omits a fact the source never recorded rather than inventing one", async () => {
    const { client } = fakeSourceClient([
      candidateRow({ tracking_number: null, carrier: null, carrier_name: null, real_sku: null, item_sku: null }),
    ]);

    const facts = await resolveSelectedOrderContext(client, conversation, "00-00000-00000");
    const names = facts.map((fact) => fact.name);

    expect(names).not.toContain("tracking_number");
    expect(names).not.toContain("delivery_courier");
    expect(names).not.toContain("sku");
    expect(names).toContain("order_number");
  });
});

describe("what it refuses", () => {
  it("returns nothing for an order this conversation never matched", async () => {
    const { client } = fakeSourceClient(twoCandidates);
    expect(await resolveSelectedOrderContext(client, conversation, "NO-SUCH-ORDER")).toEqual([]);
  });

  it("returns nothing for an empty or blank selection", async () => {
    const { client } = fakeSourceClient(twoCandidates);
    expect(await resolveSelectedOrderContext(client, conversation, "")).toEqual([]);
    expect(await resolveSelectedOrderContext(client, conversation, "   ")).toEqual([]);
  });

  /**
   * Two rows with one order number is not a choice a human could have made
   * meaningfully, so it produces nothing rather than the first one.
   */
  it("returns nothing when the selection matches more than one candidate", async () => {
    const { client } = fakeSourceClient([
      candidateRow({ order_row_id: "501", order_number: "00-00000-00000" }),
      candidateRow({ order_row_id: "502", order_number: "00-00000-00000", tracking_number: "TRK-9" }),
    ]);
    expect(await resolveSelectedOrderContext(client, conversation, "00-00000-00000")).toEqual([]);
  });

  it("queries nothing at all for a marketplace this does not cover", async () => {
    const { calls, client } = fakeSourceClient(twoCandidates);
    const facts = await resolveSelectedOrderContext(
      client,
      { ...conversation, marketplace: "amazon" },
      "00-00000-00000",
    );
    expect(facts).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("queries nothing when a matching key is missing", async () => {
    for (const incomplete of [
      { ...conversation, subSourceId: null },
      { ...conversation, listingItemRef: null },
      { ...conversation, listingItemRef: "  " },
    ]) {
      const { calls, client } = fakeSourceClient(twoCandidates);
      expect(await resolveSelectedOrderContext(client, incomplete, "00-00000-00000")).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  /**
   * The selection is checked against the SAME query that decided the
   * conversation was ambiguous -- same keys, same scoping -- so a chosen order
   * is always one the conversation genuinely matched, never one named by the
   * request alone.
   */
  it("re-matches against the conversation's own keys before trusting the choice", async () => {
    const { calls, client } = fakeSourceClient(twoCandidates);
    await resolveSelectedOrderContext(client, conversation, "00-00000-00000");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual([2, 1, "166239358700", "kraskir24"]);
  });

  it("writes nothing: it is given no application client to write with", async () => {
    const { calls, client } = fakeSourceClient(twoCandidates);
    await resolveSelectedOrderContext(client, conversation, "00-00000-00000");

    for (const call of calls) {
      expect(call.text.toUpperCase()).not.toContain("INSERT");
      expect(call.text.toUpperCase()).not.toContain("UPDATE ");
      expect(call.text.toUpperCase()).not.toContain("DELETE");
    }
  });
});

/**
 * The bug this fixes, at the fact level.
 *
 * The reviewer picked an order, the sidebar showed it, and the model still
 * asked the customer for their order number — because the selection never
 * reached the request. These two tests pin what must be true once it does:
 * the chosen order's identifying values ARE in the facts, and the other
 * order's are not.
 */
describe("what the model ends up seeing", () => {
  it("gives the model the selected order's number, tracking and SKU", async () => {
    const { client } = fakeSourceClient(twoCandidates);
    const facts = await resolveSelectedOrderContext(client, conversation, "12-34567-89012");

    const byName = new Map(facts.map((fact) => [fact.name, fact.value]));
    expect(byName.get("order_number")).toBe("12-34567-89012");
    expect(byName.get("tracking_number")).toBe("TRK-2");
    expect(byName.get("sku")).toBe("REAL-SKU-2");
    expect(byName.get("product_title")).toBe("Other Widget");

    // ...which is what stops the reply asking for an order number: the prompt
    // builder buckets these under the ORDER block instead of the
    // "no order has been resolved" sentence.
    expect(facts.length).toBeGreaterThan(0);
  });

  it("gives the model nothing at all from the order that was not selected", async () => {
    const { client } = fakeSourceClient(twoCandidates);
    const facts = await resolveSelectedOrderContext(client, conversation, "12-34567-89012");

    const serialised = JSON.stringify(facts);
    for (const unselected of ["00-00000-00000", "TRK-1", "REAL-SKU-1", "Synthetic Widget"]) {
      expect(serialised, `${unselected} belongs to the unselected order`).not.toContain(unselected);
    }
  });

  it("gives the model nothing when the reviewer selected nothing", async () => {
    const { calls, client } = fakeSourceClient(twoCandidates);
    // The draft route only calls this when a selection exists; an empty one
    // still resolves to no facts rather than to the first candidate.
    expect(await resolveSelectedOrderContext(client, conversation, "")).toEqual([]);
    expect(calls).toEqual([]);
  });
});
