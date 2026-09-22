"use client";

import { useCallback, useState } from "react";

import { formatSourceTimestamp } from "@/lib/domain/inbox";
import {
  INTERNAL_NOTE_MAX_LENGTH,
  INTERNAL_NOTE_REJECTION_MESSAGE,
  type InternalNote,
  parseInternalNoteUpdate,
} from "@/lib/domain/internal-note";

/**
 * One internal note, wherever it is shown.
 *
 * ONE COMPONENT FOR BOTH PLACES. The same note is rendered pinned under the
 * conversation header and again in the Internal Notes section of the details
 * column. Two implementations would be two chances for the edit control, the
 * delete confirmation or the timestamp to drift apart, and the reader would
 * have no way to know which one was current. The operations come from the
 * caller, which holds the single list — see `use-internal-notes.ts`.
 *
 * A CARD, NEVER A BUBBLE. No left/right side, no speaker label, no tail. The
 * conversation bubbles in `conversation-view.tsx` say who said something to
 * whom; a note was said to nobody. This is the rendering that keeps an
 * internal note from reading as a message.
 *
 * AMBER, BECAUSE THIS IS NOT CUSTOMER INFORMATION. The same amber the
 * customer-note card already uses: the application has one "this is a note,
 * not a message" colour, and a second near-identical yellow would be a
 * distinction without a difference.
 *
 * THE TEXT LEADS AND THE METADATA TRAILS. When the note was written and what
 * can be done to it both sit bottom-right, under the text and aligned away
 * from it, so a column of notes reads as a stack of what was recorded rather
 * than a stack of timestamps.
 *
 * DELETE ASKS FIRST, INLINE. A note is the only record of what somebody
 * observed about a case and there is no undo, so a stray click must not be
 * enough. The confirmation is a second click on the same row rather than a
 * browser dialog: this application has no modal anywhere, and a native
 * `confirm()` would be a new convention as well as an untestable one.
 */

const FIELD_CLASS =
  "w-full resize-y rounded border border-amber-600/25 bg-transparent px-2 py-1.5 text-sm dark:border-amber-300/25";

const ACTION_CLASS =
  "rounded-full border border-amber-600/30 px-3 py-1 text-xs font-medium transition-all hover:-translate-y-px hover:bg-amber-500/15 active:translate-y-0 disabled:translate-y-0 disabled:opacity-40 disabled:hover:bg-transparent dark:border-amber-300/30";

/** A quieter control for the per-note actions, so they do not compete with Add. */
const INLINE_CLASS =
  "text-[11px] underline decoration-dotted underline-offset-2 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-35";

export function InternalNoteCard({
  note,
  onSave,
  onDelete,
  busy = false,
}: {
  note: InternalNote;
  onSave: (noteId: string, text: string) => Promise<string | null>;
  onDelete: (noteId: string) => Promise<string | null>;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.noteText);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const stamp = formatSourceTimestamp(note.createdAt);
  // Said only when it happened, so an unedited note carries no extra word.
  const edited = note.updatedAt !== note.createdAt;

  const startEdit = useCallback(() => {
    setDraft(note.noteText);
    setError(null);
    setConfirming(false);
    setEditing(true);
  }, [note.noteText]);

  const save = useCallback(async () => {
    const checked = parseInternalNoteUpdate({ noteText: draft });
    if (!checked.ok) {
      setError(INTERNAL_NOTE_REJECTION_MESSAGE[checked.reason]);
      return;
    }
    setWorking(true);
    setError(null);
    const failure = await onSave(note.id, checked.edit.noteText);
    setWorking(false);
    if (failure === null) setEditing(false);
    else setError(failure);
  }, [draft, note.id, onSave]);

  const remove = useCallback(async () => {
    setWorking(true);
    setError(null);
    const failure = await onDelete(note.id);
    setWorking(false);
    // On success this card unmounts with the note, so only a failure is shown.
    if (failure !== null) {
      setConfirming(false);
      setError(failure);
    }
  }, [note.id, onDelete]);

  const disabled = busy || working;

  return (
    <div
      data-testid="internal-note"
      className="rounded-lg border border-amber-500/30 bg-amber-500/[0.10] px-3 py-2 dark:border-amber-300/25 dark:bg-amber-300/[0.08]"
    >
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            rows={3}
            maxLength={INTERNAL_NOTE_MAX_LENGTH}
            disabled={working}
            autoFocus
            className={FIELD_CLASS}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={working || draft.trim() === ""}
              className={ACTION_CLASS}
            >
              {working ? "Saving…" : "Update"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={working}
              className={ACTION_CLASS}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* `wrap-anywhere` for the same reason every other verbatim body
              here has it: a note routinely carries a tracking reference or a
              combo SKU that no space breaks. See
              tests/guards/message-wrapping.test.ts. */}
          <p className="text-sm whitespace-pre-wrap wrap-anywhere">{note.noteText}</p>

          {/* Bottom-right: when it was written, then what can be done to it. */}
          <div className="mt-2 flex flex-col items-end gap-0.5">
            <span className="text-[10px] tabular-nums opacity-55">
              {stamp.date} {stamp.time}
              {edited && " (edited)"}
            </span>
            {confirming ? (
              <span
                data-testid="internal-note-confirm"
                className="flex items-center gap-2 text-[11px]"
              >
                <span className="opacity-70">Delete this note?</span>
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={working}
                  className={INLINE_CLASS}
                >
                  {working ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={working}
                  className={INLINE_CLASS}
                >
                  Keep
                </button>
              </span>
            ) : (
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={startEdit}
                  disabled={disabled}
                  className={INLINE_CLASS}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setConfirming(true);
                  }}
                  disabled={disabled}
                  className={INLINE_CLASS}
                >
                  Delete
                </button>
              </span>
            )}
          </div>
        </>
      )}

      {error !== null && (
        <p className="mt-1.5 text-[11px] text-amber-800 dark:text-amber-200">{error}</p>
      )}
    </div>
  );
}
