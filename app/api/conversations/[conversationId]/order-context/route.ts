import { NextResponse } from "next/server";

import { loadOrderDisplayDetails } from "@/lib/context/load-order-display";
import { resolveEbayOrderContext } from "@/lib/context/resolve-order-context";
import { resolveSelectedOrderContext } from "@/lib/context/resolve-selected-order-context";
import { resolveVerifiedTracking } from "@/lib/context/resolve-tracking-context";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import type { OrderContextResponse } from "@/lib/domain/order";
import { matchEvidenceFor, orderByNearest } from "@/lib/domain/order-match-evidence";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";
import {
  getContextSnapshot,
  getOrderCandidates,
} from "@/lib/repositories/context-snapshot-repository";

/**
 * GET /api/conversations/:id/order-context
 *
 * The verified order/shipping facts for the sidebar -- the exact same
 * resolver the draft pipeline calls (`resolveEbayOrderContext`), read here
 * for display rather than for grounding a reply. Nothing in this route
 * decides what counts as verified; that stays entirely in the resolver.
 *
 * Read-only against the marketplace source (the resolver's own contract).
 * The one write this can trigger is the resolver's existing cache write to
 * `cst_app.context_snapshots` on a conversation's first resolution -- the
 * same write that already happens the first time a draft is generated for
 * it. Opening the sidebar can now be what triggers that first resolution
 * instead of clicking Generate; either way it is the one write the pipeline
 * already made, not a new one.
 *
 * NEVER GUESSES, because it never computes anything: a non-eBay
 * conversation, an ambiguous match, or no match at all all come back from
 * the resolver as an empty list, and an empty list is exactly what this
 * route returns as `facts`. There is no separate "ambiguous" branch here to
 * get wrong.
 *
 * CANDIDATES ARE NOT FACTS. When the resolver has recorded an ambiguous
 * conversation -- several genuine purchases of the same listing by the same
 * buyer -- this also reads back the candidate orders it already stored, so
 * the sidebar can show a reviewer what actually matched instead of a flat
 * "nothing loaded". They travel in their own `candidates` field, typed
 * `OrderCandidate` rather than `VerifiedFact`, and `facts` stays empty: a
 * candidate is a verified order, but not a verified statement about THIS
 * conversation, and nothing downstream may treat it as one.
 *
 * Reads only; the one write this can trigger remains the resolver's own.
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

  const pool = getAppPool();

  try {
    const detail = await getConversation(pool, id);
    if (detail === null) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    let facts = await resolveEbayOrderContext(getSourcePool(), pool, detail.conversation);

    /**
     * The reviewer's choice, on the SAME terms the draft route already grants
     * it — see `verifiedFactsFor` there, which this deliberately mirrors.
     *
     * ORDER OF PRECEDENCE, NOT A MERGE. The resolver speaks first: the guard is
     * `facts.length === 0`, so a conversation that resolved to a single order on
     * its own evidence cannot be overridden by anything a browser sends. A
     * selection is read only where the resolver returned nothing, which for an
     * ambiguous conversation is exactly what it returns.
     *
     * WHY THE PANEL NEEDS THIS AT ALL. Everything below keys off `facts` —
     * including the tracking lookup. Without the selection the sidebar had no
     * facts for an ambiguous conversation, so it could show a reviewer the
     * order they had just picked and no shipment for it, while the draft
     * generated from that same choice had both. One choice, two answers.
     *
     * `resolveSelectedOrderContext` re-checks the number against the orders
     * this conversation actually matched, so a request naming any other order
     * gets nothing back. Nothing here trusts the query string.
     */
    const selectedOrderNumber = new URL(request.url).searchParams.get("selectedOrder");
    if (facts.length === 0 && selectedOrderNumber !== null) {
      try {
        facts = await resolveSelectedOrderContext(
          getSourcePool(),
          detail.conversation,
          selectedOrderNumber,
        );
      } catch (cause) {
        console.error("[order-context] selected order resolution failed", cause);
      }
    }

    /**
     * Read after resolving, deliberately: the call above is what writes this
     * conversation's snapshot the first time, so reading it second is what
     * makes a first-ever open of an ambiguous conversation show its
     * candidates rather than nothing.
     *
     * Null when the resolver wrote no snapshot at all -- every non-eBay
     * conversation, and the (caught, logged) case where the cache write
     * failed. Null is reported as null, never flattened into "no_order".
     */
    const snapshot = await getContextSnapshot(pool, id);
    const resolution = snapshot?.resolution ?? null;
    const candidates = resolution === "ambiguous" ? await getOrderCandidates(pool, id) : [];

    /**
     * The full picture, read live for display only.
     *
     * The cached snapshot holds what the RESOLVER needed -- eight facts chosen
     * because a draft may state them -- and a reviewer needs more than that:
     * the customer's name, the seller storefront, the order total and the
     * shipment record's state are all in the source and none of them is
     * cached anywhere, so a sidebar fed only by the snapshot left them blank
     * against orders that plainly have them. This reads them at open time,
     * from the same verified join the resolver matches on.
     *
     * A failure here is not a failure of the request: `facts` and `candidates`
     * above still describe the same orders, only more thinly, and the panel
     * falls back to them. Logged, never surfaced -- the message may name a
     * schema or a host.
     */
    let orders: OrderContextResponse["orders"] = [];
    try {
      const found = await loadOrderDisplayDetails(getSourcePool(), detail.conversation);
      /**
       * Nearest to what the customer wrote, first.
       *
       * Ordering only -- no order is chosen, preselected or hidden by it, and
       * every one keeps the same block format. It saves a reviewer scanning to
       * the bottom for the order a message written today is most likely about.
       */
      orders = orderByNearest(found, detail.messages);
    } catch (cause) {
      console.error("[order-context] display lookup failed", cause);
    }

    /**
     * Why each order matched, computed only when there is a comparison to
     * make. A single matching order needs no explanation of which one it is,
     * and an evidence line under it would be noise.
     *
     * Runs over the messages this handler already loaded -- no extra query --
     * and produces sentences, never values. Nothing in `evidence` is a fact,
     * reaches `facts`, or is readable by the draft pipeline, which does not
     * call this route.
     */
    const evidence = orders.length > 1 ? matchEvidenceFor(orders, detail.messages) : [];

    /**
     * Where the parcel has got to — WHATEVER THE CUSTOMER ASKED ABOUT.
     *
     * `resolveVerifiedTracking`, not `resolveTrackingContext`: display takes
     * the same lookup without the delivery-query gate. That gate exists to keep
     * a scan history out of the MODEL's context on a conversation it has no
     * business using one for, and it earns its place there. It earned nothing
     * here — a reviewer answering a damage claim, a wrong-item complaint or a
     * refund request is often asking exactly whether the parcel arrived, and
     * hiding a verified shipment from them cost them the answer while saving
     * nothing.
     *
     * EVERY OTHER REFUSAL STILL APPLIES, because both paths call one function.
     * No resolved order, no tracking number, an unrecognised carrier, a
     * reference recorded against two orders, an order sent in several parcels,
     * a stale non-terminal status — each still returns null, and the panel
     * still shows nothing.
     *
     * NEVER FAILS THE REQUEST. Order facts are the answer this route exists to
     * give, and a tracking failure must not cost them.
     */
    let tracking: OrderContextResponse["tracking"] = null;
    try {
      const trackingContext = await resolveVerifiedTracking({ facts });
      tracking = trackingContext.tracking;
    } catch (cause) {
      console.error("[order-context] tracking lookup failed", cause);
    }

    const payload: OrderContextResponse = {
      conversationId: id,
      facts,
      resolution,
      candidates,
      orders,
      evidence,
      tracking,
    };
    return NextResponse.json(payload);
  } catch (cause) {
    // The underlying error may name schemas, hosts or credentials, so it is
    // logged server-side and never returned to the browser.
    console.error("[order-context] lookup failed", cause);
    return NextResponse.json({ error: "Unable to load order context" }, { status: 500 });
  }
}
