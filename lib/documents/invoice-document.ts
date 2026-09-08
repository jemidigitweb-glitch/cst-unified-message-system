import type { OrderInvoiceContext, OrderInvoiceWarning } from "@/lib/domain/order-invoice";

import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  type PdfFont,
  type PdfItem,
  type PdfPage,
  renderPdf,
  wrapExact,
  wrapText,
} from "@/lib/documents/pdf";

/**
 * The invoice document, rendered from verified order data and nothing else.
 *
 * ------------------------------------------------------------------------
 * IT IS "INVOICE", NEVER "VAT INVOICE"
 * ------------------------------------------------------------------------
 * The source does not guarantee the fields a VAT document needs. Measured: only
 * 23.7% of orders record a tax above zero — every GBP order sampled records
 * 0.00 — and 1 of 22 eBay storefronts records a VAT number. A document headed
 * with that phrase asserts a tax position this data cannot support, so the
 * words do not appear. `INVOICE_TITLE` is the single place the heading is
 * spelled.
 *
 * ------------------------------------------------------------------------
 * NOTHING IS CALCULATED
 * ------------------------------------------------------------------------
 * Every figure on the page is a string that came out of the database. There is
 * no addition, no multiplication, no rounding and no reformatting of money
 * anywhere in this file — not even a line total from price × quantity, which is
 * why `unitPrice` and `quantity` print in separate columns and no third column
 * exists. No VAT rate, VAT amount, net or gross figure is derived. A field the
 * source did not record prints as `—`, never as `0.00`.
 *
 * The one numeric operation on this path is TEXT MEASUREMENT, used to wrap a
 * description and to right-align a column. It reads a string's width in points
 * and never its value.
 *
 * ------------------------------------------------------------------------
 * WHAT A CUSTOMER SEES, AND WHAT STAYS INTERNAL
 * ------------------------------------------------------------------------
 * The resolver's warnings are a mix of two different things. Whether an order
 * is CANCELLED or REFUNDED is the customer's business — an invoice for a
 * cancelled order that does not say so is misleading. Whether the seller's VAT
 * number is recorded, whether a discount reconciles, whether a payment row is
 * duplicated: those describe the state of our database, and printing them tells
 * a customer nothing they can act on while advertising our data quality.
 * `CUSTOMER_VISIBLE_WARNINGS` is that split, and it is a presentation rule —
 * the resolver still reports every warning to the application unchanged.
 *
 * ------------------------------------------------------------------------
 * NO DATABASE ACCESS
 * ------------------------------------------------------------------------
 * This module takes an `OrderInvoiceContext` and returns bytes. It imports no
 * pool, no repository and no client, so the renderer cannot widen what the
 * resolver decided to expose.
 */

/** The one place the document's heading is spelled. */
export const INVOICE_TITLE = "INVOICE";

/** Said where the source recorded nothing. Never `0.00`, which is a value. */
const ABSENT = "—";

/** Shown under BILL TO when the context carries no billing details. */
export const BILLING_UNAVAILABLE = "Billing details not available.";

/** Shown against the seller's VAT registration when none is recorded. */
export const SELLER_VAT_UNAVAILABLE = "Not available";

/**
 * Warnings a customer should read on their own invoice.
 *
 * Everything else the resolver reports is internal — see the module doc. The
 * split is deliberately a small allow-list rather than a deny-list, so a
 * warning added to the domain later stays off the page until somebody decides
 * it belongs there.
 */
const CUSTOMER_VISIBLE_WARNINGS: Record<string, string> = {
  order_cancelled: "This order was cancelled.",
  order_refunded: "This order was refunded. The amounts below are the original order values.",
};

const MARGIN = 56;
const RIGHT = PAGE_WIDTH - MARGIN;
const BOTTOM = PAGE_HEIGHT - MARGIN;
const BODY = 9.5;
const SMALL = 8.5;
const LINE = 13;

/* Two-column key/value blocks. */
const LABEL_X = MARGIN;
const VALUE_X = MARGIN + 130;

/*
 * The item table. Fixed columns, so a long description can never run into the
 * quantity: it wraps inside its own width instead. `QTY_RIGHT` and
 * `PRICE_RIGHT` are right edges — numbers line up on their last digit.
 */
const COL_SKU_X = MARGIN;
const COL_SKU_W = 126;
const COL_DESC_X = MARGIN + 136;
const COL_DESC_W = 208;
const COL_QTY_RIGHT = MARGIN + 396;
const COL_PRICE_RIGHT = RIGHT;

/* Totals block, right-aligned against the page margin. */
const TOTALS_LABEL_X = RIGHT - 200;
const TOTALS_VALUE_RIGHT = RIGHT;

function text(
  x: number,
  y: number,
  value: string,
  options: { size?: number; bold?: boolean; align?: "left" | "right" } = {},
): PdfItem {
  return {
    kind: "text",
    x,
    y,
    size: options.size ?? BODY,
    font: options.bold === true ? "bold" : "regular",
    text: value,
    align: options.align ?? "left",
  };
}

function rule(y: number, options: { x1?: number; x2?: number; width?: number } = {}): PdfItem {
  return {
    kind: "rule",
    x1: options.x1 ?? MARGIN,
    x2: options.x2 ?? RIGHT,
    y,
    width: options.width ?? 0.5,
  };
}

/** A stored value, or the absence marker. Never substitutes a zero. */
function shown(value: string | null): string {
  return value === null || value.trim() === "" ? ABSENT : value;
}

function fontFor(bold: boolean): PdfFont {
  return bold ? "bold" : "regular";
}

/**
 * The document.
 *
 * BILL TO CARRIES WHAT THE CONTEXT HAS. `OrderInvoiceContext` deliberately
 * holds the invoice-to party as booleans — the resolver never selects the name,
 * street, phone or email out of the database — so there are no billing details
 * to print today and the section says so in one clean line. Carrying the party
 * itself is a resolver change, and a decision about where personal data may
 * travel, neither of which belongs in a layout task.
 */
export function invoiceDocument(invoice: OrderInvoiceContext): readonly PdfPage[] {
  const pages: PdfItem[][] = [];
  let items: PdfItem[] = [];
  let y = MARGIN;

  const newPage = () => {
    items = [];
    pages.push(items);
    y = MARGIN;
  };
  newPage();

  /* ---- header ---- */
  items.push(text(MARGIN, y, INVOICE_TITLE, { size: 20, bold: true }));
  if (invoice.orderNumber !== null) {
    items.push(text(RIGHT, y, `Order ${invoice.orderNumber}`, { size: 11, align: "right" }));
  }
  y += 24;
  items.push(rule(y, { width: 1 }));
  y += 20;

  const pair = (label: string, value: string) => {
    items.push(text(LABEL_X, y, label, { bold: true }));
    items.push(text(VALUE_X, y, value));
    y += LINE;
  };

  pair("Order number", shown(invoice.orderNumber));
  pair("Order date", shown(invoice.orderDate));
  pair("Order status", shown(invoice.orderStatus));
  y += 10;

  /* ---- seller ---- */
  items.push(text(MARGIN, y, "SELLER", { bold: true, size: 11 }));
  y += LINE + 3;
  pair(
    "VAT Registration",
    invoice.sellerVatNumberAvailable ? "On file" : SELLER_VAT_UNAVAILABLE,
  );
  y += 10;

  /* ---- bill to ---- */
  items.push(text(MARGIN, y, "BILL TO", { bold: true, size: 11 }));
  y += LINE + 3;
  /*
   * ONE LINE, WHETHER OR NOT A PARTY IS RECORDED.
   *
   * `billingPartyPresent` says a party EXISTS; it does not carry the name or
   * the address, because the resolver never selects those columns. So there is
   * nothing to print in either case, and branching on the boolean would only
   * produce two ways of saying the same nothing. When the party is carried —
   * a resolver change, and a decision about where personal data may travel —
   * this is the block it fills.
   */
  items.push(text(LABEL_X, y, BILLING_UNAVAILABLE));
  y += LINE + 10;

  /* ---- items ---- */
  items.push(text(MARGIN, y, "ITEMS", { bold: true, size: 11 }));
  y += LINE + 3;

  const columnHeader = () => {
    items.push(text(COL_SKU_X, y, "SKU", { bold: true, size: SMALL }));
    items.push(text(COL_DESC_X, y, "Description", { bold: true, size: SMALL }));
    items.push(text(COL_QTY_RIGHT, y, "Qty", { bold: true, size: SMALL, align: "right" }));
    items.push(
      text(COL_PRICE_RIGHT, y, "Unit price", { bold: true, size: SMALL, align: "right" }),
    );
    y += 5;
    items.push(rule(y));
    y += LINE;
  };
  columnHeader();

  if (invoice.lines.length === 0) {
    items.push(text(COL_SKU_X, y, "No order lines recorded."));
    y += LINE;
  }

  for (const line of invoice.lines) {
    /*
     * THE SKU WRAPS, IT DOES NOT CHANGE. A combo such as AAA+BBB+CCC that is
     * wider than its column continues on the next line, character for
     * character, with no hyphen and nothing removed — so a customer can read
     * the whole identifier and type it back exactly. It is still ONE SKU; the
     * break is a property of the page, not of the value.
     *
     * `wrapExact`, NOT `wrapText`: word wrapping normalises runs of whitespace
     * to a single space, which is correct for a description and a corruption
     * of an opaque identifier. Concatenating these lines reproduces the stored
     * SKU byte for byte.
     */
    const skuLines = wrapExact(shown(line.sku), COL_SKU_W, SMALL, fontFor(false));
    const descLines = wrapText(shown(line.productTitle), COL_DESC_W, BODY, fontFor(false));
    const rows = Math.max(skuLines.length, descLines.length);
    const height = rows * (LINE - 1) + 5;

    // The row travels whole: a description never starts on one page and
    // finishes on the next.
    if (y + height > BOTTOM) {
      newPage();
      columnHeader();
    }

    skuLines.forEach((part, index) => {
      items.push(text(COL_SKU_X, y + index * (LINE - 1), part, { size: SMALL }));
    });
    descLines.forEach((part, index) => {
      items.push(text(COL_DESC_X, y + index * (LINE - 1), part));
    });
    items.push(text(COL_QTY_RIGHT, y, shown(line.quantity), { align: "right" }));
    items.push(text(COL_PRICE_RIGHT, y, shown(line.unitPrice), { align: "right" }));

    y += height;
  }

  items.push(rule(y));
  y += LINE + 8;

  /* ---- totals ---- */
  if (y + LINE * 7 > BOTTOM) newPage();

  if (invoice.currency !== null) {
    items.push(
      text(TOTALS_VALUE_RIGHT, y, `Amounts in ${invoice.currency}`, {
        size: SMALL,
        align: "right",
      }),
    );
    y += LINE + 4;
  }

  const amount = (label: string, value: string | null, bold = false) => {
    items.push(text(TOTALS_LABEL_X, y, label, { bold }));
    items.push(text(TOTALS_VALUE_RIGHT, y, shown(value), { bold, align: "right" }));
    y += LINE;
  };

  amount("Subtotal", invoice.subtotal);
  amount("Shipping", invoice.shippingCost);
  amount("Discount", invoice.discount);
  amount("Tax", invoice.tax);

  y += 3;
  items.push(rule(y, { x1: TOTALS_LABEL_X }));
  y += LINE + 2;
  amount("Total", invoice.total, true);

  y += 6;
  amount("Amount paid", invoice.amountPaid);
  if (invoice.paymentMethod !== null) amount("Payment method", invoice.paymentMethod);
  if (invoice.paidTime !== null) amount("Paid at", invoice.paidTime);

  /* ---- notes a customer should read, and only those ---- */
  const notes = invoice.warnings
    .map((warning) => CUSTOMER_VISIBLE_WARNINGS[warning])
    .filter((note): note is string => note !== undefined);

  if (notes.length > 0) {
    y += 16;
    if (y + LINE * (notes.length + 1) > BOTTOM) newPage();
    items.push(rule(y));
    y += LINE + 4;
    for (const note of notes) {
      items.push(text(MARGIN, y, note, { size: SMALL, bold: true }));
      y += LINE;
    }
  }

  return pages;
}

/** The invoice as PDF bytes. Rendering only — no query, no write, no storage. */
export function renderInvoicePdf(invoice: OrderInvoiceContext): Buffer {
  return renderPdf(invoiceDocument(invoice));
}

/**
 * The download filename.
 *
 * Built from the ORDER NUMBER because that is what a person recognises, and
 * sanitised to a conservative character set so nothing in a source value can
 * break out of the `Content-Disposition` header. It is a label, never a key.
 */
export function invoiceFilename(invoice: OrderInvoiceContext): string {
  const reference = (invoice.orderNumber ?? invoice.sourceOrderRowId).replace(
    /[^A-Za-z0-9._-]/g,
    "-",
  );
  return `invoice-${reference}.pdf`;
}

/** Retained for callers and tests that assert the warning vocabulary. */
export type { OrderInvoiceWarning };
