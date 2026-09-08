import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeAllPools, getSourcePool } from "@/lib/db/pools";
import { invoiceFilename, renderInvoicePdf } from "@/lib/documents/invoice-document";
import { findOrderInvoiceContext } from "@/lib/repositories/order-invoice-repository";

/**
 * Live invoice-context check. Opt-in, read-only, presence and counts only.
 *
 * Run:
 *   CST_INVOICE_LIVE=1 npx vitest run tests/source-validation/order-invoice-live-source.test.ts
 *
 * Skipped in the normal suite and never runs unattended, exactly as
 * `ebay-live-source.test.ts` and `category-live-sample.test.ts` are.
 *
 * SAME DISCIPLINE AS THE OTHER LIVE TESTS. Every statement is a SELECT, the
 * pool pins `default_transaction_read_only=on`, and nothing printed here can
 * identify a person: the repository returns the billing party only as a
 * boolean, and this file asserts on row ids, order numbers, statuses, counts
 * and flags. No name, address, email or phone number is read or logged.
 *
 * THE ROW IDS ARE SUPPLIED, NEVER COMMITTED. A source row id identifies one
 * real customer's order, so no default list is baked in here: the operator
 * passes `CST_INVOICE_ROW_IDS` for the run and the file holds none. Without it
 * the suite skips, which is the correct behaviour for a check that has nothing
 * to check. `tests/guards/no-customer-data.test.ts` exists because fixtures
 * drift towards real identifiers, and this is the same discipline applied to a
 * value that guard's patterns would not catch.
 */

const ENABLED = process.env.CST_INVOICE_LIVE === "1";

/**
 * Where to write a rendered PDF, if the operator wants one to open.
 *
 * Off unless set, and a gitignored directory when it is. A rendered invoice
 * carries a real order number, SKUs and prices, so it is an artefact to look at
 * and delete — never something to commit. Mirrors `CST_CATEGORY_OUT` in
 * `category-live-sample.test.ts`.
 */
const PDF_OUT = process.env.CST_INVOICE_PDF_OUT ?? "";

const ROW_IDS = (process.env.CST_INVOICE_ROW_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value !== "");

afterAll(async () => {
  if (ENABLED) await closeAllPools();
});

describe.skipIf(!ENABLED || ROW_IDS.length === 0)("live invoice context for traced orders", () => {
  it("resolves every traced order from its row id alone", async () => {
    const pool = getSourcePool();
    const summary: Record<string, unknown>[] = [];

    for (const rowId of ROW_IDS) {
      const invoice = await findOrderInvoiceContext(pool, rowId);
      expect(invoice, rowId).not.toBeNull();

      // Only safe fields. No billing party, no email, no address.
      summary.push({
        orderRowId: invoice!.sourceOrderRowId,
        orderNumber: invoice!.orderNumber,
        status: invoice!.orderStatus,
        currency: invoice!.currency,
        lineCount: invoice!.lineCount,
        billingPartyPresent: invoice!.billingPartyPresent,
        billingCompanyPresent: invoice!.billingCompanyPresent,
        invoiceEmailOnFile: invoice!.invoiceEmailOnFile,
        sellerVatNumberAvailable: invoice!.sellerVatNumberAvailable,
        vatAmountAvailable: invoice!.vatAmountAvailable,
        invoiceDataAvailable: invoice!.invoiceDataAvailable,
        vatDocumentDataComplete: invoice!.vatDocumentDataComplete,
        warnings: invoice!.warnings,
      });

      expect(invoice!.sourceOrderRowId).toBe(rowId);
      // Every SKU the source holds arrives whole.
      for (const line of invoice!.lines) {
        if (line.sku !== null) expect(line.sku.length).toBeGreaterThan(0);
      }

      /*
       * The document, rendered from exactly this context. Proves the whole
       * chain end to end on real data — row id, resolver, renderer, bytes —
       * and gives a human a file to open rather than a passing assertion.
       */
      const pdf = renderInvoicePdf(invoice!);
      expect(pdf.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
      expect(pdf.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
      if (PDF_OUT !== "") {
        writeFileSync(join(PDF_OUT, invoiceFilename(invoice!)), pdf);
      }
    }

    console.log(JSON.stringify(summary, null, 2));
    expect(summary).toHaveLength(ROW_IDS.length);
  });

  /** The order number must remain unusable as a key against the live source. */
  it("refuses the live order number as a lookup key", async () => {
    const pool = getSourcePool();
    const invoice = await findOrderInvoiceContext(pool, ROW_IDS[0]!);
    const orderNumber = invoice!.orderNumber!;
    expect(orderNumber).toMatch(/-/);
    expect(await findOrderInvoiceContext(pool, orderNumber)).toBeNull();
  });
});
