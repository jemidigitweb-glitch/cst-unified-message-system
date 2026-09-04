import type { MessagePriority } from "@/lib/knowledge/message-priority";

/**
 * The priority marker, and the one place its colours and wording are decided.
 *
 * A RIBBON, NOT A THIRD CHIP. The row already carries two labelled pills — the
 * category capsule and the status badge — and a third would turn a scannable
 * list into a wall of text. This says one thing with one colour and no words,
 * so a reviewer can see which rows are red without reading any of them.
 *
 * COLOUR IS THE WHOLE MESSAGE, so it is solid rather than the 15% tint the
 * category chip uses. The tints exist to stop eleven categories out-shouting
 * the status badge; there are only three priorities and their entire job is to
 * be noticed. A solid block also means the ribbon can never be mistaken for a
 * chip at a glance, which is what keeps the three signals on the row readable
 * as three separate things.
 *
 * NO SORTING, ANYWHERE. This colours a row and filters it. The inbox stays
 * ordered newest-first, because a list that reorders itself by a derived
 * reading is a list where a reviewer cannot find what they saw a moment ago.
 */

/**
 * Red, yellow, green — the ordinary traffic light, because that is the one
 * colour scale a reader needs no legend for.
 *
 * Keyed by `MessagePriority` and therefore exhaustive: adding a level to the
 * engine without giving it a colour here is a type error, not a ribbon that
 * silently renders unstyled.
 */
export const PRIORITY_RIBBON_CLASS: Readonly<Record<MessagePriority, string>> = {
  HIGH: "bg-red-500",
  MEDIUM: "bg-yellow-400",
  LOW: "bg-green-500",
};

/**
 * How a priority is said in English, for the dropdown and for the ribbon's
 * accessible name. One table, so the filter and the marker can never disagree
 * about what to call the same level.
 */
export const PRIORITY_LABEL: Readonly<Record<MessagePriority, string>> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

/** "High priority" — what a screen reader announces, and what a hover shows. */
export function priorityDescription(priority: MessagePriority): string {
  return `${PRIORITY_LABEL[priority]} priority`;
}

/**
 * The ribbon geometry, kept here rather than inline in the row.
 *
 * IT HANGS OFF THE RIGHT EDGE AND POINTS LEFT. `absolute right-0` pins it to
 * the row's right edge and the clip-path cuts a V into its LEFT end, which is
 * the tail of a ribbon running back into the row — the shape a reader already
 * knows means "marked". Wider than it is tall, so it reads as a horizontal tab
 * rather than the vertical bookmark a right-hand marker usually becomes.
 *
 * IT IS NOT A BORDER AND NOT A PILL. No rounding, no text, no padding: a
 * rounded end would make it a capsule, and a capsule beside two real capsules
 * is a third label rather than a marker.
 *
 * THE ROW MAKES ROOM FOR IT rather than the ribbon overlapping anything — see
 * the row's right padding in `InboxList`. Nothing here overlaps the title, the
 * timestamp, the category capsule or the status badge.
 */
const RIBBON_SHAPE =
  "pointer-events-none absolute top-1/2 right-0 h-3 w-6 -translate-y-1/2 [clip-path:polygon(100%_0,100%_100%,0_100%,25%_50%,0_0)]";

/**
 * Renders NOTHING when no priority was established.
 *
 * An unranked conversation gets no ribbon at all — never a green one. Green is
 * a claim that this can wait, and the engine returning null means it could not
 * read the conversation well enough to make any claim. A message nobody could
 * read is not a message that can wait, and colouring it as though it were is
 * the one way this marker could actively mislead.
 */
export function PriorityRibbon({ priority }: { priority: MessagePriority | null }) {
  if (priority === null) return null;
  const description = priorityDescription(priority);
  return (
    <span
      role="img"
      aria-label={description}
      title={description}
      className={`${RIBBON_SHAPE} ${PRIORITY_RIBBON_CLASS[priority]}`}
    />
  );
}
