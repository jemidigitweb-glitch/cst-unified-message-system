import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { parseMarketplaceForFeed } from "@/lib/domain/marketplace-capabilities";
import { listConversations } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations?marketplace=<name> — one marketplace's reply inbox.
 *
 * Read-only. Only GET is exported, so any other method returns 405 from the
 * framework. There is deliberately no POST/PUT/PATCH/DELETE anywhere under
 * /api: this phase writes nothing and sends nothing.
 *
 * `marketplace` is resolved through the capability allowlist for the
 * conversation feed, so an arbitrary string — or a marketplace whose source
 * cannot support a conversation at all — is rejected before it reaches the
 * database.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const requested = new URL(request.url).searchParams.get("marketplace");
  const marketplace = parseMarketplaceForFeed(requested, "conversations");
  if (marketplace === null) {
    return NextResponse.json(
      { error: "Unknown or unavailable marketplace" },
      { status: 400 },
    );
  }

  try {
    const conversations = await listConversations(getAppPool(), { marketplace });
    return NextResponse.json({ marketplace, conversations });
  } catch (cause) {
    // The underlying error may name schemas, columns or hosts, so it is logged
    // server-side and never returned to the browser.
    console.error("[conversations] list failed", cause);
    return NextResponse.json({ error: "Unable to load conversations" }, { status: 500 });
  }
}
