import "server-only";

import type { Pool, PoolClient } from "pg";

import {
  type ShipmentDispatchDetail,
  type SourceQueryable,
  shipmentDispatchDetail,
} from "@/lib/repositories/dispatch-detail-repository";
import { dispatchEventForShipment } from "@/lib/repositories/dispatch-event-repository";
import { itemById } from "@/lib/repositories/automation-repository";

import type { AutomationItem, DispatchEvent } from "./automation-types";

/**
 * What is really behind one post-dispatch automation record.
 *
 * ------------------------------------------------------------------------
 * THE DISPATCH TIMESTAMP IS THE RECORD'S OWN, NOT A FRESH READ
 * ------------------------------------------------------------------------
 * This is the rule the whole feature turns on, so it is stated here rather than
 * left to the interface.
 *
 * `automation_items.dispatched_at` is the timestamp the SCHEDULER used. It is
 * copied out of `order_management.order_info.shipped_time` when the record is
 * created, `dispatch_source` records that provenance verbatim
 * (`'order_info_shipped_time'`, hard-coded in `INSERT_ITEM`), and `scheduled_at`
 * is computed FROM IT in the database. The Records table prints that same column.
 *
 * So the detail view prints it too. Re-reading `shipped_time` here and showing
 * the answer would produce a screen where the table says one thing and the
 * detail says another, and it would silently change which field the reviewer
 * believes the schedule was built on. The brief forbids both, and the reason is
 * the same in each case: there is one authoritative dispatch moment per record
 * and it has already been chosen.
 *
 * THE LIVE VALUE IS STILL READ, and compared. If the source's `shipped_time` has
 * moved since the record was written, `dispatchDrift` reports both values so a
 * reviewer can see that it happened. It is a reported discrepancy, never the
 * displayed dispatch time — a drift is a fact about the data, not a correction to
 * apply behind somebody's back.
 *
 * ------------------------------------------------------------------------
 * THE SHIPMENT IS THE RECORD'S SHIPMENT
 * ------------------------------------------------------------------------
 * Both source reads are keyed on `item.shipmentId`, never on the order. One
 * order can carry several shipments and each is a separate automation record
 * with its own tracking number and carrier; resolving by order would show the
 * wrong parcel under the right order number. `shipmentsOnOrder` comes back so the
 * view can say when this is one of several.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ------------------------------------------------------------------------
 * No eligibility is evaluated, no schedule is recomputed, no template is
 * rendered and nothing is written anywhere. This is a read. The automation's
 * trigger, its 24-hour delay, its eligibility rules and its templates are
 * untouched by this file, and it is deliberately not called from the runner.
 *
 * Every absent source value stays null. The interface prints "Not available"; it
 * is never filled in here, and no carrier or tracking number is ever defaulted.
 */

/**
 * The application-side query surface, matching `automation-repository`'s own.
 *
 * Restated rather than widened: `itemById` accepts a pool or a pooled client, and
 * declaring anything looser here would let a caller pass a stub the repository
 * cannot actually use.
 */
type Db = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/** A dispatch timestamp that no longer matches the source it was copied from. */
export type DispatchDrift = {
  /** What the record was scheduled from, and what is displayed. */
  readonly recorded: string;
  /** What `order_info.shipped_time` says now. Null when the source no longer has one. */
  readonly sourceNow: string | null;
};

export type AutomationDispatchDetails = {
  /** The record, exactly as the Records table has it. */
  readonly item: AutomationItem;
  /**
   * The live source reading for THIS shipment, or null when the source no longer
   * returns it — a shipment removed since the record was written, or one whose
   * marketplace this application has no channel for.
   */
  readonly event: DispatchEvent | null;
  /** The display-only columns `event` does not carry, or null when unavailable. */
  readonly shipment: ShipmentDispatchDetail | null;
  /**
   * Set only when the source's dispatch timestamp has moved away from the one the
   * record was scheduled on. Null in the ordinary case.
   */
  readonly dispatchDrift: DispatchDrift | null;
};

/** Both halves of a lookup that can fail for one reason worth telling apart. */
export type AutomationDispatchDetailsResult =
  | { readonly found: true; readonly details: AutomationDispatchDetails }
  | { readonly found: false };

/**
 * Everything the detail view shows, for one automation record.
 *
 * THE RECORD IS RESOLVED FIRST, AND ITS ABSENCE IS THE ONLY NOT-FOUND. A record
 * that exists but whose shipment the source can no longer answer for is still
 * found: the view shows the automation half and says the source half is
 * unavailable, which is the honest reading and is different from a bad id.
 *
 * The two source reads run together — they are independent, both keyed on the
 * same shipment id, and one round trip of latency is enough for a click.
 */
export async function getAutomationDispatchDetails(
  app: Db,
  source: SourceQueryable,
  jobId: string,
): Promise<AutomationDispatchDetailsResult> {
  const item = await itemById(app, jobId);
  if (item === undefined) return { found: false };

  const [event, shipment] = await Promise.all([
    dispatchEventForShipment(source, item.shipmentId),
    shipmentDispatchDetail(source, item.shipmentId),
  ]);

  return {
    found: true,
    details: {
      item,
      event: event ?? null,
      shipment: shipment ?? null,
      dispatchDrift: driftOf(item, shipment ?? null),
    },
  };
}

/**
 * Whether the source has moved under the record.
 *
 * Compared as the strings both sides already are — two naive source timestamps,
 * neither parsed into a `Date`. Parsing to compare would reintroduce the
 * process-timezone shift that every `::text` cast in this codebase exists to
 * avoid, and would make two identical values differ across a DST boundary.
 *
 * A source that no longer reports a dispatch at all IS a drift: the record was
 * scheduled on a timestamp the source has since dropped, and that is worth
 * saying rather than hiding behind a missing shipment.
 */
function driftOf(
  item: AutomationItem,
  shipment: ShipmentDispatchDetail | null,
): DispatchDrift | null {
  // No source row at all is reported through `shipment: null`, not as a drift —
  // there is nothing to have drifted from.
  if (shipment === null) return null;
  if (shipment.sourceShippedTime === item.dispatchedAt) return null;
  return { recorded: item.dispatchedAt, sourceNow: shipment.sourceShippedTime };
}
