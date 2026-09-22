"use client";

import type { FollowUpReminder } from "@/lib/domain/follow-up-reminder";
import {
  FOLLOW_UP_STATE_CLASS,
  FOLLOW_UP_STATE_LABEL,
  FOLLOW_UP_TABS,
  type FollowUpFeed,
  type FollowUpTab,
  followUpDisplayState,
  followUpRelativeTime,
  formatFollowUpDueAt,
  sortByDueSoonest,
} from "@/lib/domain/follow-up-view";
import { conversationTitle } from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";

/**
 * The shared follow-up list, inside the existing notification drawer.
 *
 * ------------------------------------------------------------------------
 * SHARED, AND ACROSS EVERY MARKETPLACE
 * ------------------------------------------------------------------------
 * Every CST user sees the same reminders. There is no owner, no assignee and
 * no "mine" filter, because this application has no current user — and a
 * promise made on an Amazon thread is owed whether or not the reviewer is
 * looking at the eBay tab, exactly as the notification feed beside it is.
 *
 * ------------------------------------------------------------------------
 * TWO SECTIONS, FOUR BADGES
 * ------------------------------------------------------------------------
 * `Scheduled` and `Completed` are what a reminder IS; upcoming / due soon /
 * overdue are how a scheduled one READS against the clock, so they are badges
 * inside the first list rather than tabs of their own. A reminder moving
 * between tabs as time passed would make a reviewer hunt for it.
 *
 * ------------------------------------------------------------------------
 * NOTHING HERE CONTACTS A CUSTOMER
 * ------------------------------------------------------------------------
 * Two actions exist on a row: open the conversation, which is navigation and
 * nothing else, and mark completed, which changes one row's status. Neither
 * sends, drafts, queues or copies a reply. Passing the due time changes
 * nothing at all — a reminder goes overdue by being read, not by being written.
 */

/** What the list needs to name a conversation, from data already loaded. */
export type ConversationLabel = {
  readonly counterpartyRef: string;
  readonly marketplace: Marketplace;
};

export function FollowUpList({
  feed,
  error,
  tab,
  onSelectTab,
  labels,
  failures,
  completing,
  now,
  onOpenConversation,
  onComplete,
}: {
  feed: FollowUpFeed | null;
  error: string | null;
  tab: FollowUpTab;
  onSelectTab: (tab: FollowUpTab) => void;
  /**
   * Conversation names the workspace ALREADY has, keyed by conversation id.
   *
   * BEST EFFORT, AND NEVER INVENTED. The reminder API returns a conversation
   * id and no customer identity, so a row is named only when that conversation
   * is already loaded somewhere on this screen — the inbox page or the
   * notification feed. A reminder we cannot name says so plainly rather than
   * guessing a customer or an order. See the report's note on the missing
   * backend display fields.
   */
  labels: Readonly<Record<string, ConversationLabel>>;
  /** Why an individual row would not complete or open, keyed by reminder id. */
  failures: Readonly<Record<string, string>>;
  /** Which row is mid-request, so its button can say so. */
  completing: string | null;
  /** Passed in, so every row is measured against one moment. */
  now: Date;
  onOpenConversation: (reminderId: string, conversationId: string) => void;
  onComplete: (reminderId: string) => void;
}) {
  const reminders = feed?.reminders ?? [];
  const ordered = tab === "scheduled" ? sortByDueSoonest(reminders) : reminders;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-black/10 px-4 py-2 dark:border-white/15">
        {FOLLOW_UP_TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-pressed={tab === entry.key}
            onClick={() => onSelectTab(entry.key)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              tab === entry.key
                ? "border-black/25 bg-black/[0.06] dark:border-white/30 dark:bg-white/[0.10]"
                : "border-black/10 dark:border-white/15"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error !== null ? (
        <p className="p-5 text-sm opacity-70">{error}</p>
      ) : feed === null ? (
        <p className="p-5 text-sm opacity-60">Loading…</p>
      ) : ordered.length === 0 ? (
        <p className="p-5 text-sm opacity-60">
          {tab === "scheduled"
            ? "No follow-ups are scheduled."
            : "No follow-ups have been completed yet."}
        </p>
      ) : (
        <ul>
          {ordered.map((reminder) => (
            <FollowUpRow
              key={reminder.id}
              reminder={reminder}
              label={labels[reminder.conversationId] ?? null}
              failure={failures[reminder.id] ?? null}
              busy={completing === reminder.id}
              now={now}
              onOpenConversation={onOpenConversation}
              onComplete={onComplete}
            />
          ))}
        </ul>
      )}

      {feed?.hasMore === true && (
        // Said rather than hidden: a short list is not by itself evidence that
        // there is nothing else, and an interface that cannot tell those apart
        // will present one as the other.
        <p className="px-4 py-3 text-[11px] opacity-60">
          Showing the first {reminders.length}. More exist.
        </p>
      )}
    </div>
  );
}

function FollowUpRow({
  reminder,
  label,
  failure,
  busy,
  now,
  onOpenConversation,
  onComplete,
}: {
  reminder: FollowUpReminder;
  label: ConversationLabel | null;
  failure: string | null;
  busy: boolean;
  now: Date;
  onOpenConversation: (reminderId: string, conversationId: string) => void;
  onComplete: (reminderId: string) => void;
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
  const capability = label === null ? null : capabilityOf(label.marketplace);

  return (
    <li className="flex flex-col gap-1.5 border-b border-black/5 px-4 py-3 dark:border-white/10">
      <span className="flex items-baseline justify-between gap-2">
        {/*
         * Named from data already on screen where we have it, and plainly
         * identified where we do not — never a guessed customer. `conversationTitle`
         * decides from THAT row's capability whether the stored reference is a
         * real handle or a source reference that must not be printed as a person.
         */}
        <span className="truncate text-sm font-medium">
          {label !== null && capability !== null
            ? conversationTitle({ counterpartyRef: label.counterpartyRef }, capability)
            : `Conversation #${reminder.conversationId}`}
        </span>
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ${FOLLOW_UP_STATE_CLASS[state]}`}
        >
          {FOLLOW_UP_STATE_LABEL[state]}
        </span>
      </span>

      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] opacity-70">
        <span className="tabular-nums">{formatFollowUpDueAt(reminder.promisedDueAt)}</span>
        {relative !== null && <span className="tabular-nums">· {relative}</span>}
        {capability !== null && <span>· {capability.label}</span>}
      </span>

      {reminder.note !== null && (
        // CST's own words. Never rendered as markup and never sent anywhere.
        <span className="line-clamp-3 text-xs opacity-80">{reminder.note}</span>
      )}

      {failure !== null && (
        <span className="text-[11px] text-amber-800 dark:text-amber-200">{failure}</span>
      )}

      <span className="flex flex-wrap gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => onOpenConversation(reminder.id, reminder.conversationId)}
          className="rounded-full border border-black/15 px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.05]"
        >
          Open conversation
        </button>
        {/*
         * ONLY ON A SCHEDULED REMINDER, and only when a person presses it.
         * Opening the conversation does not complete it, and neither does the
         * due time passing — see `followUpDisplayState`, which reads the clock
         * and writes nothing.
         */}
        {reminder.status === "scheduled" && (
          <button
            type="button"
            onClick={() => onComplete(reminder.id)}
            disabled={busy}
            className="rounded-full border border-black/15 px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-black/[0.03] disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/[0.05]"
          >
            {busy ? "Completing…" : "Mark completed"}
          </button>
        )}
      </span>
    </li>
  );
}
