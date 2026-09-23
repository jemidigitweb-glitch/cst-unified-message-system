import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FILTER_DEFINITIONS,
  KPI_DEFINITIONS,
  MESSAGES_HANDLED_ACTIONS,
  availableKpiKeys,
  kpiByKey,
  readiness,
} from "@/lib/domain/performance-metrics";
import { performanceDashboardAccess } from "@/lib/domain/performance-dashboard-access";
import {
  AGENT_OPTIONS_SQL,
  COVERAGE_SQL,
  MESSAGES_HANDLED_SQL,
  messagesHandledByAgent,
} from "@/lib/repositories/performance-repository";

/**
 * The dashboard's honesty rules, tested as rules rather than as rendering.
 *
 * Everything asserted here is a promise the page makes to somebody whose work
 * it reports: that an absent measurement is shown as absent, that a shared
 * login is never given a name, and that the whole surface stays shut until
 * somebody can be identified.
 */

describe("access control", () => {
  // `vi.stubEnv` rather than assigning to process.env: Vitest defines NODE_ENV
  // itself, and a plain assignment does not survive into the module under test.
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const setEnv = (value: string) => vi.stubEnv("NODE_ENV", value);

  /**
   * The single most important test in this file. The application has no
   * session, no login and zero user records; this page names ten members of
   * staff and counts their work.
   */
  it("is closed in production", () => {
    setEnv("production");
    const access = performanceDashboardAccess();
    expect(access.allowed).toBe(false);
    expect(access.allowed === false && access.reason).toMatch(/authenticated access/i);
  });

  it("is open in development", () => {
    setEnv("development");
    expect(performanceDashboardAccess().allowed).toBe(true);
  });

  it("is open under test", () => {
    setEnv("test");
    expect(performanceDashboardAccess().allowed).toBe(true);
  });

  /**
   * No escape hatch. A flag that opens this in production is a thing somebody
   * sets in a hurry, so there must not be one to set.
   */
  it("cannot be opened in production by any environment variable", () => {
    setEnv("production");
    for (const name of [
      "PERFORMANCE_DASHBOARD_ENABLED",
      "ENABLE_PERFORMANCE_DASHBOARD",
      "DASHBOARD_ENABLED",
    ]) {
      process.env[name] = "true";
      expect(performanceDashboardAccess().allowed).toBe(false);
      delete process.env[name];
    }
  });
});

describe("KPI coverage", () => {
  it("defines all seven requested KPIs", () => {
    expect(KPI_DEFINITIONS.map((k) => k.key).sort()).toEqual(
      [
        "average_response_time",
        "buyer_contact_rate",
        "buyer_dissatisfaction_rate",
        "customer_feedback",
        "messages_handled",
        "sla_performance",
        "unresolved_cases",
      ].sort(),
    );
  });

  /**
   * Ships honest: the headline counts what actually works, and it moves only
   * when a KPI is genuinely activated against verified data. Customer feedback
   * joined messages handled once eBay sentiment was read from the source.
   */
  it("reports messages handled, customer feedback and unresolved cases as available", () => {
    expect([...availableKpiKeys()].sort()).toEqual(["customer_feedback", "messages_handled", "unresolved_cases"]);
    expect(readiness()).toEqual({ available: 3, total: 7 });
  });

  it("gives every unavailable KPI at least one blocker", () => {
    for (const kpi of KPI_DEFINITIONS) {
      if (kpi.availability.state === "unavailable") {
        expect(kpi.availability.blockers.length).toBeGreaterThan(0);
      }
    }
  });

  it("states a calculation for every KPI, computable or not", () => {
    for (const kpi of KPI_DEFINITIONS) {
      expect(kpi.calculation.length).toBeGreaterThan(20);
    }
  });

  /**
   * Scope is what keeps a marketplace figure out of an agent's row. Feedback,
   * contact rate and dissatisfaction can never be per-agent: no feedback record
   * carries an agent and no agent owns an order.
   */
  /**
   * `unresolved_cases` sits here rather than with the agent KPIs: a backlog
   * belongs to a queue, and attributing it to whoever last touched a
   * conversation would blame or credit one person for work many people did.
   */
  it.each([
    "customer_feedback",
    "buyer_contact_rate",
    "buyer_dissatisfaction_rate",
    "unresolved_cases",
  ] as const)("scopes %s to the marketplace, never an agent", (key) => {
    expect(kpiByKey(key).scope).toBe("marketplace");
  });

  it.each(["messages_handled", "average_response_time", "sla_performance"] as const)(
    "scopes %s to the agent",
    (key) => {
      expect(kpiByKey(key).scope).toBe("agent");
    },
  );

  /** Only the two actions that put words in front of a customer. */
  it("counts replies, not every recorded action", () => {
    expect([...MESSAGES_HANDLED_ACTIONS]).toEqual(["reply_to_message", "reply_with_warning"]);
  });

  /** A blocker nobody can act on is a shrug. Each says which kind of work it is. */
  it("classifies every blocker as data, import or definition", () => {
    const kinds = new Set(["missing_data", "not_imported", "missing_definition"]);
    for (const kpi of KPI_DEFINITIONS) {
      if (kpi.availability.state !== "unavailable") continue;
      for (const blocker of kpi.availability.blockers) {
        expect(kinds.has(blocker.kind)).toBe(true);
        expect(blocker.detail.length).toBeGreaterThan(20);
      }
    }
  });

  it("names the timestamp dependency on both time-based KPIs", () => {
    for (const key of ["average_response_time", "sla_performance"] as const) {
      const availability = kpiByKey(key).availability;
      expect(
        availability.state === "unavailable" &&
          availability.blockers.some((b) => /arrival time/i.test(b.detail)),
      ).toBe(true);
    }
  });
});

describe("filter coverage", () => {
  it("defines all five requested filters", () => {
    expect(FILTER_DEFINITIONS.map((f) => f.key).sort()).toEqual(
      ["agent", "date_range", "marketplace", "message_category", "team"].sort(),
    );
  });

  it("offers agent, marketplace and date range", () => {
    for (const key of ["agent", "marketplace", "date_range"] as const) {
      const filter = FILTER_DEFINITIONS.find((f) => f.key === key)!;
      expect(filter.availability.state).toBe("available");
      // Available is not the same as complete, and each says so.
      expect(filter.coverageNote).toBeTruthy();
    }
  });

  /** Team membership exists in no system. It is missing data, not a backlog item. */
  it("marks team unavailable as missing data", () => {
    const team = FILTER_DEFINITIONS.find((f) => f.key === "team")!;
    expect(team.availability.state).toBe("unavailable");
    expect(
      team.availability.state === "unavailable" &&
        team.availability.blockers.every((b) => b.kind === "missing_data"),
    ).toBe(true);
  });

  /** Category data exists and is verified — it simply has not been imported. */
  it("marks category unavailable as not imported, not missing", () => {
    const category = FILTER_DEFINITIONS.find((f) => f.key === "message_category")!;
    expect(category.availability.state).toBe("unavailable");
    expect(
      category.availability.state === "unavailable" &&
        category.availability.blockers.some((b) => b.kind === "not_imported"),
    ).toBe(true);
  });
});

describe("the repository reads PostgreSQL only", () => {
  it.each([MESSAGES_HANDLED_SQL, COVERAGE_SQL, AGENT_OPTIONS_SQL])(
    "issues a SELECT and nothing else",
    (sql) => {
      for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE"]) {
        expect(sql.toUpperCase()).not.toContain(verb);
      }
    },
  );

  /**
   * Schema-qualified references only. `source_system = 'order_management'` is a
   * legitimate column VALUE naming which directory an id came from — it is not
   * a database this query reads, and an earlier version of this test failed on
   * exactly that distinction.
   */
  it("reads only cst_app tables", () => {
    for (const sql of [MESSAGES_HANDLED_SQL, COVERAGE_SQL, AGENT_OPTIONS_SQL]) {
      expect(sql).toMatch(/FROM cst_app\./);
      expect(sql).not.toMatch(/\b(message_app|order_management|ledsone|customer_service)\./);
      // ...and no FROM/JOIN reaches outside cst_app.
      for (const ref of sql.match(/\b(?:FROM|JOIN)\s+([a-z_]+)\./gi) ?? []) {
        expect(ref).toMatch(/cst_app\.$/i);
      }
    }
  });

  it("binds every filter value", () => {
    expect(MESSAGES_HANDLED_SQL).toMatch(/\$1::text\[\]/);
    expect(MESSAGES_HANDLED_SQL).toMatch(/\$2::date AND \$3::date/);
    expect(MESSAGES_HANDLED_SQL).toMatch(/\$4::text/);
    expect(MESSAGES_HANDLED_SQL).toMatch(/\$5::bigint/);
    expect(MESSAGES_HANDLED_SQL).not.toMatch(/\$\{/);
  });

  /** An id missing from the directory must still be counted, not dropped. */
  it("left-joins the directory so an unknown id is not silently dropped", () => {
    expect(MESSAGES_HANDLED_SQL).toMatch(/LEFT JOIN cst_app\.agent_directory/);
  });
});

describe("messagesHandledByAgent", () => {
  const stub = (rows: unknown[]) => ({
    calls: [] as Array<{ text: string; values: unknown[] }>,
    query: async function (this: { calls: unknown[] }, config: { text: string; values?: unknown[] }) {
      (this.calls as Array<unknown>).push({ text: config.text, values: config.values ?? [] });
      return { rows };
    },
  });

  it("names a known agent", async () => {
    const rows = await messagesHandledByAgent(
      stub([{ source_user_id: 210, display_name: "thurshikan", active: true, messages_handled: 100, conversations: 40 }]),
      { from: "2026-09-01", to: "2026-09-23", marketplace: null, sourceUserId: null },
    );
    expect(rows[0]).toEqual({
      sourceUserId: 210,
      displayName: "thurshikan",
      active: true,
      attributable: true,
      messagesHandled: 100,
      conversations: 40,
    });
  });

  /**
   * Account 86 is a shared login called `admin`. The work is counted; the name
   * is withheld. Crediting it to a person would credit whoever held the
   * password.
   */
  it("never names the shared admin account, but keeps its count", async () => {
    const rows = await messagesHandledByAgent(
      stub([{ source_user_id: 86, display_name: "admin", active: true, messages_handled: 2, conversations: 1 }]),
      { from: "2026-09-01", to: "2026-09-23", marketplace: null, sourceUserId: null },
    );
    expect(rows[0].attributable).toBe(false);
    expect(rows[0].displayName).toBeNull();
    expect(rows[0].sourceUserId).toBe(86);
    expect(rows[0].messagesHandled).toBe(2);
  });

  it("keeps an id the directory does not know, unnamed", async () => {
    const rows = await messagesHandledByAgent(
      stub([{ source_user_id: 9999, display_name: null, active: null, messages_handled: 5, conversations: 3 }]),
      { from: "2026-09-01", to: "2026-09-23", marketplace: null, sourceUserId: null },
    );
    expect(rows[0].attributable).toBe(false);
    expect(rows[0].sourceUserId).toBe(9999);
    expect(rows[0].messagesHandled).toBe(5);
  });

  it("keeps activity with no recorded user", async () => {
    const rows = await messagesHandledByAgent(
      stub([{ source_user_id: null, display_name: null, active: null, messages_handled: 3, conversations: 2 }]),
      { from: "2026-09-01", to: "2026-09-23", marketplace: null, sourceUserId: null },
    );
    expect(rows[0].attributable).toBe(false);
    expect(rows[0].sourceUserId).toBeNull();
  });

  it("passes the date window and filters through as bound values", async () => {
    const client = stub([]);
    await messagesHandledByAgent(client, {
      from: "2026-08-01", to: "2026-08-31", marketplace: "ebay", sourceUserId: 241,
    });
    expect(client.calls[0].values).toEqual([
      ["reply_to_message", "reply_with_warning"], "2026-08-01", "2026-08-31", "ebay", 241,
    ]);
  });
});
