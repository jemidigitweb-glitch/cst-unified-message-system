import { describe, expect, it } from "vitest";

import {
  BILLING_UNAVAILABLE,
  INVOICE_TITLE,
  SELLER_VAT_UNAVAILABLE,
  invoiceFilename,
  renderInvoicePdf,
} from "@/lib/documents/invoice-document";
import { textWidth } from "@/lib/documents/pdf";
import type { OrderInvoiceContext, OrderInvoiceLine } from "@/lib/domain/order-invoice";

/**
 * The invoice document.
 *
 * The properties that matter: every figure on the page came out of the
 * database, no tax is ever computed, a SKU survives whole, and a missing or
 * abnormal state is printed rather than hidden. The word "VAT Invoice" must not
 * appear anywhere, because the source cannot back that claim.
 *
 * Synthetic fixtures. The order numbers are the documented placeholders.
 */

const COMBO_SKU = "PSHYOS4BRBM+SPUPBM+SLDO210BM";

function line(overrides: Partial<OrderInvoiceLine> = {}): OrderInvoiceLine {
  return {
    lineId: "1",
    lineItemRef: "111111111111-1",
    itemRef: "111111111111",
    sku: COMBO_SKU,
    productTitle: "Ceiling Rose Strap Bracket Plate",
    unitPrice: "5.49",
    quantity: "1",
    ...overrides,
  };
}

function invoice(overrides: Partial<OrderInvoiceContext> = {}): OrderInvoiceContext {
  return {
    sourceOrderRowId: "9000000001",
    orderNumber: "20-00000-00001",
    orderDate: "2026-09-01 09:14:22",
    orderStatus: "Completed",
    currency: "GBP",
    subtotal: "5.49",
    shippingCost: "2.89",
    tax: "0.00",
    discount: "0.00",
    total: "8.38",
    amountPaid: "8.38",
    paidTime: "2026-09-01 09:15:03",
    paymentMethod: "CreditCard",
    lineCount: 1,
    lines: [line()],
    billingPartyPresent: true,
    billingCompanyPresent: false,
    invoiceEmailOnFile: true,
    sellerVatNumberAvailable: true,
    vatAmountAvailable: false,
    invoiceDataAvailable: true,
    vatDocumentDataComplete: false,
    warnings: ["tax_amount_absent"],
    ...overrides,
  };
}

/**
 * The visible text of the PDF.
 *
 * The content streams are uncompressed by construction, so every drawn run is
 * a `(...) Tj` in the file and can be read back exactly as a reader would draw
 * it. This is what makes assertions about the PAGE possible rather than
 * assertions about the input.
 */
const WIN_ANSI_REVERSE = new Map<number, string>([
  [0x80, "€"],
  [0x91, "‘"],
  [0x92, "’"],
  [0x93, "“"],
  [0x94, "”"],
  [0x96, "–"],
  [0x97, "—"],
]);

/** Every drawn run, in page order. */
function pdfRuns(bytes: Buffer): string[] {
  const raw = bytes.toString("latin1");
  return [...raw.matchAll(/\((.*?)\) Tj/g)].map((match) =>
    match[1]!
      .replace(/\\([()\\])/g, "$1")
      .replace(/[-]/g, (c) => WIN_ANSI_REVERSE.get(c.charCodeAt(0)) ?? c),
  );
}

/** Every drawn run and its position, for overlap and alignment checks. */
function pdfPlaced(bytes: Buffer): { x: number; y: number; text: string }[] {
  const raw = bytes.toString("latin1");
  return [...raw.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm \((.*?)\) Tj/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    text: m[3]!.replace(/\\([()\\])/g, "$1"),
  }));
}

function pdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  return [...raw.matchAll(/\((.*?)\) Tj/g)]
    .map((match) =>
      match[1]!
        .replace(/\\([()\\])/g, "$1")
        // latin1 decoding leaves the 0x80–0x9F block as control codes; a reader
        // draws them through WinAnsi, so the helper does too.
        .replace(/[-]/g, (c) => WIN_ANSI_REVERSE.get(c.charCodeAt(0)) ?? c),
    )
    .join("\n");
}

/* ------------------------------------------------------------------------- *
 * IT IS A PDF
 * ------------------------------------------------------------------------- */

describe("the file is a valid PDF", () => {
  /** 1. A selected order produces a document. */
  it("has a PDF header, a catalog, an xref and a trailer", () => {
    const bytes = renderInvoicePdf(invoice());
    const raw = bytes.toString("latin1");

    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw).toContain("/Type /Catalog");
    expect(raw).toContain("/Type /Pages");
    expect(raw).toContain("/Type /Page ");
    expect(raw).toContain("/BaseFont /Helvetica");
    expect(raw).toContain("xref");
    expect(raw).toContain("trailer");
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  /**
   * The cross-reference offsets must be real byte positions, or readers reject
   * the file. Checking that each offset actually lands on `N 0 obj` is what
   * proves the writer is not merely producing plausible-looking bytes.
   */
  it("records cross-reference offsets that land on their objects", () => {
    const raw = renderInvoicePdf(invoice()).toString("latin1");
    // `lastIndexOf("xref")` would find the "xref" inside "startxref".
    const table = raw.slice(raw.lastIndexOf("\nxref\n"));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));

    expect(offsets.length).toBeGreaterThanOrEqual(6);
    offsets.forEach((offset, index) => {
      expect(raw.slice(offset, offset + 12)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });

    const startxref = Number(raw.slice(raw.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
    expect(raw.slice(startxref, startxref + 4)).toBe("xref");
  });

  it("names the file after the order number", () => {
    expect(invoiceFilename(invoice())).toBe("invoice-20-00000-00001.pdf");
    // A source value can never break out of the Content-Disposition header.
    expect(invoiceFilename(invoice({ orderNumber: 'a"; drop\\/x' }))).toBe("invoice-a---drop--x.pdf");
    // No number recorded: the row id labels it rather than an empty name.
    expect(invoiceFilename(invoice({ orderNumber: null }))).toBe("invoice-9000000001.pdf");
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT IS ON THE PAGE
 * ------------------------------------------------------------------------- */

describe("the document content", () => {
  it("prints the header fields from the resolved order", () => {
    const page = pdfText(renderInvoicePdf(invoice()));
    expect(page).toContain(INVOICE_TITLE);
    expect(page).toContain("20-00000-00001");
    expect(page).toContain("2026-09-01 09:14:22");
    expect(page).toContain("Completed");
    expect(page).toContain("GBP");
  });

  /**
   * 7. THE SKU SURVIVES WHOLE, EVEN WHEN IT WRAPS.
   *
   * A combo wider than its column continues on the next line, so the page no
   * longer holds it as one run. What must still hold is that the bytes are all
   * there, in order, with nothing inserted — which is what joining the runs
   * with no separator checks. A hyphenated wrap or a dropped character would
   * fail this.
   */
  it("prints a combo SKU as one unbroken sequence of characters", () => {
    const runs = pdfRuns(renderInvoicePdf(invoice()));
    expect(runs.join("")).toContain(COMBO_SKU);
    // No hyphen was invented at a line break.
    expect(runs.join("")).not.toContain("PSHYOS4BRBM-");
  });

  /** Whitespace inside an opaque SKU is not normalised away by wrapping. */
  it("preserves whitespace inside a SKU that has to wrap", () => {
    const spaced = "AAA111  BBB222  CCC333  DDD444  EEE555";
    const runs = pdfRuns(renderInvoicePdf(invoice({ lines: [line({ sku: spaced })] })));
    expect(runs.join("")).toContain(spaced);
  });

  it("prints every line of a multi-item order", () => {
    const lines = [
      line({ lineId: "1", sku: "AAA111", productTitle: "First" }),
      line({ lineId: "2", sku: "BBB222", productTitle: "Second" }),
      line({ lineId: "3", sku: "CCC333", productTitle: "Third" }),
    ];
    const page = pdfText(renderInvoicePdf(invoice({ lines, lineCount: 3 })));
    for (const value of ["AAA111", "BBB222", "CCC333", "First", "Second", "Third"]) {
      expect(page, value).toContain(value);
    }
  });

  it("prints the stored totals", () => {
    const page = pdfText(renderInvoicePdf(invoice()));
    for (const value of ["5.49", "2.89", "8.38", "CreditCard"]) {
      expect(page, value).toContain(value);
    }
  });

  /** Paging keeps every line rather than truncating a long order. */
  it("breaks a long order across pages without dropping a line", () => {
    const lines = Array.from({ length: 75 }, (_, index) =>
      line({ lineId: String(index), sku: `SKU${index}`, productTitle: `Item ${index}` }),
    );
    const bytes = renderInvoicePdf(invoice({ lines, lineCount: lines.length }));
    const page = pdfText(bytes);
    for (let index = 0; index < 75; index += 1) {
      expect(page, `SKU${index}`).toContain(`SKU${index}`);
    }
    expect(bytes.toString("latin1")).toContain("/Count 3");
  });

  /** German product titles are ordinary here; they must not be mangled. */
  it("renders Latin-1 accented text intact", () => {
    const page = pdfText(
      renderInvoicePdf(invoice({ lines: [line({ productTitle: "Lampenfassung Größe für Küche" })] })),
    );
    expect(page).toContain("Größe für Küche");
  });
});

/* ------------------------------------------------------------------------- *
 * THE ITEM TABLE
 * ------------------------------------------------------------------------- */

/** The column geometry the layout uses. Mirrors `invoice-document.ts`. */
const MARGIN = 56;
const COL_DESC_X = MARGIN + 136;
const COL_QTY_RIGHT = MARGIN + 396;

/**
 * The description cells only — the column header shares their x, and counting
 * it would make a wrapping assertion pass on a document that never wrapped.
 */
function descriptionRuns(bytes: Buffer) {
  return pdfPlaced(bytes).filter((run) => run.x === COL_DESC_X && run.text !== "Description");
}

const LONG_TITLE =
  "3 Core Lighting Fabric Cable Vintage Coloured Twisted Braided Wire Lamp Flex " +
  "for Pendant Ceiling Rose Chandelier Industrial Retro Antique Lighting [Army Green, 2m]";

describe("the item table", () => {
  /**
   * THE DEFECT THIS SECTION EXISTS FOR: a long description used to run straight
   * through the Qty and Unit price columns. Measured against the real font
   * metrics — the same ones the writer draws with — so this is what a reader
   * will actually show, not an approximation.
   */
  it("keeps a very long description inside its own column", () => {
    const bytes = renderInvoicePdf(invoice({ lines: [line({ productTitle: LONG_TITLE })] }));
    const placed = descriptionRuns(bytes);

    expect(placed.length).toBeGreaterThan(1); // it wrapped
    for (const run of placed) {
      const right = run.x + textWidth(run.text, 9.5, "regular");
      // Never reaches the quantity column's left edge.
      expect(right, run.text).toBeLessThan(COL_QTY_RIGHT - 20);
    }
  });

  /** Nothing is truncated to make it fit. */
  it("keeps every word of a long description", () => {
    const runs = pdfRuns(renderInvoicePdf(invoice({ lines: [line({ productTitle: LONG_TITLE })] })));
    const page = runs.join(" ");
    for (const word of ["Chandelier", "Industrial", "Antique", "Green,", "2m]"]) {
      expect(page, word).toContain(word);
    }
    expect(page).not.toContain("…");
    expect(page).not.toContain("...");
  });

  /** A short title stays on one line — wrapping must not fire needlessly. */
  it("leaves a short description on a single line", () => {
    const bytes = renderInvoicePdf(invoice({ lines: [line({ productTitle: "Brass ring" })] }));
    const placed = descriptionRuns(bytes);
    expect(placed.map((run) => run.text)).toEqual(["Brass ring"]);
  });

  /**
   * ROW HEIGHT FOLLOWS THE TALLEST CELL. Two long descriptions must not draw
   * on top of each other, which is what a fixed row height would do.
   */
  it("expands row height so wrapped rows never overlap", () => {
    const lines = [
      line({ lineId: "1", sku: "AAA111", productTitle: LONG_TITLE }),
      line({ lineId: "2", sku: "BBB222", productTitle: LONG_TITLE }),
      line({ lineId: "3", sku: "CCC333", productTitle: "Short one" }),
    ];
    const bytes = renderInvoicePdf(invoice({ lines, lineCount: 3 }));
    const placed = descriptionRuns(bytes);

    // PDF y grows upward, so each successive line sits lower — strictly.
    for (let index = 1; index < placed.length; index += 1) {
      expect(placed[index]!.y, placed[index]!.text).toBeLessThan(placed[index - 1]!.y);
    }
    // No two runs share a baseline in the description column.
    expect(new Set(placed.map((run) => run.y)).size).toBe(placed.length);
  });

  /** Qty and Unit price are right-aligned, so figures line up on their last digit. */
  it("right-aligns the quantity and unit price columns", () => {
    const lines = [
      line({ lineId: "1", quantity: "1", unitPrice: "5.49" }),
      line({ lineId: "2", quantity: "12", unitPrice: "129.00" }),
    ];
    const placed = pdfPlaced(renderInvoicePdf(invoice({ lines, lineCount: 2 })));

    for (const value of ["1", "12", "5.49", "129.00"]) {
      const run = placed.find((item) => item.text === value)!;
      const right = run.x + textWidth(value, 9.5, "regular");
      // Lands on one of the two right edges, within a rounding point.
      const edges = [COL_QTY_RIGHT, PAGE_WIDTH_RIGHT];
      expect(edges.some((edge) => Math.abs(right - edge) < 1), value).toBe(true);
    }
  });

  it("prints all four column headers", () => {
    const page = pdfText(renderInvoicePdf(invoice()));
    for (const header of ["SKU", "Description", "Qty", "Unit price"]) {
      expect(page, header).toContain(header);
    }
  });
});

/** A4 width less the right margin, matching the layout. */
const PAGE_WIDTH_RIGHT = 595.28 - MARGIN;

/* ------------------------------------------------------------------------- *
 * WHAT A CUSTOMER MUST NOT BE SHOWN
 * ------------------------------------------------------------------------- */

describe("internal warnings stay internal", () => {
  /**
   * These describe the state of OUR database. A customer can act on none of
   * them, and printing them advertises our data quality on their invoice. The
   * resolver still reports every one to the application — this is a
   * presentation rule, not a change to what is known.
   */
  it("prints no technical note about VAT, discounts or duplicated rows", () => {
    const page = pdfText(
      renderInvoicePdf(
        invoice({
          warnings: [
            "tax_amount_absent",
            "seller_vat_number_missing",
            "discount_not_reflected_in_total",
            "billing_address_missing",
            "billing_address_duplicated",
            "order_info_duplicated",
            "order_info_missing",
            "order_lines_missing",
            "order_number_missing",
            "order_not_completed",
          ],
        }),
      ),
    );

    for (const internal of [
      "VAT information is incomplete",
      "No seller VAT number recorded",
      "stored figures are shown unchanged",
      "the total equals the subtotal",
      "More than one billing address",
      "More than one payment record",
      "No payment record recorded",
      "No billing address recorded for this order",
      "is not marked Completed",
    ]) {
      expect(page, internal).not.toContain(internal);
    }
  });

  /** The two that ARE the customer's business still appear. */
  it("still prints the cancelled and refunded notes", () => {
    const page = pdfText(
      renderInvoicePdf(invoice({ warnings: ["order_cancelled", "tax_amount_absent"] })),
    );
    expect(page).toContain("This order was cancelled.");
    expect(page).not.toContain("VAT information is incomplete");
  });
});

/* ------------------------------------------------------------------------- *
 * TOTALS
 * ------------------------------------------------------------------------- */

describe("the totals block", () => {
  it("lists the four components above a ruled Total", () => {
    const page = pdfText(renderInvoicePdf(invoice()));
    for (const label of ["Subtotal", "Shipping", "Discount", "Tax", "Total"]) {
      expect(page, label).toContain(label);
    }
    expect(page.indexOf("Subtotal")).toBeLessThan(page.indexOf("Total\n"));
  });

  /** Right-aligned, so the decimal points stack. */
  it("right-aligns every amount on the same edge", () => {
    const placed = pdfPlaced(
      renderInvoicePdf(invoice({ subtotal: "5.49", shippingCost: "12.00", total: "117.49" })),
    );
    for (const value of ["5.49", "12.00", "117.49"]) {
      const run = placed.find((item) => item.text === value)!;
      const right = run.x + textWidth(value, 9.5, run.text === "117.49" ? "bold" : "regular");
      expect(Math.abs(right - PAGE_WIDTH_RIGHT), value).toBeLessThan(1);
    }
  });

  /** The currency is stated once rather than repeated against each figure. */
  it("states the currency once", () => {
    const page = pdfText(renderInvoicePdf(invoice()));
    expect(page).toContain("Amounts in GBP");
    expect(page.match(/GBP/g)).toHaveLength(1);
  });

  it("omits the currency line when the source recorded none", () => {
    const page = pdfText(renderInvoicePdf(invoice({ currency: null })));
    expect(page).not.toContain("Amounts in");
  });
});

/* ------------------------------------------------------------------------- *
 * NO VAT, EVER
 * ------------------------------------------------------------------------- */

describe("VAT", () => {
  /** 9. THE RULE. Nothing on the page was computed. */
  it("never says VAT Invoice and derives no tax figure", () => {
    const page = pdfText(renderInvoicePdf(invoice()));

    expect(page).not.toMatch(/VAT Invoice/i);
    expect(page).toContain(INVOICE_TITLE);
    // 8.38 under the usual invented rules would print one of these.
    for (const invented of ["1.39", "1.40", "6.98", "1.68", "20%"]) {
      expect(page, invented).not.toContain(invented);
    }
    expect(page).not.toMatch(/net amount|gross amount|vat rate/i);
  });

  /** 10. Missing VAT data must not break generation. */
  it("renders when no tax and no seller VAT number exist", () => {
    const bytes = renderInvoicePdf(
      invoice({
        tax: null,
        sellerVatNumberAvailable: false,
        vatAmountAvailable: false,
        warnings: ["seller_vat_number_missing", "tax_amount_absent"],
      }),
    );
    const page = pdfText(bytes);
    expect(bytes.length).toBeGreaterThan(0);
    expect(page).toContain("VAT Registration");
    expect(page).toContain(SELLER_VAT_UNAVAILABLE);
    // An absent tax prints as an absence, never as a zero.
    expect(page).toContain("—");
  });

  it("prints a stored tax verbatim when the source has one", () => {
    const page = pdfText(renderInvoicePdf(invoice({ tax: "2.94", vatAmountAvailable: true })));
    expect(page).toContain("2.94");
  });
});

/* ------------------------------------------------------------------------- *
 * STATUS AND MISSING DATA
 * ------------------------------------------------------------------------- */

describe("status and incomplete data are stated", () => {
  /** 11. A cancelled order says so — this one IS the customer's business. */
  it("shows a cancelled order's status and note", () => {
    const page = pdfText(
      renderInvoicePdf(invoice({ orderStatus: "Cancelled", warnings: ["order_cancelled"] })),
    );
    expect(page).toContain("Cancelled");
    expect(page).toContain("This order was cancelled.");
  });

  /** 12. */
  it("shows a refunded order's status and says the amounts are the originals", () => {
    const page = pdfText(
      renderInvoicePdf(invoice({ orderStatus: "Refunded", warnings: ["order_refunded"] })),
    );
    expect(page).toContain("Refunded");
    expect(page).toContain("This order was refunded.");
    expect(page).toContain("original order values");
  });

  /** 13. */
  it("renders safely with no billing information", () => {
    const bytes = renderInvoicePdf(
      invoice({
        billingPartyPresent: false,
        billingCompanyPresent: false,
        invoiceEmailOnFile: false,
        invoiceDataAvailable: false,
        warnings: ["billing_address_missing"],
      }),
    );
    const page = pdfText(bytes);
    expect(bytes.length).toBeGreaterThan(0);
    expect(page).toContain("BILL TO");
    expect(page).toContain(BILLING_UNAVAILABLE);
  });

  it("renders safely with no order lines", () => {
    const bytes = renderInvoicePdf(
      invoice({ lines: [], lineCount: 0, warnings: ["order_lines_missing"] }),
    );
    expect(bytes.length).toBeGreaterThan(0);
    expect(pdfText(bytes)).toContain("No order lines recorded");
  });

  it("prints an absence marker rather than inventing a value", () => {
    const page = pdfText(
      renderInvoicePdf(
        invoice({
          orderDate: null,
          currency: null,
          total: null,
          lines: [line({ sku: null, unitPrice: null, quantity: null })],
        }),
      ),
    );
    expect(page).toContain("—");
    expect(page).not.toContain("null");
    expect(page).not.toContain("undefined");
  });
});

/* ------------------------------------------------------------------------- *
 * PRIVACY
 * ------------------------------------------------------------------------- */

describe("customer identity is not on the page", () => {
  /**
   * The resolver carries the billing party as booleans and never selects the
   * name, street, phone or email, so there is nothing for this document to
   * print. It states that plainly rather than leaving an empty address block
   * that looks like a rendering bug.
   */
  it("heads a BILL TO block and prints no party in it", () => {
    const page = pdfText(renderInvoicePdf(invoice()));
    expect(page).toContain("BILL TO");
    expect(page).toContain(BILLING_UNAVAILABLE);
    // The old internal phrasing is gone from the customer's page.
    expect(page).not.toContain("Billing name and address are not included");
    expect(page).not.toContain("Billing party on file");
    expect(page).not.toContain("Invoice email on file");
  });

  it("reads no database and imports no client", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/documents/invoice-document.ts", "utf8"),
    );
    for (const forbidden of ["getSourcePool", "getAppPool", "repositories/", "pg", "query("]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
