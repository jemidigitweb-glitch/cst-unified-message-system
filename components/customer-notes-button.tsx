"use client";

import { NoteIcon } from "./icons";

/**
 * The customer-notes control, beside the bell.
 *
 * DELIBERATELY THE BELL'S TWIN. Same shape, same border, same open state, same
 * `aria-expanded` — because the two open the SAME panel and only change what is
 * in it. A control that looked different would imply a different kind of thing
 * opens, and then a reviewer would be surprised when the notification list was
 * replaced rather than joined.
 *
 * THE BADGE IS THE BELL'S BADGE. Same rose fill, same shape, same rule: drawn
 * only when there is at least one, and never drawn for `null` — which means
 * the request has not landed or failed, not that there are none. A "0" on a
 * quiet header is how a reviewer learns to stop reading badges.
 *
 * WHAT THE NUMBER MEANS, precisely: how many customer notes were LOADED, which
 * is the most recent page of them rather than every note in history. The panel
 * says so beneath the list when there are more. It is a total, not a queue —
 * nothing here is owed, and there is no read or dismissed state anywhere in
 * this feature.
 */
export function CustomerNotesButton({
  count,
  open,
  onToggle,
}: {
  /** How many notes are loaded, or null while unknown. */
  count: number | null;
  /** Whether the shared panel is open AND showing notes. */
  open: boolean;
  onToggle: () => void;
}) {
  const loaded = count ?? 0;
  const label =
    count === null
      ? "Customer notes"
      : loaded === 0
        ? "Customer notes, none"
        : `Customer notes, ${loaded} note${loaded === 1 ? "" : "s"}`;

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
      <NoteIcon />
      {loaded > 0 && (
        /* Inside the button, not floating over the glyph — the same choice the
           bell makes, and for the same reason: a superscript dot on a 16px
           icon is unreadable at a glance. */
        <span
          aria-hidden
          className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-rose-700 dark:text-rose-300"
        >
          {loaded}
        </span>
      )}
    </button>
  );
}
