import { z } from "zod";

import type { TrackingResult } from "@/lib/tracking/provider";

import type { VerifiedFact } from "./draft";
import type { OrderMatchEvidence } from "./order-match-evidence";

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

/**
 * One genuine purchase that matched an ambiguous conversation.
 *
 * DELIBERATELY NOT A `VerifiedFact`. A candidate is a real, stored, verified
 * order — but it is not verified to be *this conversation's* order, and that
 * is the whole distinction. Giving it a different shape from `{name, value}`
 * is what stops a future refactor spreading candidates into the grounding
 * list: the two types do not fit each other, so the mistake fails to compile
 * rather than silently handing the model three order numbers to choose from.
 *
 * Field names are the application's, not the database's, so nothing here
 * leaks a column name into the browser.
 */
export type OrderCandidate = {
  readonly orderNumber: string;
  readonly orderDate: string | null;
  readonly orderStatus: string | null;
  readonly listingItemRef: string | null;
};

/**
 * The order-context read model, as `/api/conversations/:id/order-context`
 * returns it and the sidebar consumes it.
 *
 * `facts` and `candidates` are separate fields for the same reason the types
 * differ: `facts` is non-empty only for `single_order`, `candidates` only for
 * `ambiguous`, and the two are never populated together. `resolution` is null
 * for a conversation the resolver does not cover (every non-eBay marketplace),
 * which is not the same claim as "resolved, and nothing matched".
 */
export type OrderContextResponse = {
  readonly conversationId: string;
  readonly facts: VerifiedFact[];
  readonly resolution: ContextResolution | null;
  readonly candidates: OrderCandidate[];
  /**
   * The live source read — every matching order in full. Empty when the source
   * could not answer (an outage, or a conversation without the three keys the
   * lookup needs), which is when `candidates` and `facts` become the fallback.
   */
  readonly orders: SourceOrderDetail[];
  /**
   * Why each order matched, for a reviewer comparing several — empty whenever
   * there is only one, which needs no comparison. Display only: these are
   * sentences about the match, never values a draft may state.
   */
  readonly evidence: OrderMatchEvidence[];
  /**
   * Where the parcel has got to, when the same gate the draft uses allowed a
   * lookup and it produced an answer.
   *
   * NULL IS THE ORDINARY CASE and is reported as null rather than as an empty
   * shape. Every refusal upstream lands here identically: not a delivery query,
   * no verified tracking number, an unrecognised carrier, a reference recorded
   * against two orders, an order sent in more than one parcel, or a
   * non-terminal status too old to state. The panel shows no tracking section
   * for any of them, which is the same thing it did before this field existed.
   *
   * DISPLAY ONLY. Nothing downstream reads it: the draft pipeline resolves its
   * own tracking through `resolveTrackingContext`, and does not call this route.
   */
  readonly tracking: TrackingResult | null;
};

/**
 * One matching order as the source recorded it, before display formatting.
 *
 * Lives in the domain rather than beside its query so the browser can carry
 * the type without importing a `server-only` module: the panel receives these
 * over the wire and maps them, and the repository fills them in.
 */
export type SourceOrderDetail = {
  readonly orderNumber: string;
  readonly orderDate: string | null;
  readonly orderStatus: string | null;
  readonly orderTotal: string | null;
  readonly customerName: string | null;
  readonly sellerName: string | null;
  readonly trackingNumber: string | null;
  readonly shipmentStatus: string | null;
  readonly carrierName: string | null;
  readonly deliveryAddress: string | null;
  readonly listingItemRef: string | null;
  readonly sku: string | null;
  readonly productTitle: string | null;
};

/**
 * What the shipment record's state means for dispatch, in the reviewer's words.
 *
 * A RESTATEMENT, NOT AN INFERENCE. `shipment.status` is the dispatch record's
 * own state, verified live: 538 shipments created in the last 24 hours already
 * read `Completed`, and across 1.14M rows the only values that exist are
 * Completed / New / Cancelled. So "Completed" means the label was booked and
 * the parcel left — nothing more — and this says exactly that in words a CST
 * agent can use.
 *
 * DELIBERATELY NOT A DELIVERY STATUS. There is no Delivered, In transit or Out
 * for delivery here, because no such value exists anywhere in the source: a
 * whole-database sweep for `deliver*` found only an advertising field and an
 * inbound-returns date. Adding one would mean inventing it.
 *
 * An unrecognised value maps to null — blank — rather than to a guess. If the
 * source ever grows a fourth state, a reviewer sees the raw value in
 * "Shipment status" beside a blank "Dispatch status", which is the honest
 * rendering of "this system does not know what that means yet".
 */
export const DISPATCH_STATUS_BY_SHIPMENT_STATUS: Readonly<Record<string, string>> = {
  Completed: "Dispatched",
  New: "Not dispatched",
  Cancelled: "Dispatch cancelled",
};

export function dispatchStatusFrom(shipmentStatus: string | null): string | null {
  if (shipmentStatus === null) return null;
  return DISPATCH_STATUS_BY_SHIPMENT_STATUS[shipmentStatus.trim()] ?? null;
}

/**
 * One matching order, in the ONE shape the interface renders.
 *
 * There is a single format because there is a single kind of thing being
 * shown: a verified order that matched this conversation. One match renders
 * one of these; three matches render three. A second, thinner layout for the
 * multi-match case would say — purely through styling — that those orders are
 * a lesser kind of fact, when the difference is not the orders at all, it is
 * only that nothing has established which of them the customer is writing
 * about.
 *
 * EVERY FIELD IS NULLABLE, AND NULL MEANS BLANK. Not "unknown", not a dash
 * standing in for a value, not a guess carried over from a sibling order —
 * blank, because the source did not record it or the resolution did not
 * capture it. Filling a candidate's tracking number from the one order that
 * does have one would be the exact merge this must never perform.
 */
export type OrderDetail = {
  readonly orderNumber: string | null;
  readonly buyer: string | null;
  readonly customerName: string | null;
  readonly seller: string | null;
  readonly date: string | null;
  readonly total: string | null;
  readonly status: string | null;
  readonly tracking: string | null;
  /**
   * The SHIPMENT RECORD's state — Completed / New / Cancelled — not a courier
   * delivery scan. Labelled "Shipment status" for exactly that reason: under
   * "Tracking status" a reader would take "Completed" to mean the parcel
   * arrived, which it does not say. It describes this business's own dispatch
   * record, and that is all it is shown as.
   */
  readonly shipmentStatus: string | null;
  /**
   * The same record, said in words. Shown BESIDE `shipmentStatus`, never
   * instead of it: a reviewer can see both what the database holds and what it
   * means, so the plain-English version can never be mistaken for a value the
   * source actually recorded.
   */
  readonly dispatchStatus: string | null;
  readonly courier: string | null;
  readonly deliveryAddress: string | null;
  readonly market: string | null;
  readonly sku: string | null;
  readonly productDetails: string | null;
  readonly listingReference: string | null;
};

/** The fields, in display order, with the label each is shown under. */
export const ORDER_DETAIL_FIELDS: readonly { readonly key: keyof OrderDetail; readonly label: string }[] = [
  { key: "orderNumber", label: "Order No" },
  { key: "buyer", label: "Buyer" },
  { key: "customerName", label: "Customer name" },
  { key: "seller", label: "Seller" },
  { key: "date", label: "Date" },
  { key: "total", label: "Total" },
  { key: "status", label: "Status" },
  { key: "tracking", label: "Tracking" },
  // Both, together, in that order: the stored value and what it means.
  { key: "shipmentStatus", label: "Shipment status" },
  { key: "dispatchStatus", label: "Dispatch status" },
  { key: "courier", label: "Courier" },
  { key: "deliveryAddress", label: "Delivery address" },
  { key: "market", label: "Marketplace" },
  { key: "sku", label: "SKU" },
  { key: "productDetails", label: "Product details" },
  { key: "listingReference", label: "Listing reference" },
];

/**
 * What the conversation itself proves, shared by every order shown under it.
 *
 * `buyer` and `market` are conversation-level and identical across matches —
 * they are the two things the resolver matched ON, so repeating them per block
 * copies nothing between orders. `buyer` is null wherever the stored reference
 * is not a verified customer identity; a source reference is not a person and
 * must never be shown as one.
 */
export type ConversationOrderContext = {
  readonly buyer: string | null;
  readonly market: string | null;
};

const EMPTY_DETAIL: OrderDetail = {
  orderNumber: null,
  buyer: null,
  customerName: null,
  seller: null,
  date: null,
  total: null,
  status: null,
  tracking: null,
  shipmentStatus: null,
  dispatchStatus: null,
  courier: null,
  deliveryAddress: null,
  market: null,
  sku: null,
  productDetails: null,
  listingReference: null,
};

/** Blank rather than empty-string, so "recorded as nothing" reads as "not recorded". */
function present(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === "" ? null : value;
}

/**
 * One order read live from the source, as one detail block.
 *
 * The complete case, and the one the sidebar normally renders: every field the
 * source recorded, for every order that matched. `buyer` and `market` come
 * from the conversation rather than the row — they are what the query matched
 * ON, so they are true of every row it returned — and the fourteenth field,
 * `listingReference`, comes back per order rather than being assumed from the
 * conversation, so a row that somehow carried a different listing would show
 * it rather than hide it.
 */
export function orderDetailFromSource(
  order: SourceOrderDetail,
  context: ConversationOrderContext,
): OrderDetail {
  return {
    orderNumber: present(order.orderNumber),
    buyer: present(context.buyer),
    customerName: present(order.customerName),
    seller: present(order.sellerName),
    date: present(order.orderDate),
    total: present(order.orderTotal),
    status: present(order.orderStatus),
    tracking: present(order.trackingNumber),
    shipmentStatus: present(order.shipmentStatus),
    dispatchStatus: dispatchStatusFrom(present(order.shipmentStatus)),
    courier: present(order.carrierName),
    deliveryAddress: present(order.deliveryAddress),
    market: present(context.market),
    sku: present(order.sku),
    productDetails: present(order.productTitle),
    listingReference: present(order.listingItemRef),
  };
}

/**
 * The cached single order, as one detail block.
 *
 * The fallback when the live read is unavailable — a source outage, or a
 * marketplace this display does not cover. Reads the verified facts by name
 * and nothing else, so `customerName`, `seller` and `total` stay blank: the
 * snapshot never stored them, and filling them from the marketplace label or a
 * sub-source id would put unverified values under the same labels as verified
 * ones.
 */
export function orderDetailFromFacts(
  facts: readonly VerifiedFact[],
  context: ConversationOrderContext,
): OrderDetail {
  const valueOf = (name: string): string | null =>
    present(facts.find((fact) => fact.name === name)?.value);

  return {
    ...EMPTY_DETAIL,
    orderNumber: valueOf("order_number"),
    buyer: present(context.buyer),
    date: valueOf("order_date"),
    status: valueOf("order_status"),
    tracking: valueOf("tracking_number"),
    courier: valueOf("delivery_courier"),
    deliveryAddress: valueOf("delivery_address"),
    market: present(context.market),
    sku: valueOf("sku"),
    productDetails: valueOf("product_title"),
  };
}

/**
 * One stored candidate, as one detail block in the same shape.
 *
 * Fewer fields are filled, and that is the honest picture: `context_order_candidates`
 * records the order number, date and status of each match and nothing else, so
 * tracking, SKU and product details are blank for a candidate. They are blank
 * because nothing was captured for them — not because the order lacks them —
 * and blank is the only rendering of that which does not overstate.
 */
export function orderDetailFromCandidate(
  candidate: OrderCandidate,
  context: ConversationOrderContext,
): OrderDetail {
  return {
    ...EMPTY_DETAIL,
    orderNumber: present(candidate.orderNumber),
    buyer: present(context.buyer),
    date: present(candidate.orderDate),
    status: present(candidate.orderStatus),
    market: present(context.market),
  };
}

/**
 * Every matching order for one conversation, in one list, in one format.
 *
 * ONE SOURCE PER RENDER, IN ORDER OF COMPLETENESS. The live source read is
 * used whenever it returned anything, because it is the only one of the three
 * that carries a customer name, a seller, a total and a shipment status.
 * Stored candidates are the fallback for an ambiguous conversation the source
 * read could not answer, and the cached facts are the fallback for a resolved
 * one — each is a strictly thinner view of the same orders.
 *
 * The three are never combined. Taking a total from the live row and a
 * tracking number from the cached snapshot would produce a block describing an
 * order as it existed at two different moments, which is a merge by another
 * name; one source per render is what keeps every field in a block true
 * together.
 */
export function orderDetailsFrom(
  response: Pick<OrderContextResponse, "facts" | "candidates" | "orders">,
  context: ConversationOrderContext,
): OrderDetail[] {
  if (response.orders.length > 0) {
    return response.orders.map((order) => orderDetailFromSource(order, context));
  }
  if (response.candidates.length > 0) {
    return response.candidates.map((candidate) => orderDetailFromCandidate(candidate, context));
  }
  if (response.facts.length === 0) return [];
  return [orderDetailFromFacts(response.facts, context)];
}
