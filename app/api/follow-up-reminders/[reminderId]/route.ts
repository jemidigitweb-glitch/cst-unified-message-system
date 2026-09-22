import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { completeFollowUpReminderSchema } from "@/lib/domain/follow-up-reminder";
import {
  completeReminder,
  isFollowUpStoreMissing,
} from "@/lib/repositories/follow-up-reminder-repository";

/**
 * PATCH /api/follow-up-reminders/[reminderId] — mark one reminder completed.
 *
 * THE ONLY THING THAT CAN BE DONE TO A REMINDER, and deliberately the only
 * thing. There is no reopen, no reschedule, no reassign and no DELETE: a
 * reminder records what CST promised, and the record of a promise is not
 * something to erase. Cancellation is a stored status the table admits but this
 * phase does not expose — adding it is a decision, not an oversight.
 *
 * COMPLETING IS NOT REPLYING. It marks OUR list done. The customer was dealt
 * with by a person, in the systems that can deal with them, before anybody
 * pressed this — nothing here sends, queues or prepares a message.
 *
 * ALREADY COMPLETED RETURNS 409, NOT A SILENT SUCCESS. This follows
 * `/api/automations/[itemId]/cancel`, which answers a non-transition the same
 * way: a stale browser tab gets a conflict rather than rewriting a finished
 * record. The UPDATE is guarded on `status = 'scheduled'`, so the second call
 * matches no row — `completed_at` cannot move and a second completion cannot be
 * recorded.
 *
 * Underlying errors may name schemas or columns, so they are logged
 * server-side and never returned to the browser.
 */
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ reminderId: string }> },
): Promise<NextResponse> {
  const { reminderId } = await context.params;
  if (!/^\d+$/.test(reminderId)) {
    return NextResponse.json({ error: "Invalid reminder id" }, { status: 400 });
  }

  /*
   * The body must be empty or absent. There is one transition, so there is
   * nothing to choose — and a strict empty object means a caller that tries to
   * set a status, an owner or a completion time is refused rather than quietly
   * ignored.
   */
  const parsed = completeFollowUpReminderSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid completion" }, { status: 400 });
  }

  try {
    const reminder = await completeReminder(getAppPool(), reminderId);
    if (reminder === null) {
      return NextResponse.json(
        {
          error:
            "This reminder is not scheduled, so it cannot be completed. Reload to see its current state.",
          code: "not_completable",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ reminder });
  } catch (cause) {
    if (isFollowUpStoreMissing(cause)) {
      return NextResponse.json(
        { error: "Follow-up storage is not available yet." },
        { status: 503 },
      );
    }
    console.error("[follow-up] complete failed", cause);
    return NextResponse.json({ error: "Unable to complete this reminder" }, { status: 500 });
  }
}
