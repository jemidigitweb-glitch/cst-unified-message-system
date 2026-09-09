import * as amazonRepository from "@/lib/marketplaces/amazon/message-repository";
import * as bandqRepository from "@/lib/marketplaces/bandq/message-repository";
import * as ebayRepository from "@/lib/marketplaces/ebay/message-repository";
import * as shopifyRepository from "@/lib/marketplaces/shopify/message-repository";
import * as temuRepository from "@/lib/marketplaces/temu/message-repository";
import { MARKETPLACES, type Marketplace } from "@/lib/domain/marketplace";
import type { MessageDirection } from "@/lib/domain/message";
import type { BodyDecodeStatus, SourceMessage } from "@/lib/domain/source-message";
import { MAX_PK_BATCH } from "@/lib/marketplaces/source-fetch";

import { type BodyRepairWrite, repairMessageBodies } from "./conversation-writer";

/**
 * Body repair: picks up message text that did not exist when the message was
 * first synced.
 *
 * THE PROBLEM. Some sources write a message in two steps. eBay lands the header
 * in `ebay_message_headers` immediately and the text in `ebay_messages` later; a
 * header ingested in that gap is stored honestly as
 * `body_decode_status = 'empty'` with a NULL body, and the reviewer sees an
 * empty bubble. Measured on 2026-09-08: 791 eBay messages stored blank, of which
 * 74 had real text sitting in the source by the time this was written.
 *
 * WHY THE SYNC CANNOT FIX IT. `syncFeed` reads strictly forward of the
 * `(timestamp, pk)` watermark. That is not a defect to work around — it is what
 * makes the sync resumable and cheap — but it does mean a row the cursor has
 * passed is never looked at again, whatever changes beneath it.
 *
 * WHAT THIS DOES INSTEAD. It asks `conversation_messages` which rows are stored
 * without a usable body, re-reads exactly those rows from the source by primary
 * key, and writes the body back through the sync's own upsert. No cursor is
 * read, moved or consulted at any point, so this can be run at any time, in any
 * order, alongside a sync, without either affecting the other.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *   - thread grouping — the thread builder is never called; the existing
 *     `conversation_id` is passed straight back
 *   - message ordering — `source_ts` is INSERT-only in the upsert
 *   - `sync_state` — no statement here reads or writes it
 *   - conversations, drafts, categories, notifications — never queried
 *
 * IDEMPOTENT. A repaired message is `decoded` and so is no longer a candidate;
 * a second run finds it and does nothing. A message the source still cannot
 * answer for stays a candidate and is skipped again with the same reason, which
 * costs one source read and no write.
 *
 * READS the marketplace source, WRITES `cst_app.conversation_messages` only.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * Reads named source rows for one marketplace.
 *
 * Each entry is the marketplace's OWN repository function, so the row shape, the
 * direction rule and the body decoding stay with the code that was reviewed for
 * them. Nothing in this module normalises a message itself.
 */
export type PkReader = (
  client: Queryable,
  sourcePks: readonly string[],
) => Promise<{
  readonly messages: readonly SourceMessage[];
  /** Raw rows the source returned, before normalisation. */
  readonly rowsExamined: number;
}>;

/* eslint-disable @typescript-eslint/no-explicit-any -- each repository types its
   own client shape; the reader only ever hands it back to that same repository. */
export const REPAIR_READERS: Readonly<Record<Marketplace, PkReader>> = {
  ebay: (client, pks) => ebayRepository.fetchMessagesByPk(client as any, pks),
  amazon: (client, pks) => amazonRepository.fetchMessagesByPk(client as any, pks),
  shopify: (client, pks) => shopifyRepository.fetchMessagesByPk(client as any, pks),
  bandq: (client, pks) => bandqRepository.fetchMessagesByPk(client as any, pks),
  temu: (client, pks) => temuRepository.fetchMessagesByPk(client as any, pks),
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Why a candidate was left alone.
 *
 * Every one of these is a decision to do NOTHING, and each is reported
 * separately. A repair pass that quietly did nothing 700 times and called itself
 * successful would be worse than one that failed.
 */
export const REPAIR_SKIP_REASONS = [
  /** The source row is gone, or its pk no longer matches anything. */
  "source_row_missing",
  /** The row exists but the marketplace's own rules cannot represent it. */
  "source_row_unusable",
  /** Re-read, still no body. The customer's message really is empty. */
  "still_empty_at_source",
  /** Re-read, body present but undecodable. Not text, so not shown as text. */
  "still_failed_at_source",
  /** Decoded, but to whitespace only — indistinguishable from empty on screen. */
  "decoded_to_blank",
  /** The source row now reads as the other side of the conversation. */
  "source_direction_changed",
  /** The source row's timestamp has moved since it was stored. */
  "source_timestamp_changed",
] as const;

export type RepairSkipReason = (typeof REPAIR_SKIP_REASONS)[number];

/** One stored message that has no usable body, as read back from cst_app. */
export type RepairCandidate = {
  readonly marketplace: Marketplace;
  readonly conversationId: string;
  readonly sourceDatabase: string;
  readonly sourceSchema: string;
  readonly sourceTable: string;
  readonly sourcePk: string;
  readonly direction: MessageDirection;
  readonly sourceTimestamp: string;
  readonly bodyDecodeStatus: BodyDecodeStatus;
};

/**
 * Candidate selection.
 *
 * `body_decode_status <> 'decoded'` is the whole predicate, and it is the right
 * one: `decoded` is precisely the state in which a reviewer sees the customer's
 * words. Anything else shows the unavailable placeholder, whether the body was
 * missing (`empty`) or unreadable (`failed`).
 *
 * NEWEST FIRST. A body that arrived late is most likely to have arrived
 * recently, so a bounded run spends its budget where the answer is most likely
 * to have changed. It also means the messages a reviewer is looking at today are
 * repaired first.
 *
 * The join to `conversations` is for the marketplace only — it decides which
 * source repository can answer for the row. Nothing about the conversation is
 * read, and nothing about it is written.
 */
export const SELECT_REPAIR_CANDIDATES = `
SELECT c.marketplace                AS marketplace,
       m.conversation_id::text      AS conversation_id,
       m.source_database            AS source_database,
       m.source_schema              AS source_schema,
       m.source_table               AS source_table,
       m.source_pk                  AS source_pk,
       m.direction                  AS direction,
       m.source_ts::text            AS source_ts,
       m.body_decode_status         AS body_decode_status
FROM cst_app.conversation_messages m
JOIN cst_app.conversations c ON c.id = m.conversation_id
WHERE m.body_decode_status <> 'decoded'
  AND c.marketplace = ANY($1::text[])
ORDER BY m.source_ts DESC, m.id DESC
LIMIT $2`;

export const DEFAULT_CANDIDATE_LIMIT = 500;
export const MAX_CANDIDATE_LIMIT = 5000;

function clampCandidateLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, received: ${String(limit)}`);
  }
  return Math.min(limit, MAX_CANDIDATE_LIMIT);
}

function clampBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return MAX_PK_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, received: ${String(batchSize)}`);
  }
  return Math.min(batchSize, MAX_PK_BATCH);
}

export async function selectRepairCandidates(
  app: Queryable,
  options: { readonly marketplaces: readonly Marketplace[]; readonly limit?: number },
): Promise<RepairCandidate[]> {
  if (options.marketplaces.length === 0) return [];
  const { rows } = await app.query({
    text: SELECT_REPAIR_CANDIDATES,
    values: [[...options.marketplaces], clampCandidateLimit(options.limit)],
  });
  return (rows as Record<string, string>[]).map((row) => ({
    marketplace: row.marketplace as Marketplace,
    conversationId: row.conversation_id,
    sourceDatabase: row.source_database,
    sourceSchema: row.source_schema,
    sourceTable: row.source_table,
    sourcePk: row.source_pk,
    direction: row.direction as MessageDirection,
    sourceTimestamp: row.source_ts,
    bodyDecodeStatus: row.body_decode_status as BodyDecodeStatus,
  }));
}

/** The source coordinates that identify one row, as a lookup key. */
export function sourceKeyOf(message: {
  sourceDatabase: string;
  sourceSchema: string;
  sourceTable: string;
  sourcePk: string;
}): string {
  return [
    message.sourceDatabase,
    message.sourceSchema,
    message.sourceTable,
    message.sourcePk,
  ].join(" ");
}

/**
 * Whether two renderings of the same source timestamp agree.
 *
 * Both sides are `::text` of a `timestamp without time zone` and the stored one
 * was written from the source one, so they normally match character for
 * character. The trailing-zero trim exists so a purely cosmetic difference
 * (`10:00:00` against `10:00:00.000`) cannot turn every candidate into a skip —
 * which would make the whole pass a silent no-op rather than a visible failure.
 *
 * NO PARSING AND NO ARITHMETIC, for the reason recorded everywhere else in this
 * project: the authoritative source zone is still unconfirmed, so a Date built
 * here would shift the value it was meant to compare.
 */
export function sameSourceTimestamp(stored: string, fresh: string): boolean {
  const trim = (value: string) => value.trim().replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return trim(stored) === trim(fresh);
}

/**
 * Decides what to do with one candidate, given what the source says now.
 *
 * PURE. No database, no clock, no I/O — which is what makes every branch below
 * directly testable, including the ones that are hard to reproduce live.
 *
 * The two "changed" branches are the interesting ones. The source row is
 * identified by its primary key, so a differing direction or timestamp means the
 * row itself was edited upstream, not that we looked at the wrong row. Attaching
 * that body to a message stored under the old reading would put a customer's
 * words on the CST side of a thread, or at the wrong point in it. Repairing a
 * body is not a licence to restate the message, so the row is left exactly as it
 * is and the disagreement is reported.
 */
export function decideRepair(
  candidate: RepairCandidate,
  fresh: SourceMessage | undefined,
): { readonly repair: true; readonly write: BodyRepairWrite } | { readonly repair: false; readonly reason: RepairSkipReason } {
  if (fresh === undefined) {
    return { repair: false, reason: "source_row_missing" };
  }
  if (fresh.direction !== candidate.direction) {
    return { repair: false, reason: "source_direction_changed" };
  }
  if (!sameSourceTimestamp(candidate.sourceTimestamp, fresh.sourceTimestamp)) {
    return { repair: false, reason: "source_timestamp_changed" };
  }
  if (fresh.bodyDecodeStatus === "empty") {
    return { repair: false, reason: "still_empty_at_source" };
  }
  if (fresh.bodyDecodeStatus === "failed") {
    return { repair: false, reason: "still_failed_at_source" };
  }
  if (fresh.bodyText === null || fresh.bodyText.trim() === "") {
    // `decoded` with nothing in it would replace one blank bubble with another,
    // while removing the row from every future run's candidate set — hiding the
    // gap instead of closing it.
    return { repair: false, reason: "decoded_to_blank" };
  }
  return {
    repair: true,
    write: { conversationId: candidate.conversationId, message: fresh },
  };
}

export type MarketplaceRepairSummary = {
  readonly marketplace: Marketplace;
  readonly examined: number;
  readonly repaired: number;
  readonly skipped: number;
};

export type BodyRepairOutcome = {
  readonly examined: number;
  readonly repaired: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Partial<Record<RepairSkipReason, number>>>;
  readonly byMarketplace: readonly MarketplaceRepairSummary[];
  /** Rows the writer had to INSERT. Expected zero — see `repairMessageBodies`. */
  readonly unexpectedInserts: number;
  /** True when the candidate limit stopped the pass before the queue was empty. */
  readonly moreAvailable: boolean;
};

export type BodyRepairOptions = {
  /** Which marketplaces to consider. Defaults to all of them. */
  readonly marketplaces?: readonly Marketplace[];
  /** How many stored blank messages to examine in this pass. */
  readonly limit?: number;
  /** Source rows re-read per round trip. */
  readonly batchSize?: number;
  /** Report what would happen; open no transaction and write nothing. */
  readonly dryRun?: boolean;
  readonly onBatch?: (marketplace: Marketplace, examined: number, repaired: number) => void;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs one repair pass.
 *
 * EACH BATCH IS ITS OWN TRANSACTION, committed before the next source read, for
 * the same reason `syncFeed` works that way: a failure late in a long pass keeps
 * everything already repaired. There is no cursor to leave inconsistent, so a
 * re-run simply reconsiders whatever is still blank.
 *
 * One marketplace failing does not abandon the others — each is read and written
 * independently, and the failure is rethrown only after the rest have run.
 */
export async function runBodyRepair(
  app: Queryable,
  source: Queryable,
  options: BodyRepairOptions = {},
  begin?: (run: (tx: Queryable) => Promise<void>) => Promise<void>,
): Promise<BodyRepairOutcome> {
  const marketplaces = options.marketplaces ?? MARKETPLACES;
  const limit = clampCandidateLimit(options.limit);
  const batchSize = clampBatchSize(options.batchSize);

  const candidates = await selectRepairCandidates(app, { marketplaces, limit });

  const skippedByReason: Partial<Record<RepairSkipReason, number>> = {};
  const byMarketplace: MarketplaceRepairSummary[] = [];
  let repaired = 0;
  let skipped = 0;
  let unexpectedInserts = 0;

  const note = (reason: RepairSkipReason) => {
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
    skipped += 1;
  };

  for (const marketplace of marketplaces) {
    const mine = candidates.filter((c) => c.marketplace === marketplace);
    if (mine.length === 0) continue;

    let marketplaceRepaired = 0;
    let marketplaceSkipped = 0;

    for (const batch of chunk(mine, batchSize)) {
      const read = await REPAIR_READERS[marketplace](
        source,
        batch.map((c) => c.sourcePk),
      );
      const freshByKey = new Map<string, SourceMessage>();
      for (const message of read.messages) freshByKey.set(sourceKeyOf(message), message);

      /**
       * A row that came back but could not be normalised never reaches
       * `messages`, so it looks identical to one that never came back. When the
       * source returned a row for every key asked for, anything still absent is
       * therefore unusable rather than missing — a different problem with a
       * different fix, worth naming. In a mixed batch the two cannot be told
       * apart from counts alone, so the pass reports the weaker claim.
       */
      const everyRowReturned = read.rowsExamined === batch.length;

      const writes: BodyRepairWrite[] = [];
      for (const candidate of batch) {
        const fresh = freshByKey.get(sourceKeyOf(candidate));
        const decision = decideRepair(candidate, fresh);
        if (decision.repair) {
          writes.push(decision.write);
          continue;
        }
        note(
          decision.reason === "source_row_missing" && everyRowReturned
            ? "source_row_unusable"
            : decision.reason,
        );
        marketplaceSkipped += 1;
      }

      if (writes.length > 0 && !options.dryRun) {
        if (begin === undefined) {
          throw new Error("a transaction runner is required unless dryRun");
        }
        await begin(async (tx) => {
          const stats = await repairMessageBodies(tx, writes);
          unexpectedInserts += stats.inserted;
        });
      }

      repaired += writes.length;
      marketplaceRepaired += writes.length;
      options.onBatch?.(marketplace, batch.length, writes.length);
    }

    byMarketplace.push({
      marketplace,
      examined: mine.length,
      repaired: marketplaceRepaired,
      skipped: marketplaceSkipped,
    });
  }

  return {
    examined: candidates.length,
    repaired,
    skipped,
    skippedByReason,
    byMarketplace,
    unexpectedInserts,
    moreAvailable: candidates.length === limit,
  };
}
