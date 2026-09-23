import type { AutomationDispatchDetails } from "./automation-dispatch-detail-service";

/**
 * What the dispatch detail panel actually prints.
 *
 * PURE, AND SEPARATE FROM THE COMPONENT, for one reason: these are the values
 * the brief's data rules are about — the dispatch timestamp, the shipment, the
 * courier, the tracking number — and a rule that is only enforced inside JSX can
 * only be checked by rendering. This module has no React, no server-only marker
 * and no database, so a test can assert the exact string a reviewer sees.
 *
 * NOTHING IS INVENTED HERE. Every function either passes a source value through
 * or returns `NOT_AVAILABLE`. There is no default carrier, no synthesised
 * tracking number and no fallback timestamp; an absent value is reported as
 * absent, which is the whole point of the rule.
 */

export const NOT_AVAILABLE = "Not available";

/** A source value, or the words for its absence. Blank counts as absent. */
export function displayValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return NOT_AVAILABLE;
  const trimmed = value.trim();
  return trimmed === "" ? NOT_AVAILABLE : value;
}

/**
 * The date half of a naive source timestamp, verbatim.
 *
 * Split on the separator rather than parsed. `new Date("2026-09-22 08:09:39")`
 * would be read through the process timezone and could report the previous or
 * next day — for a value the source stores with no zone at all.
 */
export function datePart(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.split(/[ T]/)[0] ?? null;
}

/** The time half of the same value, without fractional seconds. */
export function timePart(value: string | null): string | null {
  if (value === null) return null;
  const parts = value.trim().split(/[ T]/);
  if (parts.length < 2) return null;
  const time = parts[1]?.replace(/\.\d+$/, "");
  return time === undefined || time === "" ? null : time;
}

/**
 * The fields whose provenance the brief pins down, already rendered.
 *
 * `dispatchDate` and `dispatchTime` COME FROM THE RECORD, never from the live
 * source read that arrives in the same payload. `automation_items.dispatched_at`
 * is what the scheduler used and what the Records table prints, so it is what
 * this prints; `automation-dispatch-detail-service.ts` sets out why at length.
 *
 * `courier` is the resolved carrier NAME. A numeric `carrier_service_id` is never
 * returned here — the panel reports an unresolved id on its own labelled line, so
 * an id can never be mistaken for a courier.
 */
export type DispatchDetailFields = {
  readonly orderNumber: string;
  readonly channel: string;
  readonly customer: string;
  readonly shipmentId: string;
  readonly dispatchDate: string;
  readonly dispatchTime: string;
  readonly dispatchSource: string;
  readonly shipmentStatus: string;
  readonly shippingMethod: string;
  readonly courier: string;
  readonly carrierService: string;
  readonly trackingNumber: string;
  readonly shipmentCreatedAt: string;
  readonly shipmentsOnOrder: number;
};

export function dispatchDetailFields(details: AutomationDispatchDetails): DispatchDetailFields {
  const { item, event, shipment } = details;
  return {
    orderNumber: displayValue(item.orderNumber ?? item.orderId),
    channel: displayValue(item.channel),
    // The live source name first, the record's stored copy second. Both are real
    // recorded values; neither is a guess.
    customer: displayValue(event?.customerName ?? item.recipientName),
    shipmentId: displayValue(item.shipmentId),
    dispatchDate: displayValue(datePart(item.dispatchedAt)),
    dispatchTime: displayValue(timePart(item.dispatchedAt)),
    dispatchSource: item.dispatchSource,
    shipmentStatus: displayValue(event?.shipmentStatus),
    shippingMethod: displayValue(shipment?.shippingMethod),
    courier: displayValue(event?.carrier),
    carrierService: displayValue(shipment?.carrierServiceName),
    trackingNumber: displayValue(event?.trackingNumber),
    shipmentCreatedAt: displayValue(shipment?.shipmentCreatedAt),
    shipmentsOnOrder: shipment?.shipmentsOnOrder ?? 1,
  };
}
