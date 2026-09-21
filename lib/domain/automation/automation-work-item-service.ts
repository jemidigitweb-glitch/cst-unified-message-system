import type { AutomationItemStatus } from "./automation-types";

/**
 * The record lifecycle and its clock. Pure: no database, no network.
 *
 * THE WHOLE MACHINE:
 *
 *   scheduled → sent        processed successfully (test mode, in this phase)
 *   scheduled → skipped     the recheck found the order no longer qualified
 *   scheduled → failed      processing could not complete
 *   scheduled → cancelled   an operator stopped it
 *
 * Every state but `scheduled` is terminal. There is no drafting stage, no
 * review stage and nothing after `sent`.
 *
 * `failed` IS TERMINAL TOO, and that is a deliberate choice rather than an
 * omission. An automatic re-queue on failure turns one bad afternoon into an
 * unbounded loop over the same records; if a failure needs another go, that is
 * an explicit operator decision and belongs in an explicit feature.
 */

const NEXT: Readonly<Record<AutomationItemStatus, readonly AutomationItemStatus[]>> = {
  scheduled: ["sent", "skipped", "failed", "cancelled"],
  sent: [],
  skipped: [],
  failed: [],
  cancelled: [],
};

export function mayTransition(from: AutomationItemStatus, to: AutomationItemStatus): boolean {
  return NEXT[from].includes(to);
}

export function isTerminal(status: AutomationItemStatus): boolean {
  return NEXT[status].length === 0;
}

/**
 * When a record becomes due.
 *
 * FROM THE DISPATCH TIME, NEVER FROM THE SCAN TIME. A shipment discovered a
 * week after it went out is already overdue and must process on the next tick;
 * scheduling it for "now + 24h" would silently make every late discovery a day
 * late again, and the error would be invisible because the record would look
 * perfectly scheduled.
 *
 * `dispatchedAtUtc` is a real instant. Turning the source's naive dispatch
 * timestamp into one is the caller's job and needs the source zone — this
 * function refuses to guess it, so it cannot be the place a zone error hides.
 */
export function scheduledAtFrom(dispatchedAtUtc: Date, delayHours: number): Date {
  if (Number.isNaN(dispatchedAtUtc.getTime())) {
    throw new Error("dispatchedAtUtc must be a valid date");
  }
  if (!Number.isInteger(delayHours) || delayHours < 0) {
    throw new Error("delayHours must be a non-negative integer");
  }
  return new Date(dispatchedAtUtc.getTime() + delayHours * 60 * 60 * 1000);
}

/** Due means scheduled AND the moment has passed. Both, always. */
export function isDue(
  item: { readonly status: AutomationItemStatus; readonly scheduledAt: string },
  now: Date,
): boolean {
  if (item.status !== "scheduled") return false;
  const at = Date.parse(item.scheduledAt);
  return !Number.isNaN(at) && at <= now.getTime();
}
