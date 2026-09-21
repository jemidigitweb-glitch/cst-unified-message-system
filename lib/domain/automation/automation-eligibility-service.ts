import type { AutomationSettings, DispatchEvent } from "./automation-types";

/**
 * Whether one dispatched shipment may be processed. Pure: no database.
 *
 * RUN TWICE, DELIBERATELY. Once at scan time, so an ineligible shipment never
 * becomes a record, and again immediately before processing on a FRESH read of
 * the source — because the 24 hours between those two moments is exactly when
 * an order gets cancelled, refunded or returned, and a message rendered from
 * the scan's snapshot would be a cheerful dispatch update about a parcel the
 * customer has already sent back.
 *
 * THE STATUS VALUES ARE THE SOURCE'S OWN, confirmed live rather than assumed:
 *
 *   order_management.shipment.status   Completed (1,005,997) · New (141,623)
 *                                      · Cancelled (7,045)
 *   order_management.orders.status     Completed (1,079,963) · Refunded (18,887)
 *                                      · Cancelled (10,726) · Deleted (879)
 *                                      · Inprogress (699) · Hold (29) · New (8)
 *
 * So "dispatched" is `shipment.status = 'Completed'` and nothing else: `New` is
 * a shipment that has not gone out. Comparison is case-insensitive because the
 * source's capitalisation is a display choice, not a contract.
 *
 * RETURNS AND CANCELLATIONS ARE AUTHORITATIVE, and this is new. The marketplace
 * tables carry them and they join cleanly on (order number, storefront):
 * `customer_service.ebay_returns` matched all 42,185 of its rows to an order,
 * `ebay_order_cancellations` all 4,551, and `amazon_returns` 13,085 of 15,636.
 * The presence of a return row is treated as "returned" whatever state it is
 * in — 37,814 eBay rows carry a null state, and the safe reading of a return
 * request whose outcome is unrecorded is to say nothing to the customer.
 */

export type Eligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

/** Order states that mean this order is no longer a live, fulfilled sale. */
const INACTIVE_ORDER_STATUSES = new Set(["cancelled", "refunded", "deleted"]);

const DISPATCHED_SHIPMENT_STATUS = "completed";

function normalise(value: string | null): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

export function eligibilityForPostDispatch(
  settings: AutomationSettings,
  event: DispatchEvent,
): Eligibility {
  if (!settings.enabled) return { eligible: false, reason: "AUTOMATION_DISABLED" };

  if (!settings.enabledSubSources.includes(event.subSourceId)) {
    return { eligible: false, reason: "SUB_SOURCE_NOT_ENABLED" };
  }

  /**
   * The backfill floor, re-checked here and not only in the scan query.
   *
   * Both are naive timestamps in the same source zone, so they compare
   * directly. A missing floor is a refusal, never "no floor" — see
   * `scanRefusal` for why that distinction is the whole safety of this feature.
   */
  if (settings.notBefore === null) return { eligible: false, reason: "NOT_BEFORE_UNSET" };
  if (event.dispatchedAt < settings.notBefore) {
    return { eligible: false, reason: "DISPATCHED_BEFORE_FLOOR" };
  }

  const shipmentStatus = normalise(event.shipmentStatus);
  if (shipmentStatus !== DISPATCHED_SHIPMENT_STATUS) {
    return { eligible: false, reason: "SHIPMENT_NOT_DISPATCHED" };
  }
  // The timestamp, not the status: a shipment cancelled after dispatch may keep
  // its Completed status and the cancellation is recorded there instead.
  if (event.shipmentCancelled) return { eligible: false, reason: "SHIPMENT_CANCELLED" };

  const orderStatus = normalise(event.orderStatus);
  if (orderStatus === null) return { eligible: false, reason: "ORDER_STATUS_UNKNOWN" };
  if (INACTIVE_ORDER_STATUSES.has(orderStatus)) {
    return { eligible: false, reason: `ORDER_${orderStatus.toUpperCase()}` };
  }

  // Raised on the marketplace but not yet reflected in `orders.status`. Checked
  // separately because the two move at different speeds, and the window between
  // them is precisely the day this automation waits out.
  if (event.cancellationRaised) return { eligible: false, reason: "ORDER_CANCELLATION_RAISED" };
  if (event.returned) return { eligible: false, reason: "ORDER_RETURNED" };

  /**
   * The values the message cannot be rendered without.
   *
   * An order number and a recipient are the minimum any saved template needs;
   * the template's own `requiredVariables` are checked again at render time,
   * where a missing one fails the record rather than rendering a blank.
   */
  if (event.orderNumber === null || event.orderNumber.trim() === "") {
    return { eligible: false, reason: "ORDER_NUMBER_MISSING" };
  }
  if (event.customerName === null || event.customerName.trim() === "") {
    return { eligible: false, reason: "CUSTOMER_CONTEXT_MISSING" };
  }

  return { eligible: true };
}
