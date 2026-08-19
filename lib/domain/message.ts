import { z } from "zod";

/**
 * Marketplace-NEUTRAL message contracts.
 *
 * Nothing here may reference a marketplace's tables, columns, or encodings.
 * Per-marketplace details (eBay's `folder_id`, its `receive_date` column, its
 * schema names) live behind an adapter in `lib/marketplaces/<marketplace>/`.
 */
export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;

export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const messageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);

/**
 * Which side of the conversation view a message belongs on.
 * Customer messages left, previous CST replies right.
 */
export function alignmentFor(direction: MessageDirection): "left" | "right" {
  return direction === "inbound" ? "left" : "right";
}

/**
 * Chronological ordering, expressed as intent rather than SQL.
 *
 * The source timestamp is authoritative; the source row id is a stable
 * tiebreaker ONLY and never a primary sort. Each marketplace adapter supplies
 * the column names that realise this — they differ (eBay `receive_date`,
 * the email-derived channels `date`).
 */
export const MESSAGE_ORDERING = {
  primary: "source_timestamp",
  primaryDirection: "asc",
  tiebreaker: "source_pk",
  tiebreakerDirection: "asc",
} as const;

/**
 * Stable identity of a row in a live source database.
 *
 * This is the natural key that makes repeated syncing idempotent: the same
 * source row can only ever produce one `cst_app.conversation_messages` row.
 */
export type SourceMessageIdentity = {
  readonly sourceDatabase: string;
  readonly sourceSchema: string;
  readonly sourceTable: string;
  readonly sourcePk: string;
};

export const sourceMessageIdentitySchema = z.object({
  sourceDatabase: z.string().min(1),
  sourceSchema: z.string().min(1),
  sourceTable: z.string().min(1),
  sourcePk: z.string().min(1),
});

export function sourceMessageKeyOf(identity: SourceMessageIdentity): string {
  return [
    identity.sourceDatabase,
    identity.sourceSchema,
    identity.sourceTable,
    identity.sourcePk,
  ].join(".");
}

/**
 * Source timestamps are `timestamp without time zone` in every source table.
 * Day 1 evidence points strongly to UTC, but the ingestion owner has not
 * confirmed it, so the naive value is stored verbatim and left unconverted.
 *
 * Do not apply a timezone until this flips: the source server is Europe/Berlin,
 * so a naive cast to timestamptz would silently shift every message by +2h.
 */
export const SOURCE_TIMEZONE_CONFIRMED = false;
