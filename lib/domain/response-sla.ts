/**
 * The RESPONSE SLA for a before-shipment urgent conversation.
 *
 * ------------------------------------------------------------------------
 * THERE IS NO APPROVED DURATION, SO THERE IS NO NUMBER HERE
 * ------------------------------------------------------------------------
 * The repository was searched for an existing SLA or timer of any kind: no
 * config key, no settings column, no constant, no documented figure, and no
 * component. This would be the system's first SLA.
 *
 * An SLA is a PROMISE about how fast a team answers, and a countdown is not a
 * neutral display: an agent who sees "4 minutes left" works differently from
 * one who sees "45 minutes left", and an ESCALATE banner counted against an
 * invented target is a false accusation about a real person's work. A plausible
 * default is worse than a blank, because a blank is visibly missing and `30`
 * looks decided.
 *
 * So the machinery below is complete and tested, and the value is null until
 * the business supplies one. Everything renders the "not configured" state.
 *
 * TO TURN IT ON: set `RESPONSE_SLA_MINUTES` to the approved whole number of
 * minutes. Nothing else changes — no migration, no schema, no component.
 *
 * PURE. Every function is a function of its arguments; nothing here reads a
 * clock, so `now` is always passed in.
 */

/** The approved shortened response target, in minutes. Deliberately unset. */
export const RESPONSE_SLA_MINUTES: number | null = null;

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
