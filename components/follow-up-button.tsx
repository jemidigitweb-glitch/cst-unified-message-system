"use client";

import { useCallback, useState } from "react";

import { MAX_REMINDER_NOTE_LENGTH } from "@/lib/domain/follow-up-reminder";
import {
  FOLLOW_UP_PRESET_HOURS,
  dueAtFromLocalInput,
  dueAtFromPreset,
  formatFollowUpDueAt,
} from "@/lib/domain/follow-up-view";

/**
 * "Set follow-up" — recording that CST promised this customer an update.
 *
 * ------------------------------------------------------------------------
 * IT WRITES A NOTE TO OURSELVES. IT DOES NOT TOUCH THE CUSTOMER.
 * ------------------------------------------------------------------------
 * One POST, to this conversation's follow-up route, which inserts one row.
 * Nothing here generates a draft, advances the workflow, queues anything or
 * reaches a marketplace — and it deliberately does not close or reload the
 * conversation behind it, because a reviewer who set a reminder mid-read should
 * find the thread exactly where they left it.
 *
 * The note is INTERNAL. It is CST writing to CST about what to come back to,
 * never text that becomes part of a reply; nothing in this application can send
 * one, and this control adds no path to it.
 *
 * ------------------------------------------------------------------------
 * 24 / 48 / 72 ARE CONVENIENCES, NOT A VOCABULARY
 * ------------------------------------------------------------------------
 * They are the promises CST actually makes, so they are one tap each — but each
 * is turned into an ABSOLUTE instant here, before the request leaves, because
 * the API stores a moment rather than a duration. "48 hours" recorded as a
 * duration would be reinterpreted against whatever start time a later reader
 * assumed; recorded as an instant it cannot drift.
 *
 * Custom is a wall clock read as SL TIME, the zone every deadline in this
 * application is already displayed in — see `dueAtFromLocalInput` for why the
 * browser's own zone would mean the number typed was not the number shown back.
 */

type Props = {
  conversationId: string;
  /**
   * Injected so the preview and the submitted instant are computed from the
   * same moment, and so a test can put the clock wherever it likes. Defaults to
   * the real clock, read once per opening rather than per render.
   */
  now?: () => Date;
  /** Told after a reminder is stored, so the panel and the badge can refresh. */
  onCreated?: () => void;
};

type Choice = { kind: "preset"; hours: number } | { kind: "custom" };

export function FollowUpButton({ conversationId, now = () => new Date(), onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>({ kind: "preset", hours: 24 });
  const [customAt, setCustomAt] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The due time that was actually stored, so success states a fact. */
  const [savedDueAt, setSavedDueAt] = useState<string | null>(null);

  const reset = useCallback(() => {
    setChoice({ kind: "preset", hours: 24 });
    setCustomAt("");
    setNote("");
    setError(null);
    setSavedDueAt(null);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

  const submit = useCallback(async () => {
    setError(null);

    /*
     * The instant is resolved HERE, not on the server: the server stores what
     * it is given, so a preview that showed one time and stored another would
     * be a lie the API could not catch.
     */
    const promisedDueAt =
      choice.kind === "preset"
        ? dueAtFromPreset(now(), choice.hours)
        : dueAtFromLocalInput(customAt);
    if (promisedDueAt === null) {
      setError("Enter a date and time for the follow-up.");
      return;
    }

    /*
     * Trimmed, and omitted entirely when empty — the API rejects a
     * whitespace-only note to match `ck_follow_up_reminders_note_present`, and
     * sending one just to be refused would be a round trip to learn what is
     * already known here.
     */
    const trimmed = note.trim();

    setSaving(true);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          trimmed === "" ? { promisedDueAt } : { promisedDueAt, note: trimmed },
        ),
      });
      if (!response.ok) throw new Error("request failed");
      const data = (await response.json()) as { reminder?: { promisedDueAt?: string } };
      // What the DATABASE stored, echoed back — not what was sent.
      setSavedDueAt(data.reminder?.promisedDueAt ?? promisedDueAt);
      setNote("");
      onCreated?.();
    } catch {
      setError("Unable to set this follow-up just now.");
    } finally {
      setSaving(false);
    }
  }, [choice, customAt, note, conversationId, now, onCreated]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Set follow-up for this conversation"
        aria-expanded={false}
        className="shrink-0 rounded-full border border-black/15 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.05]"
      >
        Set follow-up
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label="Set follow-up"
      className="flex w-[17rem] shrink-0 flex-col gap-2 rounded-md border border-black/15 bg-black/[0.02] p-3 text-xs dark:border-white/20 dark:bg-white/[0.04]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-bold tracking-widest uppercase opacity-70">
          Set follow-up
        </span>
        <button type="button" onClick={close} className="text-[11px] underline opacity-70">
          Close
        </button>
      </div>

      {savedDueAt !== null ? (
        /*
         * A CONTROLLED SUCCESS STATE that states the stored fact rather than
         * "Saved". The thread behind is untouched, and the reviewer is told so —
         * the commonest worry after pressing a button on a customer screen is
         * whether something went out.
         */
        <div className="flex flex-col gap-2">
          <p className="rounded-sm border border-emerald-600/40 bg-emerald-600/10 px-2 py-1.5 text-emerald-800 dark:text-emerald-200">
            Follow-up set for {formatFollowUpDueAt(savedDueAt)}. Nothing was sent to the customer.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={reset} className="underline opacity-70">
              Set another
            </button>
            <button type="button" onClick={close} className="underline opacity-70">
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {FOLLOW_UP_PRESET_HOURS.map((hours) => {
              const selected = choice.kind === "preset" && choice.hours === hours;
              return (
                <button
                  key={hours}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setChoice({ kind: "preset", hours })}
                  className={`rounded-full border px-2.5 py-1 font-medium transition-colors ${
                    selected
                      ? "border-black/30 bg-black/[0.07] dark:border-white/35 dark:bg-white/[0.12]"
                      : "border-black/15 dark:border-white/20"
                  }`}
                >
                  {hours}h
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={choice.kind === "custom"}
              onClick={() => setChoice({ kind: "custom" })}
              className={`rounded-full border px-2.5 py-1 font-medium transition-colors ${
                choice.kind === "custom"
                  ? "border-black/30 bg-black/[0.07] dark:border-white/35 dark:bg-white/[0.12]"
                  : "border-black/15 dark:border-white/20"
              }`}
            >
              Custom
            </button>
          </div>

          {choice.kind === "custom" ? (
            <label className="flex flex-col gap-1">
              {/* Labelled with the zone, because an unlabelled field invites the
                  reviewer to assume their own — and the panel reads it back in
                  SL time whatever they assumed. */}
              <span className="opacity-70">Due (SL time)</span>
              <input
                type="datetime-local"
                value={customAt}
                onChange={(event) => setCustomAt(event.target.value)}
                aria-label="Follow-up due date and time, SL time"
                className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
              />
            </label>
          ) : (
            <p className="opacity-60">
              Due {formatFollowUpDueAt(dueAtFromPreset(now(), choice.hours))}
            </p>
          )}

          <label className="flex flex-col gap-1">
            <span className="opacity-70">Note for CST (optional)</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={MAX_REMINDER_NOTE_LENGTH}
              aria-label="Internal follow-up note"
              placeholder="What to come back to"
              className="resize-none rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
            {/* Said where it is typed, not only in a doc comment. */}
            <span className="text-[10px] opacity-55">
              Internal only — never part of a customer reply.
            </span>
          </label>

          {error !== null && <p className="text-red-700 dark:text-red-300">{error}</p>}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="rounded-md border border-black/20 px-2.5 py-1.5 font-medium disabled:opacity-50 dark:border-white/25"
          >
            {saving ? "Setting…" : "Set follow-up"}
          </button>
        </>
      )}
    </div>
  );
}
