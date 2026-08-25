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

/** A panel with a divided column, for "open the side panel". Toggles the Details column below `xl`. */
export function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3v10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
