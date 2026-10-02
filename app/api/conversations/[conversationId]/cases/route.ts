import { NextResponse } from "next/server";

import { resolveCaseContext } from "@/lib/context/resolve-case-context";
import { getAppPool } from "@/lib/db/pools";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";
import type {
  CaseDetectionCase,
  CaseDetectionResponse,
} from "@/lib/domain/marketplace-case-display";
import type { MarketplaceCaseView } from "@/lib/repositories/marketplace-case-repository";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations/:id/cases
 *
 * The Case Detection Indicator for one conversation: the marketplace cases
 * already on record for the order it resolved to, and this customer's cases on
 * their other orders of the same storefront.
 *
 * ------------------------------------------------------------------------
 * GET ONLY. NO WRITE OF ANY KIND
 * ------------------------------------------------------------------------
 * There is no POST, PATCH, PUT or DELETE export in this file. The resolver
 * behind it issues reads and nothing else, so opening a conversation can never
 * change a row through this path.
 *
 * ------------------------------------------------------------------------
 * ONE POOL, AND IT IS THE APPLICATION'S
 * ------------------------------------------------------------------------
 * `getAppPool()` alone. The marketplace source pool is not used, because every
 * fact this route returns was imported into `cst_app` and none of it needs the
 * live source. There is no MySQL driver in this route's call graph and there
 * must never be: the message application's account allows 100 queries and 50
 * connections per HOUR shared with every other consumer, and a page load that
 * reached it would lock out the message sync within a shift.
 * `tests/guards/case-import-isolation.test.ts` walks every module reachable
 * from `app/` and fails the build if one appears.
 *
 * FOUR STATEMENTS AT MOST, each indexed: the per-store freshness read over a
 * ledger holding tens of rows, this conversation's stored context snapshot,
 * and the two case lookups — which run together because they are independent
 * reads on one pool.
 *
 * ------------------------------------------------------------------------
 * WHAT THE RESPONSE DOES NOT CONTAIN
 * ------------------------------------------------------------------------
 * No buyer handle, customer name, address, email address, telephone number,
 * message body, case correspondence or raw marketplace payload. None of those
 * is stored in `marketplace_cases` in the first place, and the shape below
 * could not carry one if they were.
 *
 * NO SOURCE TABLE NAME REACHES THE BROWSER EITHER. Coverage travels as two
 * counts rather than as a list of store names: a reviewer needs to know that a
 * case source has never been imported, not what the message application calls
 * its tables.
 *
 * ------------------------------------------------------------------------
 * THE STATE IS THE POINT OF THIS PAYLOAD
 * ------------------------------------------------------------------------
 * `state` distinguishes a published snapshot that was searched and held nothing
 * from a marketplace that was never imported, from a conversation with no
 * verified order or customer to search on, from a lookup that failed. All four
 * show no cases, and only ONE of them is evidence that the customer has none.
 * A client that collapses them is the bug this feature exists to avoid.
 *
 * ------------------------------------------------------------------------
 * ERRORS SAY NOTHING ABOUT THE DATABASE
 * ------------------------------------------------------------------------
 * A failed read logs server-side and returns a flat 503 with a fixed sentence.
 * No driver message, constraint name, table name or statement reaches the
 * browser — and 503 rather than 500 because the client's correct response is to
 * say the records could not be checked, not to treat the conversation as
 * broken.
 */
export const dynamic = "force-dynamic";

/*
 * THE PAYLOAD SHAPE LIVES IN `lib/domain/marketplace-case-display.ts`, beside
 * the rules that render it. Declaring it here instead would mean the panel
 * importing a type out of `app/api/`, which drags a server module into a client
 * graph for no reason — `OrderContextResponse` and `ListingLinkResponse` set
 * that convention and this follows it.
 */

/** Drops the fields that are matched on or indexed by, and never displayed. */
function toPayload(view: MarketplaceCaseView): CaseDetectionCase {
  return {
    caseRef: view.caseRef,
    caseType: view.caseType,
    lifecycle: view.lifecycle,
    sourceStatus: view.sourceStatus,
    sourceState: view.sourceState,
    warehouseDisposition: view.warehouseDisposition,
    sourceResolution: view.sourceResolution,
    sourceReason: view.sourceReason,
    damageReported: view.damageReported,
    replacementConfirmed: view.replacementConfirmed,
    escalation: view.escalation,
    sellerActionOwed: view.sellerActionOwed,
    sellerActionDueAt: view.sellerActionDueAt,
    quantity: view.quantity,
    refundAmount: view.refundAmount,
    refundCurrency: view.refundCurrency,
    openedAt: view.openedAt,
    closedAt: view.closedAt,
    orderRef: view.orderRef,
    orderMatchMethod: view.orderMatchMethod,
  };
}

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

    const conversation = detail.conversation;
    const result = await resolveCaseContext(
      pool,
      {
        id: conversation.id,
        marketplace: conversation.marketplace,
        subSourceId: conversation.subSourceId,
        counterpartyRef: conversation.counterpartyRef,
      },
      capabilityOf(conversation.marketplace),
      // The clock is supplied here and nowhere deeper, so the staleness rule
      // stays a pure function of a timestamp and a moment.
      new Date(),
    );

    const payload: CaseDetectionResponse = {
      state: result.state,
      orderCases: result.orderCases.cases.map(toPayload),
      customerCases: result.customerCases.cases.map(toPayload),
      orderCasesHasMore: result.orderCases.hasMore,
      customerCasesHasMore: result.customerCases.hasMore,
      matchedOrderRef: result.matchedOrderRef,
      coverage: {
        covered: result.coverage.storesCovered.length,
        neverImported: result.coverage.storesNeverImported.length,
        asOf: result.coverage.asOf,
      },
      stale: result.stale,
    };
    return NextResponse.json(payload);
  } catch (cause) {
    // Logged with the cause; returned without it.
    console.error("[case-detection] lookup failed", cause);
    return NextResponse.json(
      { error: "Case records are unavailable." },
      { status: 503 },
    );
  }
}
