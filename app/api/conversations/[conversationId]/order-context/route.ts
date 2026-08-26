import { NextResponse } from "next/server";

import { resolveEbayOrderContext } from "@/lib/context/resolve-order-context";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations/:id/order-context
 *
 * The verified order/shipping facts for the sidebar -- the exact same
 * resolver the draft pipeline calls (`resolveEbayOrderContext`), read here
 * for display rather than for grounding a reply. Nothing in this route
 * decides what counts as verified; that stays entirely in the resolver.
 *
 * Read-only against the marketplace source (the resolver's own contract).
 * The one write this can trigger is the resolver's existing cache write to
 * `cst_app.context_snapshots` on a conversation's first resolution -- the
 * same write that already happens the first time a draft is generated for
 * it. Opening the sidebar can now be what triggers that first resolution
 * instead of clicking Generate; either way it is the one write the pipeline
 * already made, not a new one.
 *
 * NEVER GUESSES, because it never computes anything: a non-eBay
 * conversation, an ambiguous match, or no match at all all come back from
 * the resolver as an empty list, and an empty list is exactly what this
 * route returns. There is no separate "ambiguous" branch here to get wrong.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;
  const id = parseConversationId(conversationId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  const pool = getAppPool();

  try {
    const detail = await getConversation(pool, id);
    if (detail === null) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const facts = await resolveEbayOrderContext(getSourcePool(), pool, detail.conversation);

    return NextResponse.json({ conversationId: id, facts });
  } catch (cause) {
    // The underlying error may name schemas, hosts or credentials, so it is
    // logged server-side and never returned to the browser.
    console.error("[order-context] lookup failed", cause);
    return NextResponse.json({ error: "Unable to load order context" }, { status: 500 });
  }
}
