import { describe, expect, it } from "vitest";

import {
  CASE_LIST_LIMIT,
  FIND_CASES_FOR_CUSTOMER_SQL,
  FIND_CASES_FOR_ORDER_SQL,
  LAST_PUBLISHED_BY_STORE_SQL,
  findCasesForCustomer,
  findCasesForOrder,
  lastPublishedByStore,
} from "@/lib/repositories/marketplace-case-repository";

/**
 * The Case Detection reads, asserted on the statements they send and the values
 * they bind — no database is contacted. Every client below is a recording stub,
 * which is what lets this run anywhere alongside the rest of the suite.
 *
 * SYNTHETIC ONLY. `buyer-a`, `99-99999-99999`. Nothing came from live output.
 */

type Recorded = { text: string; values?: unknown[] };

function stub(rows: unknown[]): {
  client: { query: (c: Recorded) => Promise<{ rows: unknown[] }> };
  sent: Recorded[];
} {
  const sent: Recorded[] = [];
  return {
    sent,
    client: {
      query: (config: Recorded) => {
        sent.push(config);
        return Promise.resolve({ rows });
      },
    },
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_table: "ebay_returns",
    source_case_id: "5000000001",
    marketplace: "ebay",
    case_type: "RETURN",
    lifecycle: "closed",
    source_status: "CLOSED",
    source_state: "CLOSED",
    source_disposition: null,
    source_resolution: null,
    source_reason: "ARRIVED_DAMAGED",
    source_reason_family: null,
    damage_reported: true,
    replacement_confirmed: false,
    escalation: "escalated",
    seller_action_owed: "ISSUE_REFUND",
    seller_action_due_at: "2026-05-04 12:00:00",
    quantity: 1,
    refund_amount: "12.34",
    refund_currency: "GBP",
    opened_at: "2026-05-01 09:00:00",
    closed_at: "2026-05-09 09:00:00",
    order_ref: "99-99999-99999",
    order_match_method: "source_order_id_verified",
    source_row_count: 4,
    ...overrides,
  };
}

const ORDER_SCOPE = {
  marketplace: "ebay" as const,
  subSourceId: 22,
  orderRef: "99-99999-99999",
};

/**
 * THE PUBLICATION GATE IS THE PROPERTY THIS FILE EXISTS FOR.
 *
 * Migration 0022 cannot enforce it — the schema has no way to say "a row is
 * invisible unless another table's row says so" — and an abandoned
 * `in_progress` run would otherwise be read as current data. Every statement
 * must carry the join.
 */
describe("every read is gated on a published import run", () => {
  it("joins the run ledger and filters on published, in both case statements", () => {
    for (const sql of [FIND_CASES_FOR_ORDER_SQL, FIND_CASES_FOR_CUSTOMER_SQL]) {
      expect(sql).toMatch(/JOIN cst_app\.case_import_runs r/);
      expect(sql).toMatch(/r\.id = c\.import_run_id/);
      expect(sql).toMatch(/r\.status = 'published'/);
    }
  });

  it("filters the freshness read on published runs too", () => {
    expect(LAST_PUBLISHED_BY_STORE_SQL).toMatch(/WHERE r\.status = 'published'/);
  });

  /**
   * A LEFT JOIN would return the case with a null run rather than excluding it,
   * which is the one way to write this that looks right and disables the gate.
   */
  it("uses an inner join, so an unpublished run removes the row", () => {
    for (const sql of [FIND_CASES_FOR_ORDER_SQL, FIND_CASES_FOR_CUSTOMER_SQL]) {
      expect(sql).not.toMatch(/LEFT\s+JOIN/i);
    }
  });
});

describe("the reads only read", () => {
  it("contains no write verb or DDL in any statement", () => {
    for (const sql of [
      FIND_CASES_FOR_ORDER_SQL,
      FIND_CASES_FOR_CUSTOMER_SQL,
      LAST_PUBLISHED_BY_STORE_SQL,
    ]) {
      for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "CREATE", "ALTER", "DROP"]) {
        expect(sql.toUpperCase()).not.toMatch(new RegExp(`\\b${verb}\\b`));
      }
    }
  });

  it("names only the two case tables", () => {
    for (const sql of [FIND_CASES_FOR_ORDER_SQL, FIND_CASES_FOR_CUSTOMER_SQL]) {
      const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(cst_app\.\w+)/g)].map(([, t]) => t);
      for (const table of new Set(tables)) {
        expect(["cst_app.marketplace_cases", "cst_app.case_import_runs"]).toContain(table);
      }
    }
  });
});

describe("the order match is exact and scoped to one storefront", () => {
  it("binds the marketplace, the storefront and the order reference", async () => {
    const { client, sent } = stub([]);
    await findCasesForOrder(client, ORDER_SCOPE);
    expect(sent[0]?.values).toEqual(["ebay", 22, "99-99999-99999", CASE_LIST_LIMIT + 1]);
  });

  /**
   * The order reference is NOT case-folded, deliberately unlike the buyer
   * handle. It is not a human-entered value: the importer resolved it against
   * the order source and stored what that source holds, so folding it would
   * widen a verified join to catch nothing.
   */
  it("compares the order reference exactly", () => {
    expect(FIND_CASES_FOR_ORDER_SQL).toMatch(/c\.order_ref = \$3/);
    expect(FIND_CASES_FOR_ORDER_SQL).not.toMatch(/lower\(c\.order_ref\)/);
  });

  it("confines itself to one storefront", () => {
    expect(FIND_CASES_FOR_ORDER_SQL).toMatch(/c\.sub_source_id = \$2::int/);
  });
});

describe("the customer match folds case on both sides and excludes this order", () => {
  /**
   * Every imported handle is lowercase while 358 conversation handles are not,
   * so an exact predicate would silently miss the history of every mixed-case
   * buyer. `ix_marketplace_cases_counterparty` is functional on
   * `lower(counterparty_ref)` precisely so this stays indexed.
   */
  it("applies lower() to both sides", () => {
    expect(FIND_CASES_FOR_CUSTOMER_SQL).toMatch(/lower\(c\.counterparty_ref\) = lower\(\$3\)/);
  });

  /**
   * `IS DISTINCT FROM`, not `<>`. With `<>` a NULL order reference — which is
   * what a conversation that resolved to no order supplies — would exclude
   * every row and silently empty the only list there is.
   */
  it("excludes this order with a null-safe comparison", () => {
    expect(FIND_CASES_FOR_CUSTOMER_SQL).toMatch(/c\.order_ref IS DISTINCT FROM \$4/);
    expect(FIND_CASES_FOR_CUSTOMER_SQL).not.toMatch(/c\.order_ref <> \$4/);
  });

  it("returns the customer's cases when the conversation resolved to no order", async () => {
    const { client, sent } = stub([row({ order_ref: "99-88888-88888" })]);
    const list = await findCasesForCustomer(client, {
      marketplace: "ebay",
      subSourceId: 22,
      counterpartyRef: "Buyer-A",
      orderRef: null,
    });
    expect(sent[0]?.values).toEqual(["ebay", 22, "Buyer-A", null, CASE_LIST_LIMIT + 1]);
    expect(list.cases).toHaveLength(1);
  });

  it("skips rows the source recorded no customer for", () => {
    expect(FIND_CASES_FOR_CUSTOMER_SQL).toMatch(/c\.counterparty_ref IS NOT NULL/);
  });
});

/**
 * ACTIVE, THEN UNKNOWN, THEN CLOSED. `unknown` above `closed` is the measured
 * reading: 14,436 of 21,022 cases are unknown and most are Amazon returns whose
 * status reads `Approved`, which means approved and NOT finished. Sorting them
 * under six thousand closed cases would bury the live ones.
 */
describe("ordering happens on the server", () => {
  it("ranks active first, unknown second, closed last", () => {
    for (const sql of [FIND_CASES_FOR_ORDER_SQL, FIND_CASES_FOR_CUSTOMER_SQL]) {
      expect(sql).toMatch(/WHEN 'active' THEN 0 WHEN 'unknown' THEN 1 ELSE 2/);
      expect(sql).toMatch(/ORDER BY CASE c\.lifecycle/);
    }
  });

  it("breaks a tie on the id, so a list is stable across loads", () => {
    for (const sql of [FIND_CASES_FOR_ORDER_SQL, FIND_CASES_FOR_CUSTOMER_SQL]) {
      expect(sql).toMatch(/c\.opened_at DESC, c\.id DESC/);
    }
  });
});

describe("a capped list says it was capped", () => {
  it("asks for one more row than it returns, and reports the overflow", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => row({ source_case_id: `case-${i}` }));
    const { client } = stub(rows);
    const list = await findCasesForOrder(client, ORDER_SCOPE, 3);
    expect(list.cases).toHaveLength(3);
    expect(list.hasMore).toBe(true);
  });

  it("reports no overflow when the store held exactly the limit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ source_case_id: `case-${i}` }));
    const { client } = stub(rows);
    const list = await findCasesForOrder(client, ORDER_SCOPE, 3);
    expect(list.cases).toHaveLength(3);
    expect(list.hasMore).toBe(false);
  });
});

describe("the row mapping", () => {
  it("keeps the refund amount as text, so no penny is lost to a float", async () => {
    const { client } = stub([row({ refund_amount: "1234567890.99" })]);
    const list = await findCasesForOrder(client, ORDER_SCOPE);
    expect(list.cases[0]?.refundAmount).toBe("1234567890.99");
  });

  it("keeps the naive source datetimes as written", async () => {
    const { client } = stub([row()]);
    const list = await findCasesForOrder(client, ORDER_SCOPE);
    expect(list.cases[0]?.openedAt).toBe("2026-05-01 09:00:00");
    expect(list.cases[0]?.closedAt).toBe("2026-05-09 09:00:00");
    expect(list.cases[0]?.sellerActionDueAt).toBe("2026-05-04 12:00:00");
  });

  /**
   * A WAREHOUSE DISPOSITION IS CARRIED UNDER ITS OWN NAME. Reading it into the
   * status field is the one mapping mistake that would put a stockroom outcome
   * on a reviewer's screen labelled as the customer's case status.
   */
  it("carries the warehouse disposition apart from the status", async () => {
    const { client } = stub([
      row({
        source_table: "amazon_returns",
        source_status: null,
        source_disposition: "Unit returned to inventory",
      }),
    ]);
    const list = await findCasesForOrder(client, ORDER_SCOPE);
    expect(list.cases[0]?.sourceStatus).toBeNull();
    expect(list.cases[0]?.warehouseDisposition).toBe("Unit returned to inventory");
  });

  /** An escalated case can be closed — 765 of them are. Both facts survive. */
  it("keeps escalation and lifecycle as independent facts", async () => {
    const { client } = stub([row({ lifecycle: "closed", escalation: "escalated" })]);
    const list = await findCasesForOrder(client, ORDER_SCOPE);
    expect(list.cases[0]?.lifecycle).toBe("closed");
    expect(list.cases[0]?.escalation).toBe("escalated");
  });

  it("returns no buyer handle, so no identity is republished beside a case", async () => {
    const { client } = stub([row()]);
    const list = await findCasesForOrder(client, ORDER_SCOPE);
    expect(Object.keys(list.cases[0] ?? {})).not.toContain("counterpartyRef");
  });
});

describe("per-store freshness", () => {
  it("maps each store to its latest publication", async () => {
    const { client } = stub([
      { source_table: "ebay_returns", published_at: "2026-10-02 09:07:49+02" },
      { source_table: "inquiries", published_at: "2026-10-01 09:00:00+02" },
    ]);
    const map = await lastPublishedByStore(client);
    expect(map.get("ebay_returns")).toBe("2026-10-02 09:07:49+02");
    expect(map.get("cancellation")).toBeUndefined();
  });

  it("groups per store rather than returning one global timestamp", () => {
    expect(LAST_PUBLISHED_BY_STORE_SQL).toMatch(/unnest\(r\.source_tables\)/);
    expect(LAST_PUBLISHED_BY_STORE_SQL).toMatch(/GROUP BY 1/);
  });
});
