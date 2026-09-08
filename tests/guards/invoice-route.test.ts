import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Standing guards on the invoice endpoint, asserted against the source itself.
 *
 * These are the properties a runtime test cannot prove absent: that the route
 * accepts no order id, writes nothing, stores nothing, logs no customer data,
 * and never reaches for `shipment.invoice`. A behavioural test shows what the
 * code does on the paths it exercises; these show what it cannot do on any.
 */

const ROUTE = readFileSync(
  "app/api/conversations/[conversationId]/invoice/route.ts",
  "utf8",
);
const RESOLVER = readFileSync("lib/context/resolve-invoice-order.ts", "utf8");
const DOCUMENT = readFileSync("lib/documents/invoice-document.ts", "utf8");
const PDF = readFileSync("lib/documents/pdf.ts", "utf8");
const ALL = [ROUTE, RESOLVER, DOCUMENT, PDF].join("\n");

/* ------------------------------------------------------------------------- *
 * THE CALLER CANNOT NAME AN ORDER
 * ------------------------------------------------------------------------- */

describe("the endpoint accepts no order identifier", () => {
  /**
   * 3. THE ENUMERATION GUARD. `order_management.orders` is keyed by a dense
   * integer over 1.1M rows, so a route that read an order id from the request
   * would expose every customer's invoice.
   */
  it("reads only the conversation id and the selection from the request", () => {
    const params = [...ROUTE.matchAll(/searchParams\.get\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(params).toEqual(["selectedOrder"]);

    for (const forbidden of ["orderRowId\"", "orderId\"", "order_row_id\"", "orders.id\""]) {
      expect(ROUTE, forbidden).not.toContain(`get("${forbidden}`);
    }
    // The row id is produced by the resolver, never parsed from input.
    expect(ROUTE).toContain("resolveInvoiceOrderRowId");
    expect(ROUTE).toMatch(/const orderRowId = await resolveInvoiceOrderRowId/);
  });

  /** No single resolved order is a refusal with no document. */
  it("returns no PDF when the resolver names no order", () => {
    const guard = ROUTE.slice(ROUTE.indexOf("if (orderRowId === null)"));
    expect(guard.slice(0, 200)).toContain("status: 409");
    // Against the CALL SITE, not `renderInvoicePdf` anywhere — its first
    // occurrence is the import at the top of the file.
    expect(ROUTE.indexOf("if (orderRowId === null)")).toBeLessThan(
      ROUTE.indexOf("renderInvoicePdf(invoice)"),
    );
  });

  /** The selection is filtered against a fetched set, never bound into a lookup. */
  it("never binds the selected order number into a query", () => {
    expect(RESOLVER).toContain("eligible.filter");
    expect(RESOLVER).toContain("candidates.filter");
    expect(RESOLVER).not.toMatch(/values:\s*\[[^\]]*chosen/);
    expect(RESOLVER).not.toMatch(/order_id\s*=\s*\$/);
  });
});

/* ------------------------------------------------------------------------- *
 * FORBIDDEN SOURCES AND SIDE EFFECTS
 * ------------------------------------------------------------------------- */

describe("what the invoice path must never do", () => {
  /** 8. `shipment.invoice` is a DHL export document, not the customer invoice. */
  it("never mentions shipment.invoice", () => {
    for (const forbidden of ["order_management.shipment", "shipment.invoice", "label_path"]) {
      expect(ALL, forbidden).not.toContain(forbidden);
    }
  });

  /**
   * 15. Read-only. No write verb exists on any file in this path.
   *
   * Case-SENSITIVE and bounded at both ends, deliberately: a case-insensitive
   * `\bCREATE` matches the word "created" in a comment, which makes the guard
   * fire on prose instead of on SQL and trains people to weaken it.
   */
  it("contains no write statement", () => {
    for (const verb of ["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CREATE", "ALTER", "DROP"]) {
      expect(ALL, verb).not.toMatch(new RegExp(`\\b${verb}\\b`));
    }
  });

  /** Nothing is persisted: no disk, no record, no URL. */
  it("writes no file and mints no URL", () => {
    for (const forbidden of [
      "writeFile",
      "createWriteStream",
      "node:fs",
      "mkdir",
      "S3",
      "putObject",
      "createObjectURL",
      "tmpdir",
    ]) {
      expect(ALL, forbidden).not.toContain(forbidden);
    }
  });

  /** No marketplace call, no mail, no AI, no scheduled trigger. */
  it("calls no external service and runs on no schedule", () => {
    for (const forbidden of ["fetch(", "sendMail", "nodemailer", "openai", "OpenAI", "gemini", "cron"]) {
      expect(ALL, forbidden).not.toContain(forbidden);
    }
    // On demand only: a GET handler, and nothing else is exported.
    const handlers = [...ROUTE.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(handlers).toEqual(["GET"]);
  });

  /** No VAT arithmetic anywhere on the path. */
  it("computes no tax", () => {
    expect(ALL).not.toMatch(/\/\s*6\b|\*\s*0\.2\b|\*\s*1\.2\b|0\.16666/);
    expect(DOCUMENT).not.toMatch(/parseFloat|Number\(\s*invoice\./);

    /*
     * "VAT Invoice" must not be in anything the document can PRINT. Checked
     * against the file's string literals rather than the whole file, because
     * the module doc explains at length why the phrase is banned — and a guard
     * that its own rationale trips is a guard people delete.
     */
    const code = DOCUMENT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const literals = [...code.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((m) => m[1]!);
    expect(literals.length).toBeGreaterThan(10);
    // The heading itself is still there to be found, so the extractor is live.
    expect(literals).toContain("INVOICE");
    for (const literal of literals) {
      expect(literal, literal).not.toMatch(/VAT Invoice/i);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * LOGGING AND RESPONSE HYGIENE
 * ------------------------------------------------------------------------- */

describe("no customer data leaves through a log or an error", () => {
  /** 14. A log is a place customer data must not accumulate. */
  it("logs no order, billing or money value", () => {
    const logs = [...ROUTE.matchAll(/console\.(?:log|info|warn|error)\(([^;]*)\)/g)].map(
      (m) => m[1]!,
    );
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      for (const forbidden of [
        "orderNumber",
        "orderRowId",
        "selectedOrder",
        "invoice.",
        "total",
        "sku",
        "billing",
        "email",
      ]) {
        expect(log, forbidden).not.toContain(forbidden);
      }
    }
    // The resolver and the renderer log nothing at all.
    expect(RESOLVER).not.toContain("console.");
    expect(DOCUMENT).not.toContain("console.");
  });

  /** The caught error itself is never returned; it may name a host or schema. */
  it("returns a generic message on failure", () => {
    expect(ROUTE).toContain('{ error: "Unable to generate invoice" }');
    expect(ROUTE).not.toMatch(/error:\s*(?:String\()?cause/);
  });

  /** A live-data document must not be cached by a proxy or the browser's disk. */
  it("marks the response uncacheable and does not attach it as a stored file", () => {
    expect(ROUTE).toContain('"Cache-Control": "no-store, private"');
    expect(ROUTE).toContain('"Content-Type": "application/pdf"');
    expect(ROUTE).toContain("inline; filename=");
  });
});
