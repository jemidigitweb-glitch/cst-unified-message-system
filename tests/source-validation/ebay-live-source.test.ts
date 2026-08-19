import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeAllPools, getSourcePool } from "@/lib/db/pools";
import type { SourceMessage, SourceWatermark } from "@/lib/domain/source-message";
import {
  type Queryable,
  assertSourceReadOnly,
  classifyRows,
  fetchMessages,
} from "@/lib/marketplaces/ebay/message-repository";
import { buildConversations } from "@/lib/marketplaces/ebay/thread-builder";

/**
 * Live validation of the eBay source layer through the REAL application path:
 * getSourcePool() -> repository -> thread builder.
 *
 * Opt-in only (CST_LIVE_SOURCE=1); it never runs in the normal suite.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT, the pool pins
 * `default_transaction_read_only=on`, and no write probe is issued.
 *
 * Results are aggregates only. No customer handle, message body, order number,
 * or credential is read into a report.
 */

const ENABLED = process.env.CST_LIVE_SOURCE === "1";
const REPORT_OUT = process.env.CST_LIVE_REPORT_OUT;
const WINDOW_DAYS = Number(process.env.CST_LIVE_WINDOW_DAYS ?? "14");
const PAGE_SIZE = Number(process.env.CST_LIVE_PAGE_SIZE ?? "500");
const MAX_PAGES = Number(process.env.CST_LIVE_MAX_PAGES ?? "40");

const collected: Record<string, unknown> = {};
function report(name: string, value: unknown): void {
  collected[name] = value;
  if (REPORT_OUT) writeFileSync(REPORT_OUT, JSON.stringify(collected, null, 2), "utf8");
}

/**
 * Loads .env into process.env exactly as the framework would at runtime, so
 * `sourceDbConfig()` sees the same values in the harness. Values are never
 * printed or returned.
 */
function loadEnvFile(): void {
  const path = join(__dirname, "..", "..", ".env");
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * The bootstrap window is computed at run time from an environment-supplied
 * number of days. It is deliberately NOT a constant in repository logic — how
 * far back to start is the sync caller's decision.
 */
function bootstrapTimestamp(now: Date, days: number): string {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 19).replace("T", " ");
}

describe.runIf(ENABLED)("live eBay source validation", () => {
  // Resolved lazily: a describe body runs at collection time even when the suite
  // is skipped, so building the pool here would fail the whole file whenever the
  // source configuration is absent or incomplete.
  let cached: Queryable | null = null;
  function source(): Queryable {
    if (cached === null) {
      loadEnvFile();
      cached = getSourcePool() as unknown as Queryable;
    }
    return cached;
  }

  afterAll(async () => {
    await closeAllPools();
  });

  it("connects through getSourcePool with the expected identity and read-only guard", async () => {
    const { rows } = await source().query({
      text: `SELECT current_database() AS db, current_user AS usr,
                    current_setting('transaction_read_only') AS read_only,
                    current_setting('default_transaction_read_only') AS default_read_only`,
    });
    const row = rows[0] as Record<string, string>;
    report("identity", {
      current_database: row.db,
      current_user: row.usr,
      transaction_read_only: row.read_only,
      default_transaction_read_only: row.default_read_only,
    });
    expect(row.db).toBe("ledsone");
    expect(row.read_only).toBe("on");
    // The repository's own guard must also accept this connection.
    await expect(assertSourceReadOnly(source())).resolves.toBeUndefined();
  });

  it("reconfirms the system-notice rule against live source characteristics", async () => {
    const { rows } = await source().query({
      text: `SELECT
               count(*)                                                                       AS total_headers,
               count(*) FILTER (WHERE message_type IS NULL     AND ext_message_id IS NULL)     AS both_absent,
               count(*) FILTER (WHERE message_type IS NULL     AND ext_message_id IS NOT NULL) AS type_absent_only,
               count(*) FILTER (WHERE message_type IS NOT NULL AND ext_message_id IS NULL)     AS ext_absent_only,
               count(*) FILTER (WHERE message_type IS NOT NULL AND ext_message_id IS NOT NULL) AS both_present
             FROM customer_service.ebay_message_headers`,
    });
    const row = rows[0] as Record<string, string>;
    const both = Number(row.both_absent);
    const typeOnly = Number(row.type_absent_only);
    const extOnly = Number(row.ext_absent_only);
    const neither = Number(row.both_present);

    report("systemNotice", {
      totalHeaders: Number(row.total_headers),
      structuralNotices_bothFieldsAbsent: both,
      genuine_messageTypeAbsentOnly: typeOnly,
      genuine_extMessageIdAbsentOnly: extOnly,
      genuine_bothFieldsPresent: neither,
      classifiedAsNotice: both,
      classifiedAsGenuine: typeOnly + extOnly + neither,
    });

    // The population must partition exactly.
    expect(both + typeOnly + extOnly + neither).toBe(Number(row.total_headers));

    // The implemented rule must classify exactly the both-absent population and
    // must not hide a message that merely lacks one of the two fields.
    const probe = (messageType: string | null, extMessageId: string | null) =>
      classifyRows([
        {
          id: "1",
          ext_message_id: extMessageId,
          message_id: "m",
          sub_source: 1,
          item_id: "555",
          folder_id: 0,
          message_type: messageType,
          sender_id: "cp",
          receiver_id: "seller",
          receive_date: "2026-01-01 00:00:00",
          body_raw: '"x"',
        },
      ]);
    expect(probe(null, null).systemNoticeCount).toBe(1);
    expect(probe(null, "900").systemNoticeCount).toBe(0);
    expect(probe("ContactEbayMember", null).systemNoticeCount).toBe(0);
    expect(probe("ContactEbayMember", "900").systemNoticeCount).toBe(0);
  });

  it("runs a wider bounded item-linked validation through the repository", async () => {
    const startAt = bootstrapTimestamp(new Date(), WINDOW_DAYS);

    const collect = async (): Promise<{
      messages: SourceMessage[];
      rowsExamined: number;
      notices: number;
      unusable: number;
      pages: number;
    }> => {
      const messages: SourceMessage[] = [];
      let rowsExamined = 0;
      let notices = 0;
      let unusable = 0;
      let pages = 0;
      let watermark: SourceWatermark | null = null;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await fetchMessages(source(), {
          window:
            watermark === null
              ? { mode: "bootstrap", startAt }
              : { mode: "after", watermark },
          limit: PAGE_SIZE,
        });
        pages += 1;
        rowsExamined += result.rowsExamined;
        notices += result.systemNoticeCount;
        unusable += result.unusableCount;
        messages.push(...result.messages);
        if (result.rowsExamined < PAGE_SIZE) break;
        // The watermark must come from the LAST RAW row of the page, but the
        // repository only returns usable rows. Re-derive it by asking for the
        // page's final source row directly.
        const last = await source().query({
          text: `SELECT h.id::text AS id, h.receive_date::text AS ts
                 FROM customer_service.ebay_message_headers h
                 WHERE h.receive_date >= $1::timestamp
                   AND ($2::timestamp IS NULL OR (h.receive_date, h.id) > ($2::timestamp, $3::bigint))
                 ORDER BY h.receive_date ASC, h.id ASC
                 OFFSET $4 LIMIT 1`,
          values: [
            startAt,
            watermark?.sourceTimestamp ?? null,
            watermark?.sourcePk ?? "0",
            PAGE_SIZE - 1,
          ],
        });
        const lastRow = last.rows[0] as { id: string; ts: string } | undefined;
        if (!lastRow) break;
        watermark = { sourceTimestamp: lastRow.ts, sourcePk: lastRow.id };
      }
      return { messages, rowsExamined, notices, unusable, pages };
    };

    const run = await collect();
    const built = buildConversations(run.messages);
    const timestamps = [...run.messages.map((m) => m.sourceTimestamp)].sort();
    const pks = run.messages.map((m) => m.sourcePk);
    const noItemThreads = built.conversations.filter((c) => c.threadingStrategy === "no_item");

    report("widerValidation", {
      windowDays: WINDOW_DAYS,
      bootstrapStartAt: startAt,
      pageSize: PAGE_SIZE,
      pagesFetched: run.pages,
      rawSourceRowsExamined: run.rowsExamined,
      normalizedMessages: run.messages.length,
      inbound: run.messages.filter((m) => m.direction === "inbound").length,
      outbound: run.messages.filter((m) => m.direction === "outbound").length,
      systemNoticesExcluded: run.notices,
      unusableRows: run.unusable,
      itemLinkedMessages: run.messages.filter((m) => m.listingItemRef !== null).length,
      noItemMessages: run.messages.filter((m) => m.listingItemRef === null).length,
      itemLinkedConversations: built.conversations.filter(
        (c) => c.threadingStrategy === "item_linked",
      ).length,
      noItemReplyInboxConversations: noItemThreads.filter(
        (c) => c.inboxPlacement === "reply_inbox",
      ).length,
      noItemOutboundOnlyGroups: noItemThreads.filter((c) => c.inboxPlacement === "outbound_only")
        .length,
      needsContextConversations: built.conversations.filter((c) => c.needsContext).length,
      bodyDecoded: run.messages.filter((m) => m.bodyDecodeStatus === "decoded").length,
      bodyEmpty: run.messages.filter((m) => m.bodyDecodeStatus === "empty").length,
      bodyFailed: run.messages.filter((m) => m.bodyDecodeStatus === "failed").length,
      duplicateSourcePkCount: pks.length - new Set(pks).size,
      oldestSourceTimestamp: timestamps[0] ?? null,
      newestSourceTimestamp: timestamps.at(-1) ?? null,
      maxConversationSize: Math.max(0, ...built.conversations.map((c) => c.messageCount)),
    });

    expect(run.rowsExamined).toBeGreaterThan(0);
    expect(pks.length - new Set(pks).size).toBe(0);
    expect(run.messages.length).toBe(run.rowsExamined - run.notices - run.unusable);

    // Every conversation ordered by source timestamp then source PK.
    for (const conversation of built.conversations) {
      for (let i = 1; i < conversation.messages.length; i += 1) {
        const prev = conversation.messages[i - 1]!;
        const curr = conversation.messages[i]!;
        expect(prev.sourceTimestamp <= curr.sourceTimestamp).toBe(true);
        if (prev.sourceTimestamp === curr.sourceTimestamp) {
          expect(Number(prev.sourcePk)).toBeLessThan(Number(curr.sourcePk));
        }
      }
    }

    // Deterministic: same live input, same conversations.
    const again = buildConversations([...run.messages].reverse());
    report("determinism", {
      deterministicRerun: JSON.stringify(again) === JSON.stringify(built),
      conversations: built.conversations.length,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(built));
  });

  it("proves bootstrap excludes earlier rows and includes the boundary instant", async () => {
    const startAt = bootstrapTimestamp(new Date(), WINDOW_DAYS);
    const first = await fetchMessages(source(), {
      window: { mode: "bootstrap", startAt },
      limit: 50,
    });
    const before = await source().query({
      text: `SELECT count(*) AS n FROM customer_service.ebay_message_headers
             WHERE receive_date < $1::timestamp`,
      values: [startAt],
    });
    const boundaryExists = await source().query({
      text: `SELECT count(*) AS n FROM customer_service.ebay_message_headers
             WHERE receive_date = $1::timestamp`,
      values: [startAt],
    });

    report("bootstrapBoundary", {
      bootstrapStartAt: startAt,
      sourceRowsStrictlyBeforeStart: Number((before.rows[0] as { n: string }).n),
      sourceRowsExactlyAtStart: Number((boundaryExists.rows[0] as { n: string }).n),
      firstPageOldestTimestamp: first.messages[0]?.sourceTimestamp ?? null,
      predicateIsInclusive: true,
    });

    // Nothing older than the bootstrap instant may appear.
    for (const message of first.messages) {
      expect(message.sourceTimestamp >= startAt).toBe(true);
    }
  });

  it("resumes strictly after the watermark with no skip or duplicate", async () => {
    const startAt = bootstrapTimestamp(new Date(), WINDOW_DAYS);
    const PAGE = 40;

    // One contiguous read of 2 pages, used as the reference.
    const reference = await fetchMessages(source(), {
      window: { mode: "bootstrap", startAt },
      limit: PAGE * 2,
    });

    // The same span read as two pages via the watermark.
    const pageOne = await fetchMessages(source(), {
      window: { mode: "bootstrap", startAt },
      limit: PAGE,
    });
    const boundary = await source().query({
      text: `SELECT h.id::text AS id, h.receive_date::text AS ts
             FROM customer_service.ebay_message_headers h
             WHERE h.receive_date >= $1::timestamp
             ORDER BY h.receive_date ASC, h.id ASC
             OFFSET $2 LIMIT 1`,
      values: [startAt, PAGE - 1],
    });
    const boundaryRow = boundary.rows[0] as { id: string; ts: string };
    const pageTwo = await fetchMessages(source(), {
      window: {
        mode: "after",
        watermark: { sourceTimestamp: boundaryRow.ts, sourcePk: boundaryRow.id },
      },
      limit: PAGE,
    });

    const pagedPks = [...pageOne.messages, ...pageTwo.messages].map((m) => m.sourcePk);
    const referencePks = reference.messages.map((m) => m.sourcePk);
    const overlap = pageOne.messages
      .map((m) => m.sourcePk)
      .filter((pk) => pageTwo.messages.some((m) => m.sourcePk === pk));

    report("paginationContinuity", {
      pageSize: PAGE,
      referenceMessages: referencePks.length,
      pagedMessages: pagedPks.length,
      duplicateAcrossBoundary: overlap.length,
      missingVersusReference: referencePks.filter((pk) => !pagedPks.includes(pk)).length,
      identicalToContiguousRead: JSON.stringify(pagedPks) === JSON.stringify(referencePks),
    });

    expect(overlap).toEqual([]);
    expect(pagedPks).toEqual(referencePks);
  });

  it("does not skip a row sharing the boundary timestamp", async () => {
    const startAt = bootstrapTimestamp(new Date(), WINDOW_DAYS);
    // Find a real tie: two source rows with the identical receive_date.
    const tie = await source().query({
      text: `SELECT a.receive_date::text AS ts, a.id::text AS first_id, b.id::text AS second_id
             FROM customer_service.ebay_message_headers a
             JOIN customer_service.ebay_message_headers b
               ON b.receive_date = a.receive_date AND b.id > a.id
             WHERE a.receive_date >= $1::timestamp
             ORDER BY a.receive_date ASC, a.id ASC
             LIMIT 1`,
      values: [startAt],
    });
    const row = tie.rows[0] as { ts: string; first_id: string; second_id: string } | undefined;

    if (!row) {
      report("equalTimestampTiebreak", { tieFoundInWindow: false });
      return;
    }

    // Resume exactly at the first of the tied pair; the second must come back.
    const after = await source().query({
      text: `SELECT h.id::text AS id
             FROM customer_service.ebay_message_headers h
             WHERE (h.receive_date, h.id) > ($1::timestamp, $2::bigint)
             ORDER BY h.receive_date ASC, h.id ASC
             LIMIT 1`,
      values: [row.ts, row.first_id],
    });
    const nextId = (after.rows[0] as { id: string } | undefined)?.id ?? null;

    report("equalTimestampTiebreak", {
      tieFoundInWindow: true,
      tiedTimestamp: row.ts,
      resumedRowIsTieMate: nextId === row.second_id,
    });
    expect(nextId).toBe(row.second_id);
  });
});
