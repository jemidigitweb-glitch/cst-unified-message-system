import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MIN_SEARCH_LENGTH,
  SEARCH_MATCH_KINDS,
  SEARCH_MATCH_LABEL,
  type ConversationSearchResult,
  dedupeByStrongestMatch,
  isSearchable,
  looksLikeId,
  normalizeSearchQuery,
} from "@/lib/domain/conversation-search";
import { searchConversations } from "@/lib/repositories/conversation-search-repository";

/**
 * The common search: one box for a name, a handle, an order number, a
 * conversation id or a message id.
 *
 * No database is touched. The repository takes an injected `Queryable`, so a
 * recording fake proves the statements and the bound values — the project's
 * established approach. The statements themselves were additionally smoke-run
 * against the live schema when this was written; see the task report.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

type Call = { text: string; values?: unknown[] };
function fake(responses: unknown[][] = []) {
  const calls: Call[] = [];
  let index = 0;
  const db = {
    query: async (config: { text: string; values?: unknown[] }) => {
      calls.push(config);
      return { rows: responses[index++] ?? [] };
    },
  };
  return { calls, db };
}

const hit = (over: Record<string, unknown> = {}) => ({
  match_kind: "handle",
  matched_on: "lizw4512",
  conversation_id: "45862",
  marketplace: "ebay",
  counterparty_ref: "lizw4512",
  last_source_ts: "2026-09-21 17:28:54",
  message_count: 7,
  ...over,
});

/* ------------------------------------------------------------------------- *
 * THE QUERY ITSELF
 * ------------------------------------------------------------------------- */

describe("what counts as a search", () => {
  it("collapses whitespace so spacing does not change the search", () => {
    expect(normalizeSearchQuery("  Liz   Wharton ")).toBe("Liz Wharton");
  });

  it("needs two characters", () => {
    expect(MIN_SEARCH_LENGTH).toBe(2);
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable("  ")).toBe(false);
    expect(isSearchable("45")).toBe(true);
  });

  it("recognises a bare id without rejecting anything else", () => {
    expect(looksLikeId("45862")).toBe(true);
    expect(looksLikeId("LED63146")).toBe(false);
    expect(looksLikeId("10-15196-37279")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * THE PATHS
 * ------------------------------------------------------------------------- */

describe("searching the application database", () => {
  it("binds every value and interpolates none", async () => {
    const { calls, db } = fake([[hit()]]);
    await searchConversations(db, { query: "lizw4512" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).not.toContain("lizw4512");
    expect(calls[0]!.values![0]).toBe("lizw4512");
    // The contains-pattern is built on the VALUE, never into the SQL.
    expect(calls[0]!.values![3]).toBe("%lizw4512%");
  });

  it("tries the id path only for an all-digit query", async () => {
    const numeric = fake([[hit()]]);
    await searchConversations(numeric.db, { query: "45862" });
    expect(numeric.calls[0]!.values![1]).toBe(true);
    expect(numeric.calls[0]!.values![2]).toBe("45862");

    const text = fake([[hit()]]);
    await searchConversations(text.db, { query: "LED63146" });
    expect(text.calls[0]!.values![1]).toBe(false);
    // Never a non-numeric value cast to bigint.
    expect(text.calls[0]!.values![2]).toBe("0");
  });

  it("covers all four application-side paths in one statement", async () => {
    const { calls, db } = fake([[]]);
    await searchConversations(db, { query: "anything" });
    const sql = calls[0]!.text;
    expect(sql).toContain("cst_app.conversations");
    expect(sql).toContain("cst_app.conversation_messages");
    expect(sql).toContain("cst_app.context_snapshots");
    expect(sql).toContain("external_message_id");
    for (const kind of ["conversation_id", "message_id", "order_number", "handle"]) {
      expect(sql).toContain(`'${kind}'`);
    }
  });

  it("never offers an unresolved thread as a match", async () => {
    const { calls, db } = fake([[]]);
    await searchConversations(db, { query: "unresolved" });
    expect(calls[0]!.text).toContain("NOT LIKE 'unresolved:%'");
  });

  it("maps a row to the result contract", async () => {
    const { db } = fake([[hit({ match_kind: "order_number", matched_on: "10-15196-37279" })]]);
    const found = await searchConversations(db, { query: "10-15196-37279" });
    expect(found.results[0]).toEqual({
      conversationId: "45862",
      marketplace: "ebay",
      counterpartyRef: "lizw4512",
      matchKind: "order_number",
      matchedOn: "10-15196-37279",
      lastSourceTimestamp: "2026-09-21 17:28:54",
      messageCount: 7,
    });
  });
});

/* ------------------------------------------------------------------------- *
 * THE NAME PATH — the one that leaves this application
 * ------------------------------------------------------------------------- */

describe("searching by customer name", () => {
  it("reads names from the source and maps the refs back to conversations", async () => {
    const app = fake([[], [hit({ counterparty_ref: "lizw4512" })]]);
    const source = fake([[{ order_id: "10-15196-37279", ebay_buyer_id: "lizw4512", full_name: "Liz Wharton" }]]);

    const found = await searchConversations(app.db, { query: "Wharton" }, source.db);

    expect(source.calls[0]!.values![0]).toBe("%Wharton%");
    // Both the order reference and the handle are offered as lookup keys.
    expect(app.calls[1]!.values![0]).toEqual(
      expect.arrayContaining(["10-15196-37279", "lizw4512"]),
    );
    expect(found.nameSearchAvailable).toBe(true);
    expect(found.results[0]!.matchKind).toBe("customer_name");
    // The evidence is the name that matched, from the order record.
    expect(found.results[0]!.matchedOn).toBe("Liz Wharton");
  });

  /**
   * THE BUG THIS PINS. The source lookup ordered by `order_id DESC`, which
   * sorts references as TEXT — `LSFR…`/`LED…` filled the cap and eBay's
   * numeric references fell off the end, so a live search for a real surname
   * returned no conversations at all. Recency is the correct key.
   */
  it("orders the name lookup by order date, not by order reference", () => {
    const repository = read("lib", "repositories", "conversation-search-repository.ts");
    const lookup = /const SEARCH_SOURCE_NAMES = `[\s\S]*?`;/.exec(repository)?.[0] ?? "";
    expect(lookup).toContain("ORDER BY o.order_date DESC");
    expect(lookup).not.toContain("ORDER BY o.order_id");
  });

  it("matches across first and last name together", () => {
    const repository = read("lib", "repositories", "conversation-search-repository.ts");
    expect(repository).toContain("first_name, '') || ' ' || coalesce(ci.last_name");
  });

  /** Without the source pool the other paths still answer, and say so. */
  it("skips the name path when there is no source pool", async () => {
    const { calls, db } = fake([[hit()]]);
    const found = await searchConversations(db, { query: "Wharton" });
    expect(calls).toHaveLength(1);
    expect(found.nameSearchAvailable).toBe(false);
    expect(found.results).toHaveLength(1);
  });

  /** A shared production database being unavailable must not break the search. */
  it("degrades rather than failing when the source errors", async () => {
    const app = fake([[hit()]]);
    const source = {
      query: async () => {
        throw new Error("source unavailable");
      },
    };
    const found = await searchConversations(app.db, { query: "Wharton" }, source);
    expect(found.nameSearchAvailable).toBe(false);
    expect(found.results).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- *
 * RANKING
 * ------------------------------------------------------------------------- */

describe("one row per conversation, strongest match kept", () => {
  const result = (kind: string, id = "1"): ConversationSearchResult =>
    ({
      conversationId: id,
      marketplace: "ebay",
      counterpartyRef: "x",
      matchKind: kind,
      matchedOn: kind,
      lastSourceTimestamp: "2026-09-21 00:00:00",
      messageCount: 1,
    }) as ConversationSearchResult;

  it("prefers the more specific match", () => {
    const deduped = dedupeByStrongestMatch([result("handle"), result("conversation_id")]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.matchKind).toBe("conversation_id");
  });

  it("ranks the kinds most specific first", () => {
    expect([...SEARCH_MATCH_KINDS]).toEqual([
      "conversation_id",
      "message_id",
      "order_number",
      "handle",
      "customer_name",
    ]);
    const deduped = dedupeByStrongestMatch([
      result("customer_name", "4"),
      result("order_number", "2"),
      result("conversation_id", "1"),
      result("message_id", "3"),
    ]);
    expect(deduped.map((r) => r.matchKind)).toEqual([
      "conversation_id",
      "message_id",
      "order_number",
      "customer_name",
    ]);
  });

  /** Every kind is labelled, and a name says where it came from. */
  it("labels every match kind", () => {
    for (const kind of SEARCH_MATCH_KINDS) {
      expect(SEARCH_MATCH_LABEL[kind].length).toBeGreaterThan(0);
    }
    expect(SEARCH_MATCH_LABEL.customer_name).toContain("order record");
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT SEARCH IS NOT
 * ------------------------------------------------------------------------- */

describe("search reads and does nothing else", () => {
  const REPO = read("lib", "repositories", "conversation-search-repository.ts");
  const ROUTE = read("app", "api", "conversations", "search", "route.ts");
  const UI = read("components", "search-results.tsx");
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  it("writes nothing to either database", () => {
    for (const source of [REPO, ROUTE].map(stripComments)) {
      for (const write of ["INSERT", "UPDATE ", "DELETE", "TRUNCATE", "ALTER"]) {
        expect(source.toUpperCase()).not.toContain(write);
      }
    }
  });

  it("exposes only GET", () => {
    expect(ROUTE).toMatch(/export async function GET\b/);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(ROUTE).not.toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`));
    }
  });

  it("returns no raw database error to the browser", () => {
    expect(ROUTE).not.toMatch(/\berror\.message\b/);
    expect(ROUTE).toContain("console.error");
  });

  /** Results are a way to OPEN a conversation, never to act on one. */
  it("adds no send, draft or completion control", () => {
    for (const forbidden of [/sendReply/i, /outbound/i, /\bdraft\b/i, /complete/i, /PATCH/]) {
      expect(stripComments(UI)).not.toMatch(forbidden);
    }
  });

  /** A name is shown as evidence, never as the thread's identity. */
  it("titles rows through the capability rule", () => {
    expect(UI).toContain("conversationTitle(");
    expect(UI).toContain("capabilityOf(");
  });

  /** A capped list is not "all of it". */
  it("says when the result set was capped or the name path did not run", () => {
    expect(UI).toContain("feed.capped");
    expect(UI).toContain("nameSearchAvailable");
  });
});
