"use client";

import { BellIcon } from "./icons";

/**
 * The notification bell, and the whole of the notification indicator.
 *
 * ONE CONTROL, NO FRAMEWORK. There is no provider, no store, no subscription,
 * no toast layer, no browser Notification, no sound and no external alert. The
 * bell reads a count it is handed and opens a drawer; that is all it does and
 * all it can do.
 *
 * THE COUNT APPEARS ONLY WHEN THERE IS SOMETHING TO REPORT. A "0" sitting on
 * the header of every quiet marketplace is how a reviewer learns to stop
 * reading a badge, so nothing is drawn until there is at least one. The bell
 * itself always renders, so the control does not appear and disappear under the
 * cursor.
 *
 * NULL IS NOT ZERO. `count` is null while the request is in flight or after it
 * failed, and both mean "not known yet" rather than "nothing waiting" — neither
 * draws a badge, and neither claims the queue is empty.
 *
 * THE ACCESSIBLE NAME CARRIES THE COUNT, because the badge is a number with no
 * label beside it: "3 conversations need a reply" is what a screen reader
 * should hear, not "3".
 */
export function NotificationBell({
  count,
  open,
  onToggle,
}: {
  /** How many conversations are waiting, or null while unknown. */
  count: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const waiting = count ?? 0;
  const label =
    count === null
      ? "Notifications"
      : waiting === 0
        ? "Notifications, nothing waiting"
        : `Notifications, ${waiting} conversation${waiting === 1 ? "" : "s"} need${
            waiting === 1 ? "s" : ""
          } a reply`;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={open}
      title={label}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-sm transition-colors ${
        open
          ? "border-black/20 bg-black/[0.06] dark:border-white/25 dark:bg-white/[0.10]"
          : "border-black/10 hover:bg-black/[0.03] dark:border-white/15 dark:hover:bg-white/[0.05]"
      }`}
    >
      <BellIcon />
      {waiting > 0 && (
        /* The number is inside the button rather than floating over the glyph:
           a superscript dot on a 16px icon is unreadable at a glance, and the
           whole point of the count is to be read without effort. */
        <span
          aria-hidden
          className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-rose-700 dark:text-rose-300"
        >
          {waiting}
        </span>
      )}
    </button>
  );
}
