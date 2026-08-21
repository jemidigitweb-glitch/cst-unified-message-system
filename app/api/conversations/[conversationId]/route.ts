import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { parseMarketplaceForFeed } from "@/lib/domain/marketplace-capabilities";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations/[conversationId]?marketplace=<name>
 *
 * Read-only. Only GET is exported. The id is validated before it reaches the
 * database, and database errors are logged server-side rather than returned.
 *
 * When `marketplace` is supplied the conversation must belong to it; otherwise
 * the request 404s. That keeps a stale or hand-edited URL from surfacing one
 * marketplace's thread inside another marketplace's tab.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await context.params;

  const id = parseConversationId(conversationId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  const requested = new URL(request.url).searchParams.get("marketplace");
  const resolved = parseMarketplaceForFeed(requested, "conversations");
  if (requested !== null && resolved === null) {
    return NextResponse.json(
      { error: "Unknown or unavailable marketplace" },
      { status: 400 },
    );
  }
  const expectedMarketplace = resolved ?? undefined;

  try {
    const detail = await getConversation(getAppPool(), id, { expectedMarketplace });
    if (detail === null) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (cause) {
    console.error("[conversations] detail failed", cause);
    return NextResponse.json({ error: "Unable to load conversation" }, { status: 500 });
  }
}
