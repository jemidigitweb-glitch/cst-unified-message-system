import { NextResponse } from "next/server";

import { getAppPool, getSourcePool } from "@/lib/db/pools";
import {
  MIN_SEARCH_LENGTH,
  SEARCH_RESULT_LIMIT,
  normalizeSearchQuery,
} from "@/lib/domain/conversation-search";
import {
  isSearchStoreMissing,
  searchConversations,
} from "@/lib/repositories/conversation-search-repository";

/**
 * GET /api/conversations/search?q= — find a conversation from whatever the
 * agent has: a conversation id, a marketplace message id, an order number, a
 * handle, or a customer's name.
 *
 * READ ONLY, like every route that is not a draft or a follow-up. It returns
 * conversation ids; opening one is the existing selection path's job, and
 * nothing here opens, drafts, completes or sends anything.
 *
 * GLOBAL, AND TAKES NO MARKETPLACE. An agent searching for a customer has the
 * customer, not the tab they happen to live in — each result carries its own
 * marketplace so the interface can switch to it, the same way a notification
 * row already does.
 *
 * TWO POOLS, AND THE SECOND IS OPTIONAL. Customer names are not stored in this
 * application at all, so the name path reads the SOURCE — read-only, and
 * exactly as the customer-notes feature already does. Its absence is safe: the
 * other paths still answer and `nameSearchAvailable` says the name path did not
 * run, so an empty list is never mistaken for "that customer does not exist".
 *
 * Underlying errors may name schemas or columns, so they are logged
 * server-side and never returned to the browser.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get("q") ?? "";
  const query = normalizeSearchQuery(raw);

  /*
   * A short query is an EMPTY RESULT, not an error. The box is typed into one
   * character at a time, and a 400 flashing under it on the way to a real
   * search would be noise about something the agent is already fixing.
   */
  if (query.length < MIN_SEARCH_LENGTH) {
    return NextResponse.json({
      query,
      results: [],
      capped: false,
      nameSearchAvailable: false,
    });
  }

  try {
    const found = await searchConversations(
      getAppPool(),
      { query, limit: SEARCH_RESULT_LIMIT },
      getSourcePool(),
    );
    return NextResponse.json({
      query,
      results: found.results,
      capped: found.capped,
      nameSearchAvailable: found.nameSearchAvailable,
    });
  } catch (cause) {
    if (isSearchStoreMissing(cause)) {
      return NextResponse.json({ error: "Search is not available yet." }, { status: 503 });
    }
    console.error("[search] conversation search failed", cause);
    return NextResponse.json({ error: "Unable to search conversations" }, { status: 500 });
  }
}
