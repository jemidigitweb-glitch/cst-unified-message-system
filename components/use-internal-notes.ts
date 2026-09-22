"use client";

import { useCallback, useEffect, useState } from "react";

import {
  INTERNAL_NOTE_REJECTION_MESSAGE,
  type InternalNote,
  type InternalNoteFeed,
  parseInternalNoteRequest,
  parseInternalNoteUpdate,
} from "@/lib/domain/internal-note";

/**
 * One conversation's internal notes, held once and rendered twice.
 *
 * WHY A HOOK RATHER THAN STATE IN EACH PANEL. The same notes appear in two
 * places on the screen: pinned under the conversation header in the centre
 * column, and in the Internal Notes section of the details column. Those are
 * siblings — `<main>` and `<aside>` in `workspace.tsx` — so two copies of this
 * state would be two lists that drift apart the moment one of them is edited.
 * The workspace holds it once and passes it to both, which is exactly what it
 * already does for `selectedOrderNumber` and for the same reason.
 *
 * THE PIN IS DERIVED, NOT STORED. There is no pin flag, no pin table and no
 * pin request: an internal note IS a pinned internal note, so the pinned area
 * renders the newest entry of this same list. Nothing here writes twice, and
 * deleting the note removes both renderings because there is only one note.
 *
 * ONLY INTERNAL NOTES. This hook reaches
 * `/api/conversations/:id/notes` and nothing else. No conversation message,
 * customer note or CST reply can enter this list — they are not in the
 * response and there is no code path that would put one here.
 */

export type InternalNotesState = {
  /** Newest first, as the API returns them. Null until the first read lands. */
  readonly notes: readonly InternalNote[] | null;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly retry: () => void;
  /**
   * Adds a note. The stored row is prepended; nothing is re-fetched.
   *
   * Returns whether it was stored, so the caller clears the box only when
   * there is nothing left to correct — clearing it on a rejection would throw
   * away what the agent typed along with their chance to fix it.
   */
  readonly add: (text: string) => Promise<boolean>;
  /** Returns null on success, or the sentence to show beside the note. */
  readonly save: (noteId: string, text: string) => Promise<string | null>;
  readonly remove: (noteId: string) => Promise<string | null>;
  readonly clearSaveError: () => void;
};

/** The message shown for a failed request with no readable body. */
function messageFrom(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((data: { error?: string }) => (typeof data.error === "string" ? data.error : fallback))
    .catch(() => fallback);
}

export function useInternalNotes(conversationId: string | null): InternalNotesState {
  const [notes, setNotes] = useState<readonly InternalNote[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by Try again, so the effect re-runs without a second fetcher. */
  const [attempt, setAttempt] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * Loads with the conversation, and again when Try again bumps `attempt`.
   *
   * The async work is an inline IIFE and every `setState` sits after an await,
   * which is the shape `CurrentListingSection` in `context-panel.tsx` already
   * uses — a synchronous `setState` in an effect body triggers a cascading
   * render (`react-hooks/set-state-in-effect`). `cancelled` stops a response
   * for a conversation the agent has already navigated away from landing in
   * the new one's list.
   */
  useEffect(() => {
    if (conversationId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/notes`);
        if (!response.ok) throw new Error("request failed");
        const payload = (await response.json()) as InternalNoteFeed;
        if (cancelled) return;
        setNotes(payload.notes);
        setLoadError(null);
      } catch {
        // The reason is not shown: a failed read means the notes are not on
        // screen, and "unable to load" is all an agent can act on.
        if (cancelled) return;
        setNotes(null);
        setLoadError("Unable to load internal notes.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, attempt]);

  const retry = useCallback(() => {
    setLoadError(null);
    setAttempt((current) => current + 1);
  }, []);

  const clearSaveError = useCallback(() => setSaveError(null), []);

  const add = useCallback(
    async (text: string): Promise<boolean> => {
      if (conversationId === null) return false;

      // The same validation the route runs, run first so an agent is told what
      // is wrong without a round trip. The route checks it again regardless.
      const checked = parseInternalNoteRequest({ noteText: text });
      if (!checked.ok) {
        setSaveError(INTERNAL_NOTE_REJECTION_MESSAGE[checked.reason]);
        return false;
      }

      setSaving(true);
      setSaveError(null);
      try {
        const response = await fetch(`/api/conversations/${conversationId}/notes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(checked.draft),
        });
        if (!response.ok) {
          setSaveError(await messageFrom(response, "This note could not be saved."));
          return false;
        }
        const { note } = (await response.json()) as { note: InternalNote };
        /*
         * ONE REQUEST, ONE ROW, BOTH RENDERINGS.
         *
         * The stored row is prepended to the one list. That is the whole of
         * "automatically pinned": the pinned area reads the head of this
         * list, so the note appears there because it exists, not because
         * anything pinned it. There is deliberately no second call.
         */
        setNotes((current) => [note, ...(current ?? [])]);
        return true;
      } catch {
        setSaveError("This note could not be saved.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [conversationId],
  );

  const save = useCallback(
    async (noteId: string, text: string): Promise<string | null> => {
      if (conversationId === null) return "This note could not be updated.";

      const checked = parseInternalNoteUpdate({ noteText: text });
      if (!checked.ok) return INTERNAL_NOTE_REJECTION_MESSAGE[checked.reason];

      try {
        const response = await fetch(`/api/conversations/${conversationId}/notes/${noteId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ noteText: checked.edit.noteText }),
        });
        if (!response.ok) return await messageFrom(response, "This note could not be updated.");

        const { note } = (await response.json()) as { note: InternalNote };
        // Replaced in place, so the pinned card and the section card update
        // together — they are the same object rendered twice.
        setNotes((current) =>
          (current ?? []).map((entry) => (entry.id === note.id ? note : entry)),
        );
        return null;
      } catch {
        return "This note could not be updated.";
      }
    },
    [conversationId],
  );

  const remove = useCallback(
    async (noteId: string): Promise<string | null> => {
      if (conversationId === null) return "This note could not be removed.";

      try {
        const response = await fetch(`/api/conversations/${conversationId}/notes/${noteId}`, {
          method: "DELETE",
        });
        if (!response.ok) return await messageFrom(response, "This note could not be removed.");

        setNotes((current) => (current ?? []).filter((entry) => entry.id !== noteId));
        return null;
      } catch {
        return "This note could not be removed.";
      }
    },
    [conversationId],
  );

  return {
    notes,
    loading: conversationId !== null && notes === null && loadError === null,
    loadError,
    saving,
    saveError,
    retry,
    add,
    save,
    remove,
    clearSaveError,
  };
}
