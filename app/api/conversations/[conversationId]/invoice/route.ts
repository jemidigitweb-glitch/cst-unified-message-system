import { NextResponse } from "next/server";

import { resolveInvoiceOrderRowId } from "@/lib/context/resolve-invoice-order";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import { invoiceFilename, renderInvoicePdf } from "@/lib/documents/invoice-document";
import { getConversation, parseConversationId } from "@/lib/repositories/conversation-repository";
import { findOrderInvoiceContext } from "@/lib/repositories/order-invoice-repository";

/**
 * GET /api/conversations/:id/invoice[?selectedOrder=...]
 *
 * The invoice for the order THIS CONVERSATION resolves to, rendered on demand
 * and returned as PDF bytes.
 *
 * ------------------------------------------------------------------------
 * ON DEMAND, AND ONLY ON DEMAND
 * ------------------------------------------------------------------------
 * Nothing calls this on a schedule, on sync, on draft generation or on sidebar
 * open. It runs when a CST user asks for an invoice and at no other time. The
 * PDF is built in memory and streamed back: nothing is written to disk, no
 * invoice record is created, no file row is stored, no URL is minted, and the
 * bytes exist only for the length of the response.
 *
 * ------------------------------------------------------------------------
 * THE CALLER NAMES A CONVERSATION, NEVER AN ORDER
 * ------------------------------------------------------------------------
 * This route accepts NO order id. `order_management.orders` is keyed by a dense
 * integer over 1,101,548 rows, so an endpoint that took one would be an
 * enumeration hole straight through every customer's invoice. The order is
 * derived by `resolveInvoiceOrderRowId` from the conversation's own buyer,
 * storefront and listing — the same capability model, and the same precedence,
 * that the order-context and draft routes already enforce.
 *
 * `selectedOrder` carries a reviewer's CHOICE, exactly as it does on those two
 * routes, and is used only to filter a candidate set already fetched by the
 * conversation's keys. It is never a lookup value. An ambiguous conversation
 * with no choice made produces no invoice rather than a guessed one.
 *
 * ------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ------------------------------------------------------------------------
 * No new authentication mechanism, because the application has none to extend
 * and inventing one for a single endpoint would be worse than matching the
 * model every neighbouring route already uses. No VAT calculation. No
 * marketplace call. No email. No storage. The document is headed "INVOICE" and
 * never "VAT Invoice" — see `lib/documents/invoice-document.ts`.
 */
export const dynamic = "force-dynamic";
/** Buffer and the PDF writer are Node APIs; this must not run on the edge. */
export const runtime = "nodejs";

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

    const selectedOrderNumber = new URL(request.url).searchParams.get("selectedOrder");

    const orderRowId = await resolveInvoiceOrderRowId(
      getSourcePool(),
      pool,
      { ...detail.conversation, id: String(detail.conversation.id) },
      selectedOrderNumber,
    );

    /*
     * NO SINGLE RESOLVED ORDER, NO INVOICE. This is the ambiguous-without-a-
     * selection case, the no-match case and the non-eBay case, and all three
     * are the same answer: there is nothing to invoice, and producing a
     * plausible document for the wrong order would be worse than producing
     * none. 409 rather than 404 — the conversation exists; the order does not.
     */
    if (orderRowId === null) {
      return NextResponse.json(
        { error: "No single resolved order for this conversation" },
        { status: 409 },
      );
    }

    const invoice = await findOrderInvoiceContext(getSourcePool(), orderRowId);
    if (invoice === null) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const pdf = renderInvoicePdf(invoice);

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        // `inline` so the browser's own viewer opens it for printing; the
        // filename is still offered for a save. Nothing is persisted either way.
        "Content-Disposition": `inline; filename="${invoiceFilename(invoice)}"`,
        "Content-Length": String(pdf.length),
        // A document built from live customer data must not sit in a shared
        // cache, a proxy, or the browser's disk cache.
        "Cache-Control": "no-store, private",
      },
    });
  } catch (cause) {
    /*
     * Logged server-side and never returned: the underlying message may name a
     * schema, a host or a credential. The log line carries the conversation id
     * only — no order number, SKU, billing party or total, because a log is a
     * place customer data must not accumulate.
     */
    console.error("[invoice] generation failed", cause);
    return NextResponse.json({ error: "Unable to generate invoice" }, { status: 500 });
  }
}
