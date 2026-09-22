import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import {
  INTERNAL_NOTE_REJECTION_MESSAGE,
  parseInternalNoteId,
  parseInternalNoteUpdate,
} from "@/lib/domain/internal-note";
import { parseConversationId } from "@/lib/repositories/conversation-repository";
import { isInternalNoteStoreMissing } from "@/lib/repositories/internal-note-repository";
import { deleteInternalNote, updateInternalNote } from "@/lib/sync/internal-note-writer";

/**
 * One internal note, under the conversation it belongs to. CST staff only.
 *
 *   PATCH   replace its text
 *   DELETE  remove it
 *
 * NESTED UNDER THE CONVERSATION, NOT ADDRESSED BY NOTE ID ALONE. Both handlers
 * take the conversation from the path and pass it to the writer, which matches
 * on BOTH ids in the WHERE clause. A note id borrowed from another case
 * therefore matches no row here, and the answer is 404 — the same answer as
 * for a note that does not exist at all, so the difference cannot be used to
 * discover that an id is real somewhere else.
 *
 * The alternative shape, `/api/internal-notes/[noteId]`, was not built. It
 * would have made the conversation an argument the route could forget rather
 * than a segment it cannot be called without.
 *
 * WHAT AN EDIT CANNOT CHANGE: which conversation the note belongs to, its
 * visibility, its category, or when it was created. None is accepted from the
 * body and none appears in the writer's SET clause.
 *
 * WRITES THE APPLICATION DATABASE ONLY. `getAppPool()` is the sole pool named.
 *
 * Underlying errors may name schemas or columns, so they are logged
 * server-side and never returned to the browser.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ conversationId: string; noteId: string }> };

/** Both ids, validated, or the response to send instead. */
async function addressFrom(
  context: Params,
): Promise<{ conversationId: string; noteId: string } | NextResponse> {
  const { conversationId, noteId } = await context.params;

  const conversation = parseConversationId(conversationId);
  if (conversation === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }
  const note = parseInternalNoteId(noteId);
  if (note === null) {
    return NextResponse.json({ error: "Invalid note id" }, { status: 400 });
  }
  return { conversationId: conversation, noteId: note };
}

/** The one place the two handlers agree on what a failure means. */
function failureResponse(cause: unknown, action: "update" | "remove"): NextResponse {
  if (isInternalNoteStoreMissing(cause)) {
    return NextResponse.json(
      { error: "Internal notes storage is not available yet." },
      { status: 503 },
    );
  }
  console.error(`[internal-notes] ${action} failed`, cause);
  return NextResponse.json(
    {
      error:
        action === "update"
          ? "Unable to save this internal note"
          : "Unable to remove this internal note",
    },
    { status: 500 },
  );
}

const NOT_FOUND = "This note is not on this conversation.";

export async function PATCH(request: Request, context: Params): Promise<NextResponse> {
  const address = await addressFrom(context);
  if (address instanceof NextResponse) return address;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // The same text rules the panel applied, applied again here. The panel's
  // call is a convenience; this one is the rule.
  const parsed = parseInternalNoteUpdate(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: INTERNAL_NOTE_REJECTION_MESSAGE[parsed.reason], reason: parsed.reason },
      { status: 400 },
    );
  }

  try {
    const note = await updateInternalNote(
      getAppPool(),
      address.conversationId,
      address.noteId,
      parsed.edit,
    );
    if (note === undefined) {
      return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    }
    return NextResponse.json({ note });
  } catch (cause) {
    return failureResponse(cause, "update");
  }
}

export async function DELETE(_request: Request, context: Params): Promise<NextResponse> {
  const address = await addressFrom(context);
  if (address instanceof NextResponse) return address;

  try {
    const removed = await deleteInternalNote(
      getAppPool(),
      address.conversationId,
      address.noteId,
    );
    if (!removed) {
      return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    }
    return NextResponse.json({ noteId: address.noteId, removed: true });
  } catch (cause) {
    return failureResponse(cause, "remove");
  }
}
