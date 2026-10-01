import { describe, expect, it, vi } from "vitest";

import {
  COUNT_PREVIOUS_CASES_SQL,
  COUNT_PREVIOUS_CONVERSATIONS_SQL,
  COUNT_PREVIOUS_REFUNDED_ORDERS_SQL,
  countPreviousCases,
  countPreviousConversations,
  countPreviousRefundedOrders,
} from "@/lib/repositories/customer-history-repository";
import { resolveCustomerHistory } from "@/lib/context/resolve-customer-history";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";

/**
 * The history lookups, asserted on the statements they send and the values
 * they bind — no database is contacted. Every client below is a recording stub,
 * which is what lets this run anywhere alongside the rest of the suite.
 *
 * SYNTHETIC ONLY. `buyer-a`, `99-99999-99999`. Nothing came from live output.
 */

type Recorded = { text: string; values?: unknown[] };

function stub(rows: unknown[]): { client: { query: (c: Recorded) => Promise<{ rows: unknown[] }> }; sent: Recorded[] } {
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

const SCOPE = {
  marketplace: "ebay" as const,
  subSourceId: 22,
  counterpartyRef: "buyer-a",
  before: "2026-05-01 09:00:00",
  excludeConversationId: "4242",
};

describe("previous conversations", () => {
  it("excludes the current conversation, later threads, and other storefronts", () => {
    const sql = COUNT_PREVIOUS_CONVERSATIONS_SQL;
    expect(sql).toMatch(/id <> \$5::bigint/);
    expect(sql).toMatch(/first_source_ts < \$4::timestamp/);
    expect(sql).toMatch(/sub_source_id = \$2::int/);
    expect(sql).toMatch(/marketplace = \$1/);
  });

  /**
   * STRICTLY `<`, never `<=`. A thread sharing this one's exact first-message
   * timestamp is not evidence of an earlier contact, so the ambiguous case
   * falls on the side that cannot invent history.
   */
  it("uses a strict inequality so a tie is not counted as previous", () => {
    expect(COUNT_PREVIOUS_CONVERSATIONS_SQL).not.toMatch(/first_source_ts <= /);
  });

  /** Distinct on the primary key, so a join could never double a thread. */
  it("counts distinct conversation ids", () => {
    expect(COUNT_PREVIOUS_CONVERSATIONS_SQL).toMatch(/count\(DISTINCT id\)/);
  });

  it("binds every value and interpolates none", async () => {
    const { client, sent } = stub([{ previous_conversations: 3 }]);
    const count = await countPreviousConversations(client, SCOPE);
    expect(count).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.values).toEqual(["ebay", 22, "buyer-a", "2026-05-01 09:00:00", "4242"]);
    expect(sent[0]!.text).not.toMatch(/buyer-a/);
  });

  it("reports zero when the aggregate returns no row", async () => {
    const { client } = stub([]);
    expect(await countPreviousConversations(client, SCOPE)).toBe(0);
  });
});

describe("previous cases", () => {
  /**
   * COUNTS THE CASE, NOT THE EVENT ROW. The source is a status-event log —
   * 9,127 rows collapsed to 1,098 cases during the import — so counting rows
   * would report one customer's single claim as four.
   */
  it("counts distinct source case identities, never rows", () => {
    const sql = COUNT_PREVIOUS_CASES_SQL;
    expect(sql).toMatch(/count\(DISTINCT source_case_id\)/);
    expect(sql).not.toMatch(/count\(\*\)/);
  });

  /**
   * An ordinary inquiry is not a formal dispute. 1,004 of the 1,098 imported
   * cases are inquiries, so counting them as formal would flag nearly every
   * customer who has ever been in touch.
   */
  it("counts formal cases and disputes by source table, excluding inquiries", () => {
    const sql = COUNT_PREVIOUS_CASES_SQL;
    expect(sql).toMatch(/FILTER \(WHERE source_table = 'cases'\)/);
    expect(sql).toMatch(/FILTER \(WHERE source_table = 'payment_disputes'\)/);
    expect(sql).not.toMatch(/source_table = 'inquiries'/);
  });

  /**
   * `not_recorded` IS NOT `not_escalated`. The escalation count is driven by a
   * positive match on 'escalated' only — 94 imported rows carry
   * `not_recorded`, meaning the source table has no escalation signal at all,
   * and treating those as "checked and clean" would claim a check nobody made.
   */
  it("counts escalations by a positive match on 'escalated' alone", () => {
    const sql = COUNT_PREVIOUS_CASES_SQL;
    expect(sql).toMatch(/FILTER \(WHERE escalation = 'escalated'\)/);
    expect(sql).not.toMatch(/escalation <> 'not_escalated'/);
    expect(sql).not.toMatch(/escalation IN \(/);
    expect(sql).not.toMatch(/not_recorded/);
  });

  it("bounds by the conversation's own timestamp, strictly", () => {
    expect(COUNT_PREVIOUS_CASES_SQL).toMatch(/event_at < \$4::timestamp/);
    expect(COUNT_PREVIOUS_CASES_SQL).not.toMatch(/event_at <= /);
    expect(COUNT_PREVIOUS_CASES_SQL).not.toMatch(/now\(\)/);
  });

  it("restricts to one storefront", () => {
    expect(COUNT_PREVIOUS_CASES_SQL).toMatch(/sub_source_id = \$2::int/);
  });

  it("returns the three counts and the import stamp", async () => {
    const { client, sent } = stub([
      {
        formal_cases: 2, payment_disputes: 1, escalations: 4,
        escalated_event_types: ["ITEM_NOT_RECEIVED"],
        history_as_of: "2026-10-01 10:11:39",
      },
    ]);
    const counts = await countPreviousCases(client, SCOPE);
    expect(counts).toEqual({
      formalCases: 2,
      paymentDisputes: 1,
      escalations: 4,
      escalatedEventTypes: ["ITEM_NOT_RECEIVED"],
      historyAsOf: "2026-10-01 10:11:39",
    });
    expect(sent[0]!.values).toEqual(["ebay", 22, "buyer-a", "2026-05-01 09:00:00"]);
  });

  it("reports zeros and a null stamp when this customer has no cases in range", async () => {
    const { client } = stub([
      {
        formal_cases: 0, payment_disputes: 0, escalations: 0,
        escalated_event_types: null, history_as_of: null,
      },
    ]);
    expect(await countPreviousCases(client, SCOPE)).toEqual({
      formalCases: 0,
      paymentDisputes: 0,
      escalations: 0,
      escalatedEventTypes: [],
      historyAsOf: null,
    });
  });

  /**
   * `array_agg ... FILTER` yields SQL NULL, not an empty array, when no row
   * matched. Mapped to `[]` in one place so no caller has to remember, and
   * asserted because a leaked null would reach the wording as "unknown issue"
   * and silently disable the specific sentences.
   */
  it("maps a null type aggregate to an empty list", async () => {
    const { client } = stub([
      {
        formal_cases: 0, payment_disputes: 0, escalations: 0,
        history_as_of: null,
      },
    ]);
    expect((await countPreviousCases(client, SCOPE)).escalatedEventTypes).toEqual([]);
  });

  /**
   * THE ISSUE TYPES ARE AGGREGATED FROM THE SAME FILTERED ROWS AS THE COUNT.
   * If the two filters ever diverged, the card could describe a case the count
   * did not include — so the predicate is asserted to be identical.
   */
  it("aggregates issue types from exactly the rows the escalation count matched", () => {
    const sql = COUNT_PREVIOUS_CASES_SQL;
    expect(sql).toMatch(
      /array_agg\(DISTINCT event_type\) FILTER \(WHERE escalation = 'escalated'\)/,
    );
    const countFilters = sql.match(/FILTER \(WHERE escalation = 'escalated'\)/g);
    expect(countFilters).toHaveLength(2); // the count and the type aggregate
  });

  /** Wording detail must never widen what is read. Still four bound values. */
  it("reads no extra column and binds no extra value for the wording", async () => {
    const { client, sent } = stub([
      { formal_cases: 0, payment_disputes: 0, escalations: 0, escalated_event_types: null, history_as_of: null },
    ]);
    await countPreviousCases(client, SCOPE);
    expect(sent[0]!.values).toHaveLength(4);
    const sql = COUNT_PREVIOUS_CASES_SQL.toLowerCase();
    for (const column of ["comments", "buyer_req", "reason", "event_status"]) {
      expect(sql).not.toContain(column);
    }
  });

  /** Three different kinds of record. A total would be a quantity the data lacks. */
  it("does not sum the three counts in SQL", () => {
    expect(COUNT_PREVIOUS_CASES_SQL).not.toMatch(/\bsum\(/i);
  });
});

describe("previous refunded orders", () => {
  /**
   * `orders.status = 'Refunded'` is one authoritative column on the order
   * itself, from a closed vocabulary measured live (Completed 1,087,095 ·
   * Refunded 19,079 · Cancelled 10,861 · ...). One row per order, so a
   * refunded order is one record and repeated status rows cannot become
   * separate refunds.
   */
  it("counts distinct orders whose status is Refunded", () => {
    const sql = COUNT_PREVIOUS_REFUNDED_ORDERS_SQL;
    expect(sql).toMatch(/count\(DISTINCT o\.id\)/);
    expect(sql).toMatch(/o\.status = 'Refunded'/);
  });

  /**
   * A return is not a refund — `ebay_returns` is a 42,879-row event log for
   * 4,074 returns and a return can close with no money moving. Picking a
   * refund-implying subset of its vocabulary would be a guess.
   */
  it("does not read the returns event log", () => {
    expect(COUNT_PREVIOUS_REFUNDED_ORDERS_SQL).not.toMatch(/ebay_returns/);
  });

  /**
   * The platform check is `sub_source.source_id`, not `orders.market_place` —
   * which `order-context-repository.ts` documents is a COUNTRY table, and
   * filtering on it drops every non-UK order.
   */
  it("establishes the platform from sub_source.source_id, never market_place", () => {
    const sql = COUNT_PREVIOUS_REFUNDED_ORDERS_SQL;
    expect(sql).toMatch(/ss\.source_id = \$1::int/);
    expect(sql).not.toMatch(/market_place/);
  });

  it("bounds by the order's own date, strictly, and by storefront", () => {
    const sql = COUNT_PREVIOUS_REFUNDED_ORDERS_SQL;
    expect(sql).toMatch(/o\.order_date < \$4::timestamp/);
    expect(sql).not.toMatch(/order_date <= /);
    expect(sql).not.toMatch(/now\(\)/);
    expect(sql).toMatch(/o\.sub_source_id = \$2::int/);
  });

  /** No customer field is read — only the buyer handle, as a bound predicate. */
  it("selects no customer column", () => {
    const sql = COUNT_PREVIOUS_REFUNDED_ORDERS_SQL.toLowerCase();
    for (const column of ["email", "address", "phone", "post_code", "postcode", "full_name"]) {
      expect(sql).not.toContain(column);
    }
  });

  it("passes the eBay source id and binds the buyer", async () => {
    const { client, sent } = stub([{ previous_refunded_orders: 2 }]);
    expect(await countPreviousRefundedOrders(client, SCOPE)).toBe(2);
    expect(sent[0]!.values).toEqual([2, 22, "buyer-a", "2026-05-01 09:00:00"]);
  });
});

describe("every statement is a read", () => {
  it.each([
    ["conversations", COUNT_PREVIOUS_CONVERSATIONS_SQL],
    ["cases", COUNT_PREVIOUS_CASES_SQL],
    ["refunded orders", COUNT_PREVIOUS_REFUNDED_ORDERS_SQL],
  ])("%s is a SELECT and nothing else", (_name, sql) => {
    expect(sql.trim()).toMatch(/^SELECT\b/);
    for (const verb of ["insert", "update", "delete", "truncate", "alter", "drop", "create", "upsert"]) {
      expect(sql.toLowerCase()).not.toContain(verb);
    }
  });
});

describe("the resolver assembles the warning", () => {
  const conversation = {
    id: "4242",
    marketplace: "ebay" as const,
    subSourceId: 22,
    counterpartyRef: "buyer-a",
    firstSourceTimestamp: "2026-05-01 09:00:00",
  };

  /** One stub answering all three statements by matching on the text. */
  function routed(answers: {
    conversations?: number;
    cases?: { formal_cases: number; payment_disputes: number; escalations: number; history_as_of: string | null };
    refunds?: number | "throw";
  }) {
    const app = {
      query: (config: Recorded) => {
        if (config.text.includes("customer_case_history")) {
          return Promise.resolve({
            rows: [
              answers.cases ?? {
                formal_cases: 0,
                payment_disputes: 0,
                escalations: 0,
                history_as_of: null,
              },
            ],
          });
        }
        return Promise.resolve({ rows: [{ previous_conversations: answers.conversations ?? 0 }] });
      },
    };
    const source = {
      query: () =>
        answers.refunds === "throw"
          ? Promise.reject(new Error("source unavailable"))
          : Promise.resolve({ rows: [{ previous_refunded_orders: answers.refunds ?? 0 }] }),
    };
    return { app, source };
  }

  it("reports a warning with the counts that qualified", async () => {
    const { app, source } = routed({
      conversations: 3,
      cases: { formal_cases: 0, payment_disputes: 1, escalations: 0, history_as_of: "2026-10-01 10:11:39" },
    });
    const result = await resolveCustomerHistory(app, source, conversation, capabilityOf("ebay"));
    expect(result.available).toBe(true);
    expect(result.warning).toBe(true);
    expect(result.reasons).toEqual([
      { type: "previous_contacts", count: 3 },
      { type: "previous_payment_dispute", count: 1 },
    ]);
    expect(result.historyAsOf).toBe("2026-10-01 10:11:39");
    expect(result.unavailableReason).toBeNull();
  });

  /**
   * A SOURCE OUTAGE MUST NOT READ AS A CLEAN HISTORY. The refund count lives
   * on a different database from the other two, so its failure degrades that
   * one signal and leaves the rest intact.
   */
  it("degrades the refund signal to unavailable when the source throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app, source } = routed({ conversations: 1, refunds: "throw" });
      const result = await resolveCustomerHistory(app, source, conversation, capabilityOf("ebay"));
      expect(result.available).toBe(true);
      expect(result.warning).toBe(false);
      expect(result.unavailableSignals).toEqual(["previous_refunded_orders"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports the refund signal unavailable when no source client is supplied", async () => {
    const { app } = routed({ conversations: 5 });
    const result = await resolveCustomerHistory(app, null, conversation, capabilityOf("ebay"));
    expect(result.unavailableSignals).toEqual(["previous_refunded_orders"]);
    expect(result.reasons.map((r) => r.type)).toEqual(["previous_contacts"]);
  });

  /** No query is sent at all for a conversation with no verified customer. */
  it("asks the database nothing when identity is unverified", async () => {
    const app = { query: vi.fn() };
    const source = { query: vi.fn() };
    const result = await resolveCustomerHistory(
      app,
      source,
      conversation,
      capabilityOf("shopify"),
    );
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe("unsupported_marketplace");
    expect(app.query).not.toHaveBeenCalled();
    expect(source.query).not.toHaveBeenCalled();
  });

  it("asks the database nothing when the counterparty is the platform", async () => {
    const app = { query: vi.fn() };
    const result = await resolveCustomerHistory(
      app,
      null,
      { ...conversation, counterpartyRef: "eBay" },
      capabilityOf("ebay"),
    );
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe("platform_sender");
    expect(app.query).not.toHaveBeenCalled();
  });

  /**
   * THE BOUNDARY IS THE CONVERSATION'S OWN TIMESTAMP, NEVER THE SERVER CLOCK.
   * With `now()` an old thread's warning would depend on when an agent opened
   * it, so two agents reading the same thread a week apart would disagree.
   */
  it("bounds every lookup by the conversation's first source timestamp", async () => {
    const sent: Recorded[] = [];
    const record = { query: (c: Recorded) => { sent.push(c); return Promise.resolve({ rows: [{ previous_conversations: 0, formal_cases: 0, payment_disputes: 0, escalations: 0, history_as_of: null, previous_refunded_orders: 0 }] }); } };
    await resolveCustomerHistory(record, record, conversation, capabilityOf("ebay"));
    expect(sent).toHaveLength(3);
    for (const config of sent) {
      expect(config.values).toContain("2026-05-01 09:00:00");
      expect(config.text).not.toMatch(/now\(\)/);
    }
  });

  /** Every lookup carries the storefront; history is not pooled across them. */
  it("scopes every lookup to the current storefront", async () => {
    const sent: Recorded[] = [];
    const record = { query: (c: Recorded) => { sent.push(c); return Promise.resolve({ rows: [{ previous_conversations: 0, formal_cases: 0, payment_disputes: 0, escalations: 0, history_as_of: null, previous_refunded_orders: 0 }] }); } };
    await resolveCustomerHistory(record, record, conversation, capabilityOf("ebay"));
    for (const config of sent) {
      expect(config.values).toContain(22);
    }
  });
});
