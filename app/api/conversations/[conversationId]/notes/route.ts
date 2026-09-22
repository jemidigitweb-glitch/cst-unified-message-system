import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import {
  INTERNAL_NOTE_REJECTION_MESSAGE,
  parseInternalNoteRequest,
} from "@/lib/domain/internal-note";
import { parseConversationId } from "@/lib/repositories/conversation-repository";
import {
  findInternalNotes,
  isInternalNoteStoreMissing,
} from "@/lib/repositories/internal-note-repository";
import { addInternalNote, isUnknownConversation } from "@/lib/sync/internal-note-writer";

/**
 * Internal notes for one conversation. CST staff only.
 *
 *   GET   the notes already recorded against this conversation, newest first
 *   POST  record one new note
 *
 * A DEDICATED ENDPOINT, AND THAT IS THE POINT OF IT. These notes are
 * deliberately NOT part of `GET /api/conversations/[conversationId]`. That
 * response is the customer thread, and it is the same object that feeds the AI
 * draft input and the conversation export — so a note folded into it would
 * reach a drafted reply and a downloadable file in one move, without anybody
 * choosing that. Its own route, its own payload, read by one panel.
 *
 * WRITES THE APPLICATION DATABASE ONLY. `getAppPool()` is the sole pool named
 * here. The live marketplace database is read-only for this project and holds
 * nothing this feature reads or writes.
 *
 * NO EDIT AND NO DELETE. Phase 1 creates and views. There is no PATCH and no
 * DELETE handler, which is also what `tests/guards/api-surface.test.ts`
 * requires of every route in this application.
 *
 * Underlying errors may name schemas or columns, so they are logged
 * server-side and never returned to the browser.
 */
export const dynamic = "force-dynamic";

/** Shared by both handlers: a validated conversation id, or a 400 response. */
function conversationIdFrom(raw: string): string | NextResponse {
  const id = parseConversationId(raw);
  if (id === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }
  return id;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  const id = conversationIdFrom(conversationId);
  if (typeof id !== "string") return id;

  try {
    const feed = await findInternalNotes(getAppPool(), id);
    return NextResponse.json(feed);
  } catch (cause) {
    if (isInternalNoteStoreMissing(cause)) {
      return NextResponse.json(
        { error: "Internal notes storage is not available yet." },
        { status: 503 },
      );
    }
    console.error("[internal-notes] read failed", cause);
    return NextResponse.json({ error: "Unable to load internal notes" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  const id = conversationIdFrom(conversationId);
  if (typeof id !== "string") return id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  /*
   * THE SAME VALIDATION THE PANEL RAN, RUN AGAIN.
   *
   * The panel calls `parseInternalNoteRequest` so an agent is told what is
   * wrong before a request leaves the browser. That call is a convenience.
   * This one is the rule: the category must be one of the five declared
   * values and the text must not be blank or over-long, whatever arrived.
   * One function, so the two cannot disagree about what a valid note is.
   */
  const parsed = parseInternalNoteRequest(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: INTERNAL_NOTE_REJECTION_MESSAGE[parsed.reason], reason: parsed.reason },
      { status: 400 },
    );
  }

  try {
    const note = await addInternalNote(getAppPool(), id, parsed.draft);
    return NextResponse.json({ note }, { status: 201 });
  } catch (cause) {
    if (isUnknownConversation(cause)) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    if (isInternalNoteStoreMissing(cause)) {
      return NextResponse.json(
        { error: "Internal notes storage is not available yet." },
        { status: 503 },
      );
    }
    console.error("[internal-notes] write failed", cause);
    return NextResponse.json({ error: "Unable to save this internal note" }, { status: 500 });
  }
}
