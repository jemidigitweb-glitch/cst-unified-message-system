import { z } from "zod";

/**
 * Logical marketplace-order identity.
 *
 * A single marketplace order number can appear as several physical
 * `order_management.orders` rows — status/lifecycle versions, warehouse splits,
 * and duplicate re-imports. Day 1 discovery found 651 such groups (0.06% of
 * order numbers), and in every one of them the rows shared an identical
 * `order_date`: they always describe ONE order, never two different purchases.
 *
 * Therefore the logical identity is `(sub_source_id, order_id)`, and order items
 * are the UNION across all active member rows. Picking a single `orders.id`
 * discards 42.6% of the order items in the ambiguous groups — never do it.
 */
export type LogicalOrderKey = {
  readonly subSourceId: number;
  readonly orderId: string;
};

export const logicalOrderKeySchema = z.object({
  subSourceId: z.number().int(),
  orderId: z.string().min(1),
});

/** Stable string form for maps, caches and comparisons. */
export function logicalOrderKeyOf(key: LogicalOrderKey): string {
  return `${key.subSourceId}:${key.orderId}`;
}

/**
 * Statuses that keep a physical row context-relevant.
 * `Refunded` is intentionally active: a refunded order is a completed order the
 * customer is very likely writing about, and hiding it would blind CST to its
 * highest-value cases.
 */
export const ACTIVE_ORDER_STATUSES = [
  "Completed",
  "Refunded",
  "Inprogress",
  "New",
  "Hold",
] as const;

/** Statuses that mark a superseded or terminated representation of the order. */
export const TERMINATED_ORDER_STATUSES = ["Deleted", "Cancelled"] as const;

export type ActiveOrderStatus = (typeof ACTIVE_ORDER_STATUSES)[number];
export type TerminatedOrderStatus = (typeof TERMINATED_ORDER_STATUSES)[number];

export function isActiveOrderStatus(status: string): status is ActiveOrderStatus {
  return (ACTIVE_ORDER_STATUSES as readonly string[]).includes(status);
}

export function isTerminatedOrderStatus(status: string): status is TerminatedOrderStatus {
  return (TERMINATED_ORDER_STATUSES as readonly string[]).includes(status);
}

/**
 * How confidently a conversation resolved to business context.
 *
 * `ambiguous` is a first-class outcome, not a failure to be papered over: ~12%
 * of eBay threads match several genuine purchases of the same listing (93% of
 * those on different order dates — real repeat buying, not duplicate rows).
 * CST must choose; the backend must not.
 */
export const CONTEXT_RESOLUTIONS = [
  "single_order",
  "no_order",
  "ambiguous",
  "needs_context",
  "terminated_order",
] as const;

export type ContextResolution = (typeof CONTEXT_RESOLUTIONS)[number];

export const contextResolutionSchema = z.enum(CONTEXT_RESOLUTIONS);

/**
 * Whether order-derived facts may be used to ground an AI draft.
 * Blocked until a human has picked among genuine candidates.
 */
export function mayUseOrderFacts(resolution: ContextResolution): boolean {
  return resolution === "single_order";
}
