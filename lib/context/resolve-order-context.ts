import "server-only";

import type { VerifiedFact } from "@/lib/domain/draft";
import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import {
  type CandidateOrder,
  type Queryable as SourceQueryable,
  findCandidateEbayOrders,
} from "@/lib/repositories/order-context-repository";
import {
  type Writable as AppWritable,
  getContextItems,
  getContextSnapshot,
  saveAmbiguousSnapshot,
  saveNoOrderSnapshot,
  saveSingleOrderSnapshot,
} from "@/lib/repositories/context-snapshot-repository";

/**
 * Connects an eBay conversation to verified order/shipping facts an AI draft
 * may state, using ONLY item_id + buyer username — the two things a
 * conversation already carries — and the existing `cst_app.context_*`
 * schema, which has held this shape since migration 0001 and has been empty
 * ever since.
 *
 * SCOPED TO EBAY ONLY. Every other marketplace returns no facts, unchanged
 * from today's behaviour — this does not touch Amazon, Shopify, B&Q or Temu.
 *
 * THE EIGHT FACTS, AND NO OTHERS. `order_number`, `order_status`,
 * `order_date`, `tracking_number`, `delivery_courier`, `delivery_address`,
 * `sku`, `product_title`. Nothing else is ever returned — not an email
 * address, not a phone number, not a raw database id. The names are chosen
 * to fall into the right half of the existing prompt (`contextBlocks()` in
 * `lib/ai/draft-assembly.ts` buckets by matching `/order|refund|tracking|
 * delivery/i` against the fact name) without that file needing to change.
 *
 * NEVER GUESSES. Zero matching orders or more than one both return no facts
 * — see `saveNoOrderSnapshot` / `saveAmbiguousSnapshot`. Only a single,
 * unambiguous match produces facts, and it is written down as
 * `deterministic_single` so the record says plainly that no human confirmed
 * it either.
 *
 * RESOLVED ONCE, THEN CACHED. A conversation with an existing snapshot never
 * touches the source database again — it reads `cst_app.context_snapshots`
 * (already-resolved) and returns immediately. Only a conversation resolved
 * for the first time queries the source, which keeps this from adding a
 * source-database round trip to every single draft generation.
 */

export type ConversationForContext = {
  readonly id: string;
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly counterpartyRef: string;
  readonly listingItemRef: string | null;
};

const ALLOWED_FACT_NAMES = [
  "order_number",
  "order_status",
  "order_date",
  "tracking_number",
  "delivery_courier",
  "delivery_address",
  "sku",
  "product_title",
] as const;

/** Joins the non-empty address lines into one line, for a single readable fact. */
function formatAddress(order: CandidateOrder): string | null {
  const parts = [
    order.addressLine1,
    order.addressLine2,
    order.addressLine3,
    order.city,
    order.region,
    order.postcode,
  ].filter((part): part is string => part !== null && part.trim() !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

/** The single order's data, as the eight allowed facts and nothing more. */
function factsFromOrder(order: CandidateOrder): VerifiedFact[] {
  const facts: [string, string | null][] = [
    ["order_number", order.orderNumber],
    ["order_status", order.orderStatus],
    ["order_date", order.orderDate],
    ["tracking_number", order.trackingNumber],
    ["delivery_courier", order.carrierName],
    ["delivery_address", formatAddress(order)],
    ["sku", order.sku],
    ["product_title", order.productTitle],
  ];
  return facts
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1].trim() !== "")
    .map(([name, value]) => ({ name, value }));
}

/** The cached snapshot's facts, read back from `context_items` rather than recomputed. */
async function factsFromStoredSnapshot(
  appClient: AppWritable,
  snapshot: NonNullable<Awaited<ReturnType<typeof getContextSnapshot>>>,
): Promise<VerifiedFact[]> {
  const facts: VerifiedFact[] = [];
  if (snapshot.order_number) facts.push({ name: "order_number", value: snapshot.order_number });
  if (snapshot.order_status_summary) {
    facts.push({ name: "order_status", value: snapshot.order_status_summary });
  }
  if (snapshot.order_date) facts.push({ name: "order_date", value: snapshot.order_date });
  if (snapshot.tracking_number) facts.push({ name: "tracking_number", value: snapshot.tracking_number });
  if (snapshot.delivery_courier) facts.push({ name: "delivery_courier", value: snapshot.delivery_courier });
  if (snapshot.delivery_address) facts.push({ name: "delivery_address", value: snapshot.delivery_address });

  const items = await getContextItems(appClient, snapshot.id);
  const item = items[0];
  if (item) {
    if (item.exact_sku) facts.push({ name: "sku", value: item.exact_sku });
    if (item.product_title) facts.push({ name: "product_title", value: item.product_title });
  }
  return facts;
}

/**
 * Resolves (or reads back) one eBay conversation's verified order context.
 *
 * Returns an empty list for every case that is not a clean single match:
 * a non-eBay conversation, a conversation with no item reference or no
 * verified buyer identity, zero matching orders, or more than one. The
 * caller (the draft route) needs nothing more specific than "facts, or
 * none" — `settleReviewRequirement` already forces review whenever a draft
 * states something these facts do not support.
 */
export async function resolveEbayOrderContext(
  sourceClient: SourceQueryable,
  appClient: AppWritable,
  conversation: ConversationForContext,
): Promise<VerifiedFact[]> {
  if (conversation.marketplace !== "ebay") return [];

  const existing = await getContextSnapshot(appClient, conversation.id);
  if (existing !== null) {
    if (existing.resolution !== "single_order") return [];
    return factsFromStoredSnapshot(appClient, existing);
  }

  if (
    conversation.subSourceId === null ||
    conversation.listingItemRef === null ||
    conversation.listingItemRef.trim() === "" ||
    isUnresolvedReference(conversation.counterpartyRef)
  ) {
    await saveNoOrderSnapshot(appClient, conversation.id);
    return [];
  }

  const candidates = await findCandidateEbayOrders(sourceClient, {
    subSourceId: conversation.subSourceId,
    itemId: conversation.listingItemRef,
    buyerUsername: conversation.counterpartyRef,
  });

  if (candidates.length === 0) {
    await saveNoOrderSnapshot(appClient, conversation.id);
    return [];
  }

  if (candidates.length > 1) {
    await saveAmbiguousSnapshot(
      appClient,
      conversation.id,
      candidates.map((order) => ({
        subSourceId: conversation.subSourceId!,
        orderNumber: order.orderNumber,
        orderDate: order.orderDate,
        orderStatusSummary: order.orderStatus,
        orderRowId: order.orderRowId,
        listingItemRef: conversation.listingItemRef,
      })),
    );
    return [];
  }

  const [order] = candidates;
  await saveSingleOrderSnapshot(appClient, {
    conversationId: conversation.id,
    subSourceId: conversation.subSourceId,
    orderNumber: order!.orderNumber,
    orderDate: order!.orderDate,
    orderStatusSummary: order!.orderStatus,
    trackingNumber: order!.trackingNumber,
    deliveryCourier: order!.carrierName,
    deliveryAddress: formatAddress(order!),
    orderRowId: order!.orderRowId,
    listingItemRef: conversation.listingItemRef,
    // No SKU recorded for this line -> nothing honest to store as one; see
    // `SingleOrderInput.item`'s own note on why this is `null`, not a
    // placeholder string.
    item:
      order!.sku !== null
        ? {
            exactSku: order!.sku,
            productTitle: order!.productTitle,
            imageUrl: order!.productImageUrl,
            sourceOrderItemId: order!.orderItemInfoId,
          }
        : null,
  });

  return factsFromOrder(order!);
}

export { ALLOWED_FACT_NAMES };
