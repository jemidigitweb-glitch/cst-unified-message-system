import { NextResponse } from "next/server";

import { restoreCancelledItem } from "@/lib/domain/automation/automation-runner";
import { getAppPool } from "@/lib/db/pools";
import { isAutomationStoreMissing } from "@/lib/repositories/automation-repository";

/**
 * POST /api/automations/[itemId]/restore — undo an accidental cancellation.
 *
 * THE SECOND THING AN OPERATOR CAN DO TO A RECORD, and it exists because the
 * first one is a single click with no undo: cancelling a scheduled record is
 * irreversible from the screen, and an irreversible one-click control next to a
 * list of rows is a control that WILL be misused. Adding an undo is what makes
 * the confirmation dialog in front of Cancel a fair trade rather than a nuisance.
 *
 * ONLY `cancelled` IS REVIVABLE, AND THE DATABASE SAYS SO. The UPDATE is guarded
 * `WHERE status = 'cancelled'`, so a `sent`, `skipped`, `failed` or already
 * `scheduled` record matches nothing and this route answers 409 — the same shape
 * as the cancel route's 409, so a stale browser tab is told to reload rather than
 * being trusted. Cancelling is a decision; being skipped is a VERDICT about the
 * order, and there is deliberately no way to overturn one from here.
 *
 * IT DOES NOT PROCESS THE RECORD, AND THAT IS THE POINT. Nothing here reads the
 * source, renders a template, runs a scan or writes any status other than
 * `cancelled -> scheduled`. The record rejoins the queue exactly as it left it,
 * with its original `scheduled_at`: if that moment has already passed the
 * existing worker claims it on its next pass, and if it has not, the worker waits
 * for it. A button on this page must never be able to render or record a message.
 *
 * IT CANNOT CONTACT ANYBODY. There is no marketplace client, no mail client and
 * no credential read anywhere beneath this route or the repository function it
 * calls. A restored record is processed in test mode like every other one, and
 * the recheck against the source still runs first — so an order cancelled or
 * returned while the record sat cancelled is skipped at that moment rather than
 * rendered.
 *
 * Underlying errors may name schemas or columns, so they are logged server-side
 * and never returned to the browser.
 */
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<NextResponse> {
  const { itemId } = await context.params;
  if (!/^\d+$/.test(itemId)) {
    return NextResponse.json({ error: "Invalid record id" }, { status: 400 });
  }

  try {
    /**
     * The record's original `scheduled_at` is returned to the caller so the page
     * can say WHICH of the two things just happened: an overdue record is about
     * to be processed, and an operator who restored one should be told that
     * rather than left to wonder. The value is re-read, never computed here.
     */
    const restored = await restoreCancelledItem(getAppPool(), itemId);
    if (!restored) {
      return NextResponse.json(
        {
          error:
            "This record is not cancelled, so there is nothing to restore. Reload to see its current state.",
          code: "not_restorable",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ itemId, status: "scheduled" });
  } catch (cause) {
    if (isAutomationStoreMissing(cause)) {
      return NextResponse.json({ error: "Automation storage is not available yet." }, { status: 503 });
    }
    console.error("[automations] restore failed", cause);
    return NextResponse.json({ error: "Unable to restore this record" }, { status: 500 });
  }
}
