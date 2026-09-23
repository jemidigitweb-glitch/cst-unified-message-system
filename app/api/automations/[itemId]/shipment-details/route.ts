import { NextResponse } from "next/server";

import { getAutomationDispatchDetails } from "@/lib/domain/automation/automation-dispatch-detail-service";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { isAutomationStoreMissing } from "@/lib/repositories/automation-repository";

/**
 * GET /api/automations/[itemId]/shipment-details — what is behind one record.
 *
 * NAMED `shipment-details`, NOT `dispatch-details`, and the name is load-bearing.
 * `tests/guards/api-surface.test.ts` refuses any route whose path reads as
 * sending — `send`, `outbound`, `dispatch`, `transmit`, `reply-to` — so that the
 * absence of a transport is provable from the route list alone, with no judgement
 * required. This route only reads, but a rail worth having is one that does not
 * need a human to decide which "dispatch" is the innocent kind.
 *
 * READ ONLY, ON BOTH DATABASES. The application pool answers for the record and
 * the source pool answers for the shipment; the source pool pins
 * `default_transaction_read_only=on` at the session level, so the server itself
 * would reject a write from this path. Nothing here changes a record, a schedule,
 * an eligibility decision or a template, and no value is copied into an
 * application table — the shipment is read afresh on every open.
 *
 * WHY THE BROWSER CANNOT DO THIS ITSELF. The source database is shared with
 * unrelated production systems and is reached with credentials that must never
 * leave the server. The front end gets a structured answer and no connection.
 *
 * ERRORS ARE LOGGED, NOT RETURNED. A database message may quote the statement,
 * and the statement carries a real order number and a real shipment id. The
 * browser gets a sentence; the detail goes to the server log.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<NextResponse> {
  const { itemId } = await context.params;
  // Checked before it reaches `$1::bigint`, so a malformed id in a URL is a bad
  // request rather than a database error dressed up as a broken page.
  if (!/^\d+$/.test(itemId)) {
    return NextResponse.json({ error: "Invalid record id" }, { status: 400 });
  }

  try {
    const result = await getAutomationDispatchDetails(getAppPool(), getSourcePool(), itemId);
    if (!result.found) {
      return NextResponse.json({ error: "No such automation record" }, { status: 404 });
    }
    return NextResponse.json(result.details);
  } catch (cause) {
    if (isAutomationStoreMissing(cause)) {
      return NextResponse.json(
        { error: "Automation storage is not available yet." },
        { status: 503 },
      );
    }
    console.error("[automations] dispatch details failed", cause);
    return NextResponse.json({ error: "Unable to load dispatch details" }, { status: 500 });
  }
}
