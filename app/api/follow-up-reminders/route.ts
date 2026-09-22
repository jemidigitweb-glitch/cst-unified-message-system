import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import {
  type FollowUpReminderStatus,
  isFollowUpReminderStatus,
} from "@/lib/domain/follow-up-reminder";
import {
  DEFAULT_REMINDER_LIMIT,
  MAX_REMINDER_LIMIT,
  isFollowUpStoreMissing,
  listReminders,
} from "@/lib/repositories/follow-up-reminder-repository";

/**
 * GET /api/follow-up-reminders?status=&limit=&offset= — the shared list.
 *
 * SHARED AND GLOBAL, LIKE THE NOTIFICATION FEED. Every CST user sees the same
 * reminders; there is no per-user scoping because there is no user. It spans
 * conversations and marketplaces for the same reason
 * `/api/conversations/awaiting-response` does: a promise made on an Amazon
 * thread is owed whether or not the reviewer is looking at the eBay tab.
 *
 * READ ONLY. A reminder is created on its conversation's route and completed on
 * its own; this route observes and changes nothing.
 *
 * ONE STATUS AT A TIME, defaulting to `scheduled` — the working list. Passing
 * `completed` gets the history. This is a filter rather than three duplicated
 * routes so the ordering rule lives in one place.
 *
 * IT DOES NOT SAY WHAT IS OVERDUE, and cannot: `upcoming`, `due soon` and
 * `overdue` are `promised_due_at` read against a clock, which is the
 * interface's question. Storing or computing them here would put the same
 * decision in two places.
 */
export const dynamic = "force-dynamic";

/** A request, clamped. An unusable value falls back rather than failing. */
function queryOf(request: Request): {
  status: FollowUpReminderStatus;
  limit: number;
  offset: number;
} {
  const params = new URL(request.url).searchParams;
  const rawStatus = params.get("status");
  const requestedLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const requestedOffset = Number.parseInt(params.get("offset") ?? "", 10);
  return {
    /*
     * An unrecognised filter falls back to the working list rather than
     * returning nothing: an empty screen caused by a typo in a query string is
     * a confusing way to be wrong. The same choice `/api/automations` makes.
     */
    status: isFollowUpReminderStatus(rawStatus) ? rawStatus : "scheduled",
    limit:
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_REMINDER_LIMIT)
        : DEFAULT_REMINDER_LIMIT,
    offset: Number.isInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0,
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const { status, limit, offset } = queryOf(request);

  try {
    const page = await listReminders(getAppPool(), { status, limit, offset });
    return NextResponse.json({
      status,
      reminders: page.items,
      hasMore: page.hasMore,
      offset,
    });
  } catch (cause) {
    if (isFollowUpStoreMissing(cause)) {
      return NextResponse.json(
        { error: "Follow-up storage is not available yet." },
        { status: 503 },
      );
    }
    console.error("[follow-up] shared list failed", cause);
    return NextResponse.json({ error: "Unable to load follow-up reminders" }, { status: 500 });
  }
}
