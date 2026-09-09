import { describe, expect, it } from "vitest";

import type { SourceMessage } from "@/lib/domain/source-message";
import { classifyRows as classifyEbayRows } from "@/lib/marketplaces/ebay/message-repository";
import {
  type BodyRepairOptions,
  type Queryable,
  type RepairCandidate,
  REPAIR_READERS,
  REPAIR_SKIP_REASONS,
  SELECT_REPAIR_CANDIDATES,
  decideRepair,
  runBodyRepair,
  sameSourceTimestamp,
  selectRepairCandidates,
  sourceKeyOf,
} from "@/lib/sync/body-repair";
import { repairMessageBodies } from "@/lib/sync/conversation-writer";

/**
 * Body repair.
 *
 * The failure being fixed is real and was measured on 2026-09-08: eBay stores a
 * message header before its text, so 791 eBay messages sat in cst_app with
 * `body_decode_status = 'empty'`, and 74 of those had text waiting in the source
 * that the forward-only sync could never go back for.
 *
 * The fixtures below use eBay's real two-table shape — a header row plus a
 * body row that may or may not exist yet — because that shape IS the bug.
 */

const HEADER_TABLE = "ebay_message_headers";

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    marketplace: "ebay",
    conversationId: "40017",
    sourceDatabase: "ledsone",
    sourceSchema: "customer_service",
    sourceTable: HEADER_TABLE,
    sourcePk: "104212",
    direction: "inbound",
    sourceTimestamp: "2026-09-08 05:52:46",
    bodyDecodeStatus: "empty",
    ...overrides,
  };
}

/** A raw eBay header+body row, exactly as the repository projects it. */
function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "104212",
    ext_message_id: "6437034730019",
    message_id: "211700443863",
    sub_source: 2,
    item_id: "335468941361",
    folder_id: 0,
    message_type: "AskSellerQuestion",
    sender_id: "buyer-handle",
    receiver_id: "cst-store",
    receive_date: "2026-09-08 05:52:46",
    /** JSON-encoded, as eBay stores it. `null` here is "the body row is absent". */
    body_raw: JSON.stringify("Can I change the size before this ships?"),
    ...overrides,
  };
}

function freshFrom(overrides: Record<string, unknown> = {}): SourceMessage {
  const { messages } = classifyEbayRows([sourceRow(overrides)] as never);
  const message = messages[0];
  if (message === undefined) throw new Error("fixture did not normalize");
  return message;
}

/**
 * An app + source pair that records every statement.
 *
 * `stored` is the pretend `conversation_messages` table: the repair writes into
 * it through the real upsert values, so a test can assert on what a second run
 * would then see.
 */
function harness(options: {
  candidates?: RepairCandidate[];
  rows?: Record<string, unknown>[];
} = {}) {
  const appCalls: { text: string; values?: unknown[] }[] = [];
  const sourceCalls: { text: string; values?: unknown[] }[] = [];
  const written: { conversationId: string; pk: string; body: unknown; status: unknown }[] = [];
  const candidates = options.candidates ?? [candidate()];
  const rows = options.rows ?? [sourceRow()];

  const app: Queryable = {
    query: async (config) => {
      appCalls.push(config);
      if (config.text === SELECT_REPAIR_CANDIDATES) {
        const allowed = new Set(config.values![0] as string[]);
        return {
          rows: candidates
            .filter((c) => allowed.has(c.marketplace))
            .slice(0, config.values![1] as number)
            .map((c) => ({
              marketplace: c.marketplace,
              conversation_id: c.conversationId,
              source_database: c.sourceDatabase,
              source_schema: c.sourceSchema,
              source_table: c.sourceTable,
              source_pk: c.sourcePk,
              direction: c.direction,
              source_ts: c.sourceTimestamp,
              body_decode_status: c.bodyDecodeStatus,
            })),
        };
      }
      if (/INSERT INTO cst_app\.conversation_messages/.test(config.text)) {
        const conversationIds = config.values![0] as string[];
        const pks = config.values![4] as string[];
        const bodies = config.values![8] as unknown[];
        const statuses = config.values![9] as unknown[];
        for (const [i, pk] of pks.entries()) {
          written.push({
            conversationId: conversationIds[i]!,
            pk,
            body: bodies[i],
            status: statuses[i],
          });
        }
        return { rows: pks.map(() => ({ inserted: false })) };
      }
      return { rows: [] };
    },
  };

  const source: Queryable = {
    query: async (config) => {
      sourceCalls.push(config);
      const wanted = new Set((config.values![0] as string[]).map(String));
      return { rows: rows.filter((row) => wanted.has(String(row.id))) };
    },
  };

  const begin = async (work: (tx: Queryable) => Promise<void>) => {
    await work(app);
  };

  return { app, source, begin, appCalls, sourceCalls, written };
}

function run(h: ReturnType<typeof harness>, options: BodyRepairOptions = {}) {
  return runBodyRepair(h.app, h.source, { marketplaces: ["ebay"], ...options }, h.begin);
}

describe("the failure this repairs: a body that arrives after its header", () => {
  it("repairs a message stored empty whose body has since landed", async () => {
    const h = harness();
    const outcome = await run(h);

    expect(outcome.examined).toBe(1);
    expect(outcome.repaired).toBe(1);
    expect(outcome.skipped).toBe(0);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.status).toBe("decoded");
    expect(h.written[0]!.body).toBe("Can I change the size before this ships?");
  });

  it("leaves the message alone while the body row is still absent", async () => {
    const h = harness({ rows: [sourceRow({ body_raw: null })] });
    const outcome = await run(h);

    expect(outcome.repaired).toBe(0);
    expect(outcome.skippedByReason.still_empty_at_source).toBe(1);
    expect(h.written).toHaveLength(0);
  });

  it("repairs the same message once the body row appears on a later run", async () => {
    const before = harness({ rows: [sourceRow({ body_raw: null })] });
    expect((await run(before)).repaired).toBe(0);

    const after = harness();
    expect((await run(after)).repaired).toBe(1);
    expect(after.written[0]!.body).toBe("Can I change the size before this ships?");
  });

  it("treats a body row holding JSON null as genuinely empty, not as a failure", async () => {
    const h = harness({ rows: [sourceRow({ body_raw: "null" })] });
    const outcome = await run(h);

    expect(outcome.skippedByReason.still_empty_at_source).toBe(1);
    expect(outcome.skippedByReason.still_failed_at_source).toBeUndefined();
  });

  it("does not write a body it could not decode", async () => {
    const h = harness({ rows: [sourceRow({ body_raw: "{not json" })] });
    const outcome = await run(h);

    expect(outcome.repaired).toBe(0);
    expect(outcome.skippedByReason.still_failed_at_source).toBe(1);
    expect(h.written).toHaveLength(0);
  });

  it("does not swap one blank for another when the body decodes to whitespace", async () => {
    const h = harness({ rows: [sourceRow({ body_raw: JSON.stringify("   \n  ") })] });
    const outcome = await run(h);

    expect(outcome.repaired).toBe(0);
    expect(outcome.skippedByReason.decoded_to_blank).toBe(1);
  });
});

describe("repair updates the existing message", () => {
  it("writes back the conversation id the message already had", async () => {
    const h = harness({ candidates: [candidate({ conversationId: "98765" })] });
    await run(h);

    // The one identity column the upsert may change is written with the value it
    // already holds, so thread grouping cannot move.
    expect(h.written[0]!.conversationId).toBe("98765");
  });

  it("updates rather than inserts", async () => {
    const h = harness();
    const outcome = await run(h);

    expect(outcome.unexpectedInserts).toBe(0);
  });

  it("reports a row that had to be inserted instead of hiding it", async () => {
    const stats = await repairMessageBodies(
      { query: async () => ({ rows: [{ inserted: true }, { inserted: false }] }) },
      [
        { conversationId: "1", message: freshFrom() },
        { conversationId: "2", message: freshFrom({ id: "2" }) },
      ],
    );

    expect(stats.inserted).toBe(1);
    expect(stats.updated).toBe(1);
  });

  it("runs the same upsert statement the sync runs", async () => {
    const h = harness();
    await run(h);

    const insert = h.appCalls.find((c) =>
      /INSERT INTO cst_app\.conversation_messages/.test(c.text),
    );
    expect(insert).toBeDefined();
    // Only these three columns are updatable, so direction, source_ts and
    // external_message_id cannot be rewritten by a repair.
    expect(insert!.text).toContain("ON CONFLICT (source_database, source_schema, source_table, source_pk) DO UPDATE SET");
    expect(insert!.text).toContain("body_text          = EXCLUDED.body_text");
    expect(insert!.text).toContain("body_decode_status = EXCLUDED.body_decode_status");
    expect(insert!.text).not.toMatch(/DO UPDATE SET[\s\S]*\bdirection\s*=/);
    expect(insert!.text).not.toMatch(/DO UPDATE SET[\s\S]*\bsource_ts\s*=/);
  });
});

describe("an already correct message is left alone", () => {
  it("selects only messages whose body is not decoded", () => {
    expect(SELECT_REPAIR_CANDIDATES).toContain("m.body_decode_status <> 'decoded'");
  });

  it("does nothing at all when nothing is blank", async () => {
    const h = harness({ candidates: [] });
    const outcome = await run(h);

    expect(outcome).toMatchObject({ examined: 0, repaired: 0, skipped: 0 });
    expect(h.sourceCalls).toHaveLength(0);
    expect(h.written).toHaveLength(0);
  });

  it("never reads the source for a marketplace with no candidates", async () => {
    const h = harness({ candidates: [candidate({ marketplace: "ebay" })] });
    await runBodyRepair(h.app, h.source, { marketplaces: ["ebay", "amazon", "temu"] }, h.begin);

    expect(h.sourceCalls).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("repairs once and finds nothing to do the second time", async () => {
    const first = harness();
    expect((await run(first)).repaired).toBe(1);

    // After the repair the row is `decoded`, so the candidate query no longer
    // returns it — which is what makes a second run free rather than merely safe.
    const second = harness({ candidates: [] });
    const outcome = await run(second);

    expect(outcome.repaired).toBe(0);
    expect(second.written).toHaveLength(0);
  });

  it("writes the same values when the same candidate is repaired twice", async () => {
    const first = harness();
    await run(first);
    const second = harness();
    await run(second);

    expect(second.written).toEqual(first.written);
  });

  it("cannot duplicate a conversation message", async () => {
    const h = harness();
    await run(h);
    await run(h);

    // Two passes, two upserts, one source row: the unique key is the source
    // coordinates, so the second is an update of the first.
    const keys = new Set(h.written.map((w) => `${w.conversationId} ${w.pk}`));
    expect(h.written).toHaveLength(2);
    expect(keys.size).toBe(1);
  });

  it("skips the same way every time when the source still cannot answer", async () => {
    const h = harness({ rows: [sourceRow({ body_raw: null })] });
    const a = await run(h);
    const b = await run(h);

    expect(b.skippedByReason).toEqual(a.skippedByReason);
    expect(h.written).toHaveLength(0);
  });
});

describe("no message may be duplicated, moved or restated", () => {
  it("writes to conversation_messages and to nothing else", async () => {
    const h = harness();
    await run(h);

    const writes = h.appCalls.filter((c) => /INSERT|UPDATE|DELETE/.test(c.text));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toContain("INSERT INTO cst_app.conversation_messages");
  });

  it("never touches sync_state", async () => {
    const h = harness();
    await run(h);

    for (const call of [...h.appCalls, ...h.sourceCalls]) {
      expect(call.text).not.toContain("sync_state");
      expect(call.text).not.toContain("watermark");
    }
  });

  it("never touches the conversations table except to read a marketplace", async () => {
    const h = harness();
    await run(h);

    for (const call of h.appCalls) {
      if (!call.text.includes("cst_app.conversations")) continue;
      expect(call.text.startsWith("\nSELECT")).toBe(true);
    }
  });

  it("issues only SELECTs against the source", async () => {
    const h = harness();
    await run(h);

    expect(h.sourceCalls.length).toBeGreaterThan(0);
    for (const call of h.sourceCalls) {
      expect(call.text.trimStart().startsWith("SELECT")).toBe(true);
      expect(call.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|COPY)\b/i);
    }
  });

  it("refuses to attach a body to a message whose side has changed", async () => {
    // folder_id 1 is outbound; the stored message is inbound.
    const h = harness({ rows: [sourceRow({ folder_id: 1 })] });
    const outcome = await run(h);

    expect(outcome.repaired).toBe(0);
    expect(outcome.skippedByReason.source_direction_changed).toBe(1);
    expect(h.written).toHaveLength(0);
  });

  it("refuses to attach a body to a message whose timestamp has moved", async () => {
    const h = harness({ rows: [sourceRow({ receive_date: "2026-09-08 06:00:00" })] });
    const outcome = await run(h);

    expect(outcome.repaired).toBe(0);
    expect(outcome.skippedByReason.source_timestamp_changed).toBe(1);
  });

  it("tolerates a cosmetic difference in fractional seconds", () => {
    expect(sameSourceTimestamp("2026-09-08 05:52:46", "2026-09-08 05:52:46.000")).toBe(true);
    expect(sameSourceTimestamp("2026-09-08 05:52:46.120", "2026-09-08 05:52:46.12")).toBe(true);
    expect(sameSourceTimestamp("2026-09-08 05:52:46", "2026-09-08 05:52:47")).toBe(false);
  });
});

describe("dry run", () => {
  it("reports what it would repair and writes nothing", async () => {
    const h = harness();
    const outcome = await run(h, { dryRun: true });

    expect(outcome.repaired).toBe(1);
    expect(h.written).toHaveLength(0);
    expect(h.appCalls.every((c) => !/INSERT/.test(c.text))).toBe(true);
  });

  it("needs no transaction runner", async () => {
    const h = harness();
    await expect(
      runBodyRepair(h.app, h.source, { marketplaces: ["ebay"], dryRun: true }),
    ).resolves.toMatchObject({ repaired: 1 });
  });

  it("refuses to apply without one", async () => {
    const h = harness();
    await expect(
      runBodyRepair(h.app, h.source, { marketplaces: ["ebay"] }),
    ).rejects.toThrow(/transaction runner/);
  });
});

describe("reporting", () => {
  it("counts repaired, skipped and the reason for every skip", async () => {
    const h = harness({
      candidates: [
        candidate({ sourcePk: "1" }),
        candidate({ sourcePk: "2" }),
        candidate({ sourcePk: "3" }),
      ],
      rows: [
        sourceRow({ id: "1" }),
        sourceRow({ id: "2", body_raw: null }),
        sourceRow({ id: "3", body_raw: "{not json" }),
      ],
    });
    const outcome = await run(h);

    expect(outcome.examined).toBe(3);
    expect(outcome.repaired).toBe(1);
    expect(outcome.skipped).toBe(2);
    expect(outcome.skippedByReason).toEqual({
      still_empty_at_source: 1,
      still_failed_at_source: 1,
    });
  });

  it("accounts for every candidate exactly once", async () => {
    const h = harness({
      candidates: Array.from({ length: 6 }, (_, i) => candidate({ sourcePk: String(i + 1) })),
      rows: [
        sourceRow({ id: "1" }),
        sourceRow({ id: "2", body_raw: null }),
        sourceRow({ id: "3", body_raw: "{not json" }),
        sourceRow({ id: "4", folder_id: 1 }),
        sourceRow({ id: "5", body_raw: JSON.stringify(" ") }),
        // 6 has no source row at all.
      ],
    });
    const outcome = await run(h);

    expect(outcome.repaired + outcome.skipped).toBe(outcome.examined);
    expect(outcome.examined).toBe(6);
    expect(outcome.skippedByReason.source_row_missing).toBe(1);
  });

  it("names an unusable row separately from a missing one", async () => {
    // The row comes back but has no counterparty, so it cannot be normalized.
    const h = harness({
      rows: [sourceRow({ sender_id: null, receiver_id: null })],
    });
    const outcome = await run(h);

    expect(outcome.skippedByReason.source_row_unusable).toBe(1);
    expect(outcome.skippedByReason.source_row_missing).toBeUndefined();
  });

  it("summarises per marketplace", async () => {
    const h = harness({
      candidates: [candidate({ sourcePk: "1" }), candidate({ sourcePk: "2" })],
      rows: [sourceRow({ id: "1" }), sourceRow({ id: "2", body_raw: null })],
    });
    const outcome = await run(h);

    expect(outcome.byMarketplace).toEqual([
      { marketplace: "ebay", examined: 2, repaired: 1, skipped: 1 },
    ]);
  });

  it("says when the limit stopped it short", async () => {
    const h = harness({
      candidates: [candidate({ sourcePk: "1" }), candidate({ sourcePk: "2" })],
      rows: [sourceRow({ id: "1" }), sourceRow({ id: "2" })],
    });

    expect((await run(h, { limit: 2 })).moreAvailable).toBe(true);
    expect((await run(h, { limit: 5 })).moreAvailable).toBe(false);
  });

  it("declares every skip reason it can report", async () => {
    const h = harness({
      candidates: Array.from({ length: 5 }, (_, i) => candidate({ sourcePk: String(i + 1) })),
      rows: [
        sourceRow({ id: "1", body_raw: null }),
        sourceRow({ id: "2", body_raw: "{" }),
        sourceRow({ id: "3", body_raw: JSON.stringify("  ") }),
        sourceRow({ id: "4", folder_id: 1 }),
        sourceRow({ id: "5", receive_date: "2020-01-01 00:00:00" }),
      ],
    });
    const outcome = await run(h);

    for (const reason of Object.keys(outcome.skippedByReason)) {
      expect(REPAIR_SKIP_REASONS).toContain(reason);
    }
  });
});

describe("batching", () => {
  it("reads the source in batches and repairs each before the next", async () => {
    const h = harness({
      candidates: Array.from({ length: 5 }, (_, i) => candidate({ sourcePk: String(i + 1) })),
      rows: Array.from({ length: 5 }, (_, i) => sourceRow({ id: String(i + 1) })),
    });
    const outcome = await run(h, { batchSize: 2 });

    expect(h.sourceCalls).toHaveLength(3);
    expect(outcome.repaired).toBe(5);
    expect(h.written).toHaveLength(5);
  });

  it("asks the source only for the keys it is missing", async () => {
    const h = harness({
      candidates: [candidate({ sourcePk: "7" }), candidate({ sourcePk: "9" })],
      rows: [sourceRow({ id: "7" }), sourceRow({ id: "9" })],
    });
    await run(h);

    expect(h.sourceCalls[0]!.values).toEqual([["7", "9"]]);
  });

  it("rejects a source pk that is not a bigint", async () => {
    const h = harness({ candidates: [candidate({ sourcePk: "104212; DROP TABLE" })] });
    await expect(run(h)).rejects.toThrow(/not a bigint/);
  });
});

describe("candidate selection", () => {
  it("is bounded, newest first, and scoped to the requested marketplaces", async () => {
    expect(SELECT_REPAIR_CANDIDATES).toContain("c.marketplace = ANY($1::text[])");
    expect(SELECT_REPAIR_CANDIDATES).toContain("ORDER BY m.source_ts DESC, m.id DESC");
    expect(SELECT_REPAIR_CANDIDATES).toContain("LIMIT $2");
  });

  it("reads no draft, category, notification or order table", () => {
    for (const forbidden of [
      "draft_replies",
      "context_snapshots",
      "ai_usage_log",
      "orders",
      "sync_state",
    ]) {
      expect(SELECT_REPAIR_CANDIDATES).not.toContain(forbidden);
    }
  });

  it("returns nothing for an empty marketplace list without querying", async () => {
    const h = harness();
    await expect(selectRepairCandidates(h.app, { marketplaces: [] })).resolves.toEqual([]);
    expect(h.appCalls).toHaveLength(0);
  });

  it("rejects a nonsense limit", async () => {
    const h = harness();
    await expect(selectRepairCandidates(h.app, { marketplaces: ["ebay"], limit: 0 })).rejects.toThrow(
      /positive integer/,
    );
  });
});

describe("wiring", () => {
  it("has a reader for every marketplace", () => {
    expect(Object.keys(REPAIR_READERS).sort()).toEqual(
      ["amazon", "bandq", "ebay", "shopify", "temu"].sort(),
    );
  });

  it("keys a source row by its full source coordinates, not by pk alone", () => {
    const key = sourceKeyOf(candidate());
    expect(key).toContain("ledsone");
    expect(key).toContain("customer_service");
    expect(key).toContain(HEADER_TABLE);
    expect(key).toContain("104212");
    expect(sourceKeyOf(candidate({ sourceTable: "other" }))).not.toBe(key);
  });
});

describe("decideRepair is pure and total", () => {
  it("repairs only a decoded, non-blank body from an unchanged row", () => {
    const decision = decideRepair(candidate(), freshFrom());
    expect(decision.repair).toBe(true);
  });

  it("returns a named reason for every refusal", () => {
    const cases: [SourceMessage | undefined, string][] = [
      [undefined, "source_row_missing"],
      [freshFrom({ folder_id: 1 }), "source_direction_changed"],
      [freshFrom({ receive_date: "2001-01-01 00:00:00" }), "source_timestamp_changed"],
      [freshFrom({ body_raw: null }), "still_empty_at_source"],
      [freshFrom({ body_raw: "{" }), "still_failed_at_source"],
      [freshFrom({ body_raw: JSON.stringify("\t") }), "decoded_to_blank"],
    ];

    for (const [fresh, expected] of cases) {
      const decision = decideRepair(candidate(), fresh);
      expect(decision.repair).toBe(false);
      expect(decision.repair === false && decision.reason).toBe(expected);
    }
  });

  it("checks identity before content, so an edited row is never repaired", () => {
    // Direction changed AND the body is now available: identity must win.
    const decision = decideRepair(candidate(), freshFrom({ folder_id: 1 }));
    expect(decision.repair === false && decision.reason).toBe("source_direction_changed");
  });
});
