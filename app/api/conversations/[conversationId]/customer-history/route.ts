import { NextResponse } from "next/server";

import { resolveCustomerHistory } from "@/lib/context/resolve-customer-history";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";

/**
 * GET /api/conversations/:id/customer-history
 *
 * The Repeat-Customer Warning for one conversation: whether this customer has
 * verified prior history on this storefront, and which record counts say so.
 *
 * ------------------------------------------------------------------------
 * GET ONLY. NO WRITE OF ANY KIND
 * ------------------------------------------------------------------------
 * There is no POST, PATCH, PUT or DELETE export in this file. Unlike
 * `order-context/route.ts`, this route cannot even trigger an incidental cache
 * write — the resolver reads no context snapshot and writes none, so opening a
 * conversation can never change a row through this path.
 *
 * ------------------------------------------------------------------------
 * POSTGRESQL ONLY, AND THE EXISTING POOLS
 * ------------------------------------------------------------------------
 * `getAppPool()` and `getSourcePool()` — the two pools the application already
 * has, at their existing sizes. No pool is created here and no limit is
 * raised. There is no MySQL driver in this route's call graph: the historical
 * case data lives in `cst_app.customer_case_history` precisely so a page load
 * never reaches the MySQL account, which allows 100 queries per hour in total.
 *
 * THREE STATEMENTS, each a single-row aggregate. Two on the application pool
 * (run together — the same two-statement fan-out `/api/performance/summary`
 * already makes) and one on the read-only source pool. No history row crosses
 * the wire: the browser receives counts, never records.
 *
 * ------------------------------------------------------------------------
 * AUTHENTICATION
 * ------------------------------------------------------------------------
 * There is none, here or anywhere in this application — deliberately, and
 * adding it is its own piece of work (see `documentation/ai-coding-context.md`
 * §7). This route therefore follows the existing convention exactly: it
 * validates the conversation id, reads, and returns. It introduces no new
 * surface — a caller who can reach this can already reach the conversation
 * itself through `/api/conversations/:id`, which returns the full message
 * bodies this route deliberately does not read.
 *
 * ------------------------------------------------------------------------
 * WHAT THE RESPONSE DOES NOT CONTAIN
 * ------------------------------------------------------------------------
 * No buyer handle, name, address, email, order number, case id or message
 * text. The payload is counts, reason type names, and a timestamp. An agent
 * who needs the underlying records has the conversation and the order panel;
 * this endpoint exists to say "there is history", not to republish it.
 *
 * `available: false` means no verified customer identity could be established
 * — an unsupported marketplace, the platform writing to us rather than a
 * buyer, an ungrouped message, or a blank reference. It is NOT "no history",
 * and a client must render nothing rather than a zero.
 *
 * ------------------------------------------------------------------------
 * ERRORS SAY NOTHING ABOUT THE DATABASE
 * ------------------------------------------------------------------------
 * A failed read logs server-side and returns a flat 503 with a fixed
 * sentence. No driver message, constraint name, table name or SQL reaches the
 * browser — and 503 rather than 500 because the client's correct response is
 * to show no warning and optionally retry, not to treat the conversation as
 * broken.
 */
export const dynamic = "force-dynamic";

/** The shape the browser receives. Counts and reason names, nothing else. */
export type CustomerHistoryResponse = {
  readonly available: boolean;
  readonly warning: boolean;
  readonly reasons: readonly { readonly type: string; readonly count: number }[];
  /** Signals that could not be read. Never counted as zero by any client. */
  readonly unavailableSignals: readonly string[];
  readonly unavailableReason: string | null;
  readonly historyAsOf: string | null;
};

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
    const result = await resolveCustomerHistory(
      pool,
      /*
       * The source pool supplies the refund count only. Handed in rather than
       * reached for inside the resolver so a caller can withhold it, and so
       * its failure degrades that one signal to `unavailable` instead of
       * failing the request or — far worse — reporting zero refunds.
       */
      getSourcePool(),
      {
        id: conversation.id,
        marketplace: conversation.marketplace,
        subSourceId: conversation.subSourceId,
        counterpartyRef: conversation.counterpartyRef,
        firstSourceTimestamp: conversation.firstSourceTimestamp,
      },
      capabilityOf(conversation.marketplace),
    );

    const payload: CustomerHistoryResponse = {
      available: result.available,
      warning: result.warning,
      reasons: result.reasons,
      unavailableSignals: result.unavailableSignals,
      unavailableReason: result.unavailableReason,
      historyAsOf: result.historyAsOf,
    };
    return NextResponse.json(payload);
  } catch (cause) {
    // Logged with the cause; returned without it.
    console.error("[customer-history] lookup failed", cause);
    return NextResponse.json(
      { error: "Customer history is unavailable." },
      { status: 503 },
    );
  }
}
