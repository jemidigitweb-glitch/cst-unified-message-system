/**
 * The invoice for one customer order, as the source database actually holds it.
 *
 * ------------------------------------------------------------------------
 * THE ORDER IS THE INVOICE
 * ------------------------------------------------------------------------
 * There is no invoice table, no invoice number sequence, no stored PDF and no
 * document path, because this business does not model an invoice as a separate
 * entity. Discovery proved the invoice is STRUCTURED ORDER DATA: the order row
 * is the header, `customers.billing_address` is the invoice-to party, and
 * `order_management.order_item_info` are the lines. The business's own curated
 * table definition says so in as many words — `order_id` is described there as
 * the "Invoice identifier", and the customer/billing table as holding details
 * "for each invoice, one row per order_id".
 *
 * Measured live: the billing party exists for 1,133,659 of 1,133,660 orders,
 * and for 14 of 14 real eBay invoice-request orders traced end to end. It is a
 * genuinely separate party rather than a copy of the delivery address — 34,926
 * orders (3.1%) carry a different billing street, and 23,756 (2.1%) carry a
 * billing company name, which is exactly the B2B invoice case.
 *
 * ------------------------------------------------------------------------
 * `order_management.shipment.invoice` IS NOT THIS, AND IS NEVER READ
 * ------------------------------------------------------------------------
 * That column holds a DHL international export document path. It is populated
 * on 93 of 1,144,513 shipments (0.008%), is shipment-scoped so one order can
 * hold two of them, sits on a cancelled shipment in 4 cases, and was absent
 * from every one of the 14 real invoice-request orders. The repository behind
 * this type does not name it, and a guard test pins that absence.
 *
 * ------------------------------------------------------------------------
 * NO VAT IS EVER DERIVED
 * ------------------------------------------------------------------------
 * `tax` is REPORTED, never computed. There is no `total / 6`, no 20% rule, no
 * net/gross split and no VAT-inclusive breakdown anywhere on this path. Two
 * measured facts are why: only 260,833 of 1,101,548 orders (23.7%) record a
 * `tax` above zero — every GBP order in the traced sample records 0.00 — and
 * only 1 of 22 eBay storefronts has a `vat_no`. Until the business states the
 * authoritative VAT rule, availability is reported and the figure is not
 * manufactured.
 *
 * ------------------------------------------------------------------------
 * MONEY IS CARRIED AS TEXT, EXACTLY AS STORED
 * ------------------------------------------------------------------------
 * Every monetary field is the source value cast to text and passed through
 * untouched. Nothing here is parsed into a JavaScript number, rounded,
 * reformatted or recomputed, so no binary-float artefact can reach a document
 * that a customer or an accountant reads. `order_item_info.item_price` and
 * `item_quantity` are `character varying` in the source in any case; they are
 * relayed verbatim rather than coerced.
 */

/**
 * One line of the invoice, exactly as the source recorded it.
 *
 * `unitPrice` and `quantity` are STRINGS because the source stores them as
 * `character varying`. They are reference values, relayed for display. Nothing
 * multiplies them, and no line total or order total is derived from them.
 */
export type OrderInvoiceLine = {
  /** `order_item_info.id`. Stable identity for the line, not a display value. */
  readonly lineId: string;
  /** The marketplace's own line reference, where the source recorded one. */
  readonly lineItemRef: string | null;
  /** The listing item this line was bought from. */
  readonly itemRef: string | null;
  /**
   * The ordered SKU, EXACTLY as the source stored it.
   *
   * ONE OPAQUE IDENTIFIER. Never split on `+`, `-`, `_`, `/` or a space, never
   * trimmed, case-folded or normalised — see `lib/domain/sku.ts`. Combo SKUs
   * such as `PSHYOS4BRBM+SPUPBM+SLDO210BM` are a single SKU with their own
   * product master row, and 129,783 of 633,970 live eBay order lines carry one.
   *
   * `real_sku` where the source recorded a corrected value, else `item_sku` —
   * the same precedence the strict matcher already applies.
   */
  readonly sku: string | null;
  /** The title recorded ON THE ORDER LINE, not the listing's current title. */
  readonly productTitle: string | null;
  /** Source text, verbatim. Never parsed, never multiplied by `quantity`. */
  readonly unitPrice: string | null;
  /** Source text, verbatim. Never parsed. */
  readonly quantity: string | null;
};

/**
 * A condition a caller must see before treating this order as invoiceable.
 *
 * NOTHING HERE IS HIDDEN OR REPAIRED. Each value names an observed state of the
 * source data. A caller that ignores the list can still show something wrong;
 * a caller that reads it cannot be surprised by one of these silently.
 */
export type OrderInvoiceWarning =
  /** No `customers.billing_address` row. Measured: 109 orders of 1.13M. */
  | "billing_address_missing"
  /**
   * More than one billing row for one order. The repository does NOT pick one
   * — the party fields come back null and this says why. Measured: 1 order.
   */
  | "billing_address_duplicated"
  /** No `order_item_info` rows: an invoice with no lines. Measured: 7,049 orders. */
  | "order_lines_missing"
  /** No `order_management.order_info` row: no currency or payment state. */
  | "order_info_missing"
  /** Several `order_info` rows. Payment fields come back null rather than picked. */
  | "order_info_duplicated"
  /** The source did not record an order number, so the invoice has no reference. */
  | "order_number_missing"
  /** `status = 'Cancelled'`. Present in the real traced sample. */
  | "order_cancelled"
  /** `status = 'Refunded'`. The stored totals do NOT reflect the refund. */
  | "order_refunded"
  /** `status = 'Deleted'`. */
  | "order_deleted"
  /** Any other status that is not `Completed` — Hold, Inprogress, New, Pending. */
  | "order_not_completed"
  /** `sub_source.vat_no` is absent. Measured: 21 of 22 eBay storefronts. */
  | "seller_vat_number_missing"
  /** `tax` is null or zero. Measured: 76.3% of orders, and every GBP order sampled. */
  | "tax_amount_absent"
  /**
   * A discount is recorded while `total` equals `sub_total` exactly.
   *
   * PURELY OBSERVATIONAL. It asserts no formula — in particular it does not
   * claim `total = sub_total + shipping + tax - discount`, which the source
   * does not obey. It reports that a recorded discount is reflected nowhere,
   * which was found on a real order (`sub_total` 168.40, `discount` 18.72,
   * `total` 168.40). The stored values are returned unchanged regardless.
   */
  | "discount_not_reflected_in_total";

/**
 * Everything the source can prove about one order's invoice.
 *
 * ------------------------------------------------------------------------
 * TWO SEPARATE QUESTIONS, DELIBERATELY NOT ONE BOOLEAN
 * ------------------------------------------------------------------------
 *   `invoiceDataAvailable`      Is there enough source data to describe this
 *                               order as an invoice at all?
 *   `vatDocumentDataComplete`   Do the fields a VAT document additionally needs
 *                               — a seller VAT number and a tax amount — exist?
 *
 * Collapsing these into one flag is the mistake this type exists to prevent. A
 * completed order with a billing party and lines has invoice DATA; if its
 * storefront has no VAT number and its `tax` is 0.00, it cannot back a VAT
 * document, and 76.3% of orders are in exactly that position.
 *
 * NEITHER FLAG IS A LEGAL CLAIM. `vatDocumentDataComplete` asserts that the
 * FIELDS are present, not that a valid tax document exists, not that anyone is
 * entitled to one, and not that the figures are correct. The business VAT rule
 * is still unconfirmed and no code here substitutes for it.
 *
 * STATUS DOES NOT GATE AVAILABILITY. A cancelled order still has invoice data,
 * and pretending otherwise would hide the order from a reviewer who needs to
 * see exactly that. The status travels as `orderStatus` and as a warning, and
 * the caller decides — see `order_cancelled` and `order_refunded`.
 */
export type OrderInvoiceContext = {
  /** `order_management.orders.id`. The stable key this was looked up by. */
  readonly sourceOrderRowId: string;
  /**
   * `orders.order_id` — the marketplace-visible order number.
   *
   * DISPLAY ONLY. It is NOT a lookup key: 655 order numbers are reused across
   * 1,608 rows in the source, and `(sub_source_id, order_id)` does not
   * disambiguate them either. Nothing resolves an order from this value.
   */
  readonly orderNumber: string | null;
  /** Stored source timestamp as text, verbatim. Never parsed or converted. */
  readonly orderDate: string | null;
  /** `Completed` / `Cancelled` / `Refunded` / `Deleted` / `Hold` / … as stored. */
  readonly orderStatus: string | null;

  /* ---- money, as text, exactly as the source stored it ---- */
  readonly currency: string | null;
  readonly subtotal: string | null;
  readonly shippingCost: string | null;
  /** The stored `tax`. Reported, never derived — see the module doc. */
  readonly tax: string | null;
  readonly discount: string | null;
  readonly total: string | null;
  readonly amountPaid: string | null;
  readonly paidTime: string | null;
  readonly paymentMethod: string | null;

  /* ---- lines ---- */
  readonly lineCount: number;
  readonly lines: readonly OrderInvoiceLine[];

  /* ---- the invoice-to party, as presence only ---- */
  /**
   * Whether a billing party was recorded — a name or a first address line.
   *
   * PRESENCE, NOT CONTENT. No billing name, address, company, phone or email
   * crosses this boundary. Rendering a document will need those values one day;
   * this resolver is consumed by a sidebar and, later, by an AI prompt, and
   * neither has any business receiving them. Whoever builds rendering can read
   * the party inside the backend at that point, deliberately, rather than
   * finding it already in scope here.
   */
  readonly billingPartyPresent: boolean;
  /** Whether the billing party carries a company name — the B2B invoice signal. */
  readonly billingCompanyPresent: boolean;
  /** Whether `customer_info.email_invoice` holds an address. NEVER the address. */
  readonly invoiceEmailOnFile: boolean;

  /* ---- derived state, from the fields above and nothing else ---- */
  /** Whether `sub_source.vat_no` exists for this order's storefront. */
  readonly sellerVatNumberAvailable: boolean;
  /** Whether the stored `tax` is greater than zero. Computed in SQL, exactly. */
  readonly vatAmountAvailable: boolean;
  /** Order number, exactly one billing row, and at least one line. */
  readonly invoiceDataAvailable: boolean;
  /** The above, plus a seller VAT number and a tax amount. Not a legal claim. */
  readonly vatDocumentDataComplete: boolean;
  /** Every observed condition, in a stable order. Empty means nothing was found. */
  readonly warnings: readonly OrderInvoiceWarning[];
};
