import type { AutomationItemStatus } from "@/lib/domain/automation/automation-types";

/**
 * How a record's state is written and coloured, in one place.
 *
 * `sent` READS DIFFERENTLY DEPENDING ON THE ROW, and that is the whole reason
 * this is a function rather than a constant. The status word is the lifecycle
 * vocabulary this automation was specified with; what a reader takes from it
 * is not the same in both cases:
 *
 *   test_mode = true    "Processed (test)" — the template was rendered and
 *                       stored, and nothing left the system. Saying "Sent"
 *                       here would be a claim about a customer that is false.
 *   test_mode = false   "Sent" — a real transport accepted it.
 *
 * THE SECOND BRANCH IS UNREACHABLE TODAY and is written anyway, deliberately.
 * `ck_automation_items_sent_requires_test_mode` refuses a non-test `sent` row,
 * so nothing can currently take that path. When a marketplace transport is
 * connected, the label is already correct — and, just as importantly, rows
 * processed during the test phase keep saying "Processed (test)" for ever,
 * because the flag lives on the row rather than on the deployment.
 */

const LABEL: Readonly<Record<AutomationItemStatus, string>> = {
  scheduled: "Scheduled",
  sent: "Sent",
  skipped: "Skipped",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function statusLabel(status: AutomationItemStatus, testMode: boolean): string {
  return status === "sent" && testMode ? "Processed (test)" : LABEL[status];
}

/** Local time, and plainly an absent value when there is none. */
export function moment(value: string | null): string {
  if (value === null) return "—";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

/**
 * A moment rendered in a NAMED zone, matching the source's own format.
 *
 * WHY THIS EXISTS. `dispatched_at` is copied verbatim from the order system and
 * carries no zone; `scheduled_at` is a real instant. Rendering the second in the
 * reader's local zone put "2026-09-20 07:20:09" next to "9/21/2026, 10:50:09 AM"
 * and asked them to do a timezone conversion in their head to see that the gap
 * was 24 hours. Shown in the same zone the dispatch time is written in, the two
 * read 07:20:09 and 07:20:09 — and the delay is simply visible.
 *
 * Falls back to local time if the zone is one the runtime does not know, which
 * is a wrong-looking time rather than a crashed table.
 */
export function inZone(value: string | null, timeZone: string): string {
  if (value === null) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(parsed));
  } catch {
    return new Date(parsed).toLocaleString();
  }
}

export function StatusBadge({
  status,
  testMode,
}: {
  status: AutomationItemStatus;
  /**
   * Whether THIS row was processed without a transport.
   *
   * Required rather than defaulted: a default would quietly pick one of the two
   * readings above, and picking the wrong one means telling somebody a customer
   * was contacted when they were not.
   */
  testMode: boolean;
}) {
  const tone =
    status === "sent"
      ? "bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 border-emerald-600/30"
      : status === "failed"
        ? "bg-red-600/10 text-red-700 dark:text-red-300 border-red-600/30"
        : status === "skipped" || status === "cancelled"
          ? "bg-neutral-500/10 text-neutral-600 dark:text-neutral-300 border-neutral-500/30"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30";
  return (
    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {statusLabel(status, testMode)}
    </span>
  );
}
