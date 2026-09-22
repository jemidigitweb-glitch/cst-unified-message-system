"use client";

import {
  type InternalNote,
  pinnedInternalNote,
  unpinnedInternalNotes,
} from "@/lib/domain/internal-note";

import { PinIcon } from "./icons";
import { InternalNoteCard } from "./internal-note-card";

/**
 * The pinned internal note, between the conversation header and the thread.
 *
 * WHAT IS PINNED, AND WHAT CANNOT BE. Only internal notes. There is no pin
 * flag, no pin table, no pin endpoint and no Pin button: creating an internal
 * note IS pinning it, so this renders the newest entry of the list the
 * workspace already holds. A
 * customer message or a CST reply cannot appear here — they are a different
 * type from a different endpoint and there is no code path that would put one
 * in this list.
 *
 * WHY IT IS HERE RATHER THAN ONLY IN THE SIDEBAR. The details column is where
 * notes are managed; this is where they are found. An agent opening a case
 * reads down the thread, and "courier follow-up already requested" is worth
 * knowing before the first customer message rather than after checking
 * another column.
 *
 * IT DOES NOT SCROLL WITH THE THREAD, AND THAT IS THE POINT. This component
 * is mounted as a sibling of the message scroller in `conversation-view.tsx`,
 * not inside it — see the comment at that mount for why the first attempt
 * (inside the scroller) was wrong. It owns its own frame here, including the
 * height cap and the divider, so that the caller renders it unconditionally
 * and an absent note leaves NO empty strip above the thread: the early return
 * below removes the whole row, border and all.
 *
 * IT IS NOT A MESSAGE, AND THE LAYOUT SAYS SO. Full width, outside the
 * bubble list, above it rather than in it, labelled INTERNAL NOTE, and tinted
 * amber. Nothing about it lines up with the left/right bubbles below.
 *
 * ONE NOTE, THEN A COUNT. The newest is shown in full because that is the
 * current position on the case; older ones stay one column away in the
 * Internal Notes section rather than pushing the conversation off the screen.
 * A case with a long note history would otherwise open on the history instead
 * of on the conversation.
 */
export function PinnedInternalNotes({
  notes,
  onSave,
  onDelete,
}: {
  /** Newest first. Null while unread; nothing renders until they arrive. */
  notes: readonly InternalNote[] | null;
  onSave: (noteId: string, text: string) => Promise<string | null>;
  onDelete: (noteId: string) => Promise<string | null>;
}) {
  // Which note is pinned is a domain rule, not a slice of an array here —
  // see `pinnedInternalNote`. It is the newest, recomputed from the list, so
  // adding promotes, deleting the newest promotes the next, and deleting the
  // last leaves nothing.
  const newest = pinnedInternalNote(notes);
  const older = unpinnedInternalNotes(notes);

  // Nothing at all when there are none: an empty pinned strip above every
  // conversation would be a permanent row reporting an absence.
  if (newest === undefined) return null;

  return (
    <section
      data-testid="pinned-internal-notes"
      aria-label="Pinned internal note"
      /*
       * shrink-0: this is a flex child of the conversation column, beside a
       * `flex-1` scroller. Without it the row would be squeezed as the thread
       * grew, which is the same disappearance in slow motion.
       *
       * max-h-44 + overflow-y-auto: a very long note scrolls inside its own
       * box instead of taking the conversation's height. The thread below
       * keeps its own scrollbar and the two never interfere.
       */
      className="max-h-44 shrink-0 overflow-y-auto border-b border-black/10 px-5 py-3 dark:border-white/15"
    >
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase text-amber-900 dark:text-amber-200">
        <PinIcon />
        Pinned internal note
      </p>
      <InternalNoteCard note={newest} onSave={onSave} onDelete={onDelete} />
      {older.length > 0 && (
        <p className="mt-1.5 text-right text-[11px] opacity-55">
          {older.length} earlier internal note{older.length === 1 ? "" : "s"} in the details panel
        </p>
      )}
    </section>
  );
}
