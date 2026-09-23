import { describe, expect, it } from "vitest";

import {
  NOT_A_RESOLUTION,
  REOPEN_ACTION,
  RESOLUTION_ACTIONS,
  RESOLVED_ACTION,
  breakdownOf,
  resolutionSupport,
} from "@/lib/domain/unresolved-cases";
import { UNRESOLVED_SQL, unresolvedCaseCounts } from "@/lib/repositories/performance-repository";
import { kpiByKey } from "@/lib/domain/performance-metrics";

/**
 * Unresolved cases.
 *
 * Every fixture below is a measured figure: 1,870 eBay conversations, 1,197
 * currently resolved, 1,207 ever resolved, 12 currently reopened, 1,467 with
 * any activity recorded, and 4,720 resolution actions across 1,207
 * conversations.
 */

describe("the resolution vocabulary", () => {
  it("reads exactly two state-changing actions", () => {
    expect([...RESOLUTION_ACTIONS]).toEqual(["move_to_resolved", "move_to_todo"]);
    expect(RESOLVED_ACTION).toBe("move_to_resolved");
    expect(REOPEN_ACTION).toBe("move_to_todo");
  });

  /**
   * `mark_as_no_need_reply` is a decision not to reply, which is not the same
   * statement as "this is settled". Counting it would shrink the backlog by the
   * 47 conversations that carry it and nothing else.
   */
  it("does not treat 'no need to reply' as a resolution", () => {
    expect([...NOT_A_RESOLUTION]).toEqual(["mark_as_no_need_reply"]);
    expect([...RESOLUTION_ACTIONS]).not.toContain("mark_as_no_need_reply");
  });

  it("supports eBay only", () => {
    expect(resolutionSupport("ebay").supported).toBe(true);
    expect(resolutionSupport(null).supported).toBe(true);
    for (const marketplace of ["shopify", "amazon", "bandq", "temu"]) {
      const support = resolutionSupport(marketplace);
      expect(support.supported).toBe(false);
      expect(support.supported === false && support.reason).toMatch(/No resolution activity/i);
    }
  });
});

describe("breakdownOf", () => {
  /** The measured eBay position over all time. */
  it("splits the eBay figures the way the source does", () => {
    expect(breakdownOf({ total: 1870, resolved: 1197, reopened: 12, withActivity: 1467 })).toEqual({
      noRecordedResolution: 673,
      observedUnresolved: 270,
      noActivityRecord: 403,
      coveragePercent: 78.4,
    });
  });

  /**
   * THE TRAP THIS EXISTS FOR. Across every marketplace the subtraction gives
   * 18,875, of which 18,605 are conversations nothing was ever recorded
   * against. Reporting that as a backlog would invent a crisis out of an
   * import gap, so the two are always separated.
   */
  it("separates a real backlog from an absence of records", () => {
    const breakdown = breakdownOf({
      total: 20072,
      resolved: 1197,
      reopened: 12,
      withActivity: 1467,
    });
    expect(breakdown.noRecordedResolution).toBe(18875);
    expect(breakdown.observedUnresolved).toBe(270);
    expect(breakdown.noActivityRecord).toBe(18605);
    // The honest figure is a small fraction of the headline.
    expect(breakdown.observedUnresolved).toBeLessThan(breakdown.noRecordedResolution / 50);
  });

  it("reports full coverage when every conversation has activity", () => {
    const breakdown = breakdownOf({ total: 100, resolved: 60, reopened: 0, withActivity: 100 });
    expect(breakdown).toEqual({
      noRecordedResolution: 40,
      observedUnresolved: 40,
      noActivityRecord: 0,
      coveragePercent: 100,
    });
  });

  /** An empty scope has no coverage figure — 0% would imply something was missed. */
  it("returns a null coverage for an empty scope", () => {
    expect(breakdownOf({ total: 0, resolved: 0, reopened: 0, withActivity: 0 })).toEqual({
      noRecordedResolution: 0,
      observedUnresolved: 0,
      noActivityRecord: 0,
      coveragePercent: null,
    });
  });

  /** A resolved count above the total would be a query bug; it must not go negative. */
  it("never produces a negative headline", () => {
    const breakdown = breakdownOf({ total: 10, resolved: 99, reopened: 0, withActivity: 99 });
    expect(breakdown.noRecordedResolution).toBe(0);
    expect(breakdown.observedUnresolved).toBe(0);
    expect(breakdown.noActivityRecord).toBe(0);
  });
});

describe("the query", () => {
  /**
   * DUPLICATE ACTIONS. 4,720 resolution actions cover 1,207 conversations —
   * one carries 13. Counting actions would report nearly four times the truth.
   */
  it("counts conversations, never actions", () => {
    expect(UNRESOLVED_SQL).toMatch(/DISTINCT ON \(a\.conversation_id\)/);
    expect(UNRESOLVED_SQL).toMatch(/count\(DISTINCT a2\.conversation_id\)/);
  });

  /**
   * REOPENING. 19 conversations were reopened after a resolution and 12 are
   * still reopened, so the latest state is the question — not whether a
   * resolution appears anywhere in the history.
   */
  it("takes the latest state, breaking same-day ties on the source id", () => {
    expect(UNRESOLVED_SQL).toMatch(
      /ORDER BY a\.conversation_id, a\.action_date DESC, a\.source_pk::bigint DESC/,
    );
  });

  /**
   * IDENTICAL SCOPE. Both counts join the same `scoped` set. Filtering
   * resolution by the ACTION's date instead would put a June conversation
   * resolved in September into September's resolved count and June's total.
   */
  it("derives both counts from one scoped set", () => {
    expect(UNRESOLVED_SQL).toMatch(/WITH scoped AS/);
    expect(UNRESOLVED_SQL).toMatch(/JOIN scoped s ON s\.id = a\.conversation_id/);
    expect(UNRESOLVED_SQL).toMatch(/JOIN scoped s2 ON s2\.id = a2\.conversation_id/);
    // The scope is the conversation's own window, not the action's date.
    expect(UNRESOLVED_SQL).toMatch(/c\.last_source_ts >= \$1::date/);
    expect(UNRESOLVED_SQL).not.toMatch(/a\.action_date >=/);
  });

  /** A timestamp scope with an inclusive bound drops the final day. */
  it("uses a half-open upper bound", () => {
    expect(UNRESOLVED_SQL).toMatch(/c\.last_source_ts < \(\$2::date \+ 1\)/);
    expect(UNRESOLVED_SQL).not.toMatch(/BETWEEN/i);
  });

  it("binds every value and reads only cst_app", () => {
    expect(UNRESOLVED_SQL).toMatch(/\$3::text IS NULL OR c\.marketplace = \$3::text/);
    expect(UNRESOLVED_SQL).not.toMatch(/\$\{/);
    for (const ref of UNRESOLVED_SQL.match(/\b(?:FROM|JOIN)\s+([a-z_]+)\./gi) ?? []) {
      expect(ref).toMatch(/cst_app\.$/i);
    }
  });

  it("is a SELECT and nothing else", () => {
    for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER"]) {
      expect(UNRESOLVED_SQL.toUpperCase()).not.toContain(verb);
    }
  });

  it("passes the filters through as bound values", async () => {
    const calls: Array<{ values: unknown[] }> = [];
    const client = {
      query: async (config: { text: string; values?: unknown[] }) => {
        calls.push({ values: config.values ?? [] });
        return { rows: [{ total: 1870, resolved: 1197, reopened: 12, with_activity: 1467 }] };
      },
    };
    const counts = await unresolvedCaseCounts(client, {
      from: "2026-01-01",
      to: "2026-12-31",
      marketplace: "ebay",
    });
    expect(calls[0].values).toEqual([
      "2026-01-01",
      "2026-12-31",
      "ebay",
      ["move_to_resolved", "move_to_todo"],
      "move_to_resolved",
      "move_to_todo",
    ]);
    expect(counts).toEqual({ total: 1870, resolved: 1197, reopened: 12, withActivity: 1467 });
  });

  /** A scope with no conversations must read as zero, not fail. */
  it("reads a missing row as zeroes", async () => {
    const client = { query: async () => ({ rows: [] }) };
    expect(
      await unresolvedCaseCounts(client, { from: "2020-01-01", to: "2020-01-31", marketplace: "ebay" }),
    ).toEqual({ total: 0, resolved: 0, reopened: 0, withActivity: 0 });
  });
});

describe("the KPI", () => {
  it("is available", () => {
    expect(kpiByKey("unresolved_cases").availability.state).toBe("available");
  });

  /** A backlog belongs to a queue, not to whoever last touched it. */
  it("is scoped to the marketplace, never an agent", () => {
    expect(kpiByKey("unresolved_cases").scope).toBe("marketplace");
  });

  it("describes itself as a per-conversation measurement", () => {
    expect(kpiByKey("unresolved_cases").calculation).toMatch(/per conversation, not per action/i);
  });
});
