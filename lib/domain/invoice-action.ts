import type { VerifiedFact } from "@/lib/domain/draft";

/**
 * When a reviewer may print an invoice, and what the control says.
 *
 * ------------------------------------------------------------------------
 * ONE CONDITION, SHARED WITH THE BACKEND
 * ------------------------------------------------------------------------
 * The button appears exactly when `/api/conversations/:id/invoice` would answer
 * with a document rather than a refusal, and it derives that from the SAME
 * signal the sidebar already uses for everything else an order implies: the
 * presence of a resolved order fact.
 *
 * `facts` is non-empty only where the backend resolved exactly ONE order — a
 * single strict match, an ambiguous conversation whose reviewer has chosen, or
 * a `no_order` conversation whose reviewer has chosen. Those are precisely the
 * three cases `resolveInvoiceOrderRowId` answers, so the control cannot appear
 * against a state the endpoint would reject, and cannot be hidden against one
 * it would serve.
 *
 * AMBIGUOUS WITHOUT A CHOICE HAS NO FACTS, so it has no button. That is the
 * case the whole order-selection flow exists for, and offering an invoice
 * before the choice is made would be offering to print a guess.
 *
 * ------------------------------------------------------------------------
 * THE CLIENT NAMES A CONVERSATION, NEVER AN ORDER
 * ------------------------------------------------------------------------
 * `invoiceRequestPath` builds a URL carrying the conversation id and, where one
 * exists, the reviewer's SELECTION — the same `?selectedOrder=` parameter the
 * order-context and draft requests already carry, validated on the server by
 * membership of that conversation's own candidate set.
 *
 * There is deliberately no order row id in this file and none in the request.
 * `order_management.orders` is keyed by a dense integer over 1.1M rows, so a
 * client that could name one could walk every customer's invoice. The row id is
 * derived server-side and never travels.
 */

/** The control's label. Never "VAT Invoice" — the source cannot back that. */
export const PRINT_INVOICE_LABEL = "Print invoice";

/** Shown while the document is being generated. */
export const PRINT_INVOICE_PENDING = "Generating invoice…";

/**
 * Shown for every failure.
 *
 * ONE MESSAGE FOR EVERY CAUSE. A 409 (no single resolved order), a 404, a 500
 * and a dropped connection all read the same, because the distinctions are
 * server-side detail and some of them would describe a schema or a host.
 */
export const PRINT_INVOICE_ERROR = "Unable to generate invoice";

/** Shown when the browser refused to open the generated document. */
export const PRINT_INVOICE_BLOCKED = "Allow pop-ups to view the invoice";

/**
 * The fact that means "exactly one order resolved for this conversation".
 *
 * Emitted first by both `factsFromOrder` and `manualSelectionFacts`, and
 * dropped only when the source recorded no order number at all — in which case
 * there is nothing to head an invoice with anyway.
 */
const RESOLVED_ORDER_FACT = "order_number";

/**
 * Whether this conversation has a single resolved order to invoice.
 *
 * False for: no match, an ambiguous conversation with no selection, a
 * `no_order` conversation with no selection, a non-eBay conversation, and any
 * conversation whose context failed to load. All of them are the same answer —
 * there is no one order — and all of them would be refused by the endpoint.
 */
export function canPrintInvoice(facts: readonly VerifiedFact[]): boolean {
  return facts.some((fact) => fact.name === RESOLVED_ORDER_FACT && fact.value.trim() !== "");
}

/**
 * The invoice request for this conversation and this reviewer's selection.
 *
 * The selection is a FILTER the server validates, never a lookup key: it is
 * checked against the orders this conversation actually matched before anything
 * is read. A blank selection is omitted rather than sent empty.
 */
export function invoiceRequestPath(
  conversationId: string,
  selectedOrderNumber: string | null,
): string {
  const base = `/api/conversations/${encodeURIComponent(conversationId)}/invoice`;
  if (selectedOrderNumber === null || selectedOrderNumber.trim() === "") return base;
  return `${base}?selectedOrder=${encodeURIComponent(selectedOrderNumber)}`;
}
