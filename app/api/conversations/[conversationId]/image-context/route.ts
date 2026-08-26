import { NextResponse } from "next/server";

import { resolveEbayImageContext } from "@/lib/context/resolve-image-context";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations/:id/image-context
 *
 * Existing eBay-hosted images for the context panel -- a listing's own
 * product photos, and (only for a verified single order) its return-case
 * evidence photos. See `resolveEbayImageContext` for the full contract.
 *
 * NEVER FOR THE CHAT THREAD. This route exists for `context-panel.tsx`
 * only; `conversation-view.tsx` (the message thread) must never call it.
 * Neither image type is a customer message attachment.
 *
 * Read-only against the marketplace source. Unlike `/order-context`, this
 * route never writes to `cst_app.context_snapshots` -- it only reads
 * whatever snapshot already exists, so opening the image panel cannot
 * trigger a first resolution as a side effect.
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

    const images = await resolveEbayImageContext(getSourcePool(), pool, detail.conversation);

    return NextResponse.json({ conversationId: id, ...images });
  } catch (cause) {
    // The underlying error may name schemas, hosts or credentials, so it is
    // logged server-side and never returned to the browser.
    console.error("[image-context] lookup failed", cause);
    return NextResponse.json({ error: "Unable to load image context" }, { status: 500 });
  }
}
