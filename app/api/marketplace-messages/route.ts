import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { parseMarketplaceForFeed } from "@/lib/domain/marketplace-capabilities";
import { listUnresolvedMessages } from "@/lib/repositories/unresolved-message-repository";

/**
 * GET /api/marketplace-messages?marketplace=<name>
 *
 * The read-only feed for marketplaces whose message direction, customer
 * identity and conversation grouping are not verified. Those sources have no
 * conversations to serve, so they are deliberately not reachable through
 * /api/conversations — a message here is a message, not a one-message thread.
 *
 * Read-only. Only GET is exported, so any other method returns 405 from the
 * framework. There is deliberately no POST/PUT/PATCH/DELETE anywhere under
 * /api: this phase writes nothing and sends nothing.
 *
 * `marketplace` is resolved through the capability allowlist for THIS feed, so
 * an arbitrary string — or a marketplace served by the conversation API — is
 * rejected before it reaches the database.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const requested = new URL(request.url).searchParams.get("marketplace");
  const marketplace = parseMarketplaceForFeed(requested, "unresolved_messages");
  if (marketplace === null) {
    return NextResponse.json(
      { error: "Unknown or unavailable marketplace" },
      { status: 400 },
    );
  }

  try {
    const feed = await listUnresolvedMessages(getAppPool(), { marketplace });
    return NextResponse.json(feed);
  } catch (cause) {
    // The underlying error may name schemas, columns or hosts, so it is logged
    // server-side and never returned to the browser.
    console.error("[marketplace-messages] list failed", cause);
    return NextResponse.json({ error: "Unable to load messages" }, { status: 500 });
  }
}
