"use client";

import { MESSAGE_PRIORITIES } from "@/lib/knowledge/message-priority";

import { ALL_PRIORITIES, type PriorityFilter } from "./inbox-list";
import { PRIORITY_LABEL, PRIORITY_RIBBON_CLASS } from "./priority-ribbon";

/**
 * The priority filter: one horizontal row of levels, each behind a ribbon in the
 * colour that level wears on the row.
 *
 * IT REPLACED A DROPDOWN, and the reason is the thing the dropdown could not do.
 * A `<select>` shows one option and hides the rest behind a click, so the four
 * choices were never on screen together and the colour that identifies each one
 * appeared nowhere — nothing connected the word "High" in a closed menu to the
 * red mark on a row. Laid out flat, the control is the ribbon's legend as well
 * as its filter.
 *
 * FOUR CHOICES, NOT FIVE. There is no "unranked" option, because a conversation
 * carrying readable customer text is always ranked now — see
 * `explainConversationPriority`. The blanks left are conversations with no
 * readable customer message at all, which are an absence rather than a level.
 *
 * A RADIO GROUP, NOT TABS. Tabs swap what a region shows; these narrow one list
 * that is already on screen. `aria-checked` on exactly one option is what tells
 * a screen-reader user which of the four is applied — the state the highlight
 * communicates to everyone else.
 */

/**
 * The swatch: the row's own notched ribbon, stood on its end.
 *
 * THE SAME MARK, TURNED THROUGH A QUARTER TURN. The row's ribbon runs left to
 * right with its notch cut into the trailing edge, because it hangs off the
 * right-hand side of a wide row. Here it runs top to bottom with the notch cut
 * into the bottom — the bookmark shape a reader already knows — because beside a
 * word in a one-line control there is height to use and no width to spare. The
 * notch is what identifies it as the same object either way.
 *
 * ONE POLYGON, NOT AN SVG, and that is what lets every swatch be coloured by the
 * same `bg-*` class the row's ribbon uses. An `<svg>` would need `fill` or
 * `currentColor`, which means a second colour table for the filter and two
 * places for red to drift apart. Clipping a coloured box keeps
 * `PRIORITY_RIBBON_CLASS` the single answer to "what colour is HIGH".
 *
 * Vertices clockwise from the top-left: across the top, down the right side, in
 * to the point of the notch, then back out to the bottom-left corner.
 */
const RIBBON_SWATCH_SHAPE =
  "h-3.5 w-2 shrink-0 [clip-path:polygon(0_0,100%_0,100%_100%,50%_75%,0_100%)]";

/**
 * "All" flies a ribbon too, and it is GREY.
 *
 * DELIBERATELY OUTSIDE THE TRAFFIC LIGHT. All is not a level — it is the absence
 * of a level filter — so it must not wear one of the three signal colours. Green
 * in particular would make "show me everything" and "show me the quiet ones" the
 * same mark with different words under it, sitting two options apart in one
 * short row. Grey says "no level", which is exactly what All means.
 */
export const ALL_PRIORITIES_SWATCH_CLASS = "bg-slate-400 dark:bg-slate-500";

/**
 * The control's options, in the order they are shown: All, then the levels
 * most-urgent-first exactly as `MESSAGE_PRIORITIES` declares them.
 *
 * BUILT FROM THE ENGINE'S OWN LIST rather than typed out, so a level added to
 * `MESSAGE_PRIORITIES` appears here without anyone remembering to add it, and a
 * level removed cannot leave a dead button behind. Label and swatch colour come
 * from the same two tables the row ribbon reads, so the filter and the marker
 * cannot disagree about what a level is called or what colour it is.
 */
export const PRIORITY_FILTER_OPTIONS: readonly {
  readonly value: PriorityFilter;
  readonly label: string;
  readonly swatchClass: string;
}[] = [
  { value: ALL_PRIORITIES, label: "All", swatchClass: ALL_PRIORITIES_SWATCH_CLASS },
  ...MESSAGE_PRIORITIES.map((priority) => ({
    value: priority as PriorityFilter,
    label: PRIORITY_LABEL[priority],
    swatchClass: PRIORITY_RIBBON_CLASS[priority],
  })),
];

/**
 * COMPACT BY CONSTRUCTION. `text-[11px]`, one-unit gaps and `px-1.5` keep the
 * whole group about as wide as the select it replaced, so it still sits in the
 * header beside the category filter at every width. `shrink-0` on the group and
 * `whitespace-nowrap` on each option stop it collapsing into two lines when the
 * marketplace tab strip is competing for the same row.
 *
 * THE SWATCHES NEVER DIM. The unselected treatment fades the LABEL, not the
 * button, so all four colours stay at full strength — the colours are the
 * legend, and a legend that greys out three quarters of itself is no longer a
 * legend.
 *
 * NO FETCH, NO SORT. `onChange` sets a piece of local state that
 * `visibleConversations` reads; nothing here requests anything, and nothing here
 * reorders anything.
 */
export function PriorityFilterControl({
  value,
  onChange,
}: {
  value: PriorityFilter;
  onChange: (next: PriorityFilter) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Filter by priority"
      className="mb-1 flex shrink-0 items-center gap-1"
    >
      <span className="text-[11px] font-medium opacity-70">Priority:</span>
      {PRIORITY_FILTER_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors ${
              selected
                ? "bg-emerald-600/15 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200"
                : "hover:bg-black/[0.04] dark:hover:bg-white/[0.07]"
            }`}
          >
            <span aria-hidden className={`${RIBBON_SWATCH_SHAPE} ${option.swatchClass}`} />
            <span className={selected ? undefined : "opacity-80"}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
