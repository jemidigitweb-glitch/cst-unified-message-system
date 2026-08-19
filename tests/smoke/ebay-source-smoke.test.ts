import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { EbaySourceRow } from "@/lib/marketplaces/ebay/adapter";
import { buildFetchQuery, classifyRows } from "@/lib/marketplaces/ebay/message-repository";
import { buildConversations } from "@/lib/marketplaces/ebay/thread-builder";
import { compareSourceOrder } from "@/lib/domain/source-message";

/**
 * Bounded live-source smoke validation.
 *
 * Opt-in only. It never runs in the normal suite and never opens a connection
 * itself: it replays a MASKED extract of real source rows through the real
 * repository and thread-builder code.
 *
 * Masking preserves grouping semantics exactly - counterparty handles are
 * replaced by a stable hash, so identical handles stay identical and different
 * ones stay different - while message bodies are replaced with a shape-preserving
 * placeholder, since no grouping decision depends on body text. No customer
 * handle or message content is ever loaded here.
 *
 *   CST_SMOKE_PRINT_SQL=1      emit the query the repository generates
 *   CST_SMOKE_SQL_OUT=path     write that query to a file
 *   CST_SMOKE_FIXTURE=path     run the pipeline over a masked row extract
 *   CST_SMOKE_REPORT_OUT=path  write collected metrics to a file
 */

describe.runIf(process.env.CST_SMOKE_PRINT_SQL)("generated source query", () => {
  it("emits the query the repository would send", () => {
    const first = buildFetchQuery({
      window: { mode: "bootstrap", startAt: "2026-07-01 00:00:00" },
      limit: 300,
    });
    const incremental = buildFetchQuery({
      window: {
        mode: "after",
        watermark: { sourceTimestamp: "2026-08-01 00:00:00", sourcePk: "1" },
      },
      limit: 300,
    });
    const text =
      `--- BOOTSTRAP READ ---\n${first.text}\n\n` +
      `--- INCREMENTAL READ ---\n${incremental.text}\n\n` +
      `--- INCREMENTAL PARAM COUNT ---\n${incremental.values.length}\n`;
    const out = process.env.CST_SMOKE_SQL_OUT;
    if (out) writeFileSync(out, text, "utf8");
    else console.log(text);
    expect(first.text.length).toBeGreaterThan(0);
  });
});

/**
 * Collects a named result. Written to a file when CST_SMOKE_REPORT_OUT is set,
 * because the test reporter intercepts console output.
 */
const collected: Record<string, unknown> = {};
function report(name: string, value: unknown): void {
  collected[name] = value;
  const out = process.env.CST_SMOKE_REPORT_OUT;
  if (out) writeFileSync(out, JSON.stringify(collected, null, 2), "utf8");
  else console.log(`\n--- ${name} ---\n${JSON.stringify(value, null, 2)}`);
}

describe.runIf(process.env.CST_SMOKE_FIXTURE)("live source pipeline", () => {
  // Loaded lazily: a describe body is evaluated at collection time even when the
  // suite is skipped, so an eager read would break every normal run.
  let cache: {
    rows: EbaySourceRow[];
    classified: ReturnType<typeof classifyRows>;
    built: ReturnType<typeof buildConversations>;
  } | null = null;

  function load() {
    if (cache === null) {
      const rows = JSON.parse(
        readFileSync(process.env.CST_SMOKE_FIXTURE as string, "utf8"),
      ) as EbaySourceRow[];
      const classified = classifyRows(rows);
      cache = { rows, classified, built: buildConversations(classified.messages) };
    }
    return cache;
  }

  it("reports bounded sample metrics", () => {
    const { classified, built } = load();
    const noItemThreads = built.conversations.filter((c) => c.threadingStrategy === "no_item");
    const timestamps = [...classified.messages.map((m) => m.sourceTimestamp)].sort();

    report("metrics", {
      rowsExamined: classified.rowsExamined,
      systemNoticesExcluded: classified.systemNoticeCount,
      unusableExcluded: classified.unusableCount,
      normalizedMessages: classified.messages.length,
      inbound: classified.messages.filter((m) => m.direction === "inbound").length,
      outbound: classified.messages.filter((m) => m.direction === "outbound").length,
      itemLinkedMessages: classified.messages.filter((m) => m.listingItemRef !== null).length,
      noItemMessages: classified.messages.filter((m) => m.listingItemRef === null).length,
      itemLinkedThreads: built.conversations.filter((c) => c.threadingStrategy === "item_linked")
        .length,
      noItemReplyInboxThreads: noItemThreads.filter((c) => c.inboxPlacement === "reply_inbox")
        .length,
      noItemOutboundOnlyGroups: noItemThreads.filter((c) => c.inboxPlacement === "outbound_only")
        .length,
      needsContextThreads: built.conversations.filter((c) => c.needsContext).length,
      decodedBodies: classified.messages.filter((m) => m.bodyDecodeStatus === "decoded").length,
      emptyBodies: classified.messages.filter((m) => m.bodyDecodeStatus === "empty").length,
      failedBodies: classified.messages.filter((m) => m.bodyDecodeStatus === "failed").length,
      oldestSourceTimestamp: timestamps[0] ?? null,
      newestSourceTimestamp: timestamps.at(-1) ?? null,
      maxThreadSize: Math.max(0, ...built.conversations.map((c) => c.messageCount)),
    });
    expect(classified.rowsExamined).toBeGreaterThan(0);
  });

  it("produces no duplicate source PK", () => {
    const { classified } = load();
    const pks = classified.messages.map((m) => m.sourcePk);
    const duplicates = pks.length - new Set(pks).size;
    report("duplicateSourcePkCount", duplicates);
    expect(duplicates).toBe(0);
  });

  it("assigns every message to exactly one conversation", () => {
    const { classified, built } = load();
    const assigned = built.conversations.flatMap((c) => c.messages.map((m) => m.sourcePk));
    expect(assigned.length).toBe(classified.messages.length);
    expect(new Set(assigned).size).toBe(classified.messages.length);
  });

  it("orders every conversation by source timestamp then source PK", () => {
    const { built } = load();
    for (const conversation of built.conversations) {
      const ordered = [...conversation.messages].sort(compareSourceOrder);
      expect(conversation.messages.map((m) => m.sourcePk)).toEqual(ordered.map((m) => m.sourcePk));
    }
  });

  it("preserves source timestamps verbatim, applying no timezone", () => {
    const { rows, classified } = load();
    for (const message of classified.messages) {
      const original = rows.find((r) => r.id === message.sourcePk)!.receive_date;
      expect(message.sourceTimestamp).toBe(original);
    }
  });

  it("is deterministic across re-runs and input order", () => {
    const { classified, built } = load();
    const again = buildConversations([...classified.messages].reverse());
    const forward = JSON.stringify(built);
    report("determinism", {
      deterministicRerun: JSON.stringify(again) === forward,
      conversations: built.conversations.length,
      payloadBytes: forward.length,
    });
    expect(JSON.stringify(again)).toBe(forward);
  });

  it("keeps every no-item conversation flagged as needing context", () => {
    const { built } = load();
    for (const conversation of built.conversations) {
      if (conversation.threadingStrategy === "no_item") {
        expect(conversation.needsContext).toBe(true);
      }
    }
  });

  it("places no outbound-only group in the reply inbox", () => {
    const { built } = load();
    for (const conversation of built.conversations) {
      if (conversation.inboundCount === 0) {
        expect(conversation.inboxPlacement).toBe("outbound_only");
      }
    }
  });
});
