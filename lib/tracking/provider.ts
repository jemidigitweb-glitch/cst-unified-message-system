import type { Carrier } from "./carrier";

/**
 * The tracking layer, stated independently of any carrier.
 *
 * WHAT THIS BOUNDARY IS FOR. The same reason `lib/ai/provider.ts` exists: what
 * a caller asks for — "where is this consignment" — is a business question, and
 * how Royal Mail's API differs from Evri's is not. Everything above this line
 * sees one shape whoever answered; everything below is one carrier's HTTP.
 *
 * FOUNDATION ONLY, AND DELIBERATELY INERT. Nothing here reaches a network. No
 * carrier credentials are read, no endpoint is named, and `getTrackingProvider`
 * returns undefined for every carrier — see `tracking-service.ts` for why that
 * is a working state rather than an unfinished one.
 *
 * IT IS NOT WIRED INTO DRAFT GENERATION, and that is a decision rather than an
 * omission. A tracking result would be a verified fact, and the moment one
 * reaches `DraftRequest.facts` the model may state it to a customer. That
 * connection should be made once there is a live provider whose freshness and
 * failure modes are known — wiring an empty pipe into the grounding layer now
 * would mean the first real response ever seen by this system is one a customer
 * reads. The draft path, the workflow and the review flow are untouched:
 *
 *     Live Message -> Thread -> Verify Context -> AI Draft -> Review/Edit
 *     -> Reviewed -> STOP
 *
 * PURE TYPES. This module declares; it does not act.
 */

/** What a caller knows before asking: the consignment and who has it. */
export type TrackingRequest = {
  /** The carrier's own reference, as recorded on the shipment. Never invented. */
  readonly trackingNumber: string;
  /**
   * Which carrier to ask.
   *
   * Already normalised — callers resolve a stored courier string through
   * `carrierFrom` first, so a provider never has to know that Royal Mail is
   * spelled four ways in the shipment table.
   */
  readonly carrier: Carrier;
};

/**
 * Where a consignment has got to, in one vocabulary for every carrier.
 *
 * NORMALISED ON PURPOSE. Carriers each have their own status words, and a
 * hundred of them across a dozen carriers is not something the rest of the
 * application should reason about. Each provider maps its own vocabulary onto
 * these; the mapping lives with the provider that owns it.
 *
 * `unknown` is a real answer, not a failure. A carrier that returns a status
 * this system has no mapping for must say so rather than pick the nearest
 * plausible one — the difference between "we do not know" and "out for
 * delivery" is a promise to a customer.
 */
export const TRACKING_STATUSES = [
  /** The label exists; the carrier does not have the parcel yet. */
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  /** A delivery was attempted and did not succeed. */
  "attempted_delivery",
  /** Waiting at a depot, locker or post office for the customer. */
  "awaiting_collection",
  "returned_to_sender",
  /** Damage, loss, a customs hold — anything needing a human. */
  "exception",
  "unknown",
] as const;

export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

/**
 * A status as a person would say it.
 *
 * `unknown` reads "not known" rather than being left blank or rendered as the
 * identifier. A blank invites the reader — a model or a reviewer — to supply
 * something, and "unknown" is a real answer that has to look like one.
 */
export const TRACKING_STATUS_LABELS: Readonly<Record<TrackingStatus, string>> = {
  pre_transit: "Not yet with the carrier",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  attempted_delivery: "Delivery attempted",
  awaiting_collection: "Awaiting collection",
  returned_to_sender: "Being returned to us",
  exception: "Held — needs investigation",
  unknown: "Not known",
};

/** One scan, as the carrier recorded it. */
export type TrackingEvent = {
  readonly status: TrackingStatus;
  /**
   * The carrier's own wording for this scan.
   *
   * Kept verbatim alongside the normalised status rather than replaced by it.
   * The normalisation is what the application reasons about; this is what a
   * reviewer needs when they want to know what the carrier actually said.
   */
  readonly description: string;
  /** Where the scan happened, when the carrier reported it. */
  readonly location: string | null;
  /** The carrier's timestamp, verbatim. Never converted — see `lastUpdated`. */
  readonly timestamp: string;
};

/**
 * Where the answer came from.
 *
 * The same provenance discipline the draft layer already applies to a verified
 * fact: an answer without a source cannot be audited, and a cached answer and a
 * live one are not the same claim even when they carry the same words.
 */
export type TrackingSource = {
  /** Which provider answered, for the record. */
  readonly provider: string;
  /**
   * Whether this came from the carrier on this call, or from a store.
   *
   * A reviewer reading "Delivered" needs to know whether that was true a second
   * ago or a day ago, and no wording in the status itself can tell them.
   */
  readonly retrieval: "live" | "cached";
};

/** What a tracking lookup returns. */
export type TrackingResult = {
  readonly carrier: Carrier;
  readonly trackingNumber: string;
  readonly currentStatus: TrackingStatus;
  /**
   * Every scan, OLDEST FIRST.
   *
   * Ordered here so no caller has to sort, and stated so none has to guess.
   * May be empty: a carrier that knows the consignment but has not scanned it
   * is a real state, and an empty list says that more honestly than a
   * fabricated "label created" event would.
   */
  readonly trackingEvents: readonly TrackingEvent[];
  /**
   * When the carrier last reported movement, verbatim as they gave it.
   *
   * NOT the time of this lookup, and not converted to any timezone. The same
   * discipline `formatSourceTimestamp` already applies to message timestamps:
   * the authoritative zone is the carrier's, we do not know it, and a converted
   * time that is wrong by an hour is worse than an unconverted one.
   *
   * Null when the carrier has reported nothing at all.
   */
  readonly lastUpdated: string | null;
  readonly source: TrackingSource;
};

/**
 * A carrier this system can ask.
 *
 * `carrier` is declared rather than inferred so the service can pick a provider
 * without calling one, exactly as `DraftProvider.name` lets the draft service
 * report configuration without spending a token.
 */
export interface TrackingProvider {
  readonly carrier: Carrier;
  /** The provider's own name, for `TrackingSource.provider`. */
  readonly name: string;
  track(request: TrackingRequest): Promise<TrackingResult>;
}

/**
 * Raised when no provider is configured for a carrier.
 *
 * Distinct from `TrackingUnavailable` for the same reason the draft layer
 * separates its two: an operator fixes "no credentials" and "the carrier is
 * down" in completely different places, and one message covering both sends
 * them to the wrong one.
 */
export class TrackingNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingNotConfigured";
  }
}

/**
 * Raised when a configured provider could not answer.
 *
 * The message is OUR wording, never the carrier's: a carrier error can quote
 * the request back, and the request contains a real consignment reference.
 */
export class TrackingUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingUnavailable";
  }
}

/**
 * Raised when the carrier does not recognise the reference.
 *
 * Deliberately NOT the same as an empty result. "The carrier has never heard of
 * this number" and "the carrier has it but has not scanned it" look alike in a
 * naive shape and mean opposite things to a customer chasing a parcel.
 */
export class TrackingNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingNotFound";
  }
}
