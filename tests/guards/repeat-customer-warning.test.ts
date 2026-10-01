import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Architecture guard for the Repeat-Customer Warning.
 *
 * Not lint. Each assertion below encodes a decision that an ordinary test
 * cannot reach, and a failure here is a design question rather than a test to
 * fix. The risks guarded are, in order of how much damage they would do:
 *
 *   * the interface characterising a PERSON rather than citing records
 *   * a MySQL read creeping into a page load, against an account capped at
 *     100 queries per hour
 *   * the feature acquiring a write, a migration or a schedule
 *   * history reaching the AI drafting path
 *   * a new connection pool, or an existing limit raised
 *
 * Comments are stripped before asserting, because every file under test
 * discusses the things it must not do at length — read as code, those
 * explanations would fail the checks they exist to justify.
 */

const ROOT = join(__dirname, "..", "..");

const FILES = {
  domain: "lib/domain/repeat-customer-warning.ts",
  repository: "lib/repositories/customer-history-repository.ts",
  resolver: "lib/context/resolve-customer-history.ts",
  route: "app/api/conversations/[conversationId]/customer-history/route.ts",
  card: "components/repeat-customer-warning.tsx",
  hook: "components/use-customer-history.ts",
} as const;

const raw = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, readFileSync(join(ROOT, path), "utf8")]),
) as Record<keyof typeof FILES, string>;

/** Strips comments so prose about a forbidden thing is not read as the thing. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const executable = Object.fromEntries(
  Object.entries(raw).map(([key, source]) => [key, code(source)]),
) as Record<keyof typeof FILES, string>;

const ALL = Object.values(executable).join("\n");

describe("the interface cites records, never characterises a person", () => {
  /**
   * THE CENTRAL CONSTRAINT. A previous complaint or refund is not evidence of
   * wrongdoing: a customer who returned two faulty lamps produces the same
   * rows as one acting in bad faith, and the data cannot tell them apart. So
   * the vocabulary must not let an interface imply it can.
   *
   * ASSERTED ON EXECUTABLE SOURCE, COMMENTS STRIPPED, and the first draft of
   * this guard got that wrong. It checked the raw text, reasoning that even a
   * comment proposing such copy is the start of the problem — and it failed
   * immediately on `repeat-customer-warning.ts` and the card, both of which
   * NAME the forbidden words in order to say they are forbidden.
   *
   * That is the trap `documentation/ai-coding-context.md` §2.5 describes:
   * prose saying "this must never say X" is indistinguishable from X to a text
   * search. Several guards in this directory strip comments for exactly this
   * reason. The vocabulary check therefore runs on code, and a separate test
   * below asserts the constraint is still WRITTEN DOWN — so stripping comments
   * here cannot quietly delete the explanation.
   */
  const FORBIDDEN_VOCABULARY = [
    "high risk", "high-risk", "highrisk",
    "risk score", "riskscore", "risk_score",
    "fraud", "fraudulent",
    "abusive", "abuser",
    "blacklist", "black list", "blocklist",
    "untrustworthy", "bad actor", "suspicious customer",
    "problem customer", "serial returner",
  ];

  it.each(Object.keys(FILES) as (keyof typeof FILES)[])(
    "%s contains no risk or character judgement vocabulary in its code",
    (key) => {
      const lower = executable[key].toLowerCase();
      for (const term of FORBIDDEN_VOCABULARY) {
        expect(lower).not.toContain(term);
      }
    },
  );

  /**
   * The counterpart to stripping comments above: the reasoning must survive.
   * If someone deletes the paragraph explaining why no judgement vocabulary is
   * used, this fails — so the rule cannot quietly become folklore.
   */
  it("keeps the reason for that constraint written down", () => {
    expect(raw.domain).toMatch(/IT REPORTS FACTS\. IT DOES NOT SCORE A PERSON/);
    expect(raw.card).toMatch(/IT NAMES RECORDS\. IT NEVER CHARACTERISES A PERSON/);
  });

  /** No numeric severity of any kind. A score is the thing being avoided. */
  it("exposes no score, severity, tier or rating", () => {
    for (const term of ["score", "severity", "tier", "rating", "danger"]) {
      expect(ALL.toLowerCase()).not.toContain(term);
    }
  });

  /**
   * The agent-facing strings are record nouns. If a label ever becomes an
   * adjective about a customer, this is what catches it.
   */
  it("labels every reason as a count of records", () => {
    const card = raw.card;
    for (const label of [
      "Previous conversations",
      "Previous refunded orders",
      "Previous formal cases",
      "Previous payment disputes",
      "Previously escalated cases",
    ]) {
      expect(card).toContain(label);
    }
  });

  /** Context, not an interruption. An alert demands action; this informs. */
  it("renders the card as a note rather than an alert", () => {
    expect(executable.card).toMatch(/role="note"/);
    expect(executable.card).not.toMatch(/role="alert"/);
  });
});

describe("no MySQL is reachable from a page load", () => {
  /**
   * The whole reason the history was imported into PostgreSQL. The MySQL
   * account allows 100 queries per HOUR in total — a per-conversation read
   * would exhaust it in minutes and take the existing importers down with it.
   */
  it("names no MySQL driver, pool or database anywhere in the feature", () => {
    const lower = ALL.toLowerCase();
    for (const term of [
      "mysql", "mysql2", "mariadb",
      "message_app", "order_management.user",
      "db_order_", "orderdbconfig", "fetchcasehistoryevents",
    ]) {
      expect(lower).not.toContain(term);
    }
  });

  it("imports only the PostgreSQL pools, and creates none", () => {
    expect(executable.route).toMatch(/getAppPool|getSourcePool/);
    expect(ALL).not.toMatch(/new\s+Pool\b/);
    expect(ALL).not.toMatch(/new\s+pg\.Pool\b/);
    expect(ALL).not.toMatch(/createConnection/);
  });

  /** Pool sizing is a measured decision elsewhere; this feature must not touch it. */
  it("sets no pool size, max or timeout override", () => {
    for (const term of ["max:", "POOL_MAX", "idleTimeoutMillis", "connectionTimeoutMillis"]) {
      expect(ALL).not.toContain(term);
    }
  });
});

describe("the feature only reads", () => {
  it("contains no write verb in any statement", () => {
    const lower = ALL.toLowerCase();
    for (const verb of [
      "insert into", "update ", "delete from", "truncate", "alter table",
      "drop table", "create table", "create index", "on conflict", "upsert",
    ]) {
      expect(lower).not.toContain(verb);
    }
  });

  it("opens no transaction", () => {
    const lower = ALL.toLowerCase();
    expect(lower).not.toContain("begin");
    expect(lower).not.toContain("commit");
    expect(lower).not.toContain("rollback");
  });

  /**
   * `order-context/route.ts` can trigger the resolver's own snapshot cache
   * write on a first resolution. This route must not acquire that behaviour:
   * opening a conversation to read history must change nothing.
   */
  it("writes no context snapshot, unlike the order-context route", () => {
    const lower = ALL.toLowerCase();
    expect(lower).not.toContain("savesingleordersnapshot");
    expect(lower).not.toContain("saveambiguoussnapshot");
    expect(lower).not.toContain("savenoordersnapshot");
    expect(lower).not.toContain("context_snapshots");
  });

  /** A GET-only route. No other HTTP method may be exported from it. */
  it("exports GET and no mutating method", () => {
    expect(executable.route).toMatch(/export\s+async\s+function\s+GET\b/);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(executable.route).not.toMatch(new RegExp(`export\\s+async\\s+function\\s+${method}\\b`));
    }
  });
});

describe("no migration and no new storage", () => {
  /**
   * The feature reads 0021's table and the two that already existed. It
   * defines no schema of its own, and §15's instruction was to STOP rather
   * than add an index — the case-history read is a sequential scan over 1,098
   * rows by design, documented in the repository.
   */
  it("declares no DDL", () => {
    const lower = ALL.toLowerCase();
    for (const term of ["create table", "create index", "alter ", "migration"]) {
      expect(lower).not.toContain(term);
    }
  });

  it("reads only the three expected relations", () => {
    const relations = [...ALL.matchAll(/(?:FROM|JOIN)\s+([a-z_]+\.[a-z_]+)/gi)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(new Set(relations)).toEqual(
      new Set([
        "cst_app.conversations",
        "cst_app.customer_case_history",
        "order_management.orders",
        "order_management.sub_source",
        "customers.customer_info",
      ]),
    );
  });
});

describe("no automatic synchronisation", () => {
  it("registers no feed, cron, worker or schedule", () => {
    const lower = ALL.toLowerCase();
    for (const term of ["sync_state", "watermark", "cron", "setinterval", "schedule"]) {
      expect(lower).not.toContain(term);
    }
  });
});

describe("history is isolated from the AI and the workflow", () => {
  /**
   * §14. The warning is informational. If a count ever reached a prompt, an
   * agent's draft would start being shaped by a customer's history — which is
   * a different product with a different approval requirement.
   */
  it("touches no AI, draft, prompt or knowledge module", () => {
    const lower = ALL.toLowerCase();
    for (const term of [
      "lib/ai/", "draft-assembly", "verifiedfact", "contextblocks",
      "prompt", "openai", "gemini", "vector", "knowledge",
      "message-category", "classifymessagecategory", "root-cause", "rootcause",
    ]) {
      expect(lower).not.toContain(term);
    }
  });

  it("changes no workflow state and triggers no escalation", () => {
    const lower = ALL.toLowerCase();
    for (const term of [
      "workflow_state", "workflowstate", "pending_review", "reviewed",
      "escalate(", "autoescalate", "priority",
    ]) {
      expect(lower).not.toContain(term);
    }
  });

  /**
   * The card is rendered by exactly one call site. A badge on every message
   * bubble was explicitly not wanted, and a second dashboard even less so.
   */
  it("is rendered once, from the conversation view only", () => {
    const view = code(readFileSync(join(ROOT, "components/conversation-view.tsx"), "utf8"));
    expect(view.match(/<RepeatCustomerWarning\b/g)?.length).toBe(1);

    const panel = code(readFileSync(join(ROOT, "components/context-panel.tsx"), "utf8"));
    expect(panel).not.toMatch(/RepeatCustomerWarning/);
  });
});

describe("no sending capability", () => {
  it("adds no transport of any kind", () => {
    const lower = ALL.toLowerCase();
    for (const term of ["smtp", "outbound", "recipient", "transport", "sendmail", "send("]) {
      expect(lower).not.toContain(term);
    }
  });
});

describe("no customer personal information", () => {
  /**
   * The payload is counts and reason names. The buyer handle is a bound query
   * predicate and is never selected, returned or rendered — so the browser is
   * told "3 previous conversations" and never which, or whose.
   */
  it("selects no personal field in any statement", () => {
    const lower = ALL.toLowerCase();
    for (const term of [
      "email", "address", "postcode", "post_code", "phone",
      "full_name", "first_name", "last_name", "body_text", "message_content",
    ]) {
      expect(lower).not.toContain(term);
    }
  });

  /**
   * The RESPONSE carries no identifier — asserted on the response type and the
   * payload object, not on the whole route.
   *
   * The first draft of this guard scanned the whole file and failed, because
   * the route legitimately reads `conversation.counterpartyRef` to pass it INTO
   * the lookup as a bound predicate. Reading the handle is the feature; the
   * constraint is that it must not come back out, so the assertion belongs on
   * what is returned rather than on what is read.
   */
  it("returns no identifier for the history it counted", () => {
    const route = executable.route;

    const responseType = /export type CustomerHistoryResponse = \{[\s\S]*?\n\};/.exec(route)?.[0];
    expect(responseType).toBeDefined();

    const payload = /const payload: CustomerHistoryResponse = \{[\s\S]*?\n    \};/.exec(route)?.[0];
    expect(payload).toBeDefined();

    for (const returned of [responseType!, payload!]) {
      const lower = returned.toLowerCase();
      for (const term of [
        "counterparty", "source_case_id", "sourcecaseid", "order_ref", "orderref",
        "ordernumber", "subsource", "buyer", "marketplace",
      ]) {
        expect(lower).not.toContain(term);
      }
    }
  });

  /**
   * And the handle IS read, as a bound predicate. Stated positively so the
   * test above cannot be satisfied by accidentally breaking the lookup.
   */
  it("reads the buyer handle only to bind it into the query", () => {
    expect(executable.route).toMatch(/counterpartyRef:\s*conversation\.counterpartyRef/);
    expect(executable.repository).toMatch(/values:\s*\[/);
  });
});

describe("the client cannot show a stale or invented warning", () => {
  /**
   * Two conversations opened in quick succession can have their responses
   * arrive out of order. Without the cancel flag the FIRST customer's history
   * lands in the SECOND customer's header and stays there.
   */
  it("keys the request to the conversation and discards a stale response", () => {
    const hook = executable.hook;
    expect(hook).toMatch(/\[conversationId\]/);
    expect(hook).toMatch(/cancelled\s*=\s*true/);
    expect(hook).toMatch(/if\s*\(cancelled\)\s*return/);
  });

  /**
   * `cancelled` alone is not enough: between the click and the first response,
   * state still holds the PREVIOUS customer's answer. Resetting on an id
   * change is what stops the old warning rendering over the new thread.
   */
  it("resets to loading when the conversation id changes", () => {
    expect(executable.hook).toMatch(/conversationId\s*!==\s*loadedFor/);
  });

  /** A failed request must never render as a clean history. */
  it("maps a failure and an unavailable lookup to the same silent state", () => {
    const hook = executable.hook;
    expect(hook).toMatch(/catch\s*\{[\s\S]*?setState\(UNAVAILABLE\)/);
    expect(hook).toMatch(/payload\.available\s*!==\s*true[\s\S]{0,120}setState\(UNAVAILABLE\)/);
  });

  /** Loading is not "no warning yet shown as all clear" — it renders nothing. */
  it("shows nothing unless the state is ready and warning is true", () => {
    expect(executable.card).toMatch(/history\.state\s*!==\s*"ready"\s*\|\|\s*!history\.warning/);
  });
});

describe("the route reveals nothing about the database", () => {
  it("returns a fixed sentence and logs the cause server-side", () => {
    const route = executable.route;
    expect(route).toMatch(/console\.error\(/);
    expect(route).toMatch(/Customer history is unavailable\./);
    // The caught value must not reach the response body.
    expect(route).not.toMatch(/error:\s*(?:String\()?cause/);
    expect(route).not.toMatch(/cause\.message/);
  });
});

describe("the thresholds are provisional and say so", () => {
  /**
   * They are implementation defaults, not approved CST policy. The header must
   * keep saying that, and must keep the approval route written down — an
   * unapproved number that looks settled is the risk.
   */
  it("records that the thresholds are not approved policy", () => {
    expect(raw.domain).toMatch(/NOT APPROVED CST POLICY/);
    expect(raw.domain).toMatch(/HOW THE CST OWNER APPROVES OR ADJUSTS THEM/);
  });

  /**
   * One place, as plain data. Persisting them would make them look official.
   *
   * The type annotation is optional in this pattern because it was ADDED after
   * typecheck rejected the first version: declared `as const` and inferred with
   * `typeof`, each threshold became a literal type and an adjusted value of 99
   * would not compile. A configuration object nobody can reconfigure is not
   * configuration — so the annotation is the fix, and this regex must not
   * forbid it.
   */
  it("keeps them in a single exported constant with no storage behind them", () => {
    expect(executable.domain).toMatch(
      /export const REPEAT_CUSTOMER_THRESHOLDS(?::\s*RepeatCustomerThresholds)?\s*=\s*\{/,
    );
    expect(executable.domain).not.toMatch(/SELECT|INSERT|cst_app\./);
    // Exactly one declaration, so there is no second place to look.
    expect(executable.domain.match(/REPEAT_CUSTOMER_THRESHOLDS\s*(?::[^=]*)?=/g)).toHaveLength(1);
  });

  /** And the numbers must stay adjustable, which is what the annotation buys. */
  it("types the thresholds as numbers rather than their own literals", () => {
    expect(executable.domain).toMatch(/readonly previousConversations: number/);
  });
});
