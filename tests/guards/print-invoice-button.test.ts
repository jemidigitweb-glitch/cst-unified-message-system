import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { VerifiedFact } from "@/lib/domain/draft";
import {
  PRINT_INVOICE_ERROR,
  PRINT_INVOICE_LABEL,
  PRINT_INVOICE_PENDING,
  canPrintInvoice,
  invoiceRequestPath,
} from "@/lib/domain/invoice-action";

/**
 * THE PRINT INVOICE CONTROL.
 *
 * Two properties carry this file. The button appears exactly where the endpoint
 * would answer — so it cannot offer to print a conversation the backend would
 * refuse, and cannot hide from one it would serve. And the request names a
 * conversation and a choice, never an order: the row id does not exist on the
 * browser's side of the wire.
 *
 * Decision logic is unit-tested; placement and absence of side effects are
 * asserted from source, as the other sidebar suites do. This suite configures
 * no DOM.
 */

const ROOT = join(__dirname, "..", "..");
const PANEL = readFileSync(join(ROOT, "components/context-panel.tsx"), "utf8");
const ACTION = readFileSync(join(ROOT, "lib/domain/invoice-action.ts"), "utf8");

const CONVERSATION = "5001";
const ORDER_A = "20-00000-00001";
const ORDER_B = "20-00000-00002";

const fact = (name: string, value: string): VerifiedFact => ({ name, value });

/** The facts a resolved order produces, in the resolver's own vocabulary. */
const RESOLVED: VerifiedFact[] = [
  fact("order_number", ORDER_A),
  fact("order_status", "Completed"),
  fact("order_date", "2026-09-01 09:14:22"),
];

/* ------------------------------------------------------------------------- *
 * WHEN THE BUTTON EXISTS
 * ------------------------------------------------------------------------- */

describe("the control appears only against one resolved order", () => {
  /** 1. A conversation the backend placed on exactly one order. */
  it("appears when an order has resolved", () => {
    expect(canPrintInvoice(RESOLVED)).toBe(true);
  });

  /** 2. Nothing resolved, nothing to invoice. */
  it("is hidden when no order has resolved", () => {
    expect(canPrintInvoice([])).toBe(false);
  });

  /**
   * 3. AMBIGUOUS WITHOUT A CHOICE. The resolver returns no facts for a
   * conversation that matched several orders until a reviewer picks one, so
   * this is the same empty list — and the endpoint would answer 409.
   */
  it("is hidden for an ambiguous conversation with no selection", () => {
    // What the sidebar holds in that state: candidates, but no facts.
    expect(canPrintInvoice([])).toBe(false);
  });

  /** A selection on an ambiguous conversation produces facts, and a button. */
  it("appears once an ambiguous conversation has been chosen for", () => {
    expect(canPrintInvoice([fact("order_number", ORDER_B)])).toBe(true);
  });

  /** A manually selected order carries the same fact, so it behaves the same. */
  it("appears for a manually selected order on a no_order conversation", () => {
    expect(
      canPrintInvoice([
        fact("order_context_source", "manual_selected"),
        fact("order_number", ORDER_B),
      ]),
    ).toBe(true);
  });

  /** An order number the source never recorded heads no invoice. */
  it("is hidden when the resolved order has a blank number", () => {
    expect(canPrintInvoice([fact("order_number", "   ")])).toBe(false);
    // Other order facts alone are not a resolved order.
    expect(canPrintInvoice([fact("order_status", "Completed")])).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT THE REQUEST CARRIES
 * ------------------------------------------------------------------------- */

describe("the request names a conversation and a choice", () => {
  /** 4, 5. The existing endpoint, keyed on the conversation. */
  it("calls the invoice endpoint for this conversation", () => {
    expect(invoiceRequestPath(CONVERSATION, null)).toBe(
      "/api/conversations/5001/invoice",
    );
  });

  /** 7. Changing the selection changes the invoice target. */
  it("carries the reviewer's selection and follows it when it changes", () => {
    expect(invoiceRequestPath(CONVERSATION, ORDER_A)).toBe(
      "/api/conversations/5001/invoice?selectedOrder=20-00000-00001",
    );
    expect(invoiceRequestPath(CONVERSATION, ORDER_B)).toBe(
      "/api/conversations/5001/invoice?selectedOrder=20-00000-00002",
    );
  });

  it("omits a blank selection rather than sending an empty one", () => {
    expect(invoiceRequestPath(CONVERSATION, "")).toBe("/api/conversations/5001/invoice");
    expect(invoiceRequestPath(CONVERSATION, "   ")).toBe("/api/conversations/5001/invoice");
  });

  it("encodes both values", () => {
    expect(invoiceRequestPath("a/b", "x&y=z")).toBe(
      "/api/conversations/a%2Fb/invoice?selectedOrder=x%26y%3Dz",
    );
  });

  /**
   * 6. THE SECURITY PROPERTY. `order_management.orders` is keyed by a dense
   * integer over 1.1M rows; a client that could name one could walk every
   * customer's invoice. Nothing on this side of the wire can.
   */
  it("never sends an order row id", () => {
    for (const path of [
      invoiceRequestPath(CONVERSATION, null),
      invoiceRequestPath(CONVERSATION, ORDER_A),
    ]) {
      expect(path).not.toMatch(/orderRowId|order_row_id|orderId|orders\.id/);
    }
    for (const source of [ACTION, PANEL]) {
      expect(source).not.toMatch(/invoice[^\n]*orderRowId/);
    }
    // The module that builds the request knows of no row id at all.
    expect(ACTION).not.toContain("orderRowId");
  });
});

/* ------------------------------------------------------------------------- *
 * PLACEMENT AND SIDE EFFECTS
 * ------------------------------------------------------------------------- */

describe("the control in the sidebar", () => {
  it("is mounted first in the order section, gated on the resolved order", () => {
    // Anchored on the order branch's own list, so this reads the region that
    // renders resolved orders rather than any other `flex flex-col gap-5`.
    const body = PANEL.slice(PANEL.indexOf("const list = ("));
    const gate = body.indexOf("canPrintInvoice(context.facts)");
    expect(gate).toBeGreaterThan(-1);
    // Ahead of the order list, the mismatch notice and the chooser.
    for (const later of ["SelectCustomerOrder", "SELECTED_ORDER_MISMATCH_NOTICE", "{list}"]) {
      expect(gate, later).toBeLessThan(body.indexOf(later));
    }
    expect(body).toContain("<PrintInvoiceButton");
    expect(body).toContain("selectedOrderNumber={selectedOrderNumber}");
  });

  /**
   * 8, 9. NO GENERATION ON OPEN. The component has no effect and no request
   * outside the click handler — asserted on the component's own source, since
   * an effect added later is exactly the regression this guards.
   */
  it("makes no request except from the click handler", () => {
    const start = PANEL.indexOf("function PrintInvoiceButton(");
    const component = PANEL.slice(start, PANEL.indexOf("\nfunction ", start + 10));

    expect(component).not.toContain("useEffect");
    expect(component).toContain("onClick");
    // Exactly one fetch, and it is inside the handler.
    expect(component.match(/fetch\(/g)).toHaveLength(1);
    expect(component.indexOf("const print = async")).toBeLessThan(component.indexOf("fetch("));
    // No timer or observer could trigger it either.
    expect(component).not.toContain("setInterval");
    expect(component).not.toContain("requestAnimationFrame");
  });

  /** Nothing is stored, and no download is forced. */
  it("opens the document without saving it", () => {
    const start = PANEL.indexOf("function PrintInvoiceButton(");
    const component = PANEL.slice(start, PANEL.indexOf("\nfunction ", start + 10));

    expect(component).toContain("URL.createObjectURL");
    expect(component).toContain("URL.revokeObjectURL");
    expect(component).toContain('window.open(url, "_blank", "noopener,noreferrer")');
    for (const forbidden of ["download=", "localStorage", "sessionStorage", "writeFile"]) {
      expect(component, forbidden).not.toContain(forbidden);
    }
  });

  /** Existing loading and error copy, and no database detail. */
  it("uses the panel's own pending and error wording", () => {
    const start = PANEL.indexOf("function PrintInvoiceButton(");
    const component = PANEL.slice(start, PANEL.indexOf("\nfunction ", start + 10));

    expect(component).toContain("PRINT_INVOICE_PENDING");
    expect(component).toContain("PRINT_INVOICE_ERROR");
    expect(PRINT_INVOICE_PENDING).toBe("Generating invoice…");
    expect(PRINT_INVOICE_ERROR).toBe("Unable to generate invoice");
    // The caught error never reaches the screen; it may name a schema or host.
    expect(component).not.toMatch(/\{\s*(?:cause|error)\s*\}/);
    expect(component).not.toContain("console.");
  });

  /** The label is the sidebar's, and it is not a VAT claim. */
  it("is labelled Print invoice and never VAT Invoice", () => {
    expect(PRINT_INVOICE_LABEL).toBe("Print invoice");
    // Comments stripped first: the module doc explains why the phrase is
    // banned, and a guard its own rationale trips is a guard people delete.
    const code = ACTION.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("Print invoice");
    expect(code).not.toMatch(/VAT Invoice/i);
  });

  /** Styled with the button class the draft panel already uses. */
  it("reuses the existing button style", () => {
    const draft = readFileSync(join(ROOT, "components/draft-panel.tsx"), "utf8");
    const style =
      "rounded-full bg-emerald-600/15 px-3.5 py-1.5 text-xs font-semibold text-emerald-800";
    expect(draft).toContain(style);
    expect(PANEL).toContain(style);
  });
});
