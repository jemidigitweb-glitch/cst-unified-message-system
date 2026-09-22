import type { FollowUpReminder } from "@/lib/domain/follow-up-reminder";
import { SLA_DISPLAY_TIME_ZONE, formatDuration } from "@/lib/domain/response-sla";

/**
 * How a follow-up reminder READS on screen.
 *
 * ------------------------------------------------------------------------
 * DERIVED, NEVER STORED
 * ------------------------------------------------------------------------
 * `upcoming`, `due soon` and `overdue` are the same `scheduled` row read
 * against a clock. Nothing in the database changes when a reminder comes due
 * and nothing needs to: a stored `overdue` would be wrong from the moment it
 * lapsed until something remembered to update it. Every function here is a
 * function of its arguments, so `now` is always passed in and a test can put
 * the clock wherever it likes.
 *
 * ------------------------------------------------------------------------
 * IT DESCRIBES A REMINDER. IT CANNOT ACT ON ONE.
 * ------------------------------------------------------------------------
 * Nothing here completes a reminder, writes a row, or contacts anybody. A
 * reminder that has gone overdue is still `scheduled` in the database until a
 * person presses Mark Completed — see the complete flow, which is the only
 * thing that changes a status.
 */

/**
 * WHEN AN APPROACHING DEADLINE BECOMES "DUE SOON", in minutes before it lands.
 *
 * ------------------------------------------------------------------------
 * NO APPROVED THRESHOLD EXISTS, SO THERE IS NO NUMBER HERE
 * ------------------------------------------------------------------------
 * The repository was searched for an existing approaching-deadline figure
 * before this was written. What exists is:
 *
 *   RESPONSE_SLA_MINUTES = 24h   a REPLY TARGET — how long we may take to
 *                                answer a customer. Not a warning distance,
 *                                and reusing it would mean every reminder was
 *                                "due soon" from the moment it was created.
 *   BEFORE_SHIPMENT_RECENCY_HOURS = 48h
 *                                how long a before-shipping conversation stays
 *                                in the urgent block. A window, not a warning.
 *
 * `responseSlaStatus` has exactly two live states, `within` and `expired`;
 * there is no third "nearly" anywhere in this codebase, and no config key,
 * settings column or constant for one.
 *
 * So the value is null until CST supplies one, and this module says so rather
 * than picking 30 minutes, an hour or two hours and letting a plausible-looking
 * default harden into a rule nobody agreed. THE SAME DECISION
 * `RESPONSE_SLA_MINUTES` was shipped with, and for the same reason: a blank is
 * visibly missing, and `60` looks decided.
 *
 * WHAT HAPPENS MEANWHILE: a scheduled reminder that has not lapsed reads
 * `upcoming`, and one that has reads `overdue`. Both are exact, neither needs a
 * threshold, and no part of the interface is blocked on this decision.
 *
 * TO TURN IT ON: set this to the approved whole number of minutes. Nothing else
 * changes — `followUpDisplayState` already routes through it, and the label and
 * the tone are already defined below.
 */
export const FOLLOW_UP_DUE_SOON_MINUTES: number | null = null;

/** Every way a reminder can read. `due_soon` is unreachable while the above is null. */
export const FOLLOW_UP_DISPLAY_STATES = [
  "upcoming",
  "due_soon",
  "overdue",
  "completed",
  "cancelled",
] as const;
export type FollowUpDisplayState = (typeof FOLLOW_UP_DISPLAY_STATES)[number];

const MS_PER_MINUTE = 60_000;

/**
 * How this reminder reads right now.
 *
 * A SETTLED REMINDER IS NEVER RE-READ AGAINST THE CLOCK. `completed` and
 * `cancelled` are facts about what somebody did; only `scheduled` is a promise
 * still outstanding, so only `scheduled` is measured against `now`. A completed
 * reminder whose due time has passed is not overdue — it is done.
 *
 * An unparseable due time reads as `upcoming` rather than as overdue: a broken
 * timestamp must not manufacture an alarm.
 */
export function followUpDisplayState(input: {
  readonly status: FollowUpReminder["status"];
  readonly promisedDueAt: string;
  readonly now: Date;
}): FollowUpDisplayState {
  if (input.status === "completed") return "completed";
  if (input.status === "cancelled") return "cancelled";

  const due = Date.parse(input.promisedDueAt);
  if (Number.isNaN(due)) return "upcoming";

  const minutesLeft = (due - input.now.getTime()) / MS_PER_MINUTE;
  // Strictly past the promised moment. Landing exactly on it is not yet late,
  // the same way `responseSlaStatus` treats its own deadline.
  if (minutesLeft < 0) return "overdue";
  if (FOLLOW_UP_DUE_SOON_MINUTES !== null && minutesLeft <= FOLLOW_UP_DUE_SOON_MINUTES) {
    return "due_soon";
  }
  return "upcoming";
}

/** The word on the badge. */
export const FOLLOW_UP_STATE_LABEL: Readonly<Record<FollowUpDisplayState, string>> = {
  upcoming: "Upcoming",
  due_soon: "Due soon",
  overdue: "Overdue",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * Badge colours. Only `overdue` is red, for the reason the SLA panel gives:
 * a warning everything wears is a warning nobody reads.
 */
export const FOLLOW_UP_STATE_CLASS: Readonly<Record<FollowUpDisplayState, string>> = {
  upcoming: "border-black/15 text-current opacity-70 dark:border-white/20",
  due_soon: "border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  overdue: "border-red-600 bg-red-600/10 text-red-800 dark:border-red-500 dark:text-red-200",
  completed: "border-emerald-600/50 bg-emerald-600/10 text-emerald-800 dark:text-emerald-200",
  cancelled: "border-black/15 text-current opacity-50 dark:border-white/20",
};

/**
 * "Due in 3h 20m" / "Overdue by 1d 4h" / "Completed".
 *
 * Reuses `formatDuration` from the SLA module rather than formatting minutes
 * again, so a follow-up and an SLA panel describe the same span the same way.
 */
export function followUpRelativeTime(input: {
  readonly status: FollowUpReminder["status"];
  readonly promisedDueAt: string;
  readonly now: Date;
}): string | null {
  if (input.status !== "scheduled") return null;
  const due = Date.parse(input.promisedDueAt);
  if (Number.isNaN(due)) return null;

  const minutes = (due - input.now.getTime()) / MS_PER_MINUTE;
  return minutes < 0
    ? `Overdue by ${formatDuration(Math.floor(-minutes))}`
    : `Due in ${formatDuration(Math.floor(minutes))}`;
}

/**
 * A due time as CST reads it: SL time, always labelled.
 *
 * THE SAME ZONE AND THE SAME LABEL the SLA panel uses, taken from the same
 * constant rather than restated — a deadline shown in two zones on one screen
 * is worse than a deadline shown in neither.
 */
export function formatFollowUpDueAt(promisedDueAt: string): string {
  const due = new Date(promisedDueAt);
  if (Number.isNaN(due.getTime())) return "Due time not established";
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: SLA_DISPLAY_TIME_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(due);
  return `${formatted} SL time`;
}

/**
 * The quick choices the interface offers.
 *
 * UI CONVENIENCES ONLY. They are turned into an absolute instant before they
 * leave the browser; the API stores a moment, not a duration, so "48 hours"
 * cannot later be reinterpreted against a different starting point.
 */
export const FOLLOW_UP_PRESET_HOURS = [24, 48, 72] as const;
export type FollowUpPresetHours = (typeof FOLLOW_UP_PRESET_HOURS)[number];

const MS_PER_HOUR = 3_600_000;

/** `now + hours`, as the ISO instant the API expects. */
export function dueAtFromPreset(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * MS_PER_HOUR).toISOString();
}

/**
 * The offset of a zone at a given instant, in milliseconds.
 *
 * Intl is the only zone database available here — there is no date library in
 * this project and adding one for a single conversion would be a large
 * dependency for a small job.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    // Intl renders midnight as hour 24 in some locales; normalise it.
    value("hour") % 24,
    value("minute"),
    value("second"),
  );
  return asIfUtc - at.getTime();
}

/**
 * A wall-clock the reviewer typed, read AS SL TIME, as an absolute instant.
 *
 * ------------------------------------------------------------------------
 * WHY NOT THE BROWSER'S ZONE
 * ------------------------------------------------------------------------
 * `<input type="datetime-local">` has no zone. Reading it in whatever zone the
 * laptop happens to be set to would mean two reviewers typing "14:30" created
 * two different deadlines, and the panel would then show both back in SL time —
 * so the number a person typed would not be the number they saw. Every deadline
 * in this application is displayed in SL time; typing one is the same act as
 * reading one, so it is interpreted in the same zone.
 *
 * ONE PASS IS EXACT FOR `Asia/Colombo`, which has no daylight saving: the
 * offset is the same either side of the instant. For a zone with DST this
 * would need a second pass to settle the hour either side of a transition, and
 * changing `SLA_DISPLAY_TIME_ZONE` to such a zone is the moment to add it.
 *
 * Returns null for anything unparseable, which the caller reports as a
 * validation failure rather than sending an Invalid Date to the API.
 */
export function dueAtFromLocalInput(
  wallClock: string,
  timeZone: string = SLA_DISPLAY_TIME_ZONE,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wallClock.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const asIfUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? "0"),
  );
  if (Number.isNaN(asIfUtc)) return null;
  const instant = new Date(asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone));
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * Which sections the follow-up panel offers.
 *
 * TWO, NOT FIVE. `upcoming`, `due soon` and `overdue` are readings of one
 * stored status, so splitting them into tabs would ask a reviewer to guess
 * which list a reminder had moved to as time passed. They are badges inside
 * the scheduled list; `Scheduled` and `Completed` are the two things a reminder
 * actually IS.
 */
export const FOLLOW_UP_TABS = [
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
] as const;
export type FollowUpTab = (typeof FOLLOW_UP_TABS)[number]["key"];

/**
 * Scheduled reminders in the order they must be worked: soonest promise first,
 * so whatever is overdue or nearest to it is at the top.
 *
 * The server already returns this order for `status=scheduled`. Applied again
 * here because the list is re-sorted locally after a completion removes a row,
 * and a list that silently reordered on refresh would be worse than one that
 * never changed.
 */
export function sortByDueSoonest(
  reminders: readonly FollowUpReminder[],
): readonly FollowUpReminder[] {
  return [...reminders].sort((a, b) => {
    const left = Date.parse(a.promisedDueAt);
    const right = Date.parse(b.promisedDueAt);
    if (Number.isNaN(left) || Number.isNaN(right)) return 0;
    return left - right || Number(a.id) - Number(b.id);
  });
}

/** What the shared list answers with. */
export type FollowUpFeed = {
  readonly status: string;
  readonly reminders: FollowUpReminder[];
  readonly hasMore: boolean;
  readonly offset: number;
};

/** What one conversation's route answers with. */
export type ConversationFollowUpFeed = {
  readonly conversationId: string;
  readonly reminders: FollowUpReminder[];
};
