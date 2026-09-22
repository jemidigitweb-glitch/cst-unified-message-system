"use client";

import { ClockIcon } from "./icons";

/**
 * The follow-up control, beside the bell and the notes button.
 *
 * THE THIRD TWIN. Same shape, same border, same open state, same
 * `aria-expanded`, same badge rule — because all three open the SAME panel and
 * differ only in what is inside it. A control that looked different would imply
 * a different kind of thing opens.
 *
 * WHAT THE NUMBER MEANS, precisely: how many follow-ups are SCHEDULED — still
 * owed. Completed ones are reachable in the panel and deliberately not counted,
 * because a badge that included finished work would never go down.
 *
 * NULL IS NOT ZERO, the bell's rule: null means the request has not landed or
 * failed, and neither draws a badge. A "0" on a quiet header is how a reviewer
 * learns to stop reading badges.
 *
 * IT IS A COUNT AND A TOGGLE. No sound, no browser notification, no toast, no
 * transport of any kind — the indication stays inside this application, like
 * every other signal on this header.
 */
export function FollowUpPanelButton({
  count,
  open,
  onToggle,
}: {
  /** How many follow-ups are scheduled, or null while unknown. */
  count: number | null;
  /** Whether the shared panel is open AND showing follow-ups. */
  open: boolean;
  onToggle: () => void;
}) {
  const scheduled = count ?? 0;
  const label =
    count === null
      ? "Follow-ups"
      : scheduled === 0
        ? "Follow-ups, none scheduled"
        : `Follow-ups, ${scheduled} scheduled`;

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
      <ClockIcon />
      {scheduled > 0 && (
        <span
          aria-hidden
          className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-rose-700 dark:text-rose-300"
        >
          {scheduled}
        </span>
      )}
    </button>
  );
}
