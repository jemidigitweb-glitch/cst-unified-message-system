import { describe, expect, it } from "vitest";

import {
  type ConversationForCases,
  resolveCaseContext,
} from "@/lib/context/resolve-case-context";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";

/**
 * The Case Detection resolver, against a recording stub rather than a database.
 *
 * WHAT THIS FILE IS REALLY FOR: the four ways of showing no cases. Three of
 * them say nothing whatever about the customer, and a resolver that collapsed
 * any two would let "we could not check" render as "this customer has none" —
 * which is the one failure of this feature that an agent could act on and be
 * wrong.
 *
 * SYNTHETIC ONLY. `buyer-a`, `99-99999-99999`. Nothing came from live output.
 */

type Recorded = { text: string; values?: unknown[] };

const EBAY_STORES = [
  "ebay_returns",
  "cancellation",
  "inquiries",
  "cases",
  "payment_disputes",
] as const;

const PUBLISHED_AT = "2026-10-02 09:07:49+02";
const NOW = new Date("2026-10-02T10:00:00+02:00");

function caseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_table: "ebay_returns",
    source_case_id: "5000000001",
    marketplace: "ebay",
    case_type: "RETURN",
    lifecycle: "active",
    source_status: "ITEM_SHIPPED",
    source_state: "ITEM_SHIPPED",
    source_disposition: null,
    source_resolution: null,
    source_reason: null,
    source_reason_family: null,
    damage_reported: false,
    replacement_confirmed: false,
    escalation: "not_escalated",
    seller_action_owed: null,
    seller_action_due_at: null,
    quantity: 1,
    refund_amount: null,
    refund_currency: null,
    opened_at: "2026-09-30 09:00:00",
    closed_at: null,
    order_ref: "99-99999-99999",
    order_match_method: "source_order_id_verified",
    source_row_count: 1,
    ...overrides,
  };
}

/**
 * Routes each statement to a canned result by what it reads, so a test can say
 * "the snapshot has an order and the order store has two cases" without
 * knowing the order the resolver issues them in.
 */
function stub(options: {
  readonly publishedStores?: readonly string[];
  readonly publishedAt?: string;
  readonly snapshot?: Record<string, unknown> | null;
  readonly orderCases?: readonly Record<string, unknown>[];
  readonly customerCases?: readonly Record<string, unknown>[];
}) {
  const sent: Recorded[] = [];
  const publishedAt = options.publishedAt ?? PUBLISHED_AT;
  const client = {
    query(config: Recorded): Promise<{ rows: unknown[] }> {
      sent.push(config);
      if (config.text.includes("unnest(r.source_tables)")) {
        return Promise.resolve({
          rows: (options.publishedStores ?? EBAY_STORES).map((source_table) => ({
            source_table,
            published_at: publishedAt,
          })),
        });
      }
      if (config.text.includes("cst_app.context_snapshots")) {
        return Promise.resolve({
          rows: options.snapshot === undefined || options.snapshot === null ? [] : [options.snapshot],
        });
      }
      if (config.text.includes("c.order_ref = $3")) {
        return Promise.resolve({ rows: [...(options.orderCases ?? [])] });
      }
      if (config.text.includes("lower(c.counterparty_ref)")) {
        return Promise.resolve({ rows: [...(options.customerCases ?? [])] });
      }
      throw new Error(`unexpected statement: ${config.text.slice(0, 60)}`);
    },
  };
  return { client, sent };
}

const CONVERSATION: ConversationForCases = {
  id: "4242",
  marketplace: "ebay",
  subSourceId: 22,
  counterpartyRef: "buyer-a",
};

const RESOLVED_SNAPSHOT = {
  id: "7",
  conversation_id: "4242",
  resolution: "single_order",
  sub_source_id: 22,
  order_number: "99-99999-99999",
};

function resolve(stubbed: ReturnType<typeof stub>, conversation = CONVERSATION, now = NOW) {
  return resolveCaseContext(
    stubbed.client,
    conversation,
    capabilityOf(conversation.marketplace),
    now,
  );
}

describe("never imported is not the same answer as no cases", () => {
  it("reports never_imported when no run has ever been published", async () => {
    const stubbed = stub({ publishedStores: [] });
    const result = await resolve(stubbed);
    expect(result.state).toBe("never_imported");
    expect(result.orderCases.cases).toEqual([]);
  });

  /**
   * Returned BEFORE either lookup runs, so the state cannot be reached by a
   * query that happened to find nothing — which would make it a coincidence
   * rather than a guarantee.
   */
  it("asks no case question at all when nothing was ever published", async () => {
    const stubbed = stub({ publishedStores: [] });
    await resolve(stubbed);
    expect(stubbed.sent).toHaveLength(1);
    expect(stubbed.sent[0]?.text).toContain("unnest(r.source_tables)");
  });

  it("still reports never_imported when some other marketplace was published", async () => {
    const stubbed = stub({ publishedStores: ["shopify_returns"] });
    const result = await resolve(stubbed);
    expect(result.state).toBe("never_imported");
  });
});

describe("partial coverage travels with the answer", () => {
  it("names the stores that have never been published", async () => {
    const stubbed = stub({
      publishedStores: ["ebay_returns", "cancellation", "inquiries", "cases"],
      snapshot: RESOLVED_SNAPSHOT,
    });
    const result = await resolve(stubbed);
    expect(result.coverage.storesNeverImported).toEqual(["payment_disputes"]);
    expect(result.state).toBe("none_found");
  });

  it("is a property alongside the state, not a state that replaces it", async () => {
    const stubbed = stub({
      publishedStores: ["ebay_returns", "cancellation", "inquiries", "cases"],
      snapshot: RESOLVED_SNAPSHOT,
      orderCases: [caseRow()],
    });
    const result = await resolve(stubbed);
    expect(result.state).toBe("found");
    expect(result.coverage.storesNeverImported).toHaveLength(1);
  });
});

describe("there has to be something to match on", () => {
  /**
   * No resolved order and no verified customer identity means no key, so no
   * search was possible and no absence may be claimed.
   */
  it("reports no_search_key for a platform sender with no resolved order", async () => {
    const stubbed = stub({ snapshot: null });
    const result = await resolve(stubbed, { ...CONVERSATION, counterpartyRef: "eBay" });
    expect(result.state).toBe("no_search_key");
  });

  it("reports no_search_key for a blank reference with no resolved order", async () => {
    const stubbed = stub({ snapshot: null });
    const result = await resolve(stubbed, { ...CONVERSATION, counterpartyRef: "   " });
    expect(result.state).toBe("no_search_key");
  });

  /**
   * A conversation that resolved to no order still has a customer, and their
   * cases are the whole value of the panel on a pre-sales thread.
   */
  it("still searches the customer when no order resolved", async () => {
    const stubbed = stub({
      snapshot: null,
      customerCases: [caseRow({ order_ref: "99-88888-88888" })],
    });
    const result = await resolve(stubbed);
    expect(result.state).toBe("found");
    expect(result.customerCases.cases).toHaveLength(1);
    expect(result.matchedOrderRef).toBeNull();
  });

  it("uses the same verified-identity rule as the Repeat-Customer Warning", async () => {
    const stubbed = stub({ snapshot: null });
    // B&Q supplies a source reference rather than a customer identity, so the
    // handle may not be matched against a buyer's cases.
    const result = await resolve(stubbed, {
      ...CONVERSATION,
      marketplace: "bandq",
      counterpartyRef: "1234567890-A",
    });
    // No case source exists for that marketplace either, which is reported
    // first — the panel renders nothing at all for it.
    expect(result.state).toBe("never_imported");
    expect(result.coverage.storesCovered).toEqual([]);
    expect(result.coverage.storesNeverImported).toEqual([]);
  });
});

describe("the two lists are disjoint and separately labelled", () => {
  it("matches the order on the snapshot's own storefront", async () => {
    const stubbed = stub({ snapshot: RESOLVED_SNAPSHOT, orderCases: [caseRow()] });
    await resolve(stubbed);
    const orderQuery = stubbed.sent.find((q) => q.text.includes("c.order_ref = $3"));
    expect(orderQuery?.values?.slice(0, 3)).toEqual(["ebay", 22, "99-99999-99999"]);
  });

  /**
   * The resolved order is excluded from the customer list, so a case cannot
   * appear under both "On this order" and "Other orders by this customer".
   */
  it("excludes this order from the customer list", async () => {
    const stubbed = stub({ snapshot: RESOLVED_SNAPSHOT });
    await resolve(stubbed);
    const customerQuery = stubbed.sent.find((q) => q.text.includes("lower(c.counterparty_ref)"));
    expect(customerQuery?.values?.[3]).toBe("99-99999-99999");
  });

  it("passes a null order reference when none resolved, so nothing is excluded", async () => {
    const stubbed = stub({ snapshot: null });
    await resolve(stubbed);
    const customerQuery = stubbed.sent.find((q) => q.text.includes("lower(c.counterparty_ref)"));
    expect(customerQuery?.values?.[3]).toBeNull();
  });

  it("keeps order cases and customer cases in separate lists", async () => {
    const stubbed = stub({
      snapshot: RESOLVED_SNAPSHOT,
      orderCases: [caseRow({ source_case_id: "on-this-order" })],
      customerCases: [caseRow({ source_case_id: "on-another", order_ref: "99-88888-88888" })],
    });
    const result = await resolve(stubbed);
    expect(result.orderCases.cases.map((c) => c.caseRef)).toEqual(["on-this-order"]);
    expect(result.customerCases.cases.map((c) => c.caseRef)).toEqual(["on-another"]);
    expect(result.matchedOrderRef).toBe("99-99999-99999");
  });
});

describe("an empty published snapshot is the one honest absence", () => {
  it("reports none_found when every covered store was searched and held nothing", async () => {
    const stubbed = stub({ snapshot: RESOLVED_SNAPSHOT });
    const result = await resolve(stubbed);
    expect(result.state).toBe("none_found");
    expect(result.coverage.storesNeverImported).toEqual([]);
    expect(result.coverage.asOf).toBe(PUBLISHED_AT);
  });
});

describe("freshness", () => {
  it("marks a snapshot older than a day as stale, and still returns the cases", async () => {
    const stubbed = stub({
      snapshot: RESOLVED_SNAPSHOT,
      orderCases: [caseRow()],
      publishedAt: "2026-09-28 09:00:00+02",
    });
    const result = await resolve(stubbed);
    expect(result.stale).toBe(true);
    expect(result.orderCases.cases).toHaveLength(1);
  });

  it("does not mark a snapshot taken an hour ago", async () => {
    const stubbed = stub({ snapshot: RESOLVED_SNAPSHOT });
    const result = await resolve(stubbed);
    expect(result.stale).toBe(false);
  });
});

describe("it resolves no order of its own", () => {
  /**
   * The order comes from the stored context snapshot — the answer the existing
   * resolver reached on its own evidence. Nothing here matches an order, ranks
   * a candidate, or reads a product title, and the statements it sends are the
   * proof: four reads, none of them against an order or listing table.
   */
  it("reads the stored snapshot and no order source", async () => {
    const stubbed = stub({ snapshot: RESOLVED_SNAPSHOT, orderCases: [caseRow()] });
    await resolve(stubbed);
    const tables = stubbed.sent.flatMap((q) => [
      ...q.text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+\.[a-z_]+)/g),
    ].map(([, name]) => name));
    for (const table of new Set(tables)) {
      expect([
        "cst_app.marketplace_cases",
        "cst_app.case_import_runs",
        "cst_app.context_snapshots",
      ]).toContain(table);
    }
  });

  it("sends no write statement of any kind", async () => {
    const stubbed = stub({ snapshot: RESOLVED_SNAPSHOT, orderCases: [caseRow()] });
    await resolve(stubbed);
    for (const query of stubbed.sent) {
      expect(query.text.toUpperCase()).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    }
  });
});
