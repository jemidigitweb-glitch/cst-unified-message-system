/** Three lines, the usual "menu" glyph. Opens the marketplace-and-conversations drawer below `xl`. */
export function HamburgerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4h12M2 8h12M2 12h12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * A bell, for "there is something waiting". Opens the notification drawer.
 *
 * Outline rather than filled, and the same 16px box and 1.5 stroke as the two
 * above: it sits in the header beside them and a heavier glyph would read as a
 * different class of control. Whether anything is actually waiting is said by
 * the count beside it, never by swapping this for a filled variant — one shape
 * means one thing.
 */
export function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.75a4 4 0 0 0-4 4v2.6c0 .4-.14.79-.4 1.1L2.75 10.5h10.5l-.85-1.05a1.75 1.75 0 0 1-.4-1.1v-2.6a4 4 0 0 0-4-4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M6.5 12.75a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A panel with a divided column, for "open the side panel". Toggles the Details column below `xl`. */
export function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3v10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * A note with a folded corner, for "a customer wrote something on the order".
 *
 * Deliberately NOT a speech bubble: a bubble is this application's shape for a
 * message in a thread, and a customer note is not one — it is attached to the
 * order and never appears in the conversation as a bubble. Same 16px box and
 * 1.5 stroke as the bell it sits beside, so the two read as one class of
 * control rather than as a control and a decoration.
 */
export function NoteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.25 1.75H4.5a1.75 1.75 0 0 0-1.75 1.75v9a1.75 1.75 0 0 0 1.75 1.75h7a1.75 1.75 0 0 0 1.75-1.75V6.25L9.25 1.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9 2v4.25h4.25" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.75 9.25h4.5M5.75 11.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The follow-up control's glyph: a clock.
 *
 * A CLOCK, NOT A BELL OR AN ENVELOPE. The bell beside it already means "people
 * are waiting"; this one means "come back to this at a time", and the two must
 * not read as the same kind of thing. Nothing about it suggests sending.
 */
export function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.5V8l2.25 1.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A pin, for the internal note held above the thread.
 *
 * SMALLER THAN THE HEADER GLYPHS — 12px, not 16. Those are controls a reviewer
 * clicks; this is a marker on a label that says what the card below it is, and
 * at 16px it read as a button that does nothing when pressed.
 *
 * Same 1.5 stroke and outline treatment as the rest of this file, so it still
 * belongs to the set.
 */
export function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 1.75h4l-.5 3.5 2.25 2.25v1H4.25v-1L6.5 5.25 6 1.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 8.5v5.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
