import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { createFollowUpReminderSchema } from "@/lib/domain/follow-up-reminder";
import {
  createReminder,
  getConversationReminders,
  isFollowUpStoreMissing,
  isUnknownConversation,
} from "@/lib/repositories/follow-up-reminder-repository";

/**
 * One conversation's follow-up reminders.
 *
 *   GET   — what was promised on this thread, newest promise first.
 *   POST  — record a new promise.
 *
 * NEITHER METHOD CAN CONTACT A CUSTOMER. POST writes one row to
 * `cst_app.follow_up_reminders` and returns it. Nothing is queued, no worker is
 * woken, no template is rendered and no marketplace is called — a reminder is a
 * note to CST about when to come back, and coming back is a thing a person then
 * does by hand.
 *
 * NO IDENTITY IS REQUIRED OR ACCEPTED. The body carries a time and an optional
 * note; the schema is `.strict()`, so a caller cannot attach a staff id to a
 * reminder that has nowhere to put one. Reminders are shared.
 *
 * Underlying errors may name schemas or columns, so they are logged
 * server-side and never returned to the browser.
 */
export const dynamic = "force-dynamic";

/** The route parameter, which is a database id and must look like one. */
function validConversationId(value: string): boolean {
  return /^\d+$/.test(value);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  if (!validConversationId(conversationId)) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  try {
    const reminders = await getConversationReminders(getAppPool(), conversationId);
    return NextResponse.json({ conversationId, reminders });
  } catch (cause) {
    if (isFollowUpStoreMissing(cause)) {
      return NextResponse.json(
        { error: "Follow-up storage is not available yet." },
        { status: 503 },
      );
    }
    console.error("[follow-up] list for conversation failed", cause);
    return NextResponse.json({ error: "Unable to load follow-up reminders" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  if (!validConversationId(conversationId)) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  const parsed = createFollowUpReminderSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success) {
    /*
     * ONE MESSAGE, NAMING THE FIELD. The two ways this fails are a due time
     * that is not a timestamp and a note that is blank once trimmed, and a
     * caller can tell which from `field` without the validator's own prose —
     * which can quote the submitted value — reaching the browser.
     */
    const field = parsed.error.issues[0]?.path[0];
    return NextResponse.json(
      { error: "Invalid reminder", field: typeof field === "string" ? field : null },
      { status: 400 },
    );
  }

  try {
    const reminder = await createReminder(getAppPool(), {
      conversationId,
      promisedDueAt: parsed.data.promisedDueAt,
      note: parsed.data.note ?? null,
    });
    return NextResponse.json({ reminder }, { status: 201 });
  } catch (cause) {
    if (isUnknownConversation(cause)) {
      // The foreign key is what decided this, not a prior read — so the answer
      // cannot be stale by the time it is given.
      return NextResponse.json({ error: "No such conversation" }, { status: 404 });
    }
    if (isFollowUpStoreMissing(cause)) {
      return NextResponse.json(
        { error: "Follow-up storage is not available yet." },
        { status: 503 },
      );
    }
    console.error("[follow-up] create failed", cause);
    return NextResponse.json({ error: "Unable to create this reminder" }, { status: 500 });
  }
}
