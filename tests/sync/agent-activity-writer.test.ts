import { describe, expect, it } from "vitest";

import type { ActivityRecord } from "@/lib/domain/agent-activity";
import { mapActivityRow } from "@/lib/domain/agent-activity";
import {
  UPSERT_AGENT_ACTIVITY_SQL,
  toColumnArrays,
  upsertAgentActivity,
} from "@/lib/sync/agent-activity-writer";
import { SELECT_EBAY_ACTIVITY_SQL } from "@/lib/db/message-app-source";
import {
  FIND_CONVERSATIONS_SQL,
  FIND_HEADER_MESSAGE_IDS_SQL,
  resolveConversationsByExtMessageId,
} from "@/lib/repositories/ebay-message-link-repository";

const record = (over: Partial<ActivityRecord> = {}): ActivityRecord => ({
  sourceDatabase: "message_app",
  sourceTable: "message_app_logs",
  sourcePk: "40544",
  sourceUserId: 241,
  action: "reply_to_message",
  actionDate: "2026-09-23",
  marketplace: "ebay",
  subSourceId: 1,
  conversationId: 1417,
  externalMessageId: "3524071528016",
  matchStatus: "matched",
  ...over,
});

function stubTx(insertedFlags: boolean[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: async (config: { text: string; values?: unknown[] }) => {
      calls.push({ text: config.text, values: config.values ?? [] });
      return { rows: insertedFlags.map((inserted) => ({ inserted })) };
    },
  };
}

describe("the source SELECT", () => {
  /**
   * `message_app_logs.data` holds `replied_message_text` — the full reply sent
   * to a customer — plus their email and the subject line. One identifier is
   * extracted IN THE DATABASE; the payload is never transferred.
   */
  it("extracts one identifier and never selects the payload column", () => {
    expect(SELECT_EBAY_ACTIVITY_SQL).toContain("JSON_EXTRACT(data, '$.ext_message_id')");
    expect(SELECT_EBAY_ACTIVITY_SQL).not.toMatch(/\bdata\b\s+AS\b/);
    expect(SELECT_EBAY_ACTIVITY_SQL).not.toMatch(/replied_message_text|message_content|body/i);
  });

  it("is a SELECT and nothing else", () => {
    for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE"]) {
      expect(SELECT_EBAY_ACTIVITY_SQL.toUpperCase()).not.toContain(verb);
    }
  });

  /** eBay only. `source` is bound, not inlined. */
  it("filters to one marketplace with a bound parameter", () => {
    expect(SELECT_EBAY_ACTIVITY_SQL).toMatch(/WHERE id > \? AND source = \?/);
  });

  /** Keyset pagination: the table's only index is PRIMARY(id). */
  it("paginates on the primary key with bound parameters", () => {
    expect(SELECT_EBAY_ACTIVITY_SQL).toMatch(/ORDER BY id ASC/);
    expect(SELECT_EBAY_ACTIVITY_SQL).toMatch(/LIMIT \?/);
    expect(SELECT_EBAY_ACTIVITY_SQL).not.toMatch(/OFFSET/i);
  });

  /** Formatted in SQL so no JS Date can shift a day boundary. */
  it("formats the date in SQL", () => {
    expect(SELECT_EBAY_ACTIVITY_SQL).toContain("DATE_FORMAT(date, '%Y-%m-%d')");
  });
});

describe("the two-hop lookup", () => {
  it("reads headers by ext_message_id and casts the key to text", () => {
    expect(FIND_HEADER_MESSAGE_IDS_SQL).toMatch(/ext_message_id = ANY\(\$1::bigint\[\]\)/);
    expect(FIND_HEADER_MESSAGE_IDS_SQL).toMatch(/ext_message_id::text/);
  });

  it("reads conversations by the header's message_id", () => {
    expect(FIND_CONVERSATIONS_SQL).toMatch(/external_message_id = ANY\(\$1::text\[\]\)/);
  });

  it("both hops are SELECTs", () => {
    for (const sql of [FIND_HEADER_MESSAGE_IDS_SQL, FIND_CONVERSATIONS_SQL]) {
      for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP"]) {
        expect(sql.toUpperCase()).not.toContain(verb);
      }
    }
  });

  /**
   * THE MISTAKE THIS GUARDS. cst_app stores `message_id`, not `ext_message_id`.
   * Joining the log straight onto `external_message_id` matches nothing,
   * silently, and every row reads as unmatched.
   */
  it("resolves through message_id, not directly on ext_message_id", async () => {
    const source = {
      query: async () => ({
        rows: [{ ext_message_id: "3524071528016", message_id: "211890155062" }],
      }),
    };
    const app = {
      query: async () => ({
        rows: [
          {
            external_message_id: "211890155062",
            conversation_message_id: 106403,
            conversation_id: 1417,
            direction: "inbound",
          },
        ],
      }),
    };
    const resolved = await resolveConversationsByExtMessageId(source, app, ["3524071528016"]);
    expect(resolved.get("3524071528016")).toBe(1417);
  });

  it("returns nothing for an id with no header", async () => {
    const source = { query: async () => ({ rows: [] }) };
    const app = { query: async () => ({ rows: [] }) };
    expect((await resolveConversationsByExtMessageId(source, app, ["1"])).size).toBe(0);
  });

  /** A header that resolves but has no CST message stays unmatched. */
  it("returns nothing when the header has no conversation in cst_app", async () => {
    const source = {
      query: async () => ({ rows: [{ ext_message_id: "1", message_id: "2" }] }),
    };
    const app = { query: async () => ({ rows: [] }) };
    expect((await resolveConversationsByExtMessageId(source, app, ["1"])).size).toBe(0);
  });

  it("issues no query for an empty page", async () => {
    let calls = 0;
    const client = { query: async () => { calls += 1; return { rows: [] }; } };
    await resolveConversationsByExtMessageId(client, client, []);
    expect(calls).toBe(0);
  });

  /** Batched: one query per hop, regardless of page size. */
  it("costs two queries for a whole page", async () => {
    let sourceCalls = 0;
    let appCalls = 0;
    const source = {
      query: async () => {
        sourceCalls += 1;
        return { rows: [{ ext_message_id: "1", message_id: "9" }] };
      },
    };
    const app = {
      query: async () => {
        appCalls += 1;
        return {
          rows: [
            {
              external_message_id: "9",
              conversation_message_id: 11,
              conversation_id: 3,
              direction: "outbound",
            },
          ],
        };
      },
    };
    await resolveConversationsByExtMessageId(source, app, Array.from({ length: 500 }, (_, i) => String(i)));
    expect([sourceCalls, appCalls]).toEqual([1, 1]);
  });
});

describe("the upsert statement", () => {
  it("conflicts on the unique index 0017 created", () => {
    expect(UPSERT_AGENT_ACTIVITY_SQL).toMatch(
      /ON CONFLICT \(source_database, source_table, source_pk\) DO UPDATE/,
    );
  });

  /** `ingested_at` records when CST first saw the action; a re-run must not rewrite it. */
  it("never rewrites ingested_at", () => {
    const doUpdate = UPSERT_AGENT_ACTIVITY_SQL.slice(
      UPSERT_AGENT_ACTIVITY_SQL.indexOf("DO UPDATE"),
    );
    expect(doUpdate).not.toMatch(/ingested_at/);
    // ...but a late-arriving conversation must be able to land.
    expect(doUpdate).toMatch(/conversation_id\s*=\s*EXCLUDED\.conversation_id/);
    expect(doUpdate).toMatch(/match_status\s*=\s*EXCLUDED\.match_status/);
  });

  it("binds every value through unnest and interpolates none", () => {
    expect(UPSERT_AGENT_ACTIVITY_SQL).toMatch(/unnest\(\s*\$1::text\[\]/);
    expect(UPSERT_AGENT_ACTIVITY_SQL).toMatch(/\$11::text\[\]/);
    expect(UPSERT_AGENT_ACTIVITY_SQL).not.toMatch(/\$\{/);
  });

  it("writes only agent_activity", () => {
    expect(UPSERT_AGENT_ACTIVITY_SQL).toContain("cst_app.agent_activity");
    for (const t of ["app_users", "agent_directory", "conversation_messages", "conversations"]) {
      expect(UPSERT_AGENT_ACTIVITY_SQL).not.toMatch(new RegExp(`INSERT INTO cst_app\\.${t}`));
    }
  });

  it("contains no DELETE", () => {
    expect(UPSERT_AGENT_ACTIVITY_SQL).not.toMatch(/\bDELETE\b/i);
    expect(UPSERT_AGENT_ACTIVITY_SQL).not.toMatch(/\bTRUNCATE\b/i);
  });
});

describe("toColumnArrays", () => {
  it("produces eleven parallel arrays in statement order", () => {
    const arrays = toColumnArrays([record(), record({ sourcePk: "2", conversationId: null, matchStatus: "unmatched" })]);
    expect(arrays).toHaveLength(11);
    expect(arrays.every((a) => a.length === 2)).toBe(true);
    expect(arrays[2]).toEqual(["40544", "2"]);
    expect(arrays[8]).toEqual([1417, null]);
    expect(arrays[10]).toEqual(["matched", "unmatched"]);
  });

  it("keeps nulls as nulls for the nullable columns", () => {
    const arrays = toColumnArrays([
      record({ sourceUserId: null, subSourceId: null, conversationId: null, externalMessageId: null, matchStatus: "no_reference", marketplace: null }),
    ]);
    expect([arrays[3][0], arrays[6][0], arrays[7][0], arrays[8][0], arrays[9][0]]).toEqual([
      null, null, null, null, null,
    ]);
  });
});

describe("upsertAgentActivity", () => {
  it("sends one statement for a whole batch", async () => {
    const tx = stubTx([true, true, true]);
    await upsertAgentActivity(tx, [record({ sourcePk: "1" }), record({ sourcePk: "2" }), record({ sourcePk: "3" })]);
    expect(tx.calls).toHaveLength(1);
  });

  it("reports inserts and updates separately", async () => {
    const tx = stubTx([true, false, false]);
    expect(await upsertAgentActivity(tx, [record({ sourcePk: "1" }), record({ sourcePk: "2" }), record({ sourcePk: "3" })]))
      .toEqual({ inserted: 1, updated: 2 });
  });

  /** A second run must update, never duplicate. */
  it("reports a re-run as all updates", async () => {
    const tx = stubTx([false, false]);
    expect(await upsertAgentActivity(tx, [record({ sourcePk: "1" }), record({ sourcePk: "2" })]))
      .toEqual({ inserted: 0, updated: 2 });
  });

  it("does nothing and issues no query when given nothing", async () => {
    const tx = stubTx([]);
    expect(await upsertAgentActivity(tx, [])).toEqual({ inserted: 0, updated: 0 });
    expect(tx.calls).toHaveLength(0);
  });

  /** End to end through the domain, so the writer never sees an illegal pair. */
  it("carries a no_reference row through with both fields null", async () => {
    const { record: mapped } = mapActivityRow(
      { sourcePk: "7", sourceUserId: 20, action: "move_to_resolved", actionDate: "2026-07-01", sourceId: 2, subSourceId: 1, extMessageId: null },
      null,
      new Set([20]),
    );
    const tx = stubTx([true]);
    await upsertAgentActivity(tx, [mapped]);
    const values = tx.calls[0].values as unknown[][];
    expect(values[8][0]).toBeNull();  // conversation_id
    expect(values[9][0]).toBeNull();  // external_message_id
    expect(values[10][0]).toBe("no_reference");
  });
});
