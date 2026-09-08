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
