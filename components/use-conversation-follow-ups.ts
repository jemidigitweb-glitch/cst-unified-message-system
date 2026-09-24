"use client";

import { useCallback, useEffect, useState } from "react";

import type { FollowUpReminder } from "@/lib/domain/follow-up-reminder";
import type { ConversationFollowUpFeed } from "@/lib/domain/follow-up-view";

/**
 * What this conversation has been promised, for the thread that owes it.
 *
 * ------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ------------------------------------------------------------------------
 * A reminder's note was readable in exactly one place: the follow-up drawer.
 * Open the conversation from it — which is what the drawer's own button
 * invites — and the note vanished. Found on eBay `frequentedfrequencies`,
 * which was 17 hours OVERDUE with the note "come back": the drawer said so,
 * the thread said nothing, and the one word telling an agent what they had
 * promised was on the screen they had just left.
 *
 * ------------------------------------------------------------------------
 * THE BACKEND WAS ALREADY THERE
 * ------------------------------------------------------------------------
 * `GET /api/conversations/:id/follow-up` has always answered this, and
 * `ConversationFollowUpFeed` has always described the shape. Nothing in the
 * interface had ever called it — the route and the type were written for a
 * reader that was never built. This is that reader.
 *
 * ------------------------------------------------------------------------
 * READS FOLLOW-UPS, AND NOTHING ELSE
 * ------------------------------------------------------------------------
 * It reaches `/api/conversations/:id/follow-up` and the completion endpoint.
 * No message, draft, customer note or internal note can enter this list, and
 * nothing here contacts a customer: completing a reminder sets one row's
 * status. A reminder is a note CST wrote to itself.
 */

export type ConversationFollowUpsState = {
  /** Newest promise first, as the route returns them. Null until the first read lands. */
  readonly reminders: readonly FollowUpReminder[] | null;
  readonly loadError: string | null;
  /** Which reminder is mid-completion, so its control can say so. */
  readonly completing: string | null;
  /** Why a completion failed, keyed by reminder id. */
  readonly failures: Readonly<Record<string, string>>;
  readonly retry: () => void;
  /** Marks one reminder completed. Returns null on success, or the sentence to show. */
  readonly complete: (reminderId: string) => Promise<string | null>;
};

/** The message shown for a failed request with no readable body. */
function messageFrom(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((data: { error?: string }) => (typeof data.error === "string" ? data.error : fallback))
    .catch(() => fallback);
}

export function useConversationFollowUps(
  conversationId: string | null,
): ConversationFollowUpsState {
  const [reminders, setReminders] = useState<readonly FollowUpReminder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by Try again and after a completion, so the effect re-reads. */
  const [attempt, setAttempt] = useState(0);

  const [completing, setCompleting] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});

  /**
   * Loads with the conversation, and again when `attempt` moves.
   *
   * Every `setState` sits after an await — the same shape `useInternalNotes`
   * uses — because a synchronous `setState` in an effect body trips
   * `react-hooks/set-state-in-effect` and causes a cascading render.
   * `cancelled` stops a response for a conversation the agent has already
   * navigated away from landing in the new one's card.
   */
  useEffect(() => {
    if (conversationId === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/follow-up`);
        if (!response.ok) throw new Error("request failed");
        const payload = (await response.json()) as ConversationFollowUpFeed;
        if (cancelled) return;
        setReminders(payload.reminders);
        setLoadError(null);
        /*
         * Cleared HERE rather than in an effect of their own.
         *
         * A separate `useEffect` keyed on `conversationId` would be a
         * synchronous `setState` in an effect body, which
         * `react-hooks/set-state-in-effect` rejects and is right to: it causes
         * a cascading render. Clearing after the await costs nothing, because
         * a failure is keyed by REMINDER id — one belonging to the previous
         * conversation cannot match a row in the list that just replaced it,
         * so it is unreachable in the render between the two.
         */
        setFailures({});
        setCompleting(null);
      } catch {
        /*
         * The reason is not shown. A failed read means the card is not on
         * screen, and "unable to load" is all an agent can act on — but it must
         * still SAY that rather than render nothing, or an unreadable reminder
         * and an absent one would look identical.
         */
        if (cancelled) return;
        setReminders(null);
        setLoadError("Unable to load follow-ups for this conversation.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const complete = useCallback(
    async (reminderId: string): Promise<string | null> => {
      setCompleting(reminderId);
      try {
        const response = await fetch(`/api/follow-up-reminders/${reminderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        /*
         * 409 IS NOT AN ERROR IN THE ORDINARY SENSE. Reminders are shared
         * across CST with no owner, so somebody else completing one between
         * this card rendering and the button being pressed is expected. The
         * drawer says exactly this; saying something different here would make
         * the same event read as two different problems.
         */
        if (response.status === 409) {
          const message = "Already completed by someone else. This has been refreshed.";
          setFailures((current) => ({ ...current, [reminderId]: message }));
          setAttempt((n) => n + 1);
          return message;
        }
        if (!response.ok) {
          const message = await messageFrom(response, "Unable to complete this follow-up.");
          setFailures((current) => ({ ...current, [reminderId]: message }));
          return message;
        }
        /*
         * Re-read rather than patch the row in place. The card shows a state
         * computed from the clock, and the drawer is reading the same rows —
         * taking the server's answer is what keeps the two from disagreeing
         * about a reminder the agent has just closed.
         */
        setFailures((current) => {
          const next = { ...current };
          delete next[reminderId];
          return next;
        });
        setAttempt((n) => n + 1);
        return null;
      } catch {
        const message = "Unable to complete this follow-up.";
        setFailures((current) => ({ ...current, [reminderId]: message }));
        return message;
      } finally {
        setCompleting(null);
      }
    },
    [],
  );

  return { reminders, loadError, completing, failures, retry, complete };
}
