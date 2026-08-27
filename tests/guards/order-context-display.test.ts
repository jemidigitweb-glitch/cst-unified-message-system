import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MULTIPLE_ORDERS_TEXT } from "@/lib/domain/inbox";

/**
 * Standing guard on the order-context display and the order selection helper.
 *
 * Showing a reviewer three real order numbers is useful and safe; letting two
 * of them blend into one block, letting the system choose between them, or
 * letting an unchosen one reach the model is not. The properties guarded here
 * are the ones that keep those apart, and each is invisible in ordinary
 * review:
 *
 *   1. One format. The same field list renders whether one order matched or
 *      several — there is no second, thinner layout for the multi-match case.
 *   2. The reviewer picks one, or nothing picks. Nothing merges.
 *   3. A chosen order reaches the model only through one validated door, and
 *      never overrides an order the resolver established on its own.
 *
 * Asserted against source, matching how the rest of this suite guards the
 * interface: no DOM environment is configured, and what matters here is
 * structural.
 */

const ROOT = join(__dirname, "..", "..");

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const panel = read("components", "context-panel.tsx");
const route = read("app", "api", "conversations", "[conversationId]", "order-context", "route.ts");
const draftRoute = read("app", "api", "conversations", "[conversationId]", "draft", "route.ts");
const draftPanel = read("components", "draft-panel.tsx");
const workspace = read("components", "workspace.tsx");
const resolver = read("lib", "context", "resolve-order-context.ts");
const selected = read("lib", "context", "resolve-selected-order-context.ts");
const repository = read("lib", "repositories", "context-snapshot-repository.ts");
const domain = read("lib", "domain", "order.ts");

describe("one format, however many orders matched", () => {
  it("renders every block from the one shared field list", () => {
    expect(panel).toContain("ORDER_DETAIL_FIELDS.map(");
    expect(panel.match(/function OrderDetailBlock/g)).toHaveLength(1);
    expect(panel).not.toMatch(/function (Ambiguous|Candidate)\w*\(/);
  });

  it("builds the blocks in the domain, not by branching in the view", () => {
    expect(panel).toContain("orderDetailsFrom(");
    expect(panel).not.toMatch(/resolution\s*===\s*["']ambiguous["']/);
    expect(panel).not.toMatch(/resolution\s*===\s*["']single_order["']/);
  });

  it("shows every matching order, capping and slicing nothing", () => {
    expect(panel).toContain("orders.map(");
    expect(panel).not.toMatch(/orders\s*\.\s*slice/);
    expect(panel).not.toMatch(/orders\s*\.\s*(sort|find|shift|pop)\b/);
    expect(panel).not.toMatch(/orders\[\d\]/);
  });

  it("renders a blank value rather than a stand-in for a field nothing recorded", () => {
    expect(panel).toContain('value ?? ""');
    for (const standIn of [">N/A<", ">Unknown<", ">—<", ">-<", '"Unknown"', '"N/A"']) {
      expect(panel).not.toContain(standIn);
    }
  });
});

describe("the interface speaks the reviewer's language", () => {
  it("asks the question plainly and names no internal concept", () => {
    expect(MULTIPLE_ORDERS_TEXT).toBe(
      "Multiple orders found. Please select the order related to this conversation.",
    );
    for (const jargon of [
      "ordered this listing more than once",
      "None is confirmed",
      "used in the draft",
      "Ambiguous",
      "ambiguous",
      "Verification",
    ]) {
      expect(MULTIPLE_ORDERS_TEXT).not.toContain(jargon);
    }
  });

  /**
   * The panel is the one file a CST agent reads through the screen. A
   * resolution value or a verification state rendered there describes the
   * system's bookkeeping, not anything they can act on.
   */
  it("shows no system vocabulary anywhere in the panel", () => {
    for (const internal of [
      "ambiguous",
      "Ambiguous",
      "verification",
      "Verification",
      "single_order",
      "no_order",
      "deterministic",
    ]) {
      expect(panel, `${internal} is a system concept, not CST wording`).not.toContain(internal);
    }
  });
});

describe("nearest order first", () => {
  it("orders the list before it leaves the server, not in the view", () => {
    expect(route).toContain("orderByNearest(found, detail.messages)");
    expect(panel).not.toContain("orderByNearest");
  });

  it("orders without choosing: no order is preselected or hidden", () => {
    expect(panel).not.toMatch(/defaultChecked/);
    expect(panel).not.toMatch(/most recent|most likely|best match|recommended/i);
  });
});

describe("the reviewer picks; nothing else does, and nothing merges", () => {
  /**
   * A radio, not a checkbox, and one shared `name` per conversation — so the
   * browser itself makes two orders unselectable together. No state anywhere
   * holds more than one order number.
   */
  it("offers a single-select radio and no multi-select control", () => {
    expect(panel).toContain('type="radio"');
    expect(panel).toContain("name={`order-choice-${conversationId}`}");
    expect(panel).not.toContain('type="checkbox"');
    expect(panel).not.toMatch(/selectedOrderNumbers/);
    expect(workspace).not.toMatch(/selectedOrderNumbers/);
  });

  it("offers the choice only where several orders matched", () => {
    expect(panel).toContain("const selectable = orders.length > 1");
    expect(panel).toContain("{selectable &&");
  });

  /**
   * No save button, no confirmation screen: the choice lives in memory and
   * travels with the next generate request. Nothing in the panel writes.
   */
  it("saves nothing and confirms nothing", () => {
    expect(panel).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/);
    expect(panel).not.toMatch(/>\s*(Save|Confirm|Apply)\b/);
    expect(panel).not.toContain("verification_method");
    expect(panel).not.toContain("confirmed_by");
  });

  /**
   * A choice made on one conversation must never be sent with another's draft
   * request.
   */
  it("clears the choice when the selected conversation changes", () => {
    expect(workspace).toContain("setSelectedOrderNumber(null)");
    expect(workspace).toContain("}, [selectedId]);");
  });

  it("never blends the resolved order with the candidates", () => {
    const builder = domain.slice(domain.indexOf("export function orderDetailsFrom"));
    expect(builder).not.toMatch(/\.\.\.\s*response\.candidates/);
    expect(builder).not.toMatch(/facts.*concat|concat.*candidates/);
    expect(builder).toContain("response.candidates.map(");
    expect(builder).toContain("response.orders.map(");
  });

  it("fills a candidate's missing fields from nothing at all", () => {
    const fromCandidate = domain.slice(
      domain.indexOf("export function orderDetailFromCandidate"),
      domain.indexOf("export function orderDetailsFrom"),
    );
    expect(fromCandidate).not.toContain("facts");
    expect(fromCandidate).not.toMatch(/\|\|\s*["'][^"']+["']/);
    expect(fromCandidate).not.toMatch(/\?\?\s*["'][^"']+["']/);
  });
});

describe("a chosen order grounds one generation, and only if it is real", () => {
  it("never overrides an order the resolver established on its own", () => {
    expect(draftRoute).toContain("orderFacts.length === 0 && selectedOrderNumber !== null");
  });

  it("replaces the fact list rather than adding to it, so two orders cannot combine", () => {
    expect(draftRoute).not.toMatch(/orderFacts\s*=\s*\[\s*\.\.\.orderFacts/);
    expect(draftRoute).not.toMatch(/orderFacts\.push/);
    expect(draftRoute).not.toMatch(/orderFacts\.concat/);
  });

  it("re-checks the choice against the orders this conversation matched", () => {
    expect(selected).toContain("findCandidateEbayOrders");
    expect(selected).toContain("matches.length !== 1");
  });

  it("leaves the resolver untouched and writes nothing", () => {
    expect(resolver).not.toContain("resolveSelectedOrderContext");
    expect(selected).not.toContain("context-snapshot-repository");
    expect(selected).not.toContain("saveSingleOrderSnapshot");
    expect(selected).not.toContain("verification_method");
  });

  /**
   * With nothing chosen the request must be byte-identical to the one made
   * before selection existed, so the no-selection path cannot drift.
   */
  it("sends nothing when nothing was chosen", () => {
    expect(draftPanel).toContain('if (selectedOrderNumber !== null) params.set("selectedOrder"');
    expect(draftPanel).toContain('return query === "" ? "" : `?${query}`');
  });
});

describe("the draft pipeline reads no candidate and no evidence", () => {
  it("imports neither the candidates reader nor the evidence builder", () => {
    expect(draftRoute).not.toContain("getOrderCandidates");
    expect(draftRoute).not.toContain("matchEvidenceFor");
    expect(draftRoute).not.toContain("order-match-evidence");
    expect(draftRoute).not.toContain("loadOrderDisplayDetails");
    expect(resolver).not.toContain("getOrderCandidates");
    expect(resolver).not.toContain("matchEvidenceFor");
  });

  it("keeps candidates, live orders and evidence in their own response fields", () => {
    for (const field of ["facts,", "resolution,", "candidates,", "orders,", "evidence,"]) {
      expect(route).toContain(field);
    }
    expect(route).not.toMatch(/facts\s*:\s*\[\s*\.\.\./);
    expect(route).not.toMatch(/\.\.\.candidates/);
    expect(route).not.toMatch(/\.\.\.orders/);
    expect(route).not.toMatch(/\.\.\.evidence/);
  });

  it("computes evidence only where there is a comparison to explain", () => {
    expect(route).toContain("orders.length > 1 ? matchEvidenceFor");
  });

  it("shows evidence beneath the order it explains, with no control attached", () => {
    const section = panel.slice(
      panel.indexOf("function MatchEvidence"),
      panel.indexOf("export function ContextPanel"),
    );
    expect(section).toContain("MATCH_EVIDENCE_HEADING");
    expect(section).toContain("reasons.map(");
    expect(section).not.toMatch(/<button|onClick|<input/i);
    expect(section).not.toMatch(/reasons\.length\s*>\s*[1-9]/);
    expect(section).not.toMatch(/sort|slice/);
  });

  it("keeps the display types out of the grounding type", () => {
    const detail = domain.slice(
      domain.indexOf("export type OrderDetail"),
      domain.indexOf("export const ORDER_DETAIL_FIELDS"),
    );
    expect(detail).not.toContain("VerifiedFact");
    expect(resolver).not.toContain("OrderDetail");
    expect(draftRoute).not.toContain("OrderDetail");
  });
});

describe("the candidates reader is read-only", () => {
  it("adds a SELECT and no other statement", () => {
    const reader = repository.slice(repository.indexOf("const GET_ORDER_CANDIDATES"));
    const sql = reader.slice(0, reader.indexOf("export async function getOrderCandidates"));
    expect(sql).toContain("SELECT");
    for (const statement of ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP"]) {
      expect(sql.toUpperCase()).not.toContain(statement);
    }
  });
});

/**
 * The selection helper required no schema change, and must not acquire one by
 * accident. `context_order_candidates` has held its columns since migration
 * 0001; nothing here writes to it or to `context_snapshots`.
 */
describe("no migration was created for this", () => {
  const MIGRATIONS = join(ROOT, "migrations");
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));

  it("scans the migrations directory", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("names no migration after candidates, selection or the sidebar", () => {
    for (const name of files) {
      expect(name.toLowerCase()).not.toMatch(
        /candidate|ambiguous|sidebar|context_panel|detail|select/,
      );
    }
  });

  it("alters or drops the candidates table nowhere", () => {
    for (const name of files) {
      const sql = readFileSync(join(MIGRATIONS, name), "utf8");
      expect(sql).not.toMatch(/ALTER\s+TABLE\s+cst_app\.context_order_candidates/i);
    }
  });

  it("still creates the table exactly once, in the core schema", () => {
    const creators = files.filter((name) =>
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+cst_app\.context_order_candidates/i.test(
        readFileSync(join(MIGRATIONS, name), "utf8"),
      ),
    );
    expect(creators).toEqual(["0001_cst_core_schema.up.sql"]);
  });

  it("adds no selected column anywhere, so no process can mark an order chosen", () => {
    for (const name of files) {
      const sql = readFileSync(join(MIGRATIONS, name), "utf8").toLowerCase();
      expect(sql).not.toMatch(/add\s+column[^;]*\bselected\b/);
    }
  });
});

/**
 * The hand-off that broke, guarded end to end.
 *
 * The selection is SET in the aside (context panel) and SENT from inside the
 * conversation view (draft panel) — two different branches of the workspace
 * tree. It once reached the first and not the second: the prop was optional,
 * the missing hand-off compiled, and it silently defaulted to null. A reviewer
 * saw their chosen order highlighted while every generation ran ungrounded and
 * the model went on asking for an order number.
 *
 * Two defences, and this file holds both: every link in the chain is asserted
 * below, and every prop in it is required so a future omission is a type error
 * rather than a wrong answer.
 */
describe("the selected order reaches the draft request", () => {
  const conversationView = read("components", "conversation-view.tsx");

  it("passes the selection down BOTH branches of the workspace", () => {
    // The aside, which sets it...
    const aside = workspace.slice(workspace.indexOf("<ContextPanel"));
    expect(aside).toContain("selectedOrderNumber={selectedOrderNumber}");
    expect(aside).toContain("onSelectOrder={setSelectedOrderNumber}");

    // ...and the main column, which sends it. This is the link that was missing.
    const main = workspace.slice(
      workspace.indexOf("<ConversationView"),
      workspace.indexOf("<ContextPanel"),
    );
    expect(main, "ConversationView must receive the selection").toContain(
      "selectedOrderNumber={selectedOrderNumber}",
    );
  });

  it("carries it through the conversation view into the draft panel", () => {
    const draftMount = conversationView.slice(conversationView.indexOf("<DraftPanel"));
    expect(draftMount).toContain("selectedOrderNumber={selectedOrderNumber}");
  });

  it("puts it on the generate request", () => {
    expect(draftPanel).toContain('params.set("selectedOrder", selectedOrderNumber)');
    expect(draftPanel).toContain("generateQuery(force, selectedOrderNumber)");
  });

  /**
   * Required, not optional — an omitted hand-off must not compile.
   */
  it("requires the prop at every link, so a missing hand-off cannot default to null", () => {
    for (const [name, source] of [
      ["context-panel", panel],
      ["conversation-view", conversationView],
      ["draft-panel", draftPanel],
    ] as const) {
      expect(source, `${name} must not make selectedOrderNumber optional`).not.toMatch(
        /selectedOrderNumber\?\s*:/,
      );
      expect(source, `${name} must not default selectedOrderNumber`).not.toMatch(
        /selectedOrderNumber\s*=\s*null/,
      );
    }
    expect(panel).not.toMatch(/onSelectOrder\?\s*:/);
    expect(panel).not.toMatch(/onSelectOrder\s*\?\?/);
  });

  it("reads it server-side and hands it to the fact assembly", () => {
    expect(draftRoute).toContain('requestUrl.searchParams.get("selectedOrder")');
    expect(draftRoute).toContain("verifiedFactsFor(detail.conversation, selectedOrderNumber)");
  });
});

/**
 * The selection survives a refresh, in the reviewer's own browser and nowhere
 * else.
 *
 * The risk this guards is narrow and serious: a remembered value that grounds
 * the next draft without being re-checked against the orders currently on
 * screen. The panel must validate before restoring, and must forget a value it
 * cannot validate.
 */
describe("a selection survives a page refresh", () => {
  const storage = read("lib", "domain", "order-selection-storage.ts");

  it("remembers the choice against the conversation it belongs to", () => {
    expect(panel).toContain("saveStoredSelection(browserOrderSelectionStorage(), conversationId");
    expect(storage).toContain("`${ORDER_SELECTION_KEY_PREFIX}${conversationId}`");
  });

  it("restores only after checking the value is still one of the orders shown", () => {
    expect(panel).toContain("restorableSelection(stored, available)");
    // ...and forgets it when it is not.
    expect(panel).toContain("saveStoredSelection(storage, conversationId, null)");
  });

  /**
   * Restoring must never overwrite a choice the reviewer just made in this
   * session — it only fills an empty selection.
   */
  it("never overrides a live selection with a remembered one", () => {
    expect(panel).toContain("selectedOrderNumber !== null) return");
  });

  it("stays in the browser: nothing is written to a database or sent anywhere", () => {
    expect(storage).not.toMatch(/fetch\(|XMLHttpRequest|navigator\.sendBeacon|https?:\/\//);
    expect(storage).not.toMatch(/INSERT|UPDATE|DELETE|cst_app/i);
    expect(storage).not.toContain("server-only");
    // The panel gained persistence without gaining a write path.
    expect(panel).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/);
  });

  it("survives a browser that denies storage instead of throwing at render", () => {
    expect(storage).toContain("catch");
    expect(storage).toContain('typeof window === "undefined"');
  });

  it("adds no save button or confirmation step", () => {
    expect(panel).not.toMatch(/>\s*(Save|Confirm|Apply|Remember)\b/);
  });
});
