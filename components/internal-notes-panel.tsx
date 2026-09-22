"use client";

import { useState } from "react";

import {
  INTERNAL_NOTES_TITLE,
  INTERNAL_NOTE_MAX_LENGTH,
} from "@/lib/domain/internal-note";

import { InternalNoteCard } from "./internal-note-card";
import type { InternalNotesState } from "./use-internal-notes";

/**
 * Internal notes, as a section of the details column. The management and
 * history side of the feature.
 *
 * TWO PLACES, ONE LIST. The newest note is also pinned under the conversation
 * header — see `pinned-internal-note.tsx`. Both render the same objects from
 * the same state, so an edit here changes the pinned card and a delete here
 * removes it. There is no second copy and no second request.
 *
 * A SECTION, NOT A CONTROL. It was a pill an agent had to click, which made
 * the notes on a case invisible until asked for — the opposite of what an
 * operational summary is for. The heading is a heading; the notes are simply
 * there.
 *
 * AMBER, BECAUSE THIS IS NOT CUSTOMER INFORMATION. Every other section in
 * this column states something read from the customer or their purchase.
 * These are the only rows CST wrote, and the tint says so at a glance.
 *
 * NOTHING EXPLAINS ITSELF. No caption saying the notes are internal, and no
 * sentence when there are none: an empty section under a heading that reads
 * Internal Notes has already said everything a sentence would.
 *
 * NO CATEGORY. The column still exists and is filled by the writer — see
 * `STORED_INTERNAL_NOTE_CATEGORY` — but nobody is asked about it.
 *
 * PRESENTATIONAL. Every operation comes from `useInternalNotes`, held by the
 * workspace so the two renderings cannot diverge.
 */

const FIELD_CLASS =
  "w-full resize-y rounded border border-amber-600/25 bg-transparent px-2 py-1.5 text-sm dark:border-amber-300/25";

const ACTION_CLASS =
  "rounded-full border border-amber-600/30 px-3 py-1 text-xs font-medium transition-all hover:-translate-y-px hover:bg-amber-500/15 active:translate-y-0 disabled:translate-y-0 disabled:opacity-40 disabled:hover:bg-transparent dark:border-amber-300/30";

export function InternalNotesSection({ notes }: { notes: InternalNotesState }) {
  const [noteText, setNoteText] = useState("");

  return (
    <section
      data-testid="internal-notes"
      /* The tint marks the whole section, not just the cards, so the boundary
         between "what CST recorded" and the customer-derived sections around
         it is visible before a single note is read. Kept light: this column
         already carries status pills and category chips, and a saturated
         panel would outrank them. */
      className="flex flex-col gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] p-3 dark:border-amber-300/25 dark:bg-amber-300/[0.04]"
    >
      {/* A heading, not a control. Sentence case and a rule beneath it, so the
          section announces itself without looking like something to click. */}
      <h2 className="border-b border-amber-500/25 pb-1.5 text-xs font-semibold tracking-wide text-amber-900 dark:border-amber-300/20 dark:text-amber-200">
        {INTERNAL_NOTES_TITLE}
      </h2>

      {notes.loading && <p className="text-sm opacity-60">Loading…</p>}

      {notes.loadError !== null && (
        <div className="flex items-center gap-2">
          <p className="text-sm text-amber-800 dark:text-amber-200">{notes.loadError}</p>
          <button type="button" onClick={notes.retry} className={ACTION_CLASS}>
            Try again
          </button>
        </div>
      )}

      {/* No empty state. An empty section under this heading has said it. */}
      {notes.notes !== null && notes.notes.length > 0 && (
        <ol className="flex flex-col gap-2">
          {notes.notes.map((note) => (
            <li key={note.id}>
              <InternalNoteCard
                note={note}
                onSave={notes.save}
                onDelete={notes.remove}
                busy={notes.saving}
              />
            </li>
          ))}
        </ol>
      )}

      {/*
        The add-note area. No <form> element and no submit event: a nested form
        inside the sidebar would take Enter away from the textarea, where a
        note legitimately spans several lines.
      */}
      <div className="flex flex-col gap-1.5">
        <textarea
          value={noteText}
          onChange={(event) => {
            setNoteText(event.target.value);
            notes.clearSaveError();
          }}
          rows={2}
          maxLength={INTERNAL_NOTE_MAX_LENGTH}
          disabled={notes.saving}
          placeholder="Add a note"
          aria-label="Add an internal note"
          className={FIELD_CLASS}
        />
        <div className="flex justify-end">
          <button
            type="button"
            /* Cleared only when the note was actually stored: a rejection
               leaves the text where the agent can correct it. */
            onClick={() => {
              void notes.add(noteText).then((stored) => {
                if (stored) setNoteText("");
              });
            }}
            disabled={notes.saving || noteText.trim() === ""}
            className={ACTION_CLASS}
          >
            {notes.saving ? "Adding…" : "Add note"}
          </button>
        </div>
        {notes.saveError !== null && (
          <p
            data-testid="internal-note-error"
            className="text-[11px] text-amber-800 dark:text-amber-200"
          >
            {notes.saveError}
          </p>
        )}
      </div>
    </section>
  );
}
