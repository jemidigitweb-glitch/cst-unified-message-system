import { z } from "zod";

import { marketplaceSchema } from "@/lib/domain/marketplace";
import { messageDirectionSchema } from "@/lib/domain/message";

/**
 * Marketplace-NEUTRAL normalized source message.
 *
 * This is what every marketplace adapter produces and what the rest of the
 * application consumes. No marketplace column, encoding, or table name may
 * appear in this shape — adapter-specific extras go in `sourceMetadata`, which
 * downstream code must treat as opaque.
 *
 * Deliberately absent: order number, SKU, product title, listing URL. A message
 * carries no business facts. Those are resolved separately and verified, so a
 * guess can never leak into a draft.
 */
export const bodyDecodeStatuses = ["decoded", "empty", "failed"] as const;

export type BodyDecodeStatus = (typeof bodyDecodeStatuses)[number];

export const sourceMessageSchema = z.object({
  marketplace: marketplaceSchema,

  /** Source coordinates — together these are the idempotency key for sync. */
  sourceDatabase: z.string().min(1),
  sourceSchema: z.string().min(1),
  sourceTable: z.string().min(1),
  sourcePk: z.string().min(1),

  /** Marketplace's own message id, where the source exposes one. */
  externalMessageId: z.string().nullable(),

  subSourceId: z.number().int(),

  /** Listing/item the message is attached to, when the source provides one. */
  listingItemRef: z.string().nullable(),

  /** The customer handle, whichever side of the exchange it sits on. */
  counterpartyRef: z.string().nullable(),

  direction: messageDirectionSchema,

  /**
   * The source timestamp EXACTLY as stored, carried as text.
   *
   * Text, not Date, on purpose: the source column is `timestamp without time
   * zone` and the driver would otherwise coerce it through the process
   * timezone. Until the ingestion owner confirms the source zone, no conversion
   * of any kind may happen to this value.
   */
  sourceTimestamp: z.string().min(1),

  bodyText: z.string().nullable(),
  bodyDecodeStatus: z.enum(bodyDecodeStatuses),

  /** Adapter-specific extras. Opaque to shared code. */
  sourceMetadata: z.record(z.string(), z.string().nullable()),
});

export type SourceMessage = z.infer<typeof sourceMessageSchema>;

/**
 * Comparator implementing the shared ordering intent: source timestamp first,
 * source PK only as a stable tiebreaker.
 *
 * Both are compared as strings. Timestamps arrive in a fixed-width sortable
 * format, and PKs are compared numerically when both parse as integers so that
 * "9" sorts before "10".
 */
export function compareSourceOrder(a: SourceMessage, b: SourceMessage): number {
  if (a.sourceTimestamp !== b.sourceTimestamp) {
    return a.sourceTimestamp < b.sourceTimestamp ? -1 : 1;
  }
  const left = Number(a.sourcePk);
  const right = Number(b.sourcePk);
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right) && left !== right) {
    return left - right;
  }
  if (a.sourcePk === b.sourcePk) return 0;
  return a.sourcePk < b.sourcePk ? -1 : 1;
}

/** Watermark for incremental reads: everything strictly after this pair. */
export type SourceWatermark = {
  readonly sourceTimestamp: string;
  readonly sourcePk: string;
};

export const sourceWatermarkSchema = z.object({
  sourceTimestamp: z.string().min(1),
  sourcePk: z.string().min(1),
});

/** The watermark that should follow a fetched batch, or null for an empty batch. */
export function watermarkAfter(batch: readonly SourceMessage[]): SourceWatermark | null {
  const last = batch.at(-1);
  return last ? { sourceTimestamp: last.sourceTimestamp, sourcePk: last.sourcePk } : null;
}
