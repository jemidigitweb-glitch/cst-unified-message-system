import { describe, expect, it } from "vitest";

import {
  type SourceCaseEventRow,
  collapseCaseEvents,
  rejectionSummary,
} from "@/lib/domain/customer-case-history";
import {
  MAX_CASE_HISTORY_ROWS,
  SELECT_CASE_EVENTS_SQL,
  SELECT_INQUIRY_EVENTS_SQL,
  SELECT_PAYMENT_DISPUTE_EVENTS_SQL,
} from "@/lib/db/message-app-source";
import { UPSERT_CUSTOMER_CASE_HISTORY_SQL } from "@/lib/sync/customer-case-history-writer";

/**
 * SYNTHETIC ONLY. Every identifier below is obviously fake —
 * `99-99999-99999`, `buyer-a` — because `tests/guards/no-customer-data.test.ts`
 * scans every tracked file and has already caught a real order number in four
 * fixtures. No value here came from live output.
 *
 * These tests encode the four things measured on the real source that the
 * collapse has to get right, and that a reading of the code alone would not
 * reveal:
 *
 *   1. 8,052 event rows are 1,062 cases, not 8,052 cases
 *   2. `status` is NULL on the NEWEST row of all 1,062 inquiry cases, so
 *      "latest row wins" stores NULL for every one of them
 *   3. 69 of `cases`' 127 ids are the same cases as `inquiries` rows, agreeing
 *      on buyer, storefront, type and req_date to the second
 *   4. 58 inquiry cases carry no type at all, and 1 dispute row has no case id,
 *      buyer or order — and none of the four may be repaired with a default
 */

const EBAY_SUB_SOURCES = new Set([1, 22, 28]);

/** A source event row with everything absent unless a test says otherwise. */
function event(overrides: Partial<SourceCaseEventRow> = {}): SourceCaseEventRow {
  return {
    sourceTable: "inquiries",
    caseId: "99000000001",
    eventSeq: 0,
    rowId: "1",
    buyer: "buyer-a",
    subSource: 1,
    caseType: "ITEM_NOT_RECEIVED",
    status: null,
    isCase: null,
    escDate: null,
    orderId: null,
    reqDate: "2026-03-01 09:00:00",
    ...overrides,
  };
}

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0]!;
};

describe("one row per case, not per event", () => {
  /**
   * THE DOUBLE COUNT THIS IMPORT EXISTS TO AVOID. The source is a status-event
   * log: 8,052 rows for 1,062 cases. A customer who filed one claim must not
   * report as having filed four.
   */
  it("collapses many event rows of one case into a single record", () => {
    const rows = [0, 1, 2, 3].map((seq) =>
      event({ eventSeq: seq, rowId: String(seq + 1) }),
    );

    const { records, rejections } = collapseCaseEvents(rows, {
      verifiedEbaySubSources: EBAY_SUB_SOURCES,
    });

    expect(rejections).toEqual([]);
    const record = only(records);
    expect(record.sourceCaseId).toBe("99000000001");
    expect(record.sourceRowCount).toBe(4);
  });

  it("keeps separate cases separate", () => {
    const { records } = collapseCaseEvents(
      [
        event({ caseId: "99000000001", rowId: "1" }),
        event({ caseId: "99000000002", rowId: "2", buyer: "buyer-b" }),
      ],
      { verifiedEbaySubSources: EBAY_SUB_SOURCES },
    );
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.sourceRowCount)).toEqual([1, 1]);
  });

  /** `source_row_count` is the evidence trail, so it must count events not cases. */
  it("reports total events as the sum of source_row_count, never the record count", () => {
    const rows = [
      ...[0, 1, 2].map((seq) => event({ caseId: "99000000001", eventSeq: seq, rowId: String(seq) })),
      ...[0, 1].map((seq) => event({ caseId: "99000000002", eventSeq: seq, rowId: String(10 + seq) })),
    ];
    const { records } = collapseCaseEvents(rows, { verifiedEbaySubSources: EBAY_SUB_SOURCES });
    expect(records).toHaveLength(2);
    expect(records.reduce((sum, r) => sum + r.sourceRowCount, 0)).toBe(5);
  });
});

describe("the status trap", () => {
  /**
   * MEASURED: `status` is NULL on the newest row of all 1,062 inquiry cases,
   * while existing somewhere in 1,061. A latest-row rule returns NULL for every
   * case and looks like a successful import. This is the single most important
   * test in the file.
   */
  it("takes the latest NON-NULL status, not the latest row's status", () => {
    const rows = [
      event({ eventSeq: 0, rowId: "1", status: "OPEN" }),
      event({ eventSeq: 1, rowId: "2", status: "CLOSED" }),
      event({ eventSeq: 2, rowId: "3", status: null }),
      event({ eventSeq: 3, rowId: "4", status: null }),
    ];

    const record = only(
      collapseCaseEvents(rows, { verifiedEbaySubSources: EBAY_SUB_SOURCES }).records,
    );
    expect(record.eventStatus).toBe("CLOSED");
  });

  it("reports an unknown status as null rather than inventing one", () => {
    const rows = [
      event({ eventSeq: 0, rowId: "1", status: null }),
      event({ eventSeq: 1, rowId: "2", status: "   " }),
    ];
    const record = only(
      collapseCaseEvents(rows, { verifiedEbaySubSources: EBAY_SUB_SOURCES }).records,
    );
    expect(record.eventStatus).toBeNull();
  });

  /**
   * The row-id tiebreak is load-bearing: a sequence value is not a total order
   * on its own. Ids are bigint-as-text, so a naive string compare would sort a
   * 7-digit id above a 10-digit one.
   */
  it("breaks a tied sequence by row id, comparing ids as numbers not strings", () => {
    const rows = [
      event({ eventSeq: 5, rowId: "9999999", status: "OLDER" }),
      event({ eventSeq: 5, rowId: "1000000000", status: "NEWER" }),
    ];
    const record = only(
      collapseCaseEvents(rows, { verifiedEbaySubSources: EBAY_SUB_SOURCES }).records,
    );
    expect(record.eventStatus).toBe("NEWER");
  });

  /** A null sequence must not displace a row that has one. */
  it("sorts a row with no sequence as oldest", () => {
    const rows = [
      event({ eventSeq: null, rowId: "500", status: "NO_SEQ" }),
      event({ eventSeq: 0, rowId: "1", status: "HAS_SEQ" }),
    ];
    const record = only(
      collapseCaseEvents(rows, { verifiedEbaySubSources: EBAY_SUB_SOURCES }).records,
    );
    expect(record.eventStatus).toBe("HAS_SEQ");
  });
});

describe("the date a case was raised", () => {
  /**
   * EARLIEST, not latest. A case's events accumulate over weeks; the newest
   * event's date is when it was last touched, which would make an old case look
   * recent and defeat the point of a history signal.
   */
  it("uses the earliest event date, not the most recent", () => {
    const rows = [
      event({ eventSeq: 0, rowId: "1", reqDate: "2026-01-05 08:00:00" }),
      event({ eventSeq: 1, rowId: "2", reqDate: "2026-02-20 17:30:00" }),
      event({ eventSeq: 2, rowId: "3", reqDate: "2026-03-11 11:00:00" }),
    ];
    const record = only(
      collapseCaseEvents(rows, { verifiedEbaySubSources: EBAY_SUB_SOURCES }).records,
    );
    expect(record.eventAt).toBe("2026-01-05 08:00:00");
  });

  it("rejects a case with no event date at all", () => {
    const { records, rejections } = collapseCaseEvents([event({ reqDate: null })], {
      verifiedEbaySubSources: EBAY_SUB_SOURCES,
    });
    expect(records).toEqual([]);
    expect(only(rejections).reason).toBe("no_event_date");
  });
});

describe("supersession — the 69 cases that exist in both tables", () => {
  /**
   * MEASURED: 69 of `cases`' 127 ids also appear as `inquiries.inquiry_id`, and
   * all 69 agree on buyer, storefront, type and req_date to the exact second.
   * They are one real case in two stores. Importing both tables naively gives
   * 1,225 rows for 1,156 real cases.
   *
   * 0021's unique key includes `source_table` precisely BECAUSE the id spaces
   * overlap, so the database would store both happily — which is why this is a
   * domain rule and why it must be tested.
   */
  it("drops a `cases` row whose id is already covered by inquiries", () => {
    const { records, rejections } = collapseCaseEvents(
      [event({ sourceTable: "cases", caseId: "99000000001" })],
      {
        verifiedEbaySubSources: EBAY_SUB_SOURCES,
        supersededCaseIds: new Set(["99000000001"]),
      },
    );

    expect(records).toEqual([]);
    const rejection = only(rejections);
    expect(rejection.reason).toBe("superseded_by_inquiries");
    expect(rejection.sourceTable).toBe("cases");
    expect(rejection.sourceCaseId).toBe("99000000001");
  });

  /** The 58 ids unique to `cases` are the whole reason the table is imported. */
  it("keeps a `cases` row whose id inquiries does not have", () => {
    const { records, rejections } = collapseCaseEvents(
      [event({ sourceTable: "cases", caseId: "99000000777" })],
      {
        verifiedEbaySubSources: EBAY_SUB_SOURCES,
        supersededCaseIds: new Set(["99000000001"]),
      },
    );
    expect(rejections).toEqual([]);
    expect(only(records).sourceCaseId).toBe("99000000777");
  });

  /** Supersession must never be applied to inquiries itself. */
  it("does not supersede anything when no superseded set is given", () => {
    const { records } = collapseCaseEvents([event()], {
      verifiedEbaySubSources: EBAY_SUB_SOURCES,
    });
    expect(records).toHaveLength(1);
  });
});

describe("nothing is guessed — unmappable cases are rejected and counted", () => {
  /** MEASURED: 58 of 1,062 inquiry cases carry no `type` on any row. */
  it("rejects a case whose type the source never recorded", () => {
    const { records, rejections } = collapseCaseEvents([event({ caseType: null })], {
      verifiedEbaySubSources: EBAY_SUB_SOURCES,
    });
    expect(records).toEqual([]);
    expect(only(rejections).reason).toBe("unmapped_case_type");
  });

  /** A vocabulary nobody has reviewed must not reach a verified column. */
  it("rejects a case type outside the measured vocabulary", () => {
    const { rejections } = collapseCaseEvents([event({ caseType: "SOMETHING_NEW" })], {
      verifiedEbaySubSources: EBAY_SUB_SOURCES,
    });
    expect(only(rejections).reason).toBe("unmapped_case_type");
  });

  /** MEASURED: 1 payment_disputes row has case_id, buyer and order_id all NULL. */
  it("rejects rows with no case id, counting rows rather than naming cases", () => {
    const { records, rejections } = collapseCaseEvents(
      [
        event({ sourceTable: "payment_disputes", caseId: null, rowId: "1" }),
        event({ sourceTable: "payment_disputes", caseId: null, rowId: "2" }),
      ],
      { verifiedEbaySubSources: EBAY_SUB_SOURCES },
    );

    expect(records).toEqual([]);
    const rejection = only(rejections);
    expect(rejection.reason).toBe("no_case_id");
    expect(rejection.sourceCaseId).toBeNull();
    // Two rows, one rejection: they have no identity, so counting them as two
    // cases would claim we know they were distinct.
    expect(rejection.sourceRowCount).toBe(2);
  });

  it("rejects a case with no buyer, since the buyer is the matching key", () => {
    const { rejections } = collapseCaseEvents([event({ buyer: "  " })], {
      verifiedEbaySubSources: EBAY_SUB_SOURCES,
    });
    expect(only(rejections).reason).toBe("no_buyer");
  });

  it("rejects a case with no storefront", () => {
    const { rejections } = collapseCaseEvents([event({ subSource: null })], {
      verifiedEbaySubSources: EBAY_SUB_SOURCES,
    });
    expect(only(rejections).reason).toBe("no_storefront");
  });

  /**
   * `marketplace` is NOT NULL in 0021, so there is no honest NULL to fall back
   * on. A storefront outside the verified eBay set is rejected rather than
   * labelled 'ebay' because of which table it came from.
   */
  it("rejects a storefront not in the verified eBay set", () => {
    const { records, rejections } = collapseCaseEvents([event({ subSource: 8 })], {
      verifiedEbaySubSources: EBAY_SUB_SOURCES,
    });
    expect(records).toEqual([]);
    expect(only(rejections).reason).toBe("unverified_storefront");
  });

  it("tallies rejections by reason, in cases and in rows", () => {
    const { rejections } = collapseCaseEvents(
      [
        event({ caseId: "99000000001", caseType: null, rowId: "1" }),
        event({ caseId: "99000000001", caseType: null, rowId: "2" }),
        event({ caseId: "99000000002", buyer: null, rowId: "3" }),
      ],
      { verifiedEbaySubSources: EBAY_SUB_SOURCES },
    );

    const summary = rejectionSummary(rejections);
    expect(summary.get("unmapped_case_type")).toEqual({ cases: 1, rows: 2 });
    expect(summary.get("no_buyer")).toEqual({ cases: 1, rows: 1 });
  });
});

describe("per-table field rules", () => {
  /**
   * Only `inquiries` records escalation. `cases.esc_reason` is NULL on all
   * 1,038 of its rows and `payment_disputes` has no escalation concept, so both
   * are `not_recorded` — the state meaning "the source carries no signal", not
   * a signal meaning no. 0021's
   * ck_customer_case_history_escalation_source makes anything else
   * unrepresentable for those tables, so a wrong value here is a failed insert.
   */
  it("reads escalation from inquiries, and reports not_recorded elsewhere", () => {
    const escalated = only(
      collapseCaseEvents([event({ isCase: 1 })], { verifiedEbaySubSources: EBAY_SUB_SOURCES })
        .records,
    );
    expect(escalated.escalation).toBe("escalated");

    const byDate = only(
      collapseCaseEvents([event({ escDate: "2026-03-04 10:00:00" })], {
        verifiedEbaySubSources: EBAY_SUB_SOURCES,
      }).records,
    );
    expect(byDate.escalation).toBe("escalated");

    const notEscalated = only(
      collapseCaseEvents([event()], { verifiedEbaySubSources: EBAY_SUB_SOURCES }).records,
    );
    expect(notEscalated.escalation).toBe("not_escalated");

    for (const sourceTable of ["cases", "payment_disputes"] as const) {
      const record = only(
        collapseCaseEvents(
          [event({ sourceTable, caseType: sourceTable === "cases" ? "RETURN" : null, isCase: 1 })],
          { verifiedEbaySubSources: EBAY_SUB_SOURCES },
        ).records,
      );
      expect(record.escalation).toBe("not_recorded");
    }
  });

  /**
   * Escalation is recorded if ANY event in the case shows it, not only the
   * newest — an escalation is an event that happened, and a later event does
   * not un-happen it.
   */
  it("treats escalation as sticky across the case's events", () => {
    const rows = [
      event({ eventSeq: 0, rowId: "1", isCase: 1 }),
      event({ eventSeq: 1, rowId: "2", isCase: null }),
    ];
    const record = only(
      collapseCaseEvents(rows, { verifiedEbaySubSources: EBAY_SUB_SOURCES }).records,
    );
    expect(record.escalation).toBe("escalated");
  });

  /**
   * Only `payment_disputes` records an order, and 0021's
   * ck_customer_case_history_order_ref_dispute_only enforces it. The other two
   * tables have no order id to carry; deriving one from item + buyer is what
   * resolve-order-context.ts does, with an ambiguous outcome on real data.
   */
  it("carries an order reference only for a payment dispute", () => {
    const dispute = only(
      collapseCaseEvents(
        [event({ sourceTable: "payment_disputes", caseType: null, orderId: "99-99999-99999" })],
        { verifiedEbaySubSources: EBAY_SUB_SOURCES },
      ).records,
    );
    expect(dispute.eventType).toBe("PAYMENT_DISPUTE");
    expect(dispute.orderRef).toBe("99-99999-99999");

    // An order id present on an inquiries row is ignored, not carried: the
    // table has no such column, so a populated field here would be a reader bug
    // and must not become a stored "verified" order.
    const inquiry = only(
      collapseCaseEvents([event({ orderId: "99-99999-99999" })], {
        verifiedEbaySubSources: EBAY_SUB_SOURCES,
      }).records,
    );
    expect(inquiry.orderRef).toBeNull();
  });

  /** A dispute whose order the source never recorded is still importable. */
  it("accepts a payment dispute with no order reference", () => {
    const record = only(
      collapseCaseEvents(
        [event({ sourceTable: "payment_disputes", caseType: null, orderId: null })],
        { verifiedEbaySubSources: EBAY_SUB_SOURCES },
      ).records,
    );
    expect(record.orderRef).toBeNull();
  });

  it("stamps every record with the source database and a verified marketplace", () => {
    const record = only(
      collapseCaseEvents([event()], { verifiedEbaySubSources: EBAY_SUB_SOURCES }).records,
    );
    expect(record.sourceDatabase).toBe("message_app");
    expect(record.marketplace).toBe("ebay");
  });
});

describe("the readers select only what 0021 stores", () => {
  const READERS = [
    { name: "inquiries", sql: SELECT_INQUIRY_EVENTS_SQL },
    { name: "cases", sql: SELECT_CASE_EVENTS_SQL },
    { name: "payment_disputes", sql: SELECT_PAYMENT_DISPUTE_EVENTS_SQL },
  ];

  /**
   * The source tables hold a customer's case correspondence, their postal
   * location in a longtext, and free-text dispute reasons. A column that is
   * never selected cannot be stored by accident — the rule `fetchStaffPage`
   * applies to the credential columns in `order_management.user`.
   */
  const FORBIDDEN = [
    "comments", "buyer_req", "buyer_note", "esc_reason", "evi_seller_note",
    "return_address", "tracking_no", "tracking_url", "tracking_status",
    "carrier", "claim_amount", "claim_cur", "refund_payload", "due_date",
    "item_id", "transaction_id",
  ];

  it.each(READERS)("$name selects no free-text, postal or payload column", ({ sql }) => {
    const lower = sql.toLowerCase();
    for (const column of FORBIDDEN) {
      expect(lower).not.toContain(column);
    }
  });

  it.each(READERS)("$name is a SELECT and nothing else", ({ sql }) => {
    expect(sql).toMatch(/^\s*SELECT\b/);
    for (const verb of ["insert", "update", "delete", "truncate", "alter", "drop", "create"]) {
      expect(sql.toLowerCase()).not.toContain(verb);
    }
  });

  /**
   * The runaway guard is bound, not interpolated, and it is a guard rather than
   * pagination: no date column on any of the three tables is indexed, so paging
   * would spend an account capped at 100 queries per hour re-reading a table
   * smaller than one page.
   */
  it.each(READERS)("$name binds its limit rather than interpolating one", ({ sql }) => {
    expect(sql).toMatch(/LIMIT \?/);
    expect(sql).not.toMatch(/LIMIT\s+\d/);
  });

  it("guards each table well above its measured size", () => {
    expect(MAX_CASE_HISTORY_ROWS.inquiries).toBeGreaterThan(8_052);
    expect(MAX_CASE_HISTORY_ROWS.cases).toBeGreaterThan(1_038);
    expect(MAX_CASE_HISTORY_ROWS.payment_disputes).toBeGreaterThan(37);
  });

  /** The event sequence is what makes the collapse possible at all. */
  it("selects the event sequence the collapse needs", () => {
    expect(SELECT_INQUIRY_EVENTS_SQL).toContain("res_his_order");
    expect(SELECT_CASE_EVENTS_SQL).toContain("res_his_order");
    // payment_disputes has no res_his_order; `revision` is its sequence.
    expect(SELECT_PAYMENT_DISPUTE_EVENTS_SQL).toContain("revision");
  });
});

describe("the writer is idempotent and bounded", () => {
  /**
   * The conflict target must match `uq_customer_case_history_source_identity`
   * exactly, or a re-run appends a second copy of the history instead of
   * updating it.
   */
  it("upserts on the source identity 0021 made unique", () => {
    expect(UPSERT_CUSTOMER_CASE_HISTORY_SQL).toMatch(
      /ON CONFLICT \(source_database, source_table, source_case_id\) DO UPDATE/,
    );
  });

  /**
   * A plain column list is correct here ONLY because all three key columns are
   * NOT NULL. `sla-policy-writer.ts` needs a coalesce because one of its key
   * columns is nullable and PostgreSQL treats NULLs as distinct — which would
   * let the same row insert forever.
   */
  it("needs no coalesce in its conflict target, and has none", () => {
    expect(UPSERT_CUSTOMER_CASE_HISTORY_SQL).not.toMatch(/ON CONFLICT[^)]*coalesce/i);
  });

  it("refreshes imported_at on both paths so a stale copy is visible", () => {
    const sql = UPSERT_CUSTOMER_CASE_HISTORY_SQL;
    expect(sql).toMatch(/VALUES[\s\S]*now\(\)/);
    expect(sql).toMatch(/DO UPDATE[\s\S]*imported_at\s*=\s*now\(\)/);
  });

  /** So the caller can report real counts rather than "n affected". */
  it("reports whether each row was inserted or updated", () => {
    expect(UPSERT_CUSTOMER_CASE_HISTORY_SQL).toMatch(/RETURNING \(xmax = 0\) AS inserted/);
  });

  /**
   * `event_at` holds a naive source datetime byte-for-byte. Without an explicit
   * cast the driver's inference and the session timezone decide, which is how a
   * preserved source value quietly acquires an offset.
   */
  it("casts the naive source timestamp explicitly", () => {
    expect(UPSERT_CUSTOMER_CASE_HISTORY_SQL).toMatch(/\$11::timestamp/);
  });

  it("writes one table and deletes nothing", () => {
    const sql = UPSERT_CUSTOMER_CASE_HISTORY_SQL.toLowerCase();
    expect(sql).toContain("insert into cst_app.customer_case_history");
    expect(sql).not.toContain("delete");
    expect(sql).not.toContain("truncate");
    expect(sql).not.toContain("cst_app.conversations");
  });

  it("binds every value rather than interpolating one", () => {
    // 12 bound parameters, and no bare string literal other than the SQL
    // keywords and the two table/column names the statement names itself.
    expect(UPSERT_CUSTOMER_CASE_HISTORY_SQL).toMatch(/\$12::int/);
    expect(UPSERT_CUSTOMER_CASE_HISTORY_SQL).not.toMatch(/\$\{/);
  });
});
