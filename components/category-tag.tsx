import type { MessageCategory } from "@/lib/knowledge/message-category";

/**
 * The category chip, and the one place its colours are decided.
 *
 * ONE MAPPING, NOT ELEVEN CONDITIONS. Every place a category is shown reads
 * this table, so a category cannot end up amber in the list and violet
 * somewhere else. Adding a category to the domain without giving it a colour
 * here is a type error, not a chip that silently renders unstyled — the record
 * is keyed by `MessageCategory` and must be exhaustive.
 *
 * PASTEL, DELIBERATELY. Each entry is a 15% tint of its hue behind text two
 * steps darker, which is the same recipe the chip already used in amber. The
 * point of the colour is to let a reviewer scan a column and see that three
 * rows are the same kind of problem — not to shout. Saturated fills would put
 * eleven competing signals next to the status badge, which is the one thing on
 * the row that genuinely needs to be noticed.
 *
 * HUES ARE SPACED, not sequential. Categories that sit next to each other in
 * the list are the ones most easily confused at a glance, so the warm family
 * is split across damage/defect/return rather than given to four neighbours.
 */
export const CATEGORY_TAG_CLASS: Readonly<Record<MessageCategory, string>> = {
  // Cyan, deliberately NOT the sky the "Draft ready" status pill uses: the
  // two sit on the same row, and a category tag that matched the status pill
  // made one row look like it carried two of the same signal.
  "Delivery queries": "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  "Pre sales queries": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "Admin related issues": "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  "Order change, before shipping queries": "bg-lime-500/15 text-lime-700 dark:text-lime-300",
  "Defective items": "bg-red-500/15 text-red-700 dark:text-red-300",
  "Damage queries": "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "Wrong item sent messages": "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  "Parts missing queries": "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "Wrong quantity sent issues": "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "Wrong description issues": "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  "Return and refunds": "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

/**
 * Renders nothing when the classifier declined to name a category.
 *
 * An uncategorised conversation shows no chip at all rather than a grey
 * "Uncategorised" one: the absence is the honest rendering of "no category was
 * established", and a chip saying so would take a row's worth of attention to
 * report nothing.
 */
export function CategoryTag({ category }: { category: MessageCategory | null }) {
  if (category === null) return null;
  return (
    <span className={`rounded-md px-1.5 py-0.5 font-medium ${CATEGORY_TAG_CLASS[category]}`}>
      {category}
    </span>
  );
}
