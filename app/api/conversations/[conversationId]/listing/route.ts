import { NextResponse } from "next/server";

import { resolveListingLink } from "@/lib/context/resolve-listing-link";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import type { ListingLinkResponse } from "@/lib/domain/listing-link";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations/:id/listing
 *
 * The marketplace listing URL for a conversation's item reference, for the
 * context panel. See `resolveListingLink` for what it will and will not
 * resolve.
 *
 * ITS OWN ROUTE, NOT PART OF /order-context. The link depends on the item
 * reference alone, so it is available on conversations that resolved to no
 * order — and a pre-sales enquiry, which is precisely that case, is where a
 * reviewer most wants to open the listing. It also keeps `OrderContextResponse`
 * describing orders, which a listing URL is not.
 *
 * Read-only against the marketplace source, and unlike `/order-context` this
 * writes nothing at all: it never resolves an order, so it can never trigger
 * the resolver's first-resolution snapshot write as a side effect. Opening a
 * conversation's listing link changes no stored state.
 *
 * NEVER FAILS SOFT INTO A GUESS. Anything that goes wrong returns an error the
 * panel renders as "no link", not a URL assembled from the item reference.
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

    const listingUrl = await resolveListingLink(getSourcePool(), detail.conversation);

    const payload: ListingLinkResponse = { conversationId: id, listingUrl };
    return NextResponse.json(payload);
  } catch (cause) {
    // The underlying error may name schemas, hosts or credentials, so it is
    // logged server-side and never returned to the browser.
    console.error("[listing] lookup failed", cause);
    return NextResponse.json({ error: "Unable to load listing link" }, { status: 500 });
  }
}
