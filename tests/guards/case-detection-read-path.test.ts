import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Standing guard on the Case Detection Indicator's read path.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS DEFENDS, AND WHY NO SCHEMA CAN
 * ---------------------------------------------------------------------------
 * A case row is visible to CST only when its `import_run_id` names a run whose
 * status is `published`. Migration 0022 states that gate at length and then
 * says plainly that it cannot enforce it: the publication protocol makes a
 * committed-but-failed run unrepresentable, but nothing in a database stops a
 * reader ignoring the ledger, and an abandoned `in_progress` run would then be
 * read as the current snapshot.
 *
 * So this file is the enforcement. Every statement that reads
 * `marketplace_cases` outside the importer's own write path must join the run
 * ledger and filter on `published`.
 *
 * ---------------------------------------------------------------------------
 * AND ON WHAT THE PANEL MAY SAY
 * ---------------------------------------------------------------------------
 * The rest of this file pins the four claims the imported data does NOT
 * support, each of which a reasonable-looking edit could introduce:
 * a Shopify refund worded as an open return, an Amazon warehouse disposition
 * worded as a case status, an unknown lifecycle worded as closed, and an
 * available action worded as a dispatched replacement.
 *
 * Asserted against source, matching how the rest of this suite guards the
 * interface: no DOM environment is configured, and what matters here is
 * structural.
 */

const ROOT = join(__dirname, "..", "..");
const APP_DIR = join(ROOT, "app");
const LIB_DIR = join(ROOT, "lib");

const REPOSITORY = join(LIB_DIR, "repositories", "marketplace-case-repository.ts");
const RESOLVER = join(LIB_DIR, "context", "resolve-case-context.ts");
const DISPLAY = join(LIB_DIR, "domain", "marketplace-case-display.ts");
const WRITER = join(LIB_DIR, "sync", "marketplace-case-writer.ts");
const ROUTE = join(APP_DIR, "api", "conversations", "[conversationId]", "cases", "route.ts");
const PANEL = join(ROOT, "components", "conversation-cases-panel.tsx");
const HOOK = join(ROOT, "components", "use-conversation-cases.ts");
const CONTEXT_PANEL = join(ROOT, "components", "context-panel.tsx");
const WARNING = join(ROOT, "components", "repeat-customer-warning.tsx");

/** Strips comments, so prose about a rule is never read as the rule itself. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if ([".ts", ".tsx", ".mts", ".mjs"].includes(extname(path))) out.push(path);
  }
  return out;
}

const repository = code(read(REPOSITORY));
const resolver = code(read(RESOLVER));
const display = code(read(DISPLAY));
const route = code(read(ROUTE));
const panel = code(read(PANEL));
const hook = code(read(HOOK));
const contextPanel = code(read(CONTEXT_PANEL));

// ===========================================================================
describe("the publication gate", () => {
  /**
   * EVERY READER, not just the one written today. A second repository added
   * next month that reads the case table without the join would show an
   * abandoned run's rows as current, and the failure would be invisible on a
   * healthy database — the gate only matters on the day an import dies.
   *
   * The importer's own writer is exempt: it is what moves a run INTO the
   * published state, so it cannot filter on the state it is setting.
   */
  const WRITE_PATH = ["marketplace-case-writer.ts", "import-marketplace-cases.mjs"];

  it("is applied by every module that reads the case table", () => {
    const offenders: string[] = [];
    for (const file of [...walk(LIB_DIR), ...walk(APP_DIR)]) {
      if (WRITE_PATH.some((name) => file.endsWith(name))) continue;
      const source = code(read(file));
      if (!/\bFROM\s+cst_app\.marketplace_cases\b/.test(source)) continue;
      if (!/case_import_runs/.test(source) || !/status = 'published'/.test(source)) {
        offenders.push(file.replace(ROOT, "").replace(/\\/g, "/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is an inner join, so an unpublished run removes the row", () => {
    expect(repository).toMatch(/JOIN cst_app\.case_import_runs r/);
    expect(repository).not.toMatch(/LEFT\s+JOIN\s+cst_app\.case_import_runs/i);
  });

  /**
   * The read path keeps its own copy of the freshness statement, because
   * importing the writer's would pull the whole importer graph into a route's
   * dependencies — see that function's header. Two copies may not drift into
   * disagreeing about what "current" means, so both are checked here.
   */
  it("agrees with the writer about what a current snapshot is", () => {
    const writer = code(read(WRITER));
    for (const source of [repository, writer]) {
      expect(source).toMatch(/unnest\(r\.source_tables\)/);
      expect(source).toMatch(/WHERE r\.status = 'published'/);
      expect(source).toMatch(/GROUP BY 1/);
    }
  });

  /** Freshness is per store. One global timestamp is the bug this replaces. */
  it("answers freshness per source store, never once for everything", () => {
    expect(repository).not.toMatch(/max\(published_at\)[\s\S]{0,80}FROM cst_app\.case_import_runs[\s\S]{0,80}(?!GROUP BY)/);
    expect(repository).toMatch(/t AS source_table/);
  });
});

// ===========================================================================
describe("the read path only reads", () => {
  it("contains no write verb in the repository or the resolver", () => {
    for (const [name, source] of [
      ["repository", repository],
      ["resolver", resolver],
    ] as const) {
      for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "CREATE", "ALTER", "DROP"]) {
        expect(source.toUpperCase(), `${verb} must not appear in the ${name}`).not.toMatch(
          new RegExp(`\\b${verb}\\b`),
        );
      }
    }
  });

  /**
   * The resolver reads a context snapshot and must never write one. The order
   * resolver saves snapshots; this one borrows the answer and records nothing,
   * so opening a conversation cannot change a row through the case path.
   */
  it("reads the stored order context and saves none", () => {
    expect(resolver).toContain("getContextSnapshot");
    for (const writer of [
      "saveSingleOrderSnapshot",
      "saveNoOrderSnapshot",
      "saveAmbiguousSnapshot",
    ]) {
      expect(resolver, `the resolver must not call ${writer}`).not.toContain(writer);
    }
  });

  it("binds every value and interpolates only compile-time SQL fragments", () => {
    const templates = [...repository.matchAll(/`([^`]*)`/g)]
      .map((m) => m[1]!)
      .filter((body) => /\b(SELECT|FROM|JOIN|WHERE)\b/.test(body));
    expect(templates.length).toBeGreaterThan(0);
    const SAFE = [/\$\{CASE_COLUMNS\}/g, /\$\{PUBLISHED_RUN_JOIN\}/g, /\$\{LIFECYCLE_RANK\}/g];
    for (const template of templates) {
      let remaining = template;
      for (const safe of SAFE) remaining = remaining.replace(safe, " ");
      expect(remaining, "the repository interpolates something unreviewed into SQL").not.toMatch(
        /\$\{/,
      );
    }
  });
});

// ===========================================================================
describe("the API route", () => {
  it("exposes a GET and no other method", () => {
    expect(route).toMatch(/export\s+async\s+function\s+GET\b/);
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      expect(route, `the cases route must not export ${method}`).not.toMatch(
        new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`),
      );
    }
  });

  /**
   * ONE POOL, AND IT IS THE APPLICATION'S. Every fact this route serves was
   * imported, so the live marketplace source is not needed — and the MySQL
   * account the import came from must never be reachable from a page load.
   */
  it("uses the application pool alone", () => {
    expect(route).toContain("getAppPool");
    expect(route).not.toContain("getSourcePool");
    expect(route).not.toContain("getKnowledgePool");
    expect(route).not.toContain("getOrderSourceConnection");
  });

  it("embeds no SQL and reaches no writer", () => {
    for (const statement of ["SELECT ", "INSERT INTO", "UPDATE ", "DELETE FROM"]) {
      expect(route.toUpperCase()).not.toContain(statement);
    }
    for (const writer of ["upsertMarketplaceCases", "openImportRun", "publishImportRun"]) {
      expect(route, `the cases route must not reach ${writer}`).not.toContain(writer);
    }
  });

  /**
   * No source table name reaches the browser. Coverage travels as counts, so a
   * reviewer learns that a case source has never been imported without being
   * shown what the other system calls its tables.
   */
  it("returns coverage as counts rather than as store names", () => {
    expect(route).toMatch(/covered: result\.coverage\.storesCovered\.length/);
    expect(route).toMatch(/neverImported: result\.coverage\.storesNeverImported\.length/);
  });

  /**
   * Asserted on the PAYLOAD BUILDER, not on the whole file. The buyer handle is
   * legitimately present in this route — it is handed to the resolver as one of
   * the two things a case is matched on — and a file-wide scan would read that
   * input as an output. What must never happen is it travelling back out.
   */
  it("returns no buyer handle, address, email or message body", () => {
    /*
     * Both windows are CLOSED at their far end, and the first draft of this
     * test was not: slicing to end-of-file swept in the handler below, where
     * the buyer handle legitimately appears as a resolver input, and the test
     * failed on the thing it is meant to permit.
     */
    const builderStart = route.indexOf("function toPayload");
    const builderEnd = route.indexOf("export async function GET");
    const payloadStart = route.indexOf("const payload: CaseDetectionResponse");
    const payloadEnd = route.indexOf("return NextResponse.json(payload)");
    for (const index of [builderStart, builderEnd, payloadStart, payloadEnd]) {
      expect(index).toBeGreaterThan(-1);
    }
    const builder = route.slice(builderStart, builderEnd);
    const payload = route.slice(payloadStart, payloadEnd);
    for (const field of [
      "counterpartyRef",
      "counterparty_ref",
      "deliveryAddress",
      "email",
      "phone",
      "bodyText",
      "messages",
    ]) {
      for (const [name, source] of [
        ["the case mapper", builder],
        ["the response payload", payload],
      ] as const) {
        expect(source, `${field} must not be on ${name}`).not.toMatch(
          new RegExp(`${field}\\s*:`),
        );
      }
    }
  });
});

// ===========================================================================
describe("no MySQL anywhere near the read path", () => {
  /**
   * `tests/guards/case-import-isolation.test.ts` already walks everything
   * reachable from `app/`. This names the four new modules explicitly, so the
   * one that matters most is checked by name as well as by sweep.
   */
  it("names no MySQL driver or source reader in any new module", () => {
    for (const [name, source] of [
      ["repository", repository],
      ["resolver", resolver],
      ["display", display],
      ["route", route],
      ["panel", panel],
      ["hook", hook],
    ] as const) {
      for (const marker of [/\bmysql2\b/, /\bcreateConnection\b/, /\bcreatePool\b/, /\bmariadb\b/]) {
        expect(source, `${name} :: ${String(marker)}`).not.toMatch(marker);
      }
      expect(source, `${name} must not reach the MySQL case reader`).not.toContain(
        "message-app-case-source",
      );
    }
  });

  /**
   * And it must not reach the importer's writer either — not because the
   * writer opens MySQL, but because its module graph belongs to the importer
   * and pulling it into a route's dependencies puts the whole import path one
   * edit away from the CST runtime.
   */
  it("keeps the importer's writer out of the route's dependency graph", () => {
    for (const source of [repository, resolver, route, panel, hook]) {
      expect(source).not.toContain("marketplace-case-writer");
      expect(source).not.toContain("import-marketplace-cases");
    }
  });
});

// ===========================================================================
describe("the panel says only what the data supports", () => {
  it("renders the lifecycle through the shared label, never a raw stored value", () => {
    expect(panel).toContain("caseLifecycleLabel(lifecycle)");
    expect(panel).not.toMatch(/>\s*(Closed|Open|Active)\s*</);
  });

  /**
   * AN UNKNOWN LIFECYCLE IS NOT A CLOSED ONE, and the panel must not be able to
   * decide otherwise locally. Every lifecycle word comes from the domain.
   */
  it("makes no lifecycle judgement of its own", () => {
    expect(panel).not.toMatch(/lifecycle\s*===\s*["']closed["']\s*\?\s*["']/);
    expect(panel).toContain("caseNeedsAttention(c.lifecycle)");
  });

  /**
   * AN AMAZON WAREHOUSE DISPOSITION IS NOT A CASE STATUS. The panel never
   * touches that field directly — `caseFactsFor` is the only thing that reads
   * it, and it attaches the label that says what it is.
   */
  it("never renders the warehouse disposition itself", () => {
    expect(panel).not.toMatch(/\{[^}]*warehouseDisposition[^}]*\}/);
    expect(display).toContain("Warehouse outcome (not a case status)");
  });

  it("qualifies an order match that was not verified", () => {
    expect(panel).toContain("orderMatchCaveat(caseRecord.orderMatchMethod)");
  });

  it("states when the snapshot is old and when a source was never imported", () => {
    expect(panel).toContain("data.stale");
    expect(panel).toContain("data.coverage.neverImported");
    expect(panel).toContain("data.coverage.asOf");
  });

  it("says when a list was capped rather than implying it is complete", () => {
    expect(panel).toContain("orderCasesHasMore");
    expect(panel).toContain("customerCasesHasMore");
  });

  it("caps and sorts nothing itself — the server decided the order", () => {
    expect(panel).not.toMatch(/\.slice\(0,\s*\d/);
    expect(panel).not.toMatch(/\.sort\(/);
  });

  /** A failed lookup must never be drawn as an empty case list. */
  it("renders the unavailable sentence rather than an empty list", () => {
    expect(panel).toMatch(/cases\.state === "unavailable"/);
    expect(panel).toContain('caseEmptyStateText("unavailable"');
  });

  it("renders nothing while the lookup is in flight", () => {
    expect(panel).toMatch(/cases\.state === "loading"\)\s*return null/);
  });

  /**
   * Two of the five marketplaces have no case source at all. A section
   * permanently reading "never imported" on their conversations would be a
   * standing caveat about data that is never going to arrive.
   */
  it("renders nothing for a marketplace with no case source", () => {
    expect(panel).toMatch(
      /data\.coverage\.covered === 0 && data\.coverage\.neverImported === 0\) return null/,
    );
  });
});

// ===========================================================================
describe("the panel is read-only and reaches nobody", () => {
  it("writes nothing and offers no control", () => {
    expect(panel).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/);
    expect(panel).not.toMatch(/<button|<input|<form|onClick/);
    expect(panel).not.toMatch(/>\s*(Save|Confirm|Apply|Send|Resolve|Close case)\b/);
  });

  it("fetches exactly one endpoint, from the hook and not the panel", () => {
    expect(panel).not.toMatch(/fetch\(/);
    const fetches = [...hook.matchAll(/fetch\(`([^`]*)`/g)].map(([, url]) => url);
    expect(fetches).toEqual(["/api/conversations/${conversationId}/cases"]);
  });

  /**
   * The same stale-answer guard the history hook carries, and it matters more
   * here: a case list names order references, so a late response landing on the
   * wrong conversation would put one customer's order number in front of an
   * agent answering another.
   */
  it("discards a response for a conversation the agent has left", () => {
    expect(hook).toContain("cancelled");
    expect(hook).toMatch(/conversationId !== loadedFor/);
    expect(hook).toMatch(/setState\(LOADING\)/);
  });
});

// ===========================================================================
describe("it is mounted after the order it describes", () => {
  it("sits below the order section and above the customer's own claims", () => {
    const order = contextPanel.indexOf("<OrderContextFacts");
    const cases = contextPanel.indexOf("<ConversationCasesPanel");
    const reported = contextPanel.indexOf("<CustomerReportedProductDetails");
    expect(order).toBeGreaterThan(-1);
    expect(cases).toBeGreaterThan(order);
    expect(reported).toBeGreaterThan(cases);
  });

  it("is mounted exactly once", () => {
    expect(contextPanel.match(/<ConversationCasesPanel/g)).toHaveLength(1);
  });

  /**
   * ONE LOOKUP, TWO RENDERINGS.
   *
   * The thread column shows a flag for the live cases and the details column
   * shows the full list, so the state is held by the workspace and handed to
   * both — the same arrangement `internalNotes` has, and for the same two
   * reasons: one request per conversation instead of two, and two renderings
   * that cannot disagree because there is only one answer.
   *
   * Neither consumer may call the hook itself, and the workspace must call it
   * exactly once.
   */
  it("fetches the cases once, in the workspace, and passes them to both columns", () => {
    const workspace = code(read(join(ROOT, "components", "workspace.tsx")));
    expect(workspace.match(/useConversationCases\(/g)).toHaveLength(1);
    expect(workspace.match(/cases=\{conversationCases\}/g)).toHaveLength(2);

    for (const [name, source] of [
      ["context-panel", contextPanel],
      ["conversation-view", code(read(join(ROOT, "components", "conversation-view.tsx")))],
    ] as const) {
      expect(source, `${name} must receive the cases rather than fetching them`).not.toMatch(
        /useConversationCases\(/,
      );
    }
  });

  /**
   * THE FLAG IS THE REASON THIS FEATURE IS VISIBLE AT ALL. Measured on the
   * running application: the details column's case section sat 1,305px down a
   * 2,174px scroller, below the root-cause chip grid — a reviewer answering a
   * message never reached it. The strip sits outside the message scroller so it
   * cannot scroll away, exactly as the Repeat-Customer Warning does.
   */
  it("flags the live cases above the thread, outside the scroller", () => {
    const view = code(read(join(ROOT, "components", "conversation-view.tsx")));
    const flag = view.indexOf("<ConversationCaseFlag");
    const scroller = view.indexOf('ref={scroller}');
    expect(flag).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(scroller);
    expect(panel).toContain("shrink-0");
  });

  /** A closed case is history and never raises the flag. */
  it("raises the flag only for cases that are not closed", () => {
    const flag = panel.slice(panel.indexOf("export function ConversationCaseFlag"));
    expect(flag).toContain("caseNeedsAttention(c.lifecycle)");
    expect(flag).toMatch(
      /onThisOrder\.length === 0 && onOtherOrders\.length === 0\) return null/,
    );
  });

  /**
   * Three strips can stack above one thread — the rose Repeat-Customer Warning,
   * an amber pinned note, and this. They must stay visually distinguishable, or
   * a reviewer cannot tell a colleague's note from a case open right now at the
   * marketplace.
   */
  it("uses its own colour and its own icon, not the warning's", () => {
    const flag = panel.slice(panel.indexOf("export function ConversationCaseFlag"));
    expect(flag).toContain("border-l-sky-500");
    expect(flag).toContain("<FlagIcon");
    expect(flag).not.toContain("<PinIcon");
    expect(flag).not.toContain("rose");
    // Context, not an interruption — the same choice the warning made.
    expect(flag).toContain('role="note"');
    expect(flag).not.toContain('role="alert"');
  });
});

// ===========================================================================
/**
 * THE INDICATOR AND THE REPEAT-CUSTOMER WARNING DESCRIBE OVERLAPPING RECORDS.
 *
 * 1,098 cases exist in both tables — measured, not estimated. They cannot
 * surface as a duplicate on screen because the two render disjoint things: the
 * warning renders COUNTS of records that predate this conversation and names
 * none of them, and this panel renders CASES and totals nothing. That property
 * is what these assertions hold in place.
 */
describe("no double counting with the Repeat-Customer Warning", () => {
  const warning = code(read(WARNING));

  it("shares no data path with the warning", () => {
    expect(panel).not.toContain("use-customer-history");
    expect(panel).not.toContain("customer-history");
    expect(warning).not.toContain("use-conversation-cases");
    expect(warning).not.toContain("conversation-cases");
  });

  it("totals nothing, so no screen sums the two", () => {
    expect(panel).not.toMatch(/\.reduce\(/);
    expect(panel).not.toMatch(/total/i);
  });

  it("names no case reference in the warning", () => {
    expect(warning).not.toContain("caseRef");
    expect(warning).not.toContain("source_case_id");
  });
});
