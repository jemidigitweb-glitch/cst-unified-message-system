"use client";

import type { FollowUpReminder } from "@/lib/domain/follow-up-reminder";
import {
  FOLLOW_UP_STATE_CLASS,
  FOLLOW_UP_STATE_LABEL,
  followUpDisplayState,
  followUpRelativeTime,
  formatFollowUpDueAt,
  sortByDueSoonest,
} from "@/lib/domain/follow-up-view";

import type { ConversationFollowUpsState } from "./use-conversation-follow-ups";

/**
 * What THIS thread was promised, above the thread that owes it.
 *
 * ------------------------------------------------------------------------
 * WHY IT EXISTS
 * ------------------------------------------------------------------------
 * The note on a reminder was readable only in the follow-up drawer. Pressing
 * that drawer's own "Open conversation" button then hid it: eBay
 * `frequentedfrequencies` was 17 hours overdue with the note "come back", and
 * the conversation it named showed a pinned internal note, a thread and no
 * mention of the promise at all. The agent arrived at the right place having
 * lost the reason they came.
 *
 * ------------------------------------------------------------------------
 * IN THE DETAILS PANEL, AND IT WAS ABOVE THE THREAD FIRST
 * ------------------------------------------------------------------------
 * The first attempt put this between the conversation header and the message
 * scroller, beside the pinned internal note. Two stacked cards there crowded
 * each other and squeezed the thread, and the pinned note is the one that earns
 * that position: it is guidance an agent reads the messages AGAINST. A
 * follow-up is a deadline they need to SEE.
 *
 * So it sits in the details column, directly above Internal Notes — where a
 * reviewer already looks for what CST has written to itself about this case.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT THE INTERNAL NOTE, AND MUST NOT LOOK LIKE IT
 * ------------------------------------------------------------------------
 * Internal Notes is amber and is standing guidance. This is a dated promise
 * with a clock running against it, and it carries the drawer's own state
 * colours (`FOLLOW_UP_STATE_CLASS`) so OVERDUE reads the same red here as it
 * does there. Two panels that looked alike would invite an agent to read a
 * deadline as a note.
 *
 * ------------------------------------------------------------------------
 * SCHEDULED ONLY
 * ------------------------------------------------------------------------
 * A completed reminder is history and belongs in the drawer's Completed tab,
 * not stacked above a live thread. Filtering here rather than in the route
 * keeps `GET /api/conversations/:id/follow-up` a complete answer about the
 * conversation, which the drawer and any later reader can still rely on.
 *
 * NOTHING HERE CONTACTS A CUSTOMER. One action exists — mark completed — and
 * it sets one row's status. No draft, no message, no marketplace call.
 */
export function ConversationFollowUps({
  followUps,
}: {
  followUps: ConversationFollowUpsState;
  /**
   * Passed in rather than read here, so every row on this card and every row
   * in the drawer are measured against one moment. A component that called
   * `new Date()` itself would drift from the badge the agent just came from.
   */
}) {
  const { reminders, loadError, completing, failures, retry, complete } = followUps;

  /*
   * A NEW `Date` PER RENDER IS CORRECT HERE, and deliberately not hoisted into
   * state with an interval. This card is re-rendered whenever the conversation
   * changes or a reminder completes, and the figures it prints are whole hours
   * and minutes — a ticking clock would be a second timer for a value that
   * changes meaningfully once an hour. The SLA panel ticks because it counts
   * down to a breach; a promise does not become a different promise at 17h 18m.
   */
  const now = new Date();

  if (loadError !== null) {
    return (
      <section className="rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/15">
        <p className="text-xs opacity-70">
          {loadError}{" "}
          <button
            type="button"
            onClick={retry}
            className="underline underline-offset-2 hover:opacity-100"
          >
            Try again
          </button>
        </p>
      </section>
    );
  }

  // Null is "not read yet" and an empty list is "nothing promised". Neither is
  // worth a row: a thread with no follow-up should look like a thread.
  if (reminders === null) return null;
  const scheduled = sortByDueSoonest(
    reminders.filter((reminder) => reminder.status === "scheduled"),
  );
  if (scheduled.length === 0) return null;

  return (
    <section
      data-testid="conversation-follow-ups"
      aria-label="Follow-ups on this conversation"
      /*
       * Its own frame, like Internal Notes below it and unlike the plain
       * sections beneath that — the boundary between "what CST owes" and the
       * conversation's facts should be visible before anything is read.
       *
       * Bounded, so a long note scrolls inside its own box rather than pushing
       * the rest of the panel down.
       */
      className="flex max-h-56 flex-col overflow-y-auto rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2.5 dark:border-white/15 dark:bg-white/[0.03]"
    >
      <h3 className="text-[11px] font-semibold tracking-wide uppercase opacity-70">
        {scheduled.length === 1 ? "Follow-up" : `Follow-ups (${scheduled.length})`}
      </h3>
      <ul className="mt-2 flex flex-col gap-3">
        {scheduled.map((reminder) => (
          <Row
            key={reminder.id}
            reminder={reminder}
            now={now}
            busy={completing === reminder.id}
            failure={failures[reminder.id] ?? null}
            onComplete={complete}
          />
        ))}
      </ul>
    </section>
  );
}

function Row({
  reminder,
  now,
  busy,
  failure,
  onComplete,
}: {
  reminder: FollowUpReminder;
  now: Date;
  busy: boolean;
  failure: string | null;
  onComplete: (reminderId: string) => Promise<string | null>;
}) {
  const state = followUpDisplayState({
    status: reminder.status,
    promisedDueAt: reminder.promisedDueAt,
    now,
  });
  const relative = followUpRelativeTime({
    status: reminder.status,
    promisedDueAt: reminder.promisedDueAt,
    now,
  });

  return (
    <li className="flex flex-col gap-1.5">
      {/*
       * STACKED, NOT IN A ROW. This column is narrow — the badge, an absolute
       * time, a relative time and a button on one line wrapped into an
       * unreadable tangle at panel width. The badge leads because OVERDUE is
       * the thing worth seeing first.
       */}
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ${FOLLOW_UP_STATE_CLASS[state]}`}
        >
          {FOLLOW_UP_STATE_LABEL[state]}
        </span>
        {relative !== null && (
          <span className="text-[11px] tabular-nums opacity-70">{relative}</span>
        )}
      </span>

      <span className="text-[11px] tabular-nums opacity-70">
        {formatFollowUpDueAt(reminder.promisedDueAt)}
      </span>

      {/*
       * THE NOTE — THE WHOLE POINT OF THE CARD.
       *
       * CST's own words, rendered as text and never as markup, and never sent
       * anywhere. A reminder without one still shows its badge and deadline,
       * because "come back by Tuesday" is worth surfacing even when nobody
       * wrote down why.
       */}
      {reminder.note !== null && (
        <span className="text-xs whitespace-pre-wrap opacity-90">{reminder.note}</span>
      )}

      {failure !== null && (
        <span className="text-[11px] text-amber-800 dark:text-amber-200">{failure}</span>
      )}

      {/*
       * Last, and on its own line. The note is what an agent came to read; the
       * action follows it rather than competing with it for the first line.
       */}
      <span>
        <button
          type="button"
          onClick={() => void onComplete(reminder.id)}
          disabled={busy}
          className="rounded-full border border-black/15 px-2.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-black/[0.03] disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/[0.05]"
        >
          {busy ? "Completing…" : "Mark completed"}
        </button>
      </span>
    </li>
  );
}
