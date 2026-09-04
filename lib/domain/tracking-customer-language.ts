import { splitCarrierTimestamp } from "./shipment-tracking-display";
import type { TrackingResult, TrackingStatus } from "@/lib/tracking/provider";

/**
 * What a CUSTOMER may be told about a parcel, as opposed to what we know.
 *
 * WHY THIS EXISTS. The tracking layer already keeps two registers and says so:
 * `TrackingEvent.status` is "what the application reasons about" and
 * `TrackingEvent.description` is "what the carrier actually said", kept for a
 * reviewer (see `lib/tracking/provider.ts`). The prompt collapsed them — it
 * printed the carrier's own words beside the normalised status under one
 * heading reading VERIFIED, told the model to "say what the carrier recorded",
 * and got exactly that:
 *
 *   "Royal Mail tracking shows Data Received on 28 August at 05:56 and Not yet
 *    with the carrier."
 *
 * Every word of that is true and none of it is English a customer should read.
 * "Data Received" is the carrier's pre-scan event, "05:56" is a database
 * timestamp, and "Not yet with the carrier" is OUR internal label, written for
 * the reviewer's sidebar.
 *
 * SO THE THIRD REGISTER IS DECLARED HERE. One sentence per normalised status,
 * in the words the CST team would use. The mapping is keyed on `TrackingStatus`
 * — nine values, closed — rather than on the carrier's wording, so a scan
 * description nobody has seen before is handled by the status it normalises to
 * instead of by a phrase list that would have to grow forever.
 *
 * NOT IN `lib/tracking/provider.ts`, deliberately. That module is the carrier
 * boundary; how we speak to a customer is not a carrier's business. And NOT by
 * editing `TRACKING_STATUS_LABELS`, which the reviewer's panel renders —
 * changing those would silently reword the screen a human reads while trying to
 * fix the text a customer reads.
 *
 * PURE. No network, no database, no clock.
 */

/** One status, said out loud. */
export type DeliveryWording = {
  /**
   * Whether this sentence states WHERE THE PARCEL IS.
   *
   * False does not mean "say nothing" — every status has a sentence. It means
   * the sentence is a holding line rather than a position, so nothing may be
   * built on it: no date, no arrival estimate, no inference about movement.
   */
  readonly statesAPosition: boolean;
  /**
   * Whether a confirmed dispatch may speak in this sentence's place.
   *
   * TRUE ONLY WHERE THE CARRIER HAS NOTHING TO SAY. A label made and never
   * scanned, or a status we could not map, leaves "your order has been
   * dispatched" as the most useful true thing we hold. An EXCEPTION is not that
   * case: the carrier has said something, and what it said is that the parcel
   * is in trouble. Answering "dispatched and on its way" there would be a
   * reassurance the record contradicts — which is the failure mode this whole
   * module exists to prevent, arrived at from the polite direction.
   */
  readonly dispatchMaySpeakInstead: boolean;
  readonly sentence: string;
};

/**
 * DISPATCH IS AN ORDER FACT, NOT A SCAN.
 *
 * Kept out of the map below on purpose. `pre_transit` means the label exists
 * and the carrier has not scanned the parcel — "Data Received", "Label
 * Created" — and reading that as "dispatched" would be inventing a movement
 * from its absence. What settles dispatch is the order context: a booked
 * shipment carries a tracking number, which is what `dispatchState` reads.
 *
 * The CST delivery rules take the same view, and say so in the sheet that
 * governs this exact state: "⚠ Do NOT say parcel was not sent."
 *
 * AND DISPATCH IS NOT MOVEMENT EITHER. These are two facts from two sources: we
 * handed the parcel over (the order says so) and the carrier has scanned it
 * somewhere (the carrier says so). The first was being read as both, so a
 * shipment sitting at "Data Received" — the carrier holding a label and nothing
 * else — was answered "dispatched and is on its way". The customer chasing it
 * can see the same tracking page we can, showing no movement at all, and a
 * reassurance they can disprove in one click is worse than the silence it
 * replaced. Hence two sentences below, and `carrierHasReportedMovement` to
 * choose between them.
 */
export const DISPATCHED_SENTENCE = "Your order has been dispatched and is on its way.";

/**
 * Dispatched, and the carrier has not scanned it yet.
 *
 * SAYS BOTH FACTS AND CLAIMS NEITHER MORE. It states what we know — it left us
 * — and is honest about what we do not, which is where it has got to. That is
 * also what the CST delivery rules prescribe for this exact state: the sheet
 * covering an unscanned parcel says to tell the customer the courier has not
 * yet scanned it and that scans can take up to 48 hours, never that it is on
 * its way and never that it was not sent.
 */
export const DISPATCHED_NO_MOVEMENT_SENTENCE =
  "Your order has been dispatched, but tracking has not shown further movement yet.";

/** What we say while there is nothing to say. */
export const CHECKING_WITH_COURIER_SENTENCE =
  "We are checking the delivery status with the courier.";
const CHECKING_INFORMATION_SENTENCE = "We are checking the latest delivery information.";

/**
 * The customer-facing sentence for each normalised status.
 *
 * TOTAL BY CONSTRUCTION. `Record<TrackingStatus, …>` means a status added to
 * `TRACKING_STATUSES` later cannot reach a customer without someone writing the
 * words for it — the compiler asks, rather than a default quietly answering.
 *
 * `attempted_delivery` and `returned_to_sender` are stated plainly rather than
 * left out: both are ordinary things to tell somebody chasing a parcel, and a
 * status with no wording would fall through to a holding line that says less
 * than we know.
 */
export const CUSTOMER_DELIVERY_LANGUAGE: Readonly<Record<TrackingStatus, DeliveryWording>> = {
  // The carrier has the label and has not scanned the parcel. That is not a
  // position, and it is emphatically not "we have not sent it".
  pre_transit: {
    statesAPosition: false,
    dispatchMaySpeakInstead: true,
    sentence: CHECKING_INFORMATION_SENTENCE,
  },
  in_transit: {
    statesAPosition: true,
    dispatchMaySpeakInstead: false,
    sentence: "Your parcel is currently in transit.",
  },
  out_for_delivery: {
    statesAPosition: true,
    dispatchMaySpeakInstead: false,
    sentence: "Your parcel is out for delivery.",
  },
  delivered: {
    statesAPosition: true,
    dispatchMaySpeakInstead: false,
    sentence: "Your parcel has been delivered.",
  },
  attempted_delivery: {
    statesAPosition: true,
    dispatchMaySpeakInstead: false,
    sentence: "A delivery was attempted and the parcel could not be handed over.",
  },
  awaiting_collection: {
    statesAPosition: true,
    dispatchMaySpeakInstead: false,
    sentence: "Your parcel is ready for collection.",
  },
  returned_to_sender: {
    statesAPosition: true,
    dispatchMaySpeakInstead: false,
    sentence: "Your parcel is on its way back to us.",
  },
  // The carrier's own exception wording names facilities, codes and internal
  // handling. None of it is customer language, and the honest customer-facing
  // statement is that we are looking into it — NOT that the parcel is on its
  // way, which is why dispatch may not speak here.
  exception: {
    statesAPosition: false,
    dispatchMaySpeakInstead: false,
    sentence: CHECKING_WITH_COURIER_SENTENCE,
  },
  unknown: {
    statesAPosition: false,
    dispatchMaySpeakInstead: true,
    sentence: CHECKING_INFORMATION_SENTENCE,
  },
};

/** Where a customer-facing sentence came from, so the caller knows what it can rest on. */
export type DeliveryWordingSource =
  /** The carrier's normalised status for this parcel. */
  | "tracking"
  /** The order's own record that a shipment was booked. */
  | "order"
  /** Nothing established a position; the sentence is a holding line. */
  | "none";

export type CustomerDeliveryStatus = {
  readonly sentence: string;
  readonly statesAPosition: boolean;
  readonly source: DeliveryWordingSource;
  /**
   * Whether the CARRIER has the parcel moving, as distinct from us having sent
   * it. Only this licenses "on its way", "in transit" or any other wording that
   * puts the parcel in the network.
   */
  readonly movementConfirmed: boolean;
};

/**
 * The two statuses that are not movement.
 *
 * `pre_transit` is a label the carrier has been told about; `unknown` is a
 * status we could not map, which supports nothing at all. Everything else means
 * the carrier has physically handled the parcel at least once — including
 * `exception` and `returned_to_sender`, which are movement in a direction
 * nobody wanted but movement all the same.
 */
function isMovement(status: TrackingStatus): boolean {
  return status !== "pre_transit" && status !== "unknown";
}

/**
 * Whether the carrier has reported the parcel moving.
 *
 * READS THE SCANS AS WELL AS THE HEADLINE STATUS, and the second half is what
 * makes it right rather than merely convenient. A row whose coarse status this
 * system could not map comes through as `unknown`, and the scans underneath it
 * may still show a parcel halfway across the country — see `statusFromScan` in
 * `lib/tracking/source-database-provider.ts`, which reads each scan on its own
 * terms for exactly that reason.
 *
 * NO TRACKING IS NOT MOVEMENT. Absence of a lookup is absence of evidence, and
 * this returns false — the same discipline the rest of the draft layer applies
 * to every fact it was not given.
 */
export function carrierHasReportedMovement(
  tracking: TrackingResult | null | undefined,
): boolean {
  if (tracking === null || tracking === undefined) return false;
  if (isMovement(tracking.currentStatus)) return true;
  return tracking.trackingEvents.some((event) => isMovement(event.status));
}

/**
 * The one sentence a reply may use for where this parcel is.
 *
 * TWO SOURCES, AND THE ORDER BETWEEN THEM MATTERS. A carrier status that states
 * a position wins, because it is the more specific claim — "out for delivery"
 * says everything "dispatched" says and more. Where the carrier has nothing to
 * state, dispatch may still be known from the order, and saying so is both true
 * and what the customer actually wants to hear on the day a label was made and
 * nothing has been scanned.
 *
 * "NOTHING TO STATE" IS NARROWER THAN "NO POSITION". An exception states no
 * position either, and it is emphatically not a case for "on its way" — see
 * `dispatchMaySpeakInstead`.
 *
 * DISPATCH SPEAKS IN TWO VOICES, and which one depends on the carrier, not on
 * us. Having sent a parcel says nothing about where it is; only a scan does.
 * So a confirmed dispatch with no movement gets the sentence that says exactly
 * that, and "on its way" is reserved for the case where something actually
 * moved. This is the whole of the difference between a true reassurance and one
 * the customer can disprove by refreshing the tracking page.
 *
 * `dispatchConfirmed` is passed in rather than derived here: what establishes
 * dispatch is verified order context, and this module is not given facts. See
 * `dispatchState` in `lib/ai/draft-validation.ts`, which is the one place that
 * decides it.
 */
export function customerDeliveryStatus(
  tracking: TrackingResult | null | undefined,
  dispatchConfirmed: boolean,
): CustomerDeliveryStatus {
  const wording =
    tracking === null || tracking === undefined
      ? null
      : CUSTOMER_DELIVERY_LANGUAGE[tracking.currentStatus];
  const movementConfirmed = carrierHasReportedMovement(tracking);

  if (wording !== null && wording.statesAPosition) {
    return {
      sentence: wording.sentence,
      statesAPosition: true,
      source: "tracking",
      movementConfirmed,
    };
  }

  if (dispatchConfirmed && (wording?.dispatchMaySpeakInstead ?? true)) {
    return {
      sentence: movementConfirmed ? DISPATCHED_SENTENCE : DISPATCHED_NO_MOVEMENT_SENTENCE,
      /*
       * "Dispatched, nothing scanned" states no position and must not be built
       * on — no arrival, no delay, no journey. It is a fact about us, not about
       * the parcel's whereabouts, so the caller still gets `false` here and the
       * block still tells the model not to construct movement on top of it.
       */
      statesAPosition: movementConfirmed,
      source: "order",
      movementConfirmed,
    };
  }

  return {
    sentence: wording?.sentence ?? CHECKING_INFORMATION_SENTENCE,
    statesAPosition: false,
    source: "none",
    movementConfirmed,
  };
}

/**
 * A carrier timestamp as a DATE, with no time of day.
 *
 * The time is dropped rather than reformatted. "12:35:03" is a scan record;
 * "on 30 Aug 2026" is when the parcel arrived, and the second is the whole of
 * what a customer needs. Reuses `splitCarrierTimestamp`, which re-renders the
 * parts of the string without ever parsing it through `Date` — the carrier's
 * timezone is unknown and a value silently shifted by an hour is worse than an
 * unconverted one.
 *
 * Null when there is no usable timestamp, so a caller omits the line rather
 * than printing a raw one.
 */
export function customerDeliveryDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const { date, time } = splitCarrierTimestamp(raw);
  // An unparsed timestamp comes back unchanged with an empty time — that is the
  // raw string, and the raw string is exactly what must not reach a customer.
  return time === "" ? null : date;
}

/**
 * Wording that is ours or the carrier's, and never the customer's.
 *
 * A CLOSED VOCABULARY WE OWN, not an attempt to recognise carrier language in
 * general. Three of these lists come from things this system itself produces —
 * the nine status identifiers, the two internal labels, the database timestamp
 * format — and the rest are the pre-dispatch and facility wording actually
 * present in `order_management.shipment_tracking_log`, whose 32 distinct
 * `last_event_desc` values are documented in
 * `lib/tracking/source-database-provider.ts`.
 *
 * IT IS A NET, NOT THE RULE. The rule is stated to the model in the tracking
 * block: the normalised status is the only tier that may be spoken. This
 * catches what slips through, and it is deliberately narrow — every entry here
 * costs a regeneration when it fires, so a phrase that a careful reply might
 * legitimately contain does not belong in it. "Due to be delivered today" is a
 * carrier description and is absent for exactly that reason: it is also a
 * perfectly good English sentence about a parcel.
 *
 * Shared with `verifiedTrackingBlock`, which quotes the examples to the model,
 * so what the model is warned about and what the validator catches cannot drift.
 */
export type TechnicalTrackingTerm = {
  /** What kind of thing leaked, for the reviewer's finding. */
  readonly label: string;
  readonly pattern: RegExp;
};

export const TECHNICAL_TRACKING_LANGUAGE: readonly TechnicalTrackingTerm[] = [
  {
    label: "a carrier pre-dispatch event",
    pattern:
      /\b(?:data\s+received|label\s+created|shipment\s+information\s+received|manifest(?:\s+generated|ed)?|pre[-\s]?advice)\b/i,
  },
  {
    label: "a carrier scan description",
    pattern:
      /\b(?:item\s+scanned\s+on\s+its\s+journey|received\s+by\s+local\s+delivery\s+company|delivery\s+attempt\s+unsuccessful)\b/i,
  },
  {
    label: "a carrier facility name",
    pattern:
      /\b(?:sort(?:ing)?\s+(?:facility|cent(?:re|er)|hub)|service\s+cent(?:re|er)\s*[-–—]\s*[A-Z]{3}\b|mail\s+cent(?:re|er)|depot\s+scan)/i,
  },
  {
    label: "a carrier event code",
    pattern: /\b(?:event|scan)\s+code\b|\btracking\s+code\s*[:=]\s*\d/i,
  },
  {
    /*
     * OUR OWN VOCABULARY, and the likeliest leak of the three. The identifiers
     * are matched with their underscores so the English words they are made of
     * — "delivered", "in transit", "out for delivery" — stay perfectly usable.
     */
    label: "an internal status identifier",
    pattern:
      /\b(?:pre_transit|in_transit|out_for_delivery|attempted_delivery|awaiting_collection|returned_to_sender)\b|\bnot\s+yet\s+with\s+the\s+carrier\b|\bheld\s*[-–—]\s*needs\s+investigation\b/i,
  },
  {
    /*
     * A DATABASE TIMESTAMP, not a time. `2026-08-28` and `05:56:12` are how the
     * source stores a scan; a reply that needs a date has one in
     * `customerDeliveryDate`. A bare `05:56` is NOT matched — a delivery window
     * or a cut-off time is a legitimate thing for a CST reply to contain, and
     * failing those would cost a regeneration on drafts that were correct.
     */
    label: "a technical timestamp",
    pattern: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}:\d{2}\b/,
  },
];

/**
 * Wording that puts the parcel IN THE NETWORK.
 *
 * A CLAIM ABOUT THE CARRIER, NOT ABOUT US. "Dispatched" is ours to state — we
 * either handed the parcel over or we did not. Every phrase below says
 * something further: that it is moving, that it is between places, that it is
 * on its way to someone. Only a scan supports that, and the failure this list
 * exists for is a draft saying "dispatched and is on its way" over a shipment
 * whose tracking page — which the customer is looking at — shows nothing but a
 * label.
 *
 * DELIBERATELY NOT INCLUDING "dispatched", "sent", "posted" or "handed to the
 * courier". Those are order facts, they are what the CST delivery rules tell an
 * agent to say while a parcel is unscanned, and flagging them would take away
 * the one true thing there is to tell the customer.
 */
export const MOVEMENT_CLAIM = new RegExp(
  [
    "\\bon\\s+(?:its|it's|the)\\s+way\\b",
    "\\bin\\s+transit\\b",
    "\\ben\\s+route\\b",
    "\\bmaking\\s+its\\s+way\\b",
    "\\bmov(?:ing|es|ed)\\s+through\\s+(?:the\\s+)?(?:network|system|depot)",
    "\\bworking\\s+its\\s+way\\b",
    "\\btravel(?:ling|ing|s)\\s+(?:to|through|towards)\\b",
    // German, matching the vocabulary the rest of this layer already handles.
    "\\bunterwegs\\b",
  ].join("|"),
  "i",
);

/** The movement wording in this text, or null. */
export function movementClaimIn(text: string): string | null {
  return MOVEMENT_CLAIM.exec(text)?.[0] ?? null;
}

/** The first kind of internal wording this text exposes, or null. */
export function technicalTrackingLanguageIn(text: string): TechnicalTrackingTerm | null {
  return TECHNICAL_TRACKING_LANGUAGE.find((term) => term.pattern.test(text)) ?? null;
}
