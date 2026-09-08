import { describe, expect, it } from "vitest";

import {
  type Queryable,
  findOrderInvoiceContext,
} from "@/lib/repositories/order-invoice-repository";

/**
 * The invoice for one ALREADY-RESOLVED order.
 *
 * Three properties carry this file. The lookup key is the stable row id and an
 * order number cannot stand in for it. A missing or abnormal condition is
 * reported rather than repaired or hidden. And no tax figure is ever produced
 * that the source did not store.
 *
 * Synthetic fixtures throughout; nothing real is named. The combo SKU is the
 * shape a fifth of live order lines carry.
 */

type Call = { text: string; values?: unknown[] };

const ORDER_ROW_ID = "9000000001";
/** Synthetic, and verified against `order_management.orders` to match no live row. */
const ORDER_NUMBER = "20-00000-00001";
const COMBO_SKU = "PSHYOS4BRBM+SPUPBM+SLDO210BM";

/** Header first, lines second — the order the repository issues them in. */
function fake(headerRows: unknown[], lineRows: unknown[] = []) {
  const calls: Call[] = [];
  let issued = 0;
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      issued += 1;
      return { rows: issued === 1 ? headerRows : lineRows };
    },
  };
  return { calls, client };
}

function header(overrides: Record<string, unknown> = {}) {
  return {
    source_order_row_id: ORDER_ROW_ID,
    order_number: ORDER_NUMBER,
    order_date: "2026-09-01 09:14:22",
    order_status: "Completed",
    subtotal: "5.49",
    shipping_cost: "2.89",
    tax: "0.00",
    discount: "0.00",
    total: "8.38",
    vat_amount_available: false,
    discount_not_reflected: false,
    seller_vat_number: "GB000000000",
    order_info_row_count: 1,
    currency: "GBP",
    amount_paid: "8.38",
    paid_time: "2026-09-01 09:15:03",
    payment_method: "PayPal",
    billing_row_count: 1,
    billing_party_present: true,
    billing_company_present: false,
    invoice_email_present: true,
    ...overrides,
  };
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    line_id: "9000001",
    line_item_ref: "1234567890-0",
    item_ref: "162975561793",
    real_sku: null,
    item_sku: COMBO_SKU,
    product_title: "Ceiling Rose Strap Bracket Plate",
    real_price: null,
    item_price: "5.49",
    real_qty: null,
    item_quantity: "1",
    ...overrides,
  };
}

/* ------------------------------------------------------------------------- *
 * THE KEY
 * ------------------------------------------------------------------------- */

describe("it is keyed on orders.id and nothing else", () => {
  /** 1. The stable row id is the parameter, in both statements. */
  it("passes the exact orderRowId as the only bound value", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.values).toEqual([ORDER_ROW_ID]);
      expect(call.text).toContain("$1");
      // Parameterised, never interpolated.
      expect(call.text).not.toContain(ORDER_ROW_ID);
    }
    expect(calls[0]!.text).toMatch(/WHERE\s+o\.id\s*=\s*\$1::bigint/);
    expect(calls[1]!.text).toMatch(/WHERE\s+oii\.order_id\s*=\s*\$1::bigint/);
  });

  /**
   * 2. THE SAFETY PROPERTY. `orders.order_id` is reused by 655 numbers across
   * 1,608 rows, so resolving an invoice from one could return a different
   * customer's order. The shape guard makes that impossible before any query
   * is built.
   */
  it("refuses a marketplace order number as the lookup key", async () => {
    const { calls, client } = fake([header()], [line()]);
    expect(await findOrderInvoiceContext(client, ORDER_NUMBER)).toBeNull();
    // Not merely a null result — no statement was issued at all.
    expect(calls).toHaveLength(0);
  });

  it.each([["", "empty"], [" 9000000001 ", "padded"], ["-1", "signed"], ["1e6", "exponent"], ["12.0", "decimal"]])(
    "refuses %s (%s) as a row id",
    async (candidate) => {
      const { calls, client } = fake([header()], [line()]);
      expect(await findOrderInvoiceContext(client, candidate)).toBeNull();
      expect(calls).toHaveLength(0);
    },
  );

  /** The header row id is a primary key: anything but one row is not an order. */
  it("returns nothing when the order does not exist", async () => {
    const { client } = fake([], []);
    expect(await findOrderInvoiceContext(client, ORDER_ROW_ID)).toBeNull();
  });

  /** It never picks. Two header rows is a refusal, not a shortlist. */
  it("returns nothing rather than choosing between two header rows", async () => {
    const { client } = fake([header(), header()], [line()]);
    expect(await findOrderInvoiceContext(client, ORDER_ROW_ID)).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * A NORMAL ORDER
 * ------------------------------------------------------------------------- */

describe("a completed order returns deterministic invoice context", () => {
  /** 3. The whole point. */
  it("returns the stored header verbatim", async () => {
    const { client } = fake([header()], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;

    expect(invoice.sourceOrderRowId).toBe(ORDER_ROW_ID);
    expect(invoice.orderNumber).toBe(ORDER_NUMBER);
    expect(invoice.orderDate).toBe("2026-09-01 09:14:22");
    expect(invoice.orderStatus).toBe("Completed");
    expect(invoice.currency).toBe("GBP");
    expect(invoice.subtotal).toBe("5.49");
    expect(invoice.shippingCost).toBe("2.89");
    expect(invoice.discount).toBe("0.00");
    expect(invoice.total).toBe("8.38");
    expect(invoice.amountPaid).toBe("8.38");
    expect(invoice.paidTime).toBe("2026-09-01 09:15:03");
    expect(invoice.paymentMethod).toBe("PayPal");
    expect(invoice.invoiceDataAvailable).toBe(true);
  });

  /** 16. Presence only — the address itself must not cross the boundary. */
  it("reports the billing party and invoice email as presence, never content", async () => {
    const { calls, client } = fake([header({ billing_company_present: true })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;

    expect(invoice.billingPartyPresent).toBe(true);
    expect(invoice.billingCompanyPresent).toBe(true);
    expect(invoice.invoiceEmailOnFile).toBe(true);

    // No such field exists to hold a value, and the SQL never selects one.
    expect(invoice).not.toHaveProperty("invoiceEmail");
    expect(invoice).not.toHaveProperty("billingName");
    expect(invoice).not.toHaveProperty("billingAddress");
    const sql = calls[0]!.text;
    for (const forbidden of ["address_line_2", "address_line_3", "postcode", "phone", "city"]) {
      expect(sql, forbidden).not.toContain(forbidden);
    }
    // The email column is tested for emptiness and never selected as a value.
    expect(sql).toContain("bool_or(coalesce(c.email_invoice, '') <> '')");
    expect(sql).not.toMatch(/AS\s+invoice_email\b/);
  });

  it("issues SELECT statements only", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);
    for (const call of calls) {
      expect(call.text.trim().startsWith("SELECT")).toBe(true);
      expect(call.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * LINES AND SKUs
 * ------------------------------------------------------------------------- */

describe("order lines", () => {
  /** 4. Every line, not a chosen one. */
  it("returns all lines of a multi-item order", async () => {
    const rows = [
      line({ line_id: "1", item_sku: "AAA111" }),
      line({ line_id: "2", item_sku: "BBB222" }),
      line({ line_id: "3", item_sku: "CCC333" }),
    ];
    const { client } = fake([header()], rows);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;

    expect(invoice.lineCount).toBe(3);
    expect(invoice.lines.map((l) => l.sku)).toEqual(["AAA111", "BBB222", "CCC333"]);
  });

  /**
   * 5, 6. THE COMBO SKU IS ONE SKU. Byte for byte, and never a component of it.
   */
  it("keeps the SKU exactly as stored and never splits a combo", async () => {
    const { client } = fake([header()], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;

    expect(invoice.lines[0]!.sku).toBe(COMBO_SKU);
    // Not a component, not a normalised form, not a trimmed one.
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]!.sku).not.toBe("PSHYOS4BRBM");
  });

  it("preserves a SKU whose stored value has surrounding whitespace", async () => {
    const padded = "  CBSF100  ";
    const { client } = fake([header()], [line({ item_sku: padded })]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.lines[0]!.sku).toBe(padded);
  });

  it("prefers the corrected SKU, price and quantity where the source recorded one", async () => {
    const { client } = fake(
      [header()],
      [line({ real_sku: "CORRECTED+SKU", real_price: "6.99", real_qty: "2" })],
    );
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.lines[0]!.sku).toBe("CORRECTED+SKU");
    expect(invoice.lines[0]!.unitPrice).toBe("6.99");
    expect(invoice.lines[0]!.quantity).toBe("2");
  });

  /** A recorded blank is not a correction — the original still wins. */
  it("falls back to the original when the corrected column is blank", async () => {
    const { client } = fake([header()], [line({ real_sku: "   ", real_price: "" })]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.lines[0]!.sku).toBe(COMBO_SKU);
    expect(invoice.lines[0]!.unitPrice).toBe("5.49");
  });

  /** Price and quantity are source text. Nothing multiplies or totals them. */
  it("relays price and quantity as stored text without arithmetic", async () => {
    const { client } = fake([header()], [line({ item_price: "5.49", item_quantity: "3" })]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.lines[0]!.unitPrice).toBe("5.49");
    expect(invoice.lines[0]!.quantity).toBe("3");
    expect(invoice.lines[0]).not.toHaveProperty("lineTotal");
    expect(typeof invoice.lines[0]!.unitPrice).toBe("string");
  });

  /**
   * Reading order within one invoice is not a ranking between orders. All lines
   * are returned, so the clause cannot cause anything to be preferred.
   */
  it("orders lines only by their own id", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);
    expect(calls[1]!.text).toContain("ORDER BY oii.id");
    expect(calls[1]!.text).not.toMatch(/\bDESC\b/i);
    expect(calls[1]!.text).not.toMatch(/\bLIMIT\b/i);
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT IS MISSING IS SAID, NOT HIDDEN
 * ------------------------------------------------------------------------- */

describe("incomplete and abnormal source data", () => {
  /** 7. Measured: 109 orders of 1.13M have no billing row. */
  it("reports a missing billing address", async () => {
    const { client } = fake(
      [header({ billing_row_count: 0, billing_party_present: null, billing_company_present: null })],
      [line()],
    );
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.warnings).toContain("billing_address_missing");
    expect(invoice.billingPartyPresent).toBe(false);
    expect(invoice.invoiceDataAvailable).toBe(false);
  });

  /**
   * 8. TWO PARTIES IS NOT A CHOICE. The database nulls the party columns under
   * `count(*) <> 1`, so nothing further up can pick one, and the count says why.
   */
  it("reports duplicated billing rows instead of picking one", async () => {
    const { client } = fake(
      [header({ billing_row_count: 2, billing_party_present: null, billing_company_present: null })],
      [line()],
    );
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.warnings).toContain("billing_address_duplicated");
    expect(invoice.billingPartyPresent).toBe(false);
    expect(invoice.invoiceDataAvailable).toBe(false);
  });

  /** 9. */
  it("reports a missing order_info without losing the rest", async () => {
    const { client } = fake(
      [
        header({
          order_info_row_count: 0,
          currency: null,
          amount_paid: null,
          paid_time: null,
          payment_method: null,
        }),
      ],
      [line()],
    );
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.warnings).toContain("order_info_missing");
    expect(invoice.currency).toBeNull();
    expect(invoice.amountPaid).toBeNull();
    // The order is still describable.
    expect(invoice.orderNumber).toBe(ORDER_NUMBER);
    expect(invoice.total).toBe("8.38");
  });

  it("reports duplicated order_info rather than picking a currency", async () => {
    const { client } = fake([header({ order_info_row_count: 2, currency: null })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.warnings).toContain("order_info_duplicated");
    expect(invoice.currency).toBeNull();
  });

  /** 10. Measured: 7,049 orders have no line items. */
  it("reports missing order lines", async () => {
    const { client } = fake([header()], []);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.warnings).toContain("order_lines_missing");
    expect(invoice.lineCount).toBe(0);
    expect(invoice.lines).toEqual([]);
    expect(invoice.invoiceDataAvailable).toBe(false);
  });

  it("reports an order the source never gave a number", async () => {
    const { client } = fake([header({ order_number: "  " })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.warnings).toContain("order_number_missing");
    expect(invoice.orderNumber).toBeNull();
    expect(invoice.invoiceDataAvailable).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * STATUS SURVIVES
 * ------------------------------------------------------------------------- */

describe("order status is preserved, never softened", () => {
  /** 11. A real case in the traced sample. */
  it("keeps a cancelled order visible as cancelled", async () => {
    const { client } = fake([header({ order_status: "Cancelled" })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.orderStatus).toBe("Cancelled");
    expect(invoice.warnings).toContain("order_cancelled");
    // Status does NOT hide the data — the caller decides what to do with it.
    expect(invoice.invoiceDataAvailable).toBe(true);
  });

  /** 12. The stored totals do not reflect the refund, so this must be seen. */
  it("keeps a refunded order visible as refunded", async () => {
    const { client } = fake([header({ order_status: "Refunded" })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.orderStatus).toBe("Refunded");
    expect(invoice.warnings).toContain("order_refunded");
  });

  it.each([
    ["Deleted", "order_deleted"],
    ["Hold", "order_not_completed"],
    ["Pending", "order_not_completed"],
    ["Inprogress", "order_not_completed"],
    ["New", "order_not_completed"],
  ])("reports %s as %s", async (status, warning) => {
    const { client } = fake([header({ order_status: status })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.warnings).toContain(warning);
    expect(invoice.orderStatus).toBe(status);
  });

  it("raises no status warning for a completed order", async () => {
    const { client } = fake([header()], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    for (const status of ["order_cancelled", "order_refunded", "order_deleted", "order_not_completed"]) {
      expect(invoice.warnings, status).not.toContain(status);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * VAT IS REPORTED, NEVER DERIVED
 * ------------------------------------------------------------------------- */

describe("VAT", () => {
  /**
   * 13. THE RULE THIS FILE EXISTS TO PROTECT. Every GBP order in the traced
   * sample stores `tax = 0.00`, and 76.3% of all orders store no tax above
   * zero. A derived figure would look authoritative and be invented.
   */
  it("does not derive a tax figure when the source stored zero", async () => {
    const { client } = fake([header({ tax: "0.00", vat_amount_available: false })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;

    expect(invoice.tax).toBe("0.00");
    expect(invoice.vatAmountAvailable).toBe(false);
    expect(invoice.warnings).toContain("tax_amount_absent");
    expect(invoice.vatDocumentDataComplete).toBe(false);

    // Nothing resembling a computed VAT figure exists on the result.
    expect(invoice).not.toHaveProperty("vatAmount");
    expect(invoice).not.toHaveProperty("netAmount");
    expect(invoice).not.toHaveProperty("grossAmount");
    expect(invoice).not.toHaveProperty("vatRate");
    // 8.38 with any of the usual invented rules applied would appear here.
    expect(JSON.stringify(invoice)).not.toContain("1.39");
  });

  it("reports a stored tax amount verbatim when the source has one", async () => {
    const { client } = fake([header({ tax: "2.94", vat_amount_available: true })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.tax).toBe("2.94");
    expect(invoice.vatAmountAvailable).toBe(true);
    expect(invoice.warnings).not.toContain("tax_amount_absent");
  });

  /** 14. Measured: 21 of 22 eBay storefronts have no VAT number. */
  it("reports a missing seller VAT number", async () => {
    const { client } = fake(
      [header({ seller_vat_number: null, tax: "2.94", vat_amount_available: true })],
      [line()],
    );
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.sellerVatNumberAvailable).toBe(false);
    expect(invoice.warnings).toContain("seller_vat_number_missing");
    expect(invoice.vatDocumentDataComplete).toBe(false);
  });

  /**
   * The two questions are separate. Data can be complete for an invoice while
   * being incomplete for a VAT document, which is the common case.
   */
  it("separates invoice data availability from VAT document completeness", async () => {
    const { client } = fake([header({ seller_vat_number: null })], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.invoiceDataAvailable).toBe(true);
    expect(invoice.vatDocumentDataComplete).toBe(false);
  });

  it("reports VAT document data as complete only when both fields exist", async () => {
    const { client } = fake(
      [header({ seller_vat_number: "GB000000000", tax: "2.94", vat_amount_available: true })],
      [line()],
    );
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    expect(invoice.vatDocumentDataComplete).toBe(true);
  });

  /** No VAT arithmetic exists in the SQL either. */
  it("computes no tax in the query", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);
    const sql = calls.map((c) => c.text).join("\n");
    expect(sql).not.toMatch(/tax\s*[*/+]/i);
    expect(sql).not.toMatch(/\/\s*6\b|\*\s*0\.2\b|1\.2\b/);
  });
});

/* ------------------------------------------------------------------------- *
 * MONEY IS NOT REPAIRED
 * ------------------------------------------------------------------------- */

describe("monetary values", () => {
  /**
   * 15. A REAL ORDER LOOKS LIKE THIS: sub_total 168.40, discount 18.72, total
   * 168.40. The discount is reflected nowhere. The values are reported exactly
   * as stored and the observation is flagged — no formula is assumed, because
   * the source does not obey one.
   */
  it("returns inconsistent totals unmodified and flags the observation", async () => {
    const { client } = fake(
      [
        header({
          subtotal: "168.40",
          discount: "18.72",
          total: "168.40",
          shipping_cost: "0.00",
          discount_not_reflected: true,
        }),
      ],
      [line()],
    );
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;

    expect(invoice.subtotal).toBe("168.40");
    expect(invoice.discount).toBe("18.72");
    expect(invoice.total).toBe("168.40");
    expect(invoice.warnings).toContain("discount_not_reflected_in_total");
  });

  /** Money stays as source text, so no float artefact can reach a document. */
  it("carries every monetary field as a string", async () => {
    const { client } = fake([header()], [line()]);
    const invoice = (await findOrderInvoiceContext(client, ORDER_ROW_ID))!;
    for (const value of [
      invoice.subtotal,
      invoice.shippingCost,
      invoice.tax,
      invoice.discount,
      invoice.total,
      invoice.amountPaid,
    ]) {
      expect(typeof value).toBe("string");
    }
    // A trailing-zero scale the source stored survives intact.
    expect(invoice.tax).toBe("0.00");
  });

  it("selects money as text rather than as a number", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);
    for (const column of ["o.sub_total::text", "o.tax::text", "o.total::text", "o.discount::text"]) {
      expect(calls[0]!.text, column).toContain(column);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT IT MUST NEVER TOUCH
 * ------------------------------------------------------------------------- */

describe("forbidden sources", () => {
  /**
   * 17. `shipment.invoice` is a DHL export document path on 93 of 1,144,513
   * shipments, and was absent from all 14 real invoice-request orders. It is
   * not the customer invoice and this resolver must not reach for it.
   */
  it("never reads order_management.shipment", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);
    const sql = calls.map((c) => c.text).join("\n");

    expect(sql).not.toContain("order_management.shipment");
    expect(sql).not.toMatch(/\bshipment\b/i);
    expect(sql).not.toMatch(/\blabel_path\b/);
    expect(sql).not.toMatch(/\bcarrier_service\b/);
    expect(sql).not.toMatch(/\btracking_number\b/);
  });

  /**
   * It cannot choose an order because it is never shown more than one. No
   * buyer, listing or storefront predicate exists to widen it later by accident.
   */
  it("has no buyer, listing or storefront predicate", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);
    const sql = calls.map((c) => c.text).join("\n");

    expect(sql).not.toContain("ebay_buyer_id");
    expect(sql).not.toContain("sub_source_id = $");
    expect(sql).not.toContain("source_id = $");
    expect(sql).not.toMatch(/oii\.item_id\s*=/);
    // No ranking or truncation over orders.
    expect(calls[0]!.text).not.toMatch(/\bORDER BY\b/i);
    expect(calls[0]!.text).not.toMatch(/\bLIMIT\b/i);
  });

  /** 18. Read-only, asserted on the statements themselves. */
  it("contains no write statement anywhere", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);
    const sql = calls.map((c) => c.text).join("\n");
    for (const verb of ["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CREATE", "ALTER", "DROP", "GRANT"]) {
      expect(sql, verb).not.toMatch(new RegExp(`\\b${verb}\\b`, "i"));
    }
  });

  /** Only the six proven tables. A seventh would be an unreviewed relationship. */
  it("reads only the tables discovery proved", async () => {
    const { calls, client } = fake([header()], [line()]);
    await findOrderInvoiceContext(client, ORDER_ROW_ID);
    const sql = calls.map((c) => c.text).join("\n");

    for (const table of [
      "order_management.orders",
      "order_management.sub_source",
      "order_management.order_info",
      "order_management.order_item_info",
      "customers.billing_address",
      "customers.customer_info",
    ]) {
      expect(sql, table).toContain(table);
    }
    const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+\.[a-z_]+)/g)].map((m) => m[1]);
    expect([...new Set(tables)].sort()).toEqual([
      "customers.billing_address",
      "customers.customer_info",
      "order_management.order_info",
      "order_management.order_item_info",
      "order_management.orders",
      "order_management.sub_source",
    ]);
  });
});
