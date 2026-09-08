import "server-only";

import type {
  OrderInvoiceContext,
  OrderInvoiceLine,
  OrderInvoiceWarning,
} from "@/lib/domain/order-invoice";

/**
 * Read-only invoice context for ONE already-resolved customer order.
 *
 * STRICTLY READ-ONLY. Two SELECTs against the source pool, which the caller
 * pins `default_transaction_read_only=on` for — see `getSourcePool()`. Nothing
 * here writes anywhere, nothing is cached, and no snapshot is touched.
 *
 * ------------------------------------------------------------------------
 * IT IS GIVEN AN ORDER; IT NEVER CHOOSES ONE
 * ------------------------------------------------------------------------
 * The caller has already resolved exactly one order — through the strict
 * matcher, or through a reviewer's explicit selection — and passes its stable
 * row id. This module has no buyer predicate, no listing predicate, no
 * storefront predicate, no `ORDER BY` over orders and no `LIMIT`, because it
 * never has more than one order in view. It cannot pick the first candidate,
 * the newest candidate, or resolve an ambiguity, because it is never shown one.
 *
 * A conversation with no single resolved order must not call this at all.
 *
 * ------------------------------------------------------------------------
 * THE KEY IS `orders.id`, NEVER THE ORDER NUMBER
 * ------------------------------------------------------------------------
 * `orders.order_id` — the number a customer quotes — is NOT unique in the
 * source: 655 numbers are reused across 1,608 rows, and pairing it with
 * `sub_source_id` does not separate them either. Looking an invoice up by that
 * value could return a different customer's order, so `findOrderInvoiceContext`
 * refuses any identifier that is not a bare positive integer. An order number
 * like `20-00000-00001` contains characters a row id cannot, so it is rejected
 * by shape before a query is ever built.
 *
 * CST already carries the right value: `CandidateOrder.orderRowId`, selected as
 * `o.id::text` by the strict matcher and by the eligible-orders list, and
 * persisted as `cst_app.context_snapshots.source_order_row_ids`.
 *
 * ------------------------------------------------------------------------
 * `order_management.shipment` IS NOT READ HERE
 * ------------------------------------------------------------------------
 * `shipment.invoice` is a DHL international export document path, present on
 * 93 of 1,144,513 shipments and on none of the 14 real invoice-request orders
 * traced during discovery. It is shipment-scoped, so one order can hold two of
 * them, and four sit on cancelled shipments. This file never names the table,
 * and a guard test asserts the SQL does not.
 *
 * ------------------------------------------------------------------------
 * FAN-OUT IS COUNTED, NEVER COLLAPSED BY A PICK
 * ------------------------------------------------------------------------
 * Billing, payment and contact rows are read through LATERALs rather than
 * joined, so one order is one header row by construction. Where a LATERAL finds
 * more than one row, its value columns come back NULL from the database itself
 * — the established `CASE WHEN count(*) = 1` idiom in this codebase — and the
 * count travels alongside so the caller is told a duplicate exists instead of
 * being handed an arbitrary one of them. `min()` and `bool_or()` are safe only
 * because they are read exclusively under `count(*) = 1`.
 *
 * ------------------------------------------------------------------------
 * NO ARITHMETIC ON MONEY, AND NO VAT
 * ------------------------------------------------------------------------
 * Every monetary column is cast to text in SQL and returned untouched. Nothing
 * is parsed into a JavaScript number, so no float artefact can appear on a
 * document. The two comparisons that exist — "is `tax` above zero" and "does a
 * recorded discount appear nowhere in the total" — are evaluated by Postgres in
 * exact `numeric`, produce booleans, and produce no figure. No VAT rate, net
 * amount, gross amount or tax total is calculated anywhere on this path.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * The one order status that raises no status warning.
 *
 * Everything else is reported. `Cancelled` and `Refunded` get their own values
 * because they mean specific, different things to a reviewer; the rest share
 * `order_not_completed` rather than being silently treated as fine.
 */
const COMPLETED_STATUS = "completed";

/**
 * A bare positive integer, and nothing else.
 *
 * This is the guard that makes an order number unusable as a key. No leading
 * `+`/`-`, no whitespace, no separators, no exponent — `20-00000-00001` fails
 * here, as does an empty string.
 */
const ROW_ID_SHAPE = /^[0-9]+$/;

/**
 * The invoice header: the order row, its storefront, and the PRESENCE of the
 * billing party, the payment record and the invoice email.
 *
 * `sub_source` is a LEFT JOIN on a lookup primary key: an order whose storefront
 * row is missing must still return its invoice data, with the seller VAT number
 * reported as unavailable, rather than vanishing.
 *
 * Only booleans cross the boundary from `billing_address` and `customer_info`.
 * The names, addresses, phone numbers and email addresses are not selected at
 * all, so no later change to the mapper can start leaking one.
 */
const FIND_ORDER_INVOICE_HEADER = `
SELECT
  o.id::text                    AS source_order_row_id,
  o.order_id                    AS order_number,
  o.order_date::text            AS order_date,
  o.status                      AS order_status,
  o.sub_total::text             AS subtotal,
  o.shipping_cost::text         AS shipping_cost,
  o.tax::text                   AS tax,
  o.discount::text              AS discount,
  o.total::text                 AS total,
  (o.tax IS NOT NULL AND o.tax > 0)                       AS vat_amount_available,
  (o.discount IS NOT NULL AND o.discount > 0
     AND o.total IS NOT NULL AND o.sub_total IS NOT NULL
     AND o.total = o.sub_total)                           AS discount_not_reflected,
  ss.vat_no                     AS seller_vat_number,
  payment.row_count             AS order_info_row_count,
  payment.currency              AS currency,
  payment.amount_paid           AS amount_paid,
  payment.paid_time             AS paid_time,
  payment.payment_method        AS payment_method,
  billing.row_count             AS billing_row_count,
  billing.party_present         AS billing_party_present,
  billing.company_present       AS billing_company_present,
  contact.email_present         AS invoice_email_present
FROM order_management.orders o
LEFT JOIN order_management.sub_source ss ON ss.id = o.sub_source_id
LEFT JOIN LATERAL (
  SELECT count(*)                                                      AS row_count,
         CASE WHEN count(*) = 1 THEN min(oi.currency) END              AS currency,
         CASE WHEN count(*) = 1 THEN min(oi.amount_paid)::text END     AS amount_paid,
         CASE WHEN count(*) = 1 THEN min(oi.paid_time)::text END       AS paid_time,
         CASE WHEN count(*) = 1 THEN min(oi.payment_method) END        AS payment_method
  FROM order_management.order_info oi
  WHERE oi.order_id = o.id
) payment ON true
LEFT JOIN LATERAL (
  SELECT count(*)                                                      AS row_count,
         CASE WHEN count(*) = 1 THEN bool_or(
           coalesce(b.address_name, '') <> '' OR coalesce(b.address_line_1, '') <> ''
         ) END                                                         AS party_present,
         CASE WHEN count(*) = 1 THEN bool_or(
           coalesce(b.company, '') <> ''
         ) END                                                         AS company_present
  FROM customers.billing_address b
  WHERE b.order_id = o.id
) billing ON true
LEFT JOIN LATERAL (
  SELECT bool_or(coalesce(c.email_invoice, '') <> '')                  AS email_present
  FROM customers.customer_info c
  WHERE c.order_id = o.id
) contact ON true
WHERE o.id = $1::bigint`;

/**
 * The invoice lines, in a stable order.
 *
 * `ORDER BY oii.id` is a READING ORDER WITHIN ONE INVOICE, not a ranking
 * between candidates. The distinction matters: the order-selection queries in
 * this codebase have no `ORDER BY` precisely so that no code can take the first
 * of several ORDERS. Here every row belongs to the one order the caller already
 * resolved, all of them are returned, and none is preferred over another — the
 * clause only stops the same invoice printing its lines in a different sequence
 * on each read.
 *
 * Prices and quantities are `character varying` in the source. They are
 * selected as stored and never coerced, multiplied or totalled.
 */
const FIND_ORDER_INVOICE_LINES = `
SELECT oii.id::text        AS line_id,
       oii.line_item_id    AS line_item_ref,
       oii.item_id         AS item_ref,
       oii.real_sku        AS real_sku,
       oii.item_sku        AS item_sku,
       oii.item_title      AS product_title,
       oii.real_price      AS real_price,
       oii.item_price      AS item_price,
       oii.real_qty        AS real_qty,
       oii.item_quantity   AS item_quantity
FROM order_management.order_item_info oii
WHERE oii.order_id = $1::bigint
ORDER BY oii.id`;

type InvoiceHeaderRow = {
  source_order_row_id: string;
  order_number: string | null;
  order_date: string | null;
  order_status: string | null;
  subtotal: string | null;
  shipping_cost: string | null;
  tax: string | null;
  discount: string | null;
  total: string | null;
  vat_amount_available: boolean | null;
  discount_not_reflected: boolean | null;
  seller_vat_number: string | null;
  order_info_row_count?: string | number | null;
  currency: string | null;
  amount_paid: string | null;
  paid_time: string | null;
  payment_method: string | null;
  billing_row_count?: string | number | null;
  billing_party_present: boolean | null;
  billing_company_present: boolean | null;
  invoice_email_present: boolean | null;
};

type InvoiceLineRow = {
  line_id: string;
  line_item_ref: string | null;
  item_ref: string | null;
  real_sku: string | null;
  item_sku: string | null;
  product_title: string | null;
  real_price: string | null;
  item_price: string | null;
  real_qty: string | null;
  item_quantity: string | null;
};

/**
 * Blank is an absence; anything else is returned BYTE-FOR-BYTE.
 *
 * `.trim()` TESTS for emptiness and never produces the result — a SKU passes
 * through here and must come out exactly as the source stored it, leading and
 * trailing characters included. See `lib/domain/sku.ts`.
 */
function blankToNull(value: string | null | undefined): string | null {
  return value == null || value.trim() === "" ? null : value;
}

/**
 * The corrected source value where one was recorded, else the original.
 *
 * This is the precedence the strict matcher already applies to SKUs
 * (`real_sku ?? item_sku`), extended to price and quantity, which carry the
 * same `real_*` correction pair. Emptiness is tested through `blankToNull`
 * rather than SQL `coalesce`, because these columns are `character varying`
 * and an empty string is a recorded blank, not a correction.
 */
function correctedOrOriginal(corrected: string | null, original: string | null): string | null {
  return blankToNull(corrected) ?? blankToNull(original);
}

function toCount(value: string | number | null | undefined): number {
  return value == null ? 0 : Number(value);
}

function toInvoiceLine(row: InvoiceLineRow): OrderInvoiceLine {
  return {
    lineId: row.line_id,
    lineItemRef: blankToNull(row.line_item_ref),
    itemRef: blankToNull(row.item_ref),
    // Verbatim. Never split, trimmed, case-folded or normalised.
    sku: correctedOrOriginal(row.real_sku, row.item_sku),
    productTitle: blankToNull(row.product_title),
    unitPrice: correctedOrOriginal(row.real_price, row.item_price),
    quantity: correctedOrOriginal(row.real_qty, row.item_quantity),
  };
}

/**
 * Every observed condition, in a fixed order so callers and tests can rely on it.
 *
 * The status branch reports `Cancelled`, `Refunded` and `Deleted` distinctly and
 * groups every other non-completed state under `order_not_completed`. Nothing is
 * suppressed: an order can carry a status warning and still be perfectly
 * describable, which is exactly why status does not gate `invoiceDataAvailable`.
 */
function warningsFor(
  header: InvoiceHeaderRow,
  orderNumber: string | null,
  billingRowCount: number,
  orderInfoRowCount: number,
  lineCount: number,
  sellerVatNumberAvailable: boolean,
): OrderInvoiceWarning[] {
  const warnings: OrderInvoiceWarning[] = [];

  if (orderNumber === null) warnings.push("order_number_missing");

  if (billingRowCount === 0) warnings.push("billing_address_missing");
  else if (billingRowCount > 1) warnings.push("billing_address_duplicated");

  if (lineCount === 0) warnings.push("order_lines_missing");

  if (orderInfoRowCount === 0) warnings.push("order_info_missing");
  else if (orderInfoRowCount > 1) warnings.push("order_info_duplicated");

  const status = blankToNull(header.order_status)?.trim().toLowerCase() ?? null;
  if (status === "cancelled") warnings.push("order_cancelled");
  else if (status === "refunded") warnings.push("order_refunded");
  else if (status === "deleted") warnings.push("order_deleted");
  else if (status !== COMPLETED_STATUS) warnings.push("order_not_completed");

  if (!sellerVatNumberAvailable) warnings.push("seller_vat_number_missing");
  // REPORTED, NEVER DERIVED. The absence of a tax figure is stated; no figure
  // is computed to fill it. See the module doc.
  if (header.vat_amount_available !== true) warnings.push("tax_amount_absent");

  if (header.discount_not_reflected === true) warnings.push("discount_not_reflected_in_total");

  return warnings;
}

/**
 * The invoice context for one resolved order, or null.
 *
 * Null for an identifier that is not a bare row id — an order number can never
 * reach a query — and null for an order the source does not hold. Null is NOT
 * used for an incomplete invoice: a cancelled order, an order with no billing
 * party and an order with no lines all return a context whose `warnings` say
 * so, because hiding those states is what would let a caller show something
 * wrong without knowing it.
 */
export async function findOrderInvoiceContext(
  client: Queryable,
  orderRowId: string,
): Promise<OrderInvoiceContext | null> {
  if (!ROW_ID_SHAPE.test(orderRowId)) return null;

  const { rows: headerRows } = await client.query({
    text: FIND_ORDER_INVOICE_HEADER,
    values: [orderRowId],
  });
  // The row id is a primary key, so anything but exactly one row means the
  // caller's order does not exist. Not "take the first".
  if (headerRows.length !== 1) return null;
  const header = headerRows[0] as InvoiceHeaderRow;

  const { rows: lineRows } = await client.query({
    text: FIND_ORDER_INVOICE_LINES,
    values: [orderRowId],
  });
  const lines = (lineRows as InvoiceLineRow[]).map(toInvoiceLine);

  const orderNumber = blankToNull(header.order_number);
  const billingRowCount = toCount(header.billing_row_count);
  const orderInfoRowCount = toCount(header.order_info_row_count);
  const sellerVatNumberAvailable = blankToNull(header.seller_vat_number) !== null;
  const vatAmountAvailable = header.vat_amount_available === true;

  // Enough source data to describe this order as an invoice: it has a
  // reference, exactly one invoice-to party, and something on it.
  const invoiceDataAvailable =
    orderNumber !== null && billingRowCount === 1 && lines.length > 0;

  return {
    sourceOrderRowId: header.source_order_row_id,
    orderNumber,
    orderDate: blankToNull(header.order_date),
    orderStatus: blankToNull(header.order_status),

    currency: blankToNull(header.currency),
    subtotal: blankToNull(header.subtotal),
    shippingCost: blankToNull(header.shipping_cost),
    tax: blankToNull(header.tax),
    discount: blankToNull(header.discount),
    total: blankToNull(header.total),
    amountPaid: blankToNull(header.amount_paid),
    paidTime: blankToNull(header.paid_time),
    paymentMethod: blankToNull(header.payment_method),

    lineCount: lines.length,
    lines,

    billingPartyPresent: header.billing_party_present === true,
    billingCompanyPresent: header.billing_company_present === true,
    invoiceEmailOnFile: header.invoice_email_present === true,

    sellerVatNumberAvailable,
    vatAmountAvailable,
    invoiceDataAvailable,
    // The fields a VAT document additionally needs. A statement about the DATA,
    // never about legal validity — see the domain type.
    vatDocumentDataComplete:
      invoiceDataAvailable && sellerVatNumberAvailable && vatAmountAvailable,
    warnings: warningsFor(
      header,
      orderNumber,
      billingRowCount,
      orderInfoRowCount,
      lines.length,
      sellerVatNumberAvailable,
    ),
  };
}
