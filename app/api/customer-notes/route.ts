import { NextResponse } from "next/server";

import { getSourcePool } from "@/lib/db/pools";
import { findCustomerNotes } from "@/lib/repositories/customer-note-repository";

/**
 * GET /api/customer-notes — buyer notes, newest first.
 *
 * READ ONLY, from the read-only source. Nothing here writes anywhere, and the
 * notes carry no read, dismissed or acknowledged state — exactly like the
 * notification feed this shares a panel with.
 *
 * ONE MONTH, EVERY MARKETPLACE. A note is about an order still in flight; one
 * from six months ago is history rather than work, and a window is what makes
 * the per-marketplace counts comparable to each other.
 *
 * The limit below is a runaway guard, not the shape of the list — 108 notes
 * fell in the window when this was measured. The feed still reports `hasMore`,
 * so a month busy enough to hit the cap says so rather than reading as quiet.
 *
 * Underlying errors may name schemas or columns, so they are logged
 * server-side and never returned to the browser.
 */
export const dynamic = "force-dynamic";

const LIMIT = 500;

export async function GET(): Promise<NextResponse> {
  try {
    const feed = await findCustomerNotes(getSourcePool(), { limit: LIMIT });
    return NextResponse.json(feed);
  } catch (cause) {
    console.error("[customer-notes] read failed", cause);
    return NextResponse.json({ error: "Unable to load customer notes" }, { status: 500 });
  }
}
