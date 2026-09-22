import { NextResponse } from "next/server";

import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { parseMarketplaceForFeed } from "@/lib/domain/marketplace-capabilities";
import { listConversations } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations?marketplace=<name>[&offset=<n>] — one page of one
 * marketplace's reply inbox.
 *
 * Read-only. Only GET is exported, so any other method returns 405 from the
 * framework. There is deliberately no POST/PUT/PATCH/DELETE anywhere under
 * /api: this phase writes nothing and sends nothing.
 *
 * `marketplace` is resolved through the capability allowlist for the
 * conversation feed, so an arbitrary string — or a marketplace whose source
 * cannot support a conversation at all — is rejected before it reaches the
 * database.
 *
 * PAGED. A busy marketplace can put hundreds of conversations inside even a
 * short date range, so there is no fixed row count that reliably covers "the
 * last month" for every marketplace at once. `offset` (default 0) lets the
 * caller keep asking for the next page — `hasMore` in the response says
 * whether one exists — rather than the server guessing a limit large enough
 * up front and either over- or under-fetching.
 */
export const dynamic = "force-dynamic";

/** A bad or absent value reads as "first page" rather than a 400: offset is a scroll position, not a required input. */
function parseOffset(raw: string | null): number {
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const marketplace = parseMarketplaceForFeed(params.get("marketplace"), "conversations");
  if (marketplace === null) {
    return NextResponse.json(
      { error: "Unknown or unavailable marketplace" },
      { status: 400 },
    );
  }
  const offset = parseOffset(params.get("offset"));

  try {
    /*
     * The SOURCE pool is passed for condition 3 of the before-shipment urgent
     * rule — whether the matched order has been dispatched. It is READ-ONLY:
     * the pool pins `default_transaction_read_only=on`, so the server itself
     * refuses a write rather than relying on this route's discipline.
     *
     * Its absence is safe rather than fatal. Without dispatch state nothing is
     * urgent and the inbox loads exactly as it did before — a missed highlight,
     * never a promise that a parcel can still be stopped.
     */
    const page = await listConversations(getAppPool(), {
      marketplace,
      offset,
      source: getSourcePool(),
    });
    return NextResponse.json({
      marketplace,
      conversations: page.items,
      hasMore: page.hasMore,
      offset,
      /*
       * How many cancellation / stop-dispatch conversations were lifted to the
       * top of this page, and how far the sweep that found them looked.
       *
       * The count is non-zero only on the first page — the urgent block is
       * served once and then held out of the ordinary stream, so a caller
       * paging onwards does not meet it again. `urgentScanCapped` says the
       * sweep hit its cap, which is the difference between "no more urgent
       * conversations" and "stopped looking"; an interface that cannot tell
       * those apart will present one as the other.
       */
      urgentCount: page.urgentCount,
      urgentScanned: page.urgentScanned,
      urgentScanCapped: page.urgentScanCapped,
    });
  } catch (cause) {
    // The underlying error may name schemas, columns or hosts, so it is logged
    // server-side and never returned to the browser.
    console.error("[conversations] list failed", cause);
    return NextResponse.json({ error: "Unable to load conversations" }, { status: 500 });
  }
}
