import { NextResponse } from "next/server";

import { runPostDispatchAutomation } from "@/lib/domain/automation/automation-runner";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { assertApplicationDatabase, assertSourceReadOnly } from "@/lib/sync/guard";

/**
 * GET /api/cron/automation — one bounded post-dispatch run.
 *
 * Scans for dispatched shipments, then processes the ones whose moment has
 * come: it rechecks the order against the source, renders the saved template,
 * and records the result locally. It cannot contact a customer — there is no
 * marketplace client, no mail client and no credential read anywhere beneath
 * this route, and every processed record is marked `test_mode`.
 *
 * FAILS CLOSED. Like `/api/cron/sync`, a missing `CRON_SECRET` refuses every
 * request rather than accepting them: an unauthenticated route that writes to
 * production is not an acceptable default. The same two safety checks run
 * first — the application connection must really be the application database,
 * and the source session must really be read-only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const app = getAppPool();
  const source = getSourcePool();

  try {
    await assertApplicationDatabase(app);
    await assertSourceReadOnly(source);
  } catch (cause) {
    console.error("[cron/automation] safety check failed", cause);
    return NextResponse.json({ error: "Run refused: safety check failed" }, { status: 500 });
  }

  try {
    const summary = await runPostDispatchAutomation({ app, source });
    return NextResponse.json({ ranAt: new Date().toISOString(), ...summary });
  } catch (cause) {
    console.error("[cron/automation] run failed", cause);
    return NextResponse.json({ error: "Automation run failed" }, { status: 500 });
  }
}
