"use client";

/**
 * The sidebar's section heading, and the one colour every section uses.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ------------------------------------------------------------------------
 * It lived in `context-panel.tsx`, which was fine while the panel was the only
 * thing that rendered a heading. `conversation-cases-panel.tsx` is a section of
 * that panel AND is mounted by it, so importing the constant back out of the
 * parent would be a module cycle — the kind that resolves at build time and
 * fails as an undefined value at runtime in exactly one import order.
 *
 * Both now import it from here. `context-panel` re-exports the constant so the
 * workspace and the evidence pane, which have imported it from there since
 * before this existed, keep working unchanged.
 *
 * ------------------------------------------------------------------------
 * ONE COLOUR FOR EVERY SECTION
 * ------------------------------------------------------------------------
 * Per-section tints were tried and read as meaning — a reviewer looks for why
 * Context is one colour and Order context another, and there is no answer. A
 * single muted green says "this is a heading" and nothing more, which is all a
 * heading should say.
 *
 * TEXT COLOUR ONLY — no background, no pill, no radius. The sidebar already
 * carries status pills and category chips; boxed headings would compete with
 * the badges that are the thing actually worth noticing.
 */
export const SECTION_HEADING_CLASS = "text-teal-800 dark:text-teal-300";

export function SectionHeading({ children }: { children: string }) {
  return (
    <h2
      className={`text-[11px] font-medium tracking-wide uppercase ${SECTION_HEADING_CLASS}`}
    >
      {children}
    </h2>
  );
}
