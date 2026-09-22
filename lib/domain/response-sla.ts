/**
 * The RESPONSE SLA for a before-shipment urgent conversation.
 *
 * ------------------------------------------------------------------------
 * THE DURATION IS NOW APPROVED: 24 HOURS
 * ------------------------------------------------------------------------
 * This module shipped with the value deliberately null. An SLA is a PROMISE
 * about how fast a team answers, and a countdown is not a neutral display: an
 * agent who sees "4 minutes left" works differently from one who sees "45
 * minutes left", and an ESCALATE banner counted against an INVENTED target is a
 * false accusation about a real person's work. So the machinery was built
 * complete and the number was left blank, because a blank is visibly missing
 * and `30` looks decided.
 *
 * CST has now supplied one: answer within 24 HOURS of the customer's newest
 * message. 24 * 60 = 1440 minutes. That is the only reason this is no longer
 * null, and it is the whole of the change — no migration, no schema, no new
 * component.
 *
 * `not_configured` REMAINS REACHABLE AND REMAINS TESTED. It is what this
 * returns if the value is ever set back to null, and pretending otherwise would
 * mean deleting a state the type still admits.
 *
 * ------------------------------------------------------------------------
 * 24 AGAINST `BEFORE_SHIPMENT_RECENCY_HOURS` = 48: THE GAP IS THE POINT
 * ------------------------------------------------------------------------
 * The urgent sweep carries a conversation while its newest customer message is
 * under 48 hours old, measured from the SAME instant this clock starts from,
 * and the timer renders on urgent rows only. The two numbers therefore have to
 * differ or the red state is decoration:
 *
 *   0h  -> 24h   urgent, `within`, counting down.
 *   24h -> 48h   urgent, `expired`, CRITICAL / ESCALATE, overdue by up to 24h.
 *   past 48h     the row leaves the urgent block for its ordinary date
 *                position, and the panel goes with it.
 *
 * A 48-hour target was considered first and would have made `expired`
 * UNREACHABLE: the deadline and the window would have fallen on the same
 * instant, so a row would have left the list at the exact moment it went late
 * and nobody would ever have seen the banner. Halving the target is what opens
 * the 24-hour band in which a breach is both real and visible.
 *
 * THE BAND IS NOT A GRACE PERIOD. Past 48 hours the conversation is still
 * unanswered and still in the inbox — it has simply stopped being before-
 * shipping work, which is the only thing the urgent block claims.
 *
 * PURE. Every function is a function of its arguments; nothing here reads a
 * clock, so `now` is always passed in.
 */

/**
 * The approved response target, in minutes. 24 hours, set by CST.
 *
 * Written as `24 * 60` rather than `1440` so the approved figure is the one on
 * the page: the business agreed a number of HOURS, and a reader checking this
 * against that decision should not have to divide.
 *
 * Typed `number | null` rather than narrowed to `number`: null is a state this
 * module still supports and still renders honestly, and widening the type back
 * out later would be a bigger change than editing this one value.
 */
export const RESPONSE_SLA_MINUTES: number | null = 24 * 60;

/**
 * The zone the due time is SHOWN in — "SL time" in the requirement, read as
 * Sri Lanka Standard Time.
 *
 * AN ASSUMPTION, RECORDED IN ONE PLACE so it is one edit to correct. It affects
 * display only: the underlying instant is absolute, and changing this restates
 * the same moment in another zone rather than moving any deadline.
 */
export const SLA_DISPLAY_TIME_ZONE = "Asia/Colombo";
export const SLA_DISPLAY_ZONE_LABEL = "SL time";

/**
 * Where the clock starts, and why this is a parameter rather than a lookup.
 *
 * THE SLA RUNS FROM WHEN THE CUSTOMER'S MESSAGE ARRIVED, which the system
 * stores as a NAIVE timestamp whose authoritative zone is still unconfirmed —
 * `formatSourceTimestamp` slices it as a string and deliberately never builds a
 * Date, and the migrations README forbids casting it until the ingestion owner
 * confirms the source zone. An hour of zone error is nothing to a two-day reply
 * target and fatal to a minutes-based one.
 *
 * So this takes an INSTANT, and callers that cannot honestly produce one pass
 * null and get `unknown_received_time`. The conversion is a separate, signed-off
 * decision; this module must not hide it inside a subtraction.
 */
export type ResponseSlaStatus =
  /** No approved duration exists yet. The only state reachable today. */
  | { readonly state: "not_configured" }
  /** A duration exists but the start instant could not be established. */
  | { readonly state: "unknown_received_time"; readonly targetMinutes: number }
  | {
      readonly state: "within";
      readonly targetMinutes: number;
      readonly dueAt: Date;
      readonly minutesLeft: number;
    }
  | {
      readonly state: "expired";
      readonly targetMinutes: number;
      readonly dueAt: Date;
      readonly minutesOver: number;
    };

const MS_PER_MINUTE = 60_000;

/**
 * Where this conversation stands against the response SLA.
 *
 * MINUTES THROUGHOUT. The ordinary reply queue is measured in hours or days;
 * the before-shipment window is measured in the time it takes a parcel to reach
 * the packing bench. Every figure this returns is whole minutes.
 *
 * ROUNDED, NOT TRUNCATED, and the direction is chosen rather than inherited:
 * `minutesLeft` rounds DOWN so a timer never claims more time than there is,
 * and `minutesOver` rounds DOWN so it never overstates a breach. Both err
 * toward the reading that cannot flatter anybody.
 */
export function responseSlaStatus(input: {
  readonly targetMinutes: number | null;
  readonly receivedAt: Date | null;
  readonly now: Date;
}): ResponseSlaStatus {
  const { targetMinutes, receivedAt, now } = input;
  if (targetMinutes === null) return { state: "not_configured" };
  if (receivedAt === null) return { state: "unknown_received_time", targetMinutes };

  const dueAt = new Date(receivedAt.getTime() + targetMinutes * MS_PER_MINUTE);
  const remainingMs = dueAt.getTime() - now.getTime();

  // Strictly past the deadline. Landing exactly on it is met, not missed.
  if (remainingMs < 0) {
    return {
      state: "expired",
      targetMinutes,
      dueAt,
      minutesOver: Math.floor(-remainingMs / MS_PER_MINUTE),
    };
  }
  return {
    state: "within",
    targetMinutes,
    dueAt,
    minutesLeft: Math.floor(remainingMs / MS_PER_MINUTE),
  };
}

/**
 * Whether the row should wear the red CRITICAL / ESCALATE treatment.
 *
 * ONLY A REAL BREACH EARNS IT. "Not configured" and "unknown received time" are
 * absences, and colouring an absence red would put an escalation banner on every
 * urgent conversation in the inbox on the day the feature ships — which is how a
 * warning colour stops meaning anything.
 */
export function isSlaCritical(status: ResponseSlaStatus): boolean {
  return status.state === "expired";
}

/**
 * A duration a person reads at a glance: "8m", "1h 12m", "2d 3h".
 *
 * MINUTES ARE THE UNIT and stay visible at every scale — an SLA breached by
 * ninety minutes reads "1h 30m", never "1.5h", because the agent is being asked
 * how late this is, not how long it has been roughly.
 */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  if (hours < 24) return `${hours}h ${total % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The due moment, stated in SL time and labelled as such.
 *
 * ALWAYS LABELLED. A bare "14:32" beside a countdown invites the reader to
 * assume their own zone, and a deadline read in the wrong zone is worse than
 * no deadline at all.
 */
export function formatSlaDueAt(dueAt: Date): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: SLA_DISPLAY_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dueAt);
  return `${formatted} ${SLA_DISPLAY_ZONE_LABEL}`;
}

/** Shown wherever a countdown would be, while no duration is approved. */
export const SLA_NOT_CONFIGURED_TEXT = "Response SLA not configured";
/** Shown when a duration exists but the arrival instant does not. */
export const SLA_UNKNOWN_START_TEXT = "Message arrival time not established";

/**
 * WHERE THE CLOCK ACTUALLY STARTED, carried so it can be SHOWN.
 *
 * ------------------------------------------------------------------------
 * A FALLBACK NOBODY CAN SEE IS A FALLBACK NOBODY CAN CHALLENGE
 * ------------------------------------------------------------------------
 * `LATEST_INBOUND_INSTANT` is `COALESCE(source_ts_utc, ingested_at)`, and
 * `source_ts_utc` is populated for 0 of 23,412 inbound messages — so today the
 * fallback ALWAYS wins and every deadline is really measured from when our sync
 * picked the message up, not from when the customer pressed send. Measured over
 * the last seven days that gap has a median of 23 minutes and a maximum of 4h
 * 39m, which against the 24-hour target is 1.6% of the window typically and
 * 19.4% at worst.
 *
 * THE TARGET HALVED AND THIS DID NOT, so the caveat matters more than it did:
 * every conversation is being given up to 4h 39m longer than the promise
 * actually allows, and the customer's own clock started earlier than ours. It
 * is still the best instant this schema can produce honestly, and it is still
 * far short of a 24-hour deadline — but an agent disputing a breach is entitled
 * to know the clock started at ingest, and a conversation backfilled by a
 * historical sync has a deadline measured from when the import ran rather than
 * from anything the customer did.
 *
 * ------------------------------------------------------------------------
 * WHY `source_ts` IS NOT USED, THOUGH IT IS THE BETTER TIMESTAMP
 * ------------------------------------------------------------------------
 * `conversation_messages.source_ts` holds the marketplace's own send time, and
 * measurement says it reads as UTC: across 700 eBay inbound messages in the last
 * seven days, treating it as UTC puts the minimum lag to `ingested_at` at 0.8
 * minutes with no negative values, while London puts it at 60.8 and Berlin at
 * 120.8 — neither of which a polling ingest could produce. The same pattern
 * holds on all five marketplaces.
 *
 * That is evidence, not authority. `migrations/README.md` forbids casting a
 * naive source timestamp until the ingestion owner confirms the zone, and the
 * schema already has the column for their answer — `source_ts_zone`, also
 * empty. Filling either is an INGESTION change and a database write, so it is
 * not made here. The day `source_ts_utc` is populated this switches to it with
 * no edit, because the COALESCE already prefers it.
 */
export type SlaStartSource =
  /** The customer's own send moment, normalised to UTC by the ingestion layer. */
  | "customer_message"
  /** `ingested_at` — when our sync first saw it. Everything today. */
  | "ingest";

/**
 * Said beside a running countdown whose clock started at ingest.
 *
 * Phrased as what it IS rather than as a warning, and deliberately not red:
 * this is a caveat on a measurement, not a breach — see `isSlaCritical`, which
 * it does not touch.
 */
export const SLA_STARTED_AT_INGEST_TEXT = "From ingest, not the customer's send time";
