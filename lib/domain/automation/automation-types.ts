import { z } from "zod";

import { MARKETPLACES, type Marketplace } from "@/lib/domain/marketplace";

/**
 * The post-dispatch automation contract.
 *
 * A dispatched shipment is scheduled, rechecked when it comes due, and
 * processed against a saved message template. It is deterministic: no model
 * runs, no corpus is retrieved, and nothing is drafted or reviewed.
 *
 * THIS AUTOMATION HAS NO TRANSPORT. `sent` is the lifecycle word for "processed
 * successfully", and every processed record carries `testMode` and
 * `processedMode` saying that it was processed locally and that nothing left
 * the system. The database enforces the pairing; see 0011.
 *
 * THE CST CONVERSATION DRAFT WORKFLOW IS A DIFFERENT FEATURE and is untouched:
 * `lib/ai/*`, `lib/sync/draft-writer.ts` and the conversation routes continue
 * to draft and review customer replies exactly as before. Nothing in this file
 * or anything it feeds reads or writes any of that.
 */

/** The one automation this phase implements. */
export const POST_DISPATCH_AUTOMATION_KEY = "post_dispatch_message";

/**
 * The record's states, exhaustively.
 *
 *   scheduled   discovered and waiting for `scheduled_at`
 *   sent        processed successfully — in this phase, always in test mode
 *   skipped     the recheck found the order no longer qualified
 *   failed      processing could not complete
 *   cancelled   an operator stopped it before it was processed
 *
 * There is deliberately no `sending`, no `drafting`, no `pending_review` and no
 * `reviewed`: this automation neither drafts nor reviews.
 */
export const AUTOMATION_ITEM_STATUSES = [
  "scheduled",
  "sent",
  "skipped",
  "failed",
  "cancelled",
] as const;

export type AutomationItemStatus = (typeof AUTOMATION_ITEM_STATUSES)[number];

/**
 * How a record was processed.
 *
 * ONE VALUE, and that is the point. A second would mean a transport exists.
 */
export const PROCESSED_MODES = ["test_mode"] as const;

export type ProcessedMode = (typeof PROCESSED_MODES)[number];

/** Configuration. Every field is an operator's deliberate choice. */
export type AutomationSettings = {
  readonly automationKey: string;
  readonly enabled: boolean;
  readonly delayHours: number;
  /** `order_management.sub_source.id` values. Empty means nothing is in scope. */
  readonly enabledSubSources: readonly number[];
  /** Naive, in `dispatchTimeZone`. Compared against the source dispatch time. */
  readonly notBefore: string | null;
  readonly dispatchTimeZone: string;
  /** The saved template rendered for each record. Unset refuses the scan. */
  readonly templateId: string | null;
  /** True means process locally and transmit nothing. The only safe value now. */
  readonly testMode: boolean;
};

/**
 * A saved message template.
 *
 * `bodyTemplate` carries `{{placeholders}}` filled from VERIFIED SOURCE VALUES
 * only. A required placeholder with no verified value fails the record rather
 * than rendering a blank or a guess — see `renderTemplate`.
 */
export type AutomationTemplate = {
  readonly id: string;
  readonly templateKey: string;
  readonly version: number;
  readonly name: string;
  readonly bodyTemplate: string;
  readonly requiredVariables: readonly string[];
  readonly approved: boolean;
  readonly active: boolean;
};

/**
 * One dispatched shipment as the source records it, read at scan time and
 * again immediately before processing.
 *
 * Every field is copied from a column verified live against the source; nothing
 * here is derived, inferred or defaulted. `dispatchedAt` is NAIVE — the source
 * stores `order_info.shipped_time` without a zone.
 */
export type DispatchEvent = {
  readonly shipmentId: string;
  readonly orderId: string;
  readonly orderNumber: string | null;
  readonly channel: Marketplace;
  readonly subSourceId: number;
  readonly subSourceName: string | null;
  readonly dispatchedAt: string;
  /** `order_management.orders.status`, verbatim. */
  readonly orderStatus: string | null;
  /** `order_management.shipment.status`, verbatim. */
  readonly shipmentStatus: string | null;
  /** True when `shipment.cancelled_at` is set, whatever the status says. */
  readonly shipmentCancelled: boolean;
  /** True when the marketplace recorded a cancellation request for this order. */
  readonly cancellationRaised: boolean;
  /** True when the marketplace recorded a return for this order. */
  readonly returned: boolean;
  readonly trackingNumber: string | null;
  readonly carrier: string | null;
  readonly customerName: string | null;
  readonly productTitle: string | null;
  readonly sku: string | null;
};

export type AutomationItem = {
  readonly id: string;
  readonly automationKey: string;
  readonly channel: Marketplace;
  readonly subSourceId: number;
  readonly subSourceName: string | null;
  readonly orderId: string;
  readonly orderNumber: string | null;
  readonly shipmentId: string;
  readonly recipientName: string | null;
  readonly dispatchedAt: string;
  readonly dispatchSource: "order_info_shipped_time";
  readonly dispatchTimeZone: string;
  readonly scheduledAt: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateName: string | null;
  readonly status: AutomationItemStatus;
  readonly testMode: boolean;
  readonly processedMode: ProcessedMode | null;
  readonly processedAt: string | null;
  readonly renderedBody: string | null;
  readonly skipReason: string | null;
  readonly lastError: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledReason: string | null;
  readonly updatedAt: string;
};

/**
 * What an administrator may change.
 *
 * `notBefore` is a NAIVE source-zone timestamp — `YYYY-MM-DD` or
 * `YYYY-MM-DD HH:MM:SS` — because that is what it is compared against. It is
 * deliberately not a `datetime` with an offset: accepting one would invite a
 * UTC value to be written into a column that is read in the source's zone.
 *
 * Null CLEARS it, which switches the scan off at the same time — see
 * `settingsPatchRefusal`. That is the intended way to stop a running automation
 * without losing its storefront scope.
 */
export const automationSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  delayHours: z.number().int().min(0).max(8760).optional(),
  enabledSubSources: z.array(z.number().int().positive()).max(200).optional(),
  notBefore: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/)
    .nullable()
    .optional(),
  templateId: z.string().regex(/^\d+$/).optional(),
  testMode: z.boolean().optional(),
});

export type AutomationSettingsPatch = z.infer<typeof automationSettingsPatchSchema>;

/** Stopping one scheduled record. The reason is what the record exists to keep. */
export const automationCancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const marketplaceForSourceId: Readonly<Record<number, Marketplace>> = {
  1: "amazon",
  2: "ebay",
  3: "shopify",
  16: "bandq",
  17: "temu",
};

/** The channel for a source platform id, or undefined when this app has none. */
export function channelForSourceId(sourceId: number): Marketplace | undefined {
  const channel = marketplaceForSourceId[sourceId];
  return channel !== undefined && (MARKETPLACES as readonly string[]).includes(channel)
    ? channel
    : undefined;
}
