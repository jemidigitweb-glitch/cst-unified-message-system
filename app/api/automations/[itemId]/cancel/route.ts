import { NextResponse } from "next/server";

import { cancelScheduledItem } from "@/lib/domain/automation/automation-runner";
import { automationCancelSchema } from "@/lib/domain/automation/automation-types";
import { getAppPool } from "@/lib/db/pools";
import { isAutomationStoreMissing } from "@/lib/repositories/automation-repository";

/**
 * POST /api/automations/[itemId]/cancel — stop one scheduled record.
 *
 * THE ONLY THING AN OPERATOR CAN DO TO A RECORD, and deliberately the only
 * thing: there is no edit, no regenerate, no review and no resend, because this
 * automation renders a saved template and records the result. A record is
 * either going to be processed or it is not.
 *
 * ONLY `scheduled` IS CANCELLABLE. A record that has already been processed,
 * skipped or failed cannot be retrospectively cancelled — the UPDATE is guarded
 * on the status, so a stale browser tab gets a conflict rather than rewriting a
 * finished record. Cancelling a scheduled one is what stops it ever being
 * picked up: the due query reads `status = 'scheduled'` and nothing else.
 *
 * Underlying errors may name schemas or columns, so they are logged
 * server-side and never returned to the browser.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<NextResponse> {
  const { itemId } = await context.params;
  if (!/^\d+$/.test(itemId)) {
    return NextResponse.json({ error: "Invalid record id" }, { status: 400 });
  }

  const parsed = automationCancelSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid cancellation" }, { status: 400 });
  }

  try {
    const cancelled = await cancelScheduledItem(getAppPool(), {
      id: itemId,
      reason: parsed.data.reason ?? null,
    });
    if (!cancelled) {
      return NextResponse.json(
        {
          error:
            "This record is not scheduled, so it cannot be cancelled. Reload to see its current state.",
          code: "not_cancellable",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ itemId, status: "cancelled" });
  } catch (cause) {
    if (isAutomationStoreMissing(cause)) {
      return NextResponse.json({ error: "Automation storage is not available yet." }, { status: 503 });
    }
    console.error("[automations] cancel failed", cause);
    return NextResponse.json({ error: "Unable to cancel this record" }, { status: 500 });
  }
}
