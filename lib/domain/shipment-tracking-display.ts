import { CARRIER_LABELS } from "@/lib/tracking/carrier";
import { TRACKING_STATUS_LABELS, type TrackingResult } from "@/lib/tracking/provider";

/**
 * What a reviewer is shown about a shipment, and nothing more.
 *
 * WHY THIS IS A MODULE AND NOT JSX. Two of the rules governing this display are
 * invisible in a component — that certain fields never reach the screen, and
 * that the wording never overstates what the data is — and a rule you cannot
 * test is a rule that will be broken by whoever edits the component next. Every
 * value the panel renders is produced here, so a test can assert what is in the
 * output and, more importantly, what is not.
 *
 * THE PROJECTION IS THE SAFETY BOUNDARY. `TrackingEvent` carries a `location`;
 * `TrackingHistoryEntry` deliberately has no field to put one in. It is not
 * filtered out at render time, where a later edit could reinstate it — there is
 * nowhere for it to go. The provider already refuses to read `signer`, `geo`,
 * `pod_image`, `parcel_image`, label paths, invoices and costs from the source
 * database, so those cannot arrive here at all; `location` is the one safe-
 * looking field that could, and this is where it stops.
 *
 * WORDING. "Last carrier update", never "Live location" or "Current position".
 * The data is the sync's copy of what a carrier last reported — `retrieval` is
 * `"cached"` for every result this path produces — and a heading promising the
 * present tense would be a claim the data cannot support. The same discipline
 * `verifiedTrackingBlock` already applies to the prompt.
 *
 * PURE. No fetch, no database, no clock.
 */

export const TRACKING_HEADING = "Shipment tracking";

/** The disclosure control, phrased as the action it performs. */
export const TRACKING_HISTORY_TOGGLE = "View tracking history";

/**
 * A carrier timestamp as a person reads it, WITHOUT converting it.
 *
 * "2026-08-31 12:07:00" becomes "31 Aug 2026 12:07". Purely a re-rendering of
 * the same wall-clock value: the parts are split out of the string and
 * reassembled, and `Date` is never involved. That restriction is the whole
 * point — the authoritative zone is the carrier's, we do not know it, and
 * parsing through `Date` would silently shift the value by the server's offset.
 * `TrackingResult.lastUpdated` forbids conversion for exactly that reason.
 *
 * Anything that is not the shape we expect is returned UNCHANGED rather than
 * being coerced into looking right. A timestamp we cannot parse is still the
 * carrier's answer, and showing it verbatim is more honest than showing a
 * confident reformatting of something we did not understand.
 */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function splitCarrierTimestamp(raw: string): { date: string; time: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw.trim());
  if (match === null) return { date: raw, time: "" };

  const [, year, month, day, hour, minute] = match;
  const name = MONTHS[Number(month) - 1];
  if (name === undefined) return { date: raw, time: "" };

  // The day keeps its leading zero so a column of dates aligns; the time keeps
  // its 24-hour padding, because "09:00" and "9:00" read differently in a list.
  return { date: `${day} ${name} ${year}`, time: `${hour}:${minute}` };
}

/** The same value on one line, for the summary row. */
export function formatCarrierTimestamp(raw: string): string {
  const { date, time } = splitCarrierTimestamp(raw);
  return time === "" ? date : `${date} ${time}`;
}

/**
 * The label for the timestamp, named as a constant so the guard test can pin
 * the wording rather than trusting a reader to notice it changing.
 */
export const LAST_CARRIER_UPDATE_LABEL = "Last carrier update";

/**
 * What is said when the carrier has reported nothing.
 *
 * A sentence rather than a blank or a dash. A blank in this row would read as
 * "not loaded", and a dash as "no update exists" — this says which of the two
 * it actually is.
 */
export const NO_CARRIER_UPDATE_TEXT = "The carrier has reported nothing yet";

/** What is said when there are no scans to expand. */
export const NO_HISTORY_TEXT = "No carrier scans recorded";

export const COURIER_LABEL = "Courier";
export const TRACKING_NUMBER_LABEL = "Tracking number";
export const STATUS_LABEL = "Status";

/** One labelled line in the summary. */
export type TrackingRow = {
  readonly label: string;
  readonly value: string;
};

/**
 * The four lines of the summary, in a fixed order.
 *
 * Fixed because a reviewer scanning several conversations reads by position,
 * and because a list built conditionally would let a missing value silently
 * shorten the block rather than say what is missing.
 */
export function trackingSummaryRows(tracking: TrackingResult): readonly TrackingRow[] {
  return [
    { label: COURIER_LABEL, value: CARRIER_LABELS[tracking.carrier] },
    { label: TRACKING_NUMBER_LABEL, value: tracking.trackingNumber },
    { label: STATUS_LABEL, value: TRACKING_STATUS_LABELS[tracking.currentStatus] },
    {
      label: LAST_CARRIER_UPDATE_LABEL,
      value:
        tracking.lastUpdated === null
          ? NO_CARRIER_UPDATE_TEXT
          : formatCarrierTimestamp(tracking.lastUpdated),
    },
  ];
}

/**
 * One scan as a reviewer sees it.
 *
 * THREE FIELDS, AND THERE IS NO FOURTH. `TrackingEvent.location` has no
 * counterpart here on purpose — see the module note. Nothing is added to this
 * type without the same argument being made again.
 */
export type TrackingHistoryEntry = {
  /** The normalised status, in the wording a person would use. */
  readonly status: string;
  /**
   * The carrier's own words for this scan, verbatim — or null when they add
   * nothing.
   *
   * Null when the carrier's wording is the status over again. A scan reading
   * "Delivered" above "Delivered" is a line of noise in a list a reviewer is
   * scanning, and dropping it here rather than in the component keeps the
   * decision testable.
   */
  readonly description: string | null;
  /**
   * The carrier's timestamp, split for the timeline and never converted.
   *
   * Two fields rather than one string because the layout stacks them — the date
   * in weight, the time under it in grey — and splitting a formatted string
   * back apart in JSX is the kind of thing that quietly breaks on the one
   * timestamp that did not parse.
   */
  readonly date: string;
  readonly time: string;
};

/**
 * The scan history, NEWEST FIRST.
 *
 * Reversed relative to `TrackingResult.trackingEvents`, which is oldest-first
 * because that is the order a carrier reports movement. A reviewer opening this
 * wants the most recent line at the top; the prompt, which reads the same data,
 * wants the last element. Both are served without either having to sort.
 */
export function trackingHistoryEntries(
  tracking: TrackingResult,
): readonly TrackingHistoryEntry[] {
  return [...tracking.trackingEvents].reverse().map((event) => {
    const status = TRACKING_STATUS_LABELS[event.status];
    const description = event.description.trim();
    const { date, time } = splitCarrierTimestamp(event.timestamp);
    return {
      status,
      description:
        description === "" || description.toLowerCase() === status.toLowerCase()
          ? null
          : description,
      date,
      time,
    };
  });
}
