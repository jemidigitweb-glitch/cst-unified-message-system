import { NextResponse } from "next/server";

import { getAppPool } from "@/lib/db/pools";
import { parseMarketplaceForFeed } from "@/lib/domain/marketplace-capabilities";
import { listNoRuleConversations } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations/no-rule?marketplace=<name> — one marketplace's No
 * Rule conversations: every one currently recorded in
 * cst_app.conversation_rule_analysis, whether the finding is from the CST
 * agent's last click or from a run weeks ago.
 *
 * Read-only, like every route under /api. This reads a finding that
 * `POST /api/conversations/[id]/draft` already writes when generation is
 * refused for lack of an applicable rule — nothing here decides applicability
 * or writes anything.
 *
 * `marketplace` is resolved through the same conversation-feed allowlist
 * `/api/conversations` uses, so an arbitrary string is rejected before it
 * reaches the database.
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
    const conversations = await listNoRuleConversations(getAppPool(), { marketplace });
    return NextResponse.json({ marketplace, conversations });
  } catch (cause) {
    // The underlying error may name schemas, columns or hosts, so it is logged
    // server-side and never returned to the browser.
    console.error("[conversations/no-rule] list failed", cause);
    return NextResponse.json({ error: "Unable to load No Rule conversations" }, { status: 500 });
  }
}
