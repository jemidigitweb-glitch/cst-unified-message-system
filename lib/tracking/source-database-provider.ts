import "server-only";

import { getSourcePool } from "@/lib/db/pools";

import { type Carrier, CARRIERS, carrierFrom } from "./carrier";
import {
  type TrackingEvent,
  type TrackingProvider,
  type TrackingRequest,
  type TrackingResult,
  type TrackingStatus,
  TrackingNotFound,
  TrackingUnavailable,
} from "./provider";

/**
 * Tracking answered from the source database rather than from a carrier.
 *
 * WHY THIS EXISTS. The upstream application already polls every carrier and
 * writes the result to `order_management.shipment_tracking_log`. That is one
 * synced, carrier-agnostic table covering Royal Mail, Evri, DHL, DPD and the
 * rest, whereas `royal-mail-provider.ts` is a single carrier's API that has
 * never been connected. Reading what is already there costs no credential, no
 * outbound request and no per-carrier integration.
 *
 * STRICTLY READ-ONLY. Every statement is a parameterised SELECT against the
 * source pool, which pins `default_transaction_read_only=on`. Nothing here
 * writes anywhere, and nothing here is part of the sync pipeline: it runs on
 * demand, from a draft request.
 *
 * WHAT IT DELIBERATELY DOES NOT READ. `shipment_tracking_log.events` is a jsonb
 * array whose elements carry `signer` (the name of the person who signed for the
 * parcel), `geo` (coordinates), `pod_image` and `parcel_image` (photographs of
 * the delivery point, which means of somebody's property), and city/state.
 * NONE of it is selected. The columns this reads — `status`,
 * `last_event_desc`, `last_event_datetime` — are a controlled vocabulary: 32
 * distinct `last_event_desc` values across 32,895 rows, all carrier status
 * wording or sorting-facility names, none of them personal. `TrackingEvent`
 * carries `location: null` for the same reason: the only location this source
 * has is inside that jsonb.
 *
 * IT REFUSES RATHER THAN GUESSES, in four situations that each have their own
 * branch below: an unknown reference, a reference shared across orders, an
 * order with more than one parcel, and a non-terminal status too old to state.
 * Every refusal throws, and `resolve-tracking-context.ts` turns every throw into
 * "no tracking" — the draft is written exactly as it would have been before
 * this existed.
 */

/** The narrow query surface, matching `order-context-repository.ts`. */
export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export const SOURCE_DATABASE_PROVIDER_NAME = "source_database";

/**
 * How old a NON-TERMINAL status may be and still be stated.
 *
 * Measured on the live table: of the rows in a status that can still change,
 * 91.9% of "Label Created" and 81.1% of "Intransit" were polled within 24
 * hours, so this threshold keeps the great majority while cutting the long
 * tail. The tail is what matters — the oldest rows in the table are months old.
 *
 * STALE IS NOT A FALLBACK, the same rule `tracking-cache.ts` already states. An
 * "In transit" from three weeks ago presented as the current position is the
 * one failure mode that would make this feature worse than not having it, and
 * it is worse precisely because it reads as authoritative.
 */
export const MAX_NON_TERMINAL_AGE_HOURS = 24;

/**
 * Statuses that cannot change, and are therefore safe at any age.
 *
 * A parcel that was delivered a month ago is still delivered. Applying the
 * freshness rule to these would throw away the 94.6% of the table that is
 * `Delivered` — every one of them correct — because polling stops once there is
 * nothing left to poll for.
 */
const TERMINAL: ReadonlySet<TrackingStatus> = new Set<TrackingStatus>([
  "delivered",
  "returned_to_sender",
]);

/**
 * The source system's status words, mapped onto this application's vocabulary.
 *
 * Six values cover the whole table. `Deleted` is the one that does not describe
 * a parcel at all — it means the shipment was cancelled on our side — so it maps
 * to `unknown` rather than to anything a customer could read as a position.
 * Anything unrecognised maps to `unknown` too, which is a real answer here
 * rather than a failure: see `TRACKING_STATUSES`.
 */
const STATUS_BY_SOURCE: Readonly<Record<string, TrackingStatus>> = {
  "label created": "pre_transit",
  intransit: "in_transit",
  "in transit": "in_transit",
  delivered: "delivered",
  problem: "exception",
  returned: "returned_to_sender",
  deleted: "unknown",
};

/**
 * Refinements the coarse status cannot express.
 *
 * `status` never says "out for delivery" or "we tried and missed you" — both sit
 * under `Intransit` — but `last_event_desc` does, and those two are exactly the
 * distinctions a customer chasing a parcel is asking about. Applied ONLY to a
 * status that is still moving, so a refinement can never contradict a terminal
 * state.
 *
 * Matched on the wording actually present in the table, including the Chinese
 * strings a cross-border carrier writes.
 */
const EVENT_REFINEMENTS: readonly (readonly [RegExp, TrackingStatus])[] = [
  [/out for delivery|due to be delivered today|正在派送途中/i, "out_for_delivery"],
  [/delivery attempt(ed| unsuccessful)|delivery failed/i, "attempted_delivery"],
  [
    /available for collection|available to collect|ready for delivery|enquiry office|item retention|待自取/i,
    "awaiting_collection",
  ],
];

/**
 * SELECT ONLY, and only the columns that are safe to state.
 *
 * `shipments_on_order` is the multi-parcel check: a reference is only usable if
 * the order behind it has exactly one shipment, because otherwise a confident
 * "your parcel was delivered" is a statement about one of several boxes and the
 * customer is asking about a different one.
 *
 * Timestamps are formatted and aged IN SQL rather than in JavaScript. Both
 * columns are `timestamp without time zone`; handing them to a `Date` would
 * apply the server's offset to a value whose zone we do not know, which is the
 * conversion `TrackingResult.lastUpdated` explicitly forbids.
 *
 * `safe_events` IS THE SCAN HISTORY, PROJECTED IN SQL RATHER THAN IN
 * JAVASCRIPT. Each element of the source array also carries the name of the
 * person who signed, coordinates, two photographs of the delivery point, and a
 * city and region. Rebuilding each element from three named keys —
 * `event_datetime`, `event_desc`, `event_code` — means none of the rest is ever
 * SELECTed: they do not cross the database boundary, so no later edit to this
 * file can leak one by forgetting to strip it. The statement is asserted
 * against that list by name in the tests, which is also why those field names
 * appear in this comment and NOT inside the query text.
 *
 * `ORDER BY ord DESC` because the source stores newest first and
 * `TrackingResult.trackingEvents` is contractually oldest first.
 */
const TRACKING_QUERY = `
SELECT
  sh.order_id                                                     AS order_id,
  cs.carrier                                                      AS carrier_text,
  l.status                                                        AS log_status,
  l.last_event_desc                                               AS last_event_desc,
  to_char(l.last_event_datetime, 'YYYY-MM-DD HH24:MI:SS')         AS last_event_at,
  EXTRACT(EPOCH FROM (now() - l.api_called_at)) / 3600            AS api_age_hours,
  (SELECT count(*) FROM order_management.shipment sib
    WHERE sib.order_id = sh.order_id)                             AS shipments_on_order,
  (SELECT jsonb_agg(
            jsonb_build_object(
              'at',   e->>'event_datetime',
              'desc', e->>'event_desc',
              'code', e->>'event_code')
            ORDER BY ord DESC)
     FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(l.events) = 'array' THEN l.events ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS t(e, ord))                         AS safe_events
FROM order_management.shipment sh
LEFT JOIN order_management.carrier_service cs ON cs.id = sh.carrier_service_id
LEFT JOIN order_management.shipment_tracking_log l ON l.tracking_number = sh.tracking_number
WHERE sh.tracking_number = $1`;

/** One scan, already reduced to the three fields that may be stated. */
export type SafeEvent = {
  at: string | null;
  desc: string | null;
  code: string | null;
};

type Row = {
  order_id: string | number | null;
  carrier_text: string | null;
  log_status: string | null;
  last_event_desc: string | null;
  last_event_at: string | null;
  api_age_hours: string | number | null;
  shipments_on_order: string | number | null;
  safe_events: SafeEvent[] | null;
};

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The status of ONE SCAN, read from the carrier's own wording for it.
 *
 * Separate from `statusFrom`, which answers "where is this parcel now" from the
 * row's coarse `status`. A history line has no coarse status of its own — only
 * the sentence the carrier wrote — so this is the only thing available, and it
 * is genuinely more informative: the row says `Intransit` for a week while the
 * scans underneath it move from "Data Received" to "Out for delivery".
 *
 * ORDER IS LOAD-BEARING, and each entry below sits where it does for a reason
 * checked against the 32 distinct descriptions in the live table:
 *
 *   attempted before everything  "Delivery attempt unsuccessful" contains the
 *                                word "delivery" and must not read as delivered.
 *   out-for-delivery before      "Due to be delivered today" contains
 *   delivered                    "delivered" and is a promise, not an arrival.
 *
 * Anything unrecognised is `in_transit` rather than `unknown`: a scan exists,
 * so the parcel demonstrably moved. `unknown` is reserved for having no scan.
 */
const EVENT_STATUS: readonly (readonly [RegExp, TrackingStatus])[] = [
  [/delivery attempt|delivery failed/i, "attempted_delivery"],
  [/out for delivery|due to be delivered|正在派送途中/i, "out_for_delivery"],
  [/\breturn(ed|ing)?\b/i, "returned_to_sender"],
  [/delivered|已签收|delivery confirmed|collected from/i, "delivered"],
  [
    /available for collection|available to collect|item retention|enquiry office|local collect|待自取/i,
    "awaiting_collection",
  ],
  [/data received|label created|订单信息已收到/i, "pre_transit"],
];

export function statusFromScan(description: string | null): TrackingStatus {
  const text = description ?? "";
  if (text.trim() === "") return "unknown";
  for (const [pattern, status] of EVENT_STATUS) {
    if (pattern.test(text)) return status;
  }
  return "in_transit";
}

/** The normalised status for one log row. Exported so the mapping can be tested directly. */
export function statusFrom(logStatus: string | null, lastEventDesc: string | null): TrackingStatus {
  const base = STATUS_BY_SOURCE[(logStatus ?? "").trim().toLowerCase()] ?? "unknown";
  if (TERMINAL.has(base)) return base;

  const description = lastEventDesc ?? "";
  for (const [pattern, refined] of EVENT_REFINEMENTS) {
    if (pattern.test(description)) return refined;
  }
  return base;
}

/** Whether a status of this age may be stated. Exported for the same reason. */
export function isFreshEnough(status: TrackingStatus, apiAgeHours: number | null): boolean {
  if (TERMINAL.has(status)) return true;
  return apiAgeHours !== null && apiAgeHours <= MAX_NON_TERMINAL_AGE_HOURS;
}

/**
 * One provider, bound to one carrier.
 *
 * Bound per carrier because `TrackingProvider` is keyed that way and the
 * registry finds by `provider.carrier`. The data behind every instance is the
 * same table — this is one source wearing fourteen labels, not fourteen
 * integrations.
 *
 * `queryable` is injectable so the decision logic can be tested against scripted
 * rows without a database. Left out, it resolves the read-only source pool
 * lazily, on the call rather than at import.
 */
export function createSourceDatabaseProvider(
  carrier: Carrier,
  queryable?: Queryable,
): TrackingProvider {
  return {
    carrier,
    name: SOURCE_DATABASE_PROVIDER_NAME,

    async track(request: TrackingRequest): Promise<TrackingResult> {
      /*
       * The pool is resolved INSIDE the call and inside the guard.
       *
       * `getSourcePool` validates configuration and throws when the source
       * database is not set up — which is a perfectly ordinary state in a test
       * or a fresh checkout. Letting that escape would surface a config parse
       * error from a tracking lookup, and the gate above would log it as a
       * carrier failure. It is a refusal like any other.
       */
      let client: Queryable;
      try {
        client = queryable ?? (getSourcePool() as unknown as Queryable);
      } catch {
        throw new TrackingUnavailable("The source database is not available for tracking.");
      }

      let rows: Row[];
      try {
        const result = await client.query({
          text: TRACKING_QUERY,
          values: [request.trackingNumber],
        });
        rows = result.rows as Row[];
      } catch (cause) {
        // The database message may quote the statement, and the statement
        // carries a real consignment reference. Never returned, never logged
        // with its parameters.
        console.error(`[tracking] source lookup failed: ${(cause as Error).name}`);
        throw new TrackingUnavailable("The tracking record could not be read.");
      }

      if (rows.length === 0) {
        throw new TrackingNotFound("No shipment carries this tracking reference.");
      }

      /*
       * ONE REFERENCE, ONE ORDER. 380 of the 40,836 tracking numbers used in a
       * recent 90-day window appear on more than one shipment row, so this is a
       * real state rather than a defensive nicety. Answering would mean picking
       * an order, and a status about the wrong order is indistinguishable from
       * a status about the right one.
       */
      const orders = new Set(rows.map((row) => String(row.order_id)));
      if (orders.size > 1) {
        throw new TrackingUnavailable(
          "This tracking reference is recorded against more than one order.",
        );
      }

      const row = rows[0]!;

      /*
       * ONE ORDER, ONE PARCEL. About 1% of orders ship in more than one box.
       * The order context upstream picks the most recently created shipment,
       * so without this a two-parcel order would get a confident answer about
       * whichever box happened to be labelled last — and the customer is
       * writing about the one that has not arrived.
       */
      const shipmentsOnOrder = numberOrNull(row.shipments_on_order) ?? 1;
      if (shipmentsOnOrder > 1) {
        throw new TrackingUnavailable(
          `This order was sent in ${shipmentsOnOrder} parcels; tracking one of them would not answer the question.`,
        );
      }

      /*
       * A SHIPMENT WITH NO CARRIER RECORD IS NOT AN UNKNOWN STATUS.
       *
       * The label exists and the carrier has never been polled for it, which is
       * a different thing from having asked and been told nothing. Reporting
       * "Not known" under a heading that reads VERIFIED TRACKING INFORMATION
       * would claim we checked.
       */
      if (row.log_status === null && row.last_event_at === null) {
        throw new TrackingNotFound("The carrier has not reported on this reference.");
      }

      /*
       * The stored courier must agree with the carrier being asked about.
       * A reference that belongs to a different carrier means the order context
       * and the shipment row have diverged, and answering would attribute one
       * carrier's scan to another. An unrecognised courier string is not a
       * disagreement — `carrierFrom` returns null for 320,593 shipments that
       * carry no usable carrier at all — so it proceeds on the caller's value.
       */
      const storedCarrier = carrierFrom(row.carrier_text);
      if (storedCarrier !== null && storedCarrier !== request.carrier) {
        throw new TrackingUnavailable("The shipment is recorded against a different carrier.");
      }

      const currentStatus = statusFrom(row.log_status, row.last_event_desc);
      const apiAgeHours = numberOrNull(row.api_age_hours);

      if (!isFreshEnough(currentStatus, apiAgeHours)) {
        throw new TrackingUnavailable(
          "The last carrier update is too old to state as the current position.",
        );
      }

      /*
       * THE WHOLE SCAN HISTORY, oldest first, from the three safe fields.
       *
       * The rest of each event — signer, geo, the delivery photographs, the
       * city — was never SELECTed, so there is nothing here to strip. `location`
       * is null for that reason: the only location this source holds is one of
       * the fields the query refuses to read.
       *
       * A scan needs both a timestamp and a description to be worth a line; one
       * without the other cannot be placed in the history or explained in it.
       *
       * FALLS BACK TO THE SINGLE LAST EVENT when the array is absent or unusable
       * — some rows carry `last_event_desc` with no `events` array at all, and
       * one true line beats none.
       */
      const fromArray: TrackingEvent[] = (row.safe_events ?? [])
        .filter((scan) => scan.at !== null && (scan.desc ?? "").trim() !== "")
        .map((scan) => ({
          status: statusFromScan(scan.desc),
          description: scan.desc!.trim(),
          location: null,
          timestamp: scan.at!,
        }));

      const trackingEvents: readonly TrackingEvent[] =
        fromArray.length > 0
          ? fromArray
          : row.last_event_desc !== null &&
              row.last_event_desc.trim() !== "" &&
              row.last_event_at !== null
            ? [
                {
                  status: currentStatus,
                  description: row.last_event_desc.trim(),
                  location: null,
                  timestamp: row.last_event_at,
                },
              ]
            : [];

      return {
        carrier: request.carrier,
        trackingNumber: request.trackingNumber,
        currentStatus,
        trackingEvents,
        lastUpdated: row.last_event_at,
        source: {
          provider: SOURCE_DATABASE_PROVIDER_NAME,
          /*
           * "cached", NOT "live", and this is the honest value rather than a
           * pessimistic one. Nothing here contacted a carrier: this is the
           * upstream sync's copy of what a carrier said when it was last
           * polled. `verifiedTrackingBlock` turns "cached" into an explicit
           * instruction not to present the status as the position right now,
           * which is exactly the caveat this data needs.
           */
          retrieval: "cached",
        },
      };
    },
  };
}

/**
 * One instance per carrier, all reading the same table.
 *
 * Every carrier this system can name gets one, because the source table is
 * carrier-agnostic — there is no carrier for which the data would be present
 * but this provider could not read it.
 */
export const sourceDatabaseProviders: readonly TrackingProvider[] = CARRIERS.map((carrier) =>
  createSourceDatabaseProvider(carrier),
);
