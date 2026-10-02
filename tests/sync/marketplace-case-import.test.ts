import { describe, expect, it } from "vitest";

import { parseAccountLimits } from "@/lib/db/message-app-case-source";
import type { MarketplaceCaseRecord } from "@/lib/domain/marketplace-case";
import { storefrontAllowlistFrom } from "@/lib/repositories/order-line-lookup-repository";
import {
  FAIL_IMPORT_RUN_SQL,
  LAST_PUBLISHED_BY_STORE_SQL,
  OPEN_IMPORT_RUN_SQL,
  PUBLISH_IMPORT_RUN_SQL,
  UPSERT_BATCH_SIZE,
  UPSERT_MARKETPLACE_CASE_SQL,
  UPSERT_VALUES_PER_ROW,
  failImportRun,
  lastPublishedByStore,
  openImportRun,
  publishImportRun,
  upsertMarketplaceCases,
  upsertStatementFor,
} from "@/lib/sync/marketplace-case-writer";

/**
 * Import publication, idempotency and rollback — against a MOCKED PostgreSQL.
 *
 * NO DATABASE AND NO MYSQL. The fake below implements only the statements this
 * writer issues, plus the three things about 0022 the behaviour depends on: the
 * unique source identity, the single-in-progress unique index, and the
 * publication CHECKs. Anything else it is asked to run is an explicit failure, so
 * a statement this suite has not reasoned about cannot pass silently.
 *
 * It models TRANSACTIONS for real — staged writes are discarded on ROLLBACK —
 * because "a failed import exposes no partial record" is a claim about
 * transaction boundaries and testing it against a mock that commits eagerly would
 * prove nothing.
 */

type FakeCase = { record: MarketplaceCaseRecord; runId: string };
type FakeRun = {
  id: string;
  status: "in_progress" | "published" | "failed";
  sourceTables: string[];
  publishedAt: string | null;
  counts: { read: number; inserted: number; updated: number; rejected: number } | null;
  error: string | null;
};

/** A monotonic stand-in for now(), so a test never depends on the real clock. */
let tick = 0;
function nextStamp(): string {
  tick += 1;
  return `2026-10-02 12:00:${String(tick).padStart(2, "0")}+00`;
}

class FakePostgres {
  committedCases = new Map<string, FakeCase>();
  committedRuns = new Map<string, FakeRun>();
  private stagedCases: Map<string, FakeCase> | null = null;
  private stagedRuns: Map<string, FakeRun> | null = null;
  private nextId = 1;
  statements: string[] = [];
  /**
   * Throw on the Nth upsert OF THE CURRENT TRANSACTION, to simulate a failure
   * part-way through a batch. Counted per transaction and reset on BEGIN: a
   * counter that survived across runs made the second run of the
   * previous-snapshot test unreachable, which is how that test first "passed".
   */
  failOnUpsert: number | null = null;
  private upsertCount = 0;

  private get cases() {
    return this.stagedCases ?? this.committedCases;
  }
  private get runs() {
    return this.stagedRuns ?? this.committedRuns;
  }

  async query(config: { text: string; values?: unknown[] } | string): Promise<{ rows: unknown[] }> {
    const text = typeof config === "string" ? config : config.text;
    const values = typeof config === "string" ? [] : (config.values ?? []);
    this.statements.push(text.trim().split("\n")[0]!.trim());

    if (/^\s*BEGIN\s*$/i.test(text)) {
      this.stagedCases = new Map(this.committedCases);
      this.stagedRuns = new Map([...this.committedRuns].map(([k, v]) => [k, { ...v }]));
      this.upsertCount = 0;
      return { rows: [] };
    }
    if (/^\s*COMMIT\s*$/i.test(text)) {
      if (this.stagedCases) this.committedCases = this.stagedCases;
      if (this.stagedRuns) this.committedRuns = this.stagedRuns;
      this.stagedCases = null;
      this.stagedRuns = null;
      return { rows: [] };
    }
    if (/^\s*ROLLBACK\s*$/i.test(text)) {
      this.stagedCases = null;
      this.stagedRuns = null;
      return { rows: [] };
    }

    if (text === OPEN_IMPORT_RUN_SQL) {
      // uq_case_import_runs_single_in_progress: at most one in-progress run.
      for (const run of this.runs.values()) {
        if (run.status === "in_progress") {
          throw new Error(
            'duplicate key value violates unique constraint "uq_case_import_runs_single_in_progress"',
          );
        }
      }
      const id = String(this.nextId++);
      this.runs.set(id, {
        id,
        status: "in_progress",
        sourceTables: [...(values[0] as string[])],
        publishedAt: null,
        counts: null,
        error: null,
      });
      return { rows: [{ id }] };
    }

    // The upsert is now batched: one statement carries N rows, so the fake
    // recognises it by shape and decodes every tuple rather than assuming one.
    if (text.startsWith("\nINSERT INTO cst_app.marketplace_cases")) {
      const rowCount = values.length / UPSERT_VALUES_PER_ROW;
      expect(Number.isInteger(rowCount)).toBe(true);
      expect(text).toBe(upsertStatementFor(rowCount));

      this.upsertCount += 1;
      if (this.failOnUpsert !== null && this.upsertCount === this.failOnUpsert) {
        throw new Error("simulated failure part-way through the batch");
      }

      const out: Array<{ inserted: boolean }> = [];
      for (let r = 0; r < rowCount; r += 1) {
        const v = values.slice(r * UPSERT_VALUES_PER_ROW, (r + 1) * UPSERT_VALUES_PER_ROW);
        const key = `${v[0]}|${v[1]}|${v[2]}`;
        const existed = this.cases.has(key);
        this.cases.set(key, {
          runId: String(v[30]),
          record: {
            sourceDatabase: v[0] as "message_app",
            sourceTable: v[1] as MarketplaceCaseRecord["sourceTable"],
            sourceCaseId: v[2] as string,
            marketplace: v[3] as MarketplaceCaseRecord["marketplace"],
            subSourceId: v[4] as number,
            caseType: v[5] as MarketplaceCaseRecord["caseType"],
            orderRef: v[6] as string | null,
            orderMatchMethod: v[7] as MarketplaceCaseRecord["orderMatchMethod"],
            orderLineItemRef: v[8] as string | null,
            orderTxnRef: v[9] as string | null,
            counterpartyRef: v[10] as string | null,
            lifecycle: v[11] as MarketplaceCaseRecord["lifecycle"],
            sourceStatus: v[12] as string | null,
            sourceState: v[13] as string | null,
            sourceDisposition: v[14] as string | null,
            sourceResolution: v[15] as string | null,
            sourceReason: v[16] as string | null,
            sourceReasonFamily: v[17] as string | null,
            damageReported: v[18] as boolean,
            replacementConfirmed: v[19] as boolean,
            escalation: v[20] as MarketplaceCaseRecord["escalation"],
            sellerActionOwed: v[21] as string | null,
            sellerActionDueAt: v[22] as string | null,
            quantity: v[23] as number | null,
            refundAmount: v[24] as string | null,
            refundCurrency: v[25] as string | null,
            openedAt: v[26] as string,
            closedAt: v[27] as string | null,
            sourceUpdatedAt: v[28] as string | null,
            sourceRowCount: v[29] as number,
          },
        });
        out.push({ inserted: !existed });
      }
      return { rows: out };
    }

    if (text === PUBLISH_IMPORT_RUN_SQL) {
      const run = this.runs.get(String(values[0]));
      // `AND status = 'in_progress'` — publishing twice affects no row.
      if (run === undefined || run.status !== "in_progress") return { rows: [] };
      const counts = {
        read: values[1] as number,
        inserted: values[2] as number,
        updated: values[3] as number,
        rejected: values[4] as number,
      };
      // ck_case_import_runs_published_has_counts
      for (const value of Object.values(counts)) {
        if (value === null || value === undefined) {
          throw new Error('violates check constraint "ck_case_import_runs_published_has_counts"');
        }
      }
      const publishedAt = nextStamp();
      this.runs.set(run.id, { ...run, status: "published", publishedAt, counts });
      return { rows: [{ published_at: publishedAt }] };
    }

    if (text === FAIL_IMPORT_RUN_SQL) {
      const run = this.runs.get(String(values[0]));
      if (run === undefined || run.status !== "in_progress") return { rows: [] };
      this.runs.set(run.id, { ...run, status: "failed", error: values[1] as string });
      return { rows: [] };
    }

    if (text === LAST_PUBLISHED_BY_STORE_SQL) {
      const out = new Map<string, string>();
      for (const run of this.runs.values()) {
        if (run.status !== "published" || run.publishedAt === null) continue;
        for (const store of run.sourceTables) {
          const current = out.get(store);
          if (current === undefined || current < run.publishedAt) out.set(store, run.publishedAt);
        }
      }
      return {
        rows: [...out].sort().map(([source_table, published_at]) => ({ source_table, published_at })),
      };
    }

    throw new Error(`FakePostgres was asked to run an unmodelled statement:\n${text}`);
  }

  /** Only rows whose run is published — the read-path gate the repository owns. */
  visibleCases(): FakeCase[] {
    return [...this.committedCases.values()].filter(
      (c) => this.committedRuns.get(c.runId)?.status === "published",
    );
  }
}

function record(overrides: Partial<MarketplaceCaseRecord> = {}): MarketplaceCaseRecord {
  return {
    sourceDatabase: "message_app",
    sourceTable: "ebay_returns",
    sourceCaseId: "5289490057",
    marketplace: "ebay",
    subSourceId: 21,
    caseType: "RETURN",
    orderRef: "99-99999-99991",
    orderMatchMethod: "source_order_id_verified",
    orderLineItemRef: "1111111111",
    orderTxnRef: "2222333344441",
    counterpartyRef: null,
    lifecycle: "closed",
    sourceStatus: "CLOSED",
    sourceState: "CLOSED",
    sourceDisposition: null,
    sourceResolution: "MONEY_BACK",
    sourceReason: "WRONG_SIZE",
    sourceReasonFamily: "REMORSE",
    damageReported: false,
    replacementConfirmed: false,
    escalation: "not_escalated",
    sellerActionOwed: "SELLER_ISSUE_REFUND",
    sellerActionDueAt: "2026-05-10 09:00:00",
    quantity: 1,
    refundAmount: "24.99",
    refundCurrency: "GBP",
    openedAt: "2026-05-01 09:00:00",
    closedAt: null,
    sourceUpdatedAt: "2026-05-11 10:00:00",
    sourceRowCount: 2,
    ...overrides,
  };
}

const COUNTS = {
  casesRead: 1,
  casesInserted: 1,
  casesUpdated: 0,
  casesRejected: 0,
  rejectionSummary: {},
};

/** The protocol the importer follows: TX1 open, TX2 upsert + publish. */
async function runImport(
  db: FakePostgres,
  records: readonly MarketplaceCaseRecord[],
  sourceTables: readonly string[] = ["ebay_returns"],
  /**
   * One row per statement by default here, so `failOnUpsert` still means "fail
   * part-way through the batch" — the thing the rollback tests are about. The
   * real importer uses `UPSERT_BATCH_SIZE`, and the batching suite covers that.
   */
  batchSize = 1,
): Promise<{ runId: string; inserted: number; updated: number }> {
  await db.query("BEGIN");
  const runId = await openImportRun(db, {
    sourceTables,
    mysqlConnections: 1,
    mysqlQueries: 12,
  });
  await db.query("COMMIT");

  await db.query("BEGIN");
  try {
    const outcome = await upsertMarketplaceCases(db, records, runId, { batchSize });
    await publishImportRun(db, runId, {
      ...COUNTS,
      casesRead: records.length,
      casesInserted: outcome.inserted,
      casesUpdated: outcome.updated,
    });
    await db.query("COMMIT");
    return { runId, ...outcome };
  } catch (cause) {
    await db.query("ROLLBACK");
    await failImportRun(db, runId, (cause as Error).message);
    throw cause;
  }
}

// ===========================================================================
describe("11 — an import re-run is idempotent", () => {
  it("inserts on the first run and updates on the second, with no second copy", async () => {
    const db = new FakePostgres();
    const first = await runImport(db, [record()]);
    expect(first).toMatchObject({ inserted: 1, updated: 0 });
    expect(db.committedCases.size).toBe(1);

    const second = await runImport(db, [record({ sourceStatus: "ESCALATED" })]);
    expect(second).toMatchObject({ inserted: 0, updated: 1 });
    expect(db.committedCases.size).toBe(1);
    expect([...db.committedCases.values()][0]!.record.sourceStatus).toBe("ESCALATED");
  });

  it("keys on (source_database, source_table, source_case_id) and nothing else", () => {
    // A plain column conflict target is only correct because all three columns
    // are NOT NULL; sla-policy-writer.ts needs a coalesce for exactly that reason.
    expect(UPSERT_MARKETPLACE_CASE_SQL).toContain(
      "ON CONFLICT (source_database, source_table, source_case_id) DO UPDATE",
    );
    expect(UPSERT_MARKETPLACE_CASE_SQL).not.toContain("coalesce(");
  });

  it("refreshes imported_at and import_run_id on every update, so staleness stays visible", () => {
    expect(UPSERT_MARKETPLACE_CASE_SQL).toMatch(/imported_at\s+= now\(\)/);
    expect(UPSERT_MARKETPLACE_CASE_SQL).toMatch(/import_run_id\s+= EXCLUDED\.import_run_id/);
  });

  it("stores the same id from two stores as two rows, not one", async () => {
    const db = new FakePostgres();
    await runImport(
      db,
      [
        record({ sourceTable: "payment_disputes", sourceCaseId: "123", caseType: "PAYMENT_DISPUTE" }),
        record({ sourceTable: "cases", sourceCaseId: "123", caseType: "ITEM_NOT_RECEIVED" }),
      ],
      ["payment_disputes", "cases"],
    );
    expect(db.committedCases.size).toBe(2);
  });
});

// ===========================================================================
describe("12 — a failed import rolls every case change back", () => {
  it("writes no case row at all when the batch fails part-way", async () => {
    const db = new FakePostgres();
    db.failOnUpsert = 2;
    await expect(runImport(db, [record({ sourceCaseId: "A" }), record({ sourceCaseId: "B" })])).rejects.toThrow(
      /simulated failure/,
    );
    // The first upsert HAD staged a row. The rollback discarded it.
    expect(db.committedCases.size).toBe(0);
    expect(db.visibleCases()).toEqual([]);
  });

  it("records the run as failed, with the reason, and never as published", async () => {
    const db = new FakePostgres();
    db.failOnUpsert = 1;
    await expect(runImport(db, [record()])).rejects.toThrow();
    const runs = [...db.committedRuns.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error).toMatch(/simulated failure/);
    expect(runs[0]!.publishedAt).toBeNull();
  });

  it("leaves no publication for the freshness read to find", async () => {
    const db = new FakePostgres();
    db.failOnUpsert = 1;
    await expect(runImport(db, [record()])).rejects.toThrow();
    expect(await lastPublishedByStore(db)).toEqual(new Map());
  });

  /**
   * The failure row is written AFTER the rollback, in its own transaction. If it
   * were inside transaction 2 it would roll back with everything else and the
   * attempt would vanish from the record.
   */
  it("records the failure outside the rolled-back transaction", async () => {
    const db = new FakePostgres();
    db.failOnUpsert = 1;
    await expect(runImport(db, [record()])).rejects.toThrow();
    const order = db.statements;
    expect(order.indexOf("ROLLBACK")).toBeLessThan(
      order.findIndex((s) => s.startsWith("UPDATE cst_app.case_import_runs")),
    );
  });

  it("refuses to publish a run that is not in progress, rather than re-stamping it", async () => {
    const db = new FakePostgres();
    const { runId } = await runImport(db, [record()]);
    await expect(publishImportRun(db, runId, COUNTS)).rejects.toThrow(/was not in progress/);
  });
});

// ===========================================================================
describe("13 — a previously published snapshot survives a later failure", () => {
  it("keeps the earlier rows readable and unchanged", async () => {
    const db = new FakePostgres();
    await runImport(db, [record({ sourceCaseId: "KEEP", sourceStatus: "CLOSED" })]);
    expect(db.visibleCases()).toHaveLength(1);

    db.failOnUpsert = 1;
    await expect(
      runImport(db, [record({ sourceCaseId: "KEEP", sourceStatus: "ESCALATED" })]),
    ).rejects.toThrow();

    // The row is still the FIRST run's version, byte for byte, and still visible.
    const visible = db.visibleCases();
    expect(visible).toHaveLength(1);
    expect(visible[0]!.record.sourceStatus).toBe("CLOSED");
  });

  it("keeps the earlier run published, so freshness does not regress", async () => {
    const db = new FakePostgres();
    await runImport(db, [record()], ["ebay_returns"]);
    const before = await lastPublishedByStore(db);

    db.failOnUpsert = 1;
    await expect(runImport(db, [record()], ["ebay_returns"])).rejects.toThrow();

    expect(await lastPublishedByStore(db)).toEqual(before);
  });

  /**
   * A refresh that dies must not leave existing rows pointing at the failed run,
   * because the read-path gate would then hide correct data. The rollback reverts
   * the `import_run_id` update along with everything else.
   */
  it("does not leave an existing row naming the failed run", async () => {
    const db = new FakePostgres();
    const first = await runImport(db, [record({ sourceCaseId: "KEEP" })]);
    db.failOnUpsert = 2;
    await expect(
      runImport(db, [record({ sourceCaseId: "KEEP" }), record({ sourceCaseId: "OTHER" })]),
    ).rejects.toThrow();
    expect([...db.committedCases.values()][0]!.runId).toBe(first.runId);
    expect(db.visibleCases()).toHaveLength(1);
  });
});

// ===========================================================================
describe("14 — coverage and freshness are per source store", () => {
  it("reports each store's own last publication, not one global timestamp", async () => {
    const db = new FakePostgres();
    await runImport(db, [record({ sourceTable: "ebay_returns", sourceCaseId: "R1" })], [
      "ebay_returns",
      "inquiries",
    ]);
    await runImport(
      db,
      [record({ sourceTable: "inquiries", sourceCaseId: "I1", caseType: "ITEM_NOT_RECEIVED" })],
      ["inquiries"],
    );

    const freshness = await lastPublishedByStore(db);
    expect([...freshness.keys()].sort()).toEqual(["ebay_returns", "inquiries"]);
    // The later inquiry-only run must NOT make the return store look fresher.
    expect(freshness.get("inquiries")! > freshness.get("ebay_returns")!).toBe(true);
  });

  /**
   * A store read successfully that legitimately held no importable case STILL
   * COUNTS AS COVERED. Demanding a row from it would make an empty store
   * indistinguishable from an unread one.
   */
  it("counts a declared store with zero cases as covered", async () => {
    const db = new FakePostgres();
    await db.query("BEGIN");
    const runId = await openImportRun(db, {
      sourceTables: ["amz_cancellations"],
      mysqlConnections: 1,
      mysqlQueries: 3,
    });
    await db.query("COMMIT");
    await db.query("BEGIN");
    await publishImportRun(db, runId, { ...COUNTS, casesRead: 0, casesInserted: 0 });
    await db.query("COMMIT");

    const freshness = await lastPublishedByStore(db);
    expect(freshness.has("amz_cancellations")).toBe(true);
    expect(db.committedCases.size).toBe(0);
  });

  it("reports a store that was never published as absent, not as zero", async () => {
    const db = new FakePostgres();
    await runImport(db, [record()], ["ebay_returns"]);
    const freshness = await lastPublishedByStore(db);
    expect(freshness.has("ebay_returns")).toBe(true);
    // Absent, so a caller must say "never imported" rather than "no cases found".
    expect(freshness.has("shopify_returns")).toBe(false);
    expect(freshness.get("shopify_returns")).toBeUndefined();
  });

  it("reads freshness from published runs only", () => {
    expect(LAST_PUBLISHED_BY_STORE_SQL).toContain("WHERE r.status = 'published'");
    expect(LAST_PUBLISHED_BY_STORE_SQL).toContain("unnest(r.source_tables)");
  });
});

// ===========================================================================
describe("15 — a dry run writes nothing", () => {
  /**
   * The ledger has no mode column and no dry-run state, so a rehearsal has
   * nothing to write. A dry run simply never reaches these functions — which is
   * what makes the property structural rather than a branch somebody could get
   * wrong.
   */
  it("has no dry-run state anywhere in the writer", () => {
    for (const sql of [
      OPEN_IMPORT_RUN_SQL,
      UPSERT_MARKETPLACE_CASE_SQL,
      PUBLISH_IMPORT_RUN_SQL,
      FAIL_IMPORT_RUN_SQL,
      LAST_PUBLISHED_BY_STORE_SQL,
    ]) {
      expect(sql.toLowerCase()).not.toContain("dry_run");
      expect(sql.toLowerCase()).not.toContain("mode");
    }
  });

  it("leaves the database untouched when no writer is called", async () => {
    const db = new FakePostgres();
    // A rehearsal reads MySQL and the order source, collapses, and reports. It
    // calls none of the writers, so there is nothing for the fake to record.
    expect(db.statements).toEqual([]);
    expect(db.committedCases.size).toBe(0);
    expect(db.committedRuns.size).toBe(0);
    expect(await lastPublishedByStore(db)).toEqual(new Map());
  });

  it("contains no DELETE, TRUNCATE or DROP in any statement", () => {
    for (const sql of [
      OPEN_IMPORT_RUN_SQL,
      UPSERT_MARKETPLACE_CASE_SQL,
      PUBLISH_IMPORT_RUN_SQL,
      FAIL_IMPORT_RUN_SQL,
      LAST_PUBLISHED_BY_STORE_SQL,
    ]) {
      expect(sql).not.toMatch(/\bDELETE\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
      expect(sql).not.toMatch(/\bDROP\b/i);
    }
  });

  it("never names customer_case_history, so the warning's storage is untouched", () => {
    for (const sql of [
      OPEN_IMPORT_RUN_SQL,
      UPSERT_MARKETPLACE_CASE_SQL,
      PUBLISH_IMPORT_RUN_SQL,
      FAIL_IMPORT_RUN_SQL,
      LAST_PUBLISHED_BY_STORE_SQL,
    ]) {
      expect(sql).not.toContain("customer_case_history");
    }
  });
});

// ===========================================================================
describe("atomic publication: data and its publication commit together", () => {
  it("publishes inside the same transaction as the upserts", async () => {
    const db = new FakePostgres();
    await runImport(db, [record()]);
    const s = db.statements;
    const begins = s.reduce<number[]>((acc, v, i) => (v === "BEGIN" ? [...acc, i] : acc), []);
    const commits = s.reduce<number[]>((acc, v, i) => (v === "COMMIT" ? [...acc, i] : acc), []);
    const upsert = s.findIndex((v) => v.startsWith("INSERT INTO cst_app.marketplace_cases"));
    const publish = s.findIndex((v) => v.startsWith("UPDATE cst_app.case_import_runs"));

    // Two transactions: TX1 opens the run, TX2 carries the data AND the publish.
    expect(begins).toHaveLength(2);
    expect(commits).toHaveLength(2);
    expect(upsert).toBeGreaterThan(begins[1]!);
    expect(publish).toBeGreaterThan(upsert);
    expect(publish).toBeLessThan(commits[1]!);
  });

  it("refuses a second concurrent run, as the single-in-progress index requires", async () => {
    const db = new FakePostgres();
    await db.query("BEGIN");
    await openImportRun(db, { sourceTables: ["inquiries"], mysqlConnections: 1, mysqlQueries: 3 });
    await db.query("COMMIT");

    await expect(
      openImportRun(db, { sourceTables: ["cases"], mysqlConnections: 1, mysqlQueries: 3 }),
    ).rejects.toThrow(/uq_case_import_runs_single_in_progress/);
  });

  it("stores the source budget it spent, so the allowance is auditable", async () => {
    const db = new FakePostgres();
    await db.query("BEGIN");
    const runId = await openImportRun(db, {
      sourceTables: ["ebay_returns"],
      mysqlConnections: 1,
      mysqlQueries: 12,
    });
    await db.query("COMMIT");
    expect(runId).toBe("1");
    expect(OPEN_IMPORT_RUN_SQL).toContain("mysql_connections");
    expect(OPEN_IMPORT_RUN_SQL).toContain("mysql_queries");
    expect(OPEN_IMPORT_RUN_SQL).toContain("'in_progress'");
  });
});

// ===========================================================================
describe("batched upserts, in one transaction", () => {
  /**
   * BATCHING IS A ROUND-TRIP FIX, NOT A TRANSACTION CHANGE, and the first apply
   * run is what forced it: 21,022 one-row statements against a remote PostgreSQL
   * over TLS exceeded ten minutes and the run was killed mid-transaction. The
   * batches are statements inside the SAME transaction, so all-or-nothing is
   * unchanged — the test below pins that.
   */
  it("issues one statement per batch rather than one per row", async () => {
    const db = new FakePostgres();
    const records = Array.from({ length: 9 }, (_, i) => record({ sourceCaseId: `C${i}` }));
    await db.query("BEGIN");
    const runId = await openImportRun(db, {
      sourceTables: ["ebay_returns"],
      mysqlConnections: 1,
      mysqlQueries: 12,
    });
    await db.query("COMMIT");

    await db.query("BEGIN");
    const outcome = await upsertMarketplaceCases(db, records, runId, { batchSize: 4 });
    await db.query("COMMIT");

    expect(outcome).toEqual({ inserted: 9, updated: 0 });
    expect(db.committedCases.size).toBe(9);
    // 9 rows at 4 per batch = 3 statements, not 9.
    const upserts = db.statements.filter((s) => s.startsWith("INSERT INTO cst_app.marketplace_cases"));
    expect(upserts).toHaveLength(3);
  });

  it("still commits or rolls back as one, whichever batch fails", async () => {
    const db = new FakePostgres();
    const records = Array.from({ length: 9 }, (_, i) => record({ sourceCaseId: `C${i}` }));
    await db.query("BEGIN");
    const runId = await openImportRun(db, {
      sourceTables: ["ebay_returns"],
      mysqlConnections: 1,
      mysqlQueries: 12,
    });
    await db.query("COMMIT");

    db.failOnUpsert = 3; // the last batch
    await db.query("BEGIN");
    await expect(
      upsertMarketplaceCases(db, records, runId, { batchSize: 4 }),
    ).rejects.toThrow(/simulated failure/);
    await db.query("ROLLBACK");

    // The first two batches HAD staged 8 rows. None survives.
    expect(db.committedCases.size).toBe(0);
  });

  it("reports an exact insert/update split across batches", async () => {
    const db = new FakePostgres();
    const first = Array.from({ length: 5 }, (_, i) => record({ sourceCaseId: `C${i}` }));
    await runImport(db, first);

    const mixed = [
      ...first.slice(0, 2),
      ...Array.from({ length: 3 }, (_, i) => record({ sourceCaseId: `NEW${i}` })),
    ];
    await db.query("BEGIN");
    const runId = await openImportRun(db, {
      sourceTables: ["ebay_returns"],
      mysqlConnections: 1,
      mysqlQueries: 12,
    });
    await db.query("COMMIT");
    await db.query("BEGIN");
    const outcome = await upsertMarketplaceCases(db, mixed, runId, { batchSize: 2 });
    await db.query("COMMIT");
    expect(outcome).toEqual({ inserted: 3, updated: 2 });
  });

  /**
   * PostgreSQL refuses "ON CONFLICT DO UPDATE command cannot affect row a second
   * time" when one key appears twice in one statement. The importer already proves
   * the batch is distinct; this refuses earlier and names the duplicate.
   */
  it("refuses a batch containing the same source identity twice", async () => {
    const db = new FakePostgres();
    await expect(
      upsertMarketplaceCases(db, [record(), record()], "1"),
    ).rejects.toThrow(/duplicate source identity in one batch/);
  });

  it("renders the same columns and casts for one row as for many", () => {
    expect(UPSERT_VALUES_PER_ROW).toBe(31);
    expect(upsertStatementFor(1)).toBe(UPSERT_MARKETPLACE_CASE_SQL);
    const two = upsertStatementFor(2);
    expect(two).toContain("$31::bigint");
    expect(two).toContain("$62::bigint");
    // now() appears once per row, at the imported_at slot.
    expect(two.match(/now\(\)/g)).toHaveLength(3); // two rows + the DO UPDATE SET
  });

  /** 65,535 is PostgreSQL's bound-parameter ceiling; 400 x 31 keeps a wide margin. */
  it("keeps a batch inside the bound-parameter limit", () => {
    expect(UPSERT_BATCH_SIZE * UPSERT_VALUES_PER_ROW).toBeLessThan(65_535);
    expect(UPSERT_BATCH_SIZE).toBeGreaterThan(1);
  });

  it("rejects a non-positive row count rather than building empty SQL", () => {
    expect(() => upsertStatementFor(0)).toThrow(/positive integer/);
    expect(() => upsertStatementFor(-1)).toThrow(/positive integer/);
  });
});

// ===========================================================================
describe("the storefront allowlist covers every marketplace, and drops the rest", () => {
  /**
   * Platform ids verified read-only 2026-10-02 against the source's own
   * `source.source_name`: 1 AMAZON, 2 EBAY, 3 SHOPIFY, 6 WAYFAIR, 11 REPLACEMENT,
   * 16 B&Q. The mapping itself is `channelForSourceId`, which the post-dispatch
   * automation already owns; this suite checks the grouping, not the map.
   */
  const rows = [
    { sub_source_id: 6, source_id: 1 },
    { sub_source_id: 8, source_id: 1 },
    { sub_source_id: 21, source_id: 2 },
    { sub_source_id: 22, source_id: 2 },
    { sub_source_id: 104, source_id: 3 },
    { sub_source_id: 242, source_id: 16 },
    // Platforms this application has no channel for.
    { sub_source_id: 38, source_id: 6 }, // WAYFAIR
    { sub_source_id: 53, source_id: 11 }, // REPLACEMENT (internal)
    { sub_source_id: 54, source_id: 11 },
  ];

  it("groups storefronts under the marketplace their platform maps to", () => {
    const { byMarketplace } = storefrontAllowlistFrom(rows);
    expect([...(byMarketplace.get("amazon") ?? [])].sort()).toEqual([6, 8]);
    expect([...(byMarketplace.get("ebay") ?? [])].sort()).toEqual([21, 22]);
    expect([...(byMarketplace.get("shopify") ?? [])].sort()).toEqual([104]);
    expect([...(byMarketplace.get("bandq") ?? [])].sort()).toEqual([242]);
  });

  /**
   * THE REJECTION RULE SURVIVES THE WIDENING. A storefront under a platform with
   * no CST channel is absent, so a case against it is rejected as
   * `unverified_storefront` rather than labelled on the strength of which table
   * it came from.
   */
  it("drops a platform this application has no channel for, and counts it", () => {
    const { byMarketplace, unmappedPlatforms } = storefrontAllowlistFrom(rows);
    for (const storefronts of byMarketplace.values()) {
      expect(storefronts.has(38)).toBe(false);
      expect(storefronts.has(53)).toBe(false);
    }
    expect(unmappedPlatforms.get(6)).toBe(1);
    expect(unmappedPlatforms.get(11)).toBe(2);
  });

  it("leaves a marketplace with no storefront absent rather than empty-but-present", () => {
    const { byMarketplace } = storefrontAllowlistFrom([{ sub_source_id: 21, source_id: 2 }]);
    expect(byMarketplace.has("ebay")).toBe(true);
    expect(byMarketplace.has("temu")).toBe(false);
  });
});

// ===========================================================================
describe("the source allowance is read, not assumed", () => {
  it("parses the stated hourly limits from the account's own grants", () => {
    const limits = parseAccountLimits([
      "GRANT USAGE ON *.* TO `reader`@`%` WITH MAX_QUERIES_PER_HOUR 100 MAX_CONNECTIONS_PER_HOUR 50 MAX_USER_CONNECTIONS 3",
      "GRANT SELECT ON `message_app`.`ebay_returns` TO `reader`@`%`",
    ]);
    expect(limits).toEqual({
      maxQueriesPerHour: 100,
      maxConnectionsPerHour: 50,
      maxUserConnections: 3,
    });
  });

  /**
   * An account with no stated limit reports null, NOT a default. A number invented
   * here would be a budget nobody granted, and the pre-flight check skips rather
   * than compares against it.
   */
  it("reports an unstated limit as null rather than as a default", () => {
    expect(parseAccountLimits(["GRANT USAGE ON *.* TO `reader`@`%`"])).toEqual({
      maxQueriesPerHour: null,
      maxConnectionsPerHour: null,
      maxUserConnections: null,
    });
  });
});

// ===========================================================================
describe("data minimisation holds at the statement level", () => {
  /**
   * A column that is never written cannot leak. The upsert names its columns
   * explicitly, so this is checkable by reading the statement.
   */
  it("writes no correspondence, postal, contact or raw-payload column", () => {
    const sql = UPSERT_MARKETPLACE_CASE_SQL.toLowerCase();
    for (const forbidden of [
      "comments",
      "buyer_note",
      "buyer_req",
      "return_address",
      "evi_seller_note",
      "esc_reason",
      "refund_payload",
      "customer_email",
      "customer_name",
      "shipping_city",
      "shipping_country",
      "tracking_url",
      "img",
    ]) {
      expect(sql, `${forbidden} must not be written`).not.toContain(forbidden);
    }
  });

  it("casts naive source datetimes explicitly, so none acquires a timezone", () => {
    // 0021's first dry run wrote a locale string carrying the process timezone.
    for (const column of ["$23::timestamp", "$27::timestamp", "$28::timestamp", "$29::timestamp"]) {
      expect(UPSERT_MARKETPLACE_CASE_SQL).toContain(column);
    }
    expect(UPSERT_MARKETPLACE_CASE_SQL).not.toContain("::timestamptz");
  });

  it("casts money once in SQL rather than round-tripping it through a float", () => {
    expect(UPSERT_MARKETPLACE_CASE_SQL).toContain("$25::numeric");
  });
});
