import type { WorkflowState } from "@/lib/domain/workflow";

/**
 * At-a-glance status pill for a list row.
 *
 * `workflowLabel()` in `lib/domain/inbox.ts` still exists and is still used
 * wherever plain text is the right weight (e.g. the draft panel's own
 * header) — this is an additional, visual layer for list rows, not a
 * replacement. It reads the same `workflowState` every row already carries;
 * nothing here is a new fact about the conversation, only a clearer way to
 * show the one that was already there.
 *
 * Wording is the reviewer's next action, not the database's state name — a
 * non-technical reader should be able to tell what to do without knowing
 * what "pending_review" means.
 */

const BADGES: Readonly<
  Record<WorkflowState, { text: string; dot: string; className: string }>
> = {
  received: {
    text: "Needs reply",
    dot: "bg-amber-500",
    className: "bg-amber-500/12 text-amber-800 dark:text-amber-300",
  },
  drafting: {
    text: "Draft ready",
    dot: "bg-sky-500",
    className: "bg-sky-500/12 text-sky-800 dark:text-sky-300",
  },
  pending_review: {
    text: "Needs human review",
    dot: "bg-amber-500",
    className: "bg-amber-500/12 text-amber-800 dark:text-amber-300",
  },
  reviewed: {
    text: "Reviewed",
    dot: "bg-emerald-500",
    className: "bg-emerald-500/12 text-emerald-800 dark:text-emerald-300",
  },
};

export function StatusBadge({ state }: { state: WorkflowState }) {
  const badge = BADGES[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${badge.dot}`} />
      {badge.text}
    </span>
  );
}
