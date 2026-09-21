import { NextResponse } from "next/server";

import { NOTE_RESOLUTION_MESSAGE } from "@/lib/domain/customer-note";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import {
  customerNoteById,
  resolveNoteConversation,
} from "@/lib/repositories/customer-note-repository";

/**
 * GET /api/customer-notes/[noteId] — which conversation this note belongs to.
 *
 * THE RESOLUTION HAPPENS HERE, NOT IN THE BROWSER. The client sends a note id
 * and gets back a conversation id or a reason; it never chooses a conversation
 * and is never trusted with an order row id it could have altered. The note is
 * re-read from the source first, so a team note or a blank one cannot be
 * resolved even if its id is guessed.
 *
 * A REFUSAL IS A NORMAL ANSWER, and is returned as 200 with `resolved: false`
 * rather than as an error: "no conversation has been matched to this order
 * yet" is a fact about the data, not a failure of the request. The panel shows
 * the reason under that note and stays open.
 *
 * TODAY MOST NOTES WILL REFUSE. Only 216 order rows have a deterministically
 * resolved conversation, against 8,143 displayable buyer notes — so `unlinked`
 * is the ordinary outcome, not the exception. That is a coverage fact about
 * the order-matching that already exists, and this route reports it honestly
 * rather than reaching for a looser match.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ noteId: string }> },
): Promise<NextResponse> {
  const { noteId } = await context.params;
  if (!/^\d+$/.test(noteId)) {
    return NextResponse.json({ error: "Invalid note id" }, { status: 400 });
  }

  try {
    const note = await customerNoteById(getSourcePool(), noteId);
    if (note === undefined) {
      return NextResponse.json({
        noteId,
        resolved: false,
        reason: "not_found",
        message: NOTE_RESOLUTION_MESSAGE.not_found,
      });
    }

    const resolution = await resolveNoteConversation(getAppPool(), note.orderRowId);
    if (!resolution.resolved) {
      return NextResponse.json({
        noteId,
        resolved: false,
        reason: resolution.reason,
        message: NOTE_RESOLUTION_MESSAGE[resolution.reason],
      });
    }

    return NextResponse.json({
      noteId,
      resolved: true,
      conversationId: resolution.conversationId,
      marketplace: resolution.marketplace,
    });
  } catch (cause) {
    console.error("[customer-notes] resolution failed", cause);
    return NextResponse.json({ error: "Unable to open this note" }, { status: 500 });
  }
}
