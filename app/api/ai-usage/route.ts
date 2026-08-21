import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { readAiUsage } from "@/lib/repositories/ai-usage-repository";

/**
 * GET /api/ai-usage — what the draft model has consumed.
 *
 * Read-only, and accounting only: token counts, an estimated cost, and which
 * model produced them. No prompt, no reply and no customer text passes through
 * here, so nothing on this endpoint needs redacting.
 *
 * The cost is the application's own estimate from a local rate table, not a
 * provider invoice — a model absent from that table records NULL rather than a
 * misleading zero, and the response says how many of those there were.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await readAiUsage(getAppPool()));
  } catch (cause) {
    // Most likely the usage table is absent (migration 0006 not applied). That
    // is a configuration state rather than an outage, so the panel reports "no
    // usage recorded" instead of an error.
    console.error("[ai-usage] read failed", cause);
    return NextResponse.json({ summary: null, byModel: [], available: false });
  }
}
