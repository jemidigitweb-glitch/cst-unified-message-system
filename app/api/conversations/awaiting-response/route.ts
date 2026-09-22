import { NextResponse } from "next/server";

import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { ORDER_CHANGE_CATEGORY } from "@/lib/domain/inbox";
import { CONVERSATION_MARKETPLACES } from "@/lib/domain/marketplace-capabilities";
import { listAwaitingResponseByCategory } from "@/lib/repositories/conversation-repository";
import { isDraftStoreMissing } from "@/lib/repositories/draft-repository";

/**
 * GET /api/conversations/awaiting-response — EVERY marketplace's order-change
 * conversations that nobody has answered: a customer message exists, and no
 * reply of ours came after that message.
 *
 * A DRAFT DOES NOT RETIRE A NOTIFICATION. This route once excluded any
 * conversation that had one, which meant generating a draft removed a waiting
 * customer from the feed. Nothing in this application can send, so a draft is
 * work in progress rather than an answer; each item carries `hasDraft` for the
 * interface to label with instead.
 *
 * GLOBAL, AND IT TAKES NO PARAMETERS. This used to be scoped to one marketplace
 * by a `?marketplace=` argument, and that was wrong for a notification: an
 * Amazon customer waiting on an order change is waiting whether or not the
 * reviewer happens to be looking at the eBay tab. The marketplace list is built
 * here from `CONVERSATION_MARKETPLACES` — a fixed array of literals — so there
 * is nothing for a caller to supply and nothing to validate. Each item carries
 * its own marketplace, which is what lets one list serve every tab.
 *
 * This deliberately does NOT change how any other route is scoped. The inbox,
 * the No Rule list and the unresolved feed remain per-marketplace, because they
 * are the working lists a reviewer reads inside one tab; this is the only global
 * one.
 *
 * Read-only, like every route under /api except the two that write a draft. It
 * observes state the drafting and reply workflows already produced; it decides
 * nothing, records nothing and advances nothing.
 *
 * ONE CASE AREA, FIXED HERE. The repository function takes the area as an
 * argument because it is general; this route does not, because the feature is
 * the order-change notification and a caller-supplied category would be a
 * second, unrequested query surface.
 *
 * TWO POOLS, BECAUSE THE HEADING IS A CLAIM ABOUT AN ORDER. "Before shipping" is
 * not a wording; it is a dispatch state, and dispatch state lives in the source
 * database. The app pool finds the unanswered conversations and the source pool
 * settles whether each order has actually left — one batched read per request, in
 * `applyBeforeShipmentRule`. Without it this feed used to list orders that shipped
 * days earlier: Shopify 46268 was still here a day after dispatch, and after CST
 * had already told the customer so.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const page = await listAwaitingResponseByCategory(getAppPool(), {
      marketplaces: CONVERSATION_MARKETPLACES,
      category: ORDER_CHANGE_CATEGORY,
      source: getSourcePool(),
    });
    return NextResponse.json({
      category: ORDER_CHANGE_CATEGORY,
      conversations: page.items,
      // `scanned` and `hasMore` describe the candidate set, not the matches, and
      // `marketplaces` is what was actually read — the suppressed ones are
      // dropped before the query. Returned so the interface can say how far it
      // looked rather than implying it looked everywhere.
      scanned: page.scanned,
      hasMore: page.hasMore,
      marketplaces: page.marketplaces,
      // False means the dispatch state could not be read, so the list is empty
      // for a reason that is NOT "nobody is waiting". See `AwaitingResponsePage`.
      dispatchStateRead: page.dispatchStateRead,
    });
  } catch (cause) {
    /**
     * The draft store is what `hasDraft` is read from. It no longer decides
     * whether a row appears, but the statement still selects from it, so where
     * the migration has not been applied the query fails outright. This
     * reports an empty list and says the store is not ready — the same
     * distinction the draft route already draws, rather than a 500 that reads
     * as a broken feature.
     */
    if (isDraftStoreMissing(cause)) {
      return NextResponse.json({
        category: ORDER_CHANGE_CATEGORY,
        conversations: [],
        scanned: 0,
        hasMore: false,
        marketplaces: [],
        storeReady: false,
        // Nothing was read at all, so the dispatch gate never ran either. Saying
        // true here would claim a completeness this response does not have.
        dispatchStateRead: false,
      });
    }
    // The underlying error may name schemas, columns or hosts, so it is logged
    // server-side and never returned to the browser. Nothing customer-written
    // is logged here either — the failure is the query's, not the message's.
    console.error("[conversations/awaiting-response] list failed", cause);
    return NextResponse.json(
      { error: "Unable to load conversations awaiting a response" },
      { status: 500 },
    );
  }
}
