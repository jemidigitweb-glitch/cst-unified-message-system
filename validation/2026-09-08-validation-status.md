# Validation status — 2026-09-08

## Purpose

How the implemented system was confirmed to work, and what still needs a manual
check. Separate from the automated suite in `tests/` — this is the record of the
checking, plus the checklists a person runs.

## Current status

Automated validation is green. Manual validation of the invoice feature against
a real conversation has **not** been recorded yet.

```
npm test   →   Test Files 124 passed | 13 skipped (137)
               Tests     3365 passed |  32 skipped (3397)
```

The 13 skipped files are opt-in live-source suites; they are skipped by design.

## Implemented features (checks that exist)

### Automated

- Domain, repository, context-resolver, AI, knowledge, sync, tracking, export
  and migration suites under `tests/`.
- Standing guards that fail the build: no send capability, no customer data in
  tracked files, invoice route restrictions, print-invoice control placement,
  draft workflow terminal state, migration scope, file naming.
- Repository tests use **synthetic rows only**. No real customer data appears in
  any fixture.

### Opt-in, read-only, against live data

| Suite | Enable with |
| --- | --- |
| `tests/source-validation/ebay-live-source.test.ts` | its own env flag |
| `tests/source-validation/category-live-sample.test.ts` | `CST_CATEGORY_OUT` etc. |
| `tests/source-validation/order-invoice-live-source.test.ts` | `CST_INVOICE_LIVE=1` + `CST_INVOICE_ROW_IDS=<ids>` |

All three are `SELECT`-only on the read-only pool and assert on ids, counts,
statuses and flags — never on a name, address, email or phone number.

## Manual checklists to run

### A. Order context and ambiguity

1. Open an eBay conversation whose buyer bought the listing once → the sidebar
   shows one order, with order number, status, date, SKU and product title.
2. Open one whose buyer bought the same listing twice → the sidebar shows the
   **candidates and asks**. Confirm no order facts appear in a generated draft
   until a choice is made.
3. Pick one candidate → the facts are that order's, and nothing is blended from
   the sibling.
4. Open a conversation with no match but exactly one same-storefront order →
   the fallback order appears, clearly as a fallback.

### B. Listing vs order

5. Open a pre-sales conversation (no order) → the listing title, options and URL
   still resolve. Confirm the draft answers the listing question and does not
   claim an order.

### C. AI draft

6. Generate a draft on a conversation with a verified return → the sidebar shows
   return context and **the draft does not claim to have seen a photo**.
7. Generate a draft where the order is not yet dispatched → the draft must not
   say "we will check the dispatch status", because that is already known.
8. Confirm the draft never calls a customer-stated order number "verified",
   "confirmed" or "on our system".
9. Edit, regenerate and save → each produces a new revision; nothing is
   overwritten. Confirm `reviewed` is the last state and there is no send
   control anywhere on the page.

### D. Invoice (new — not yet run)

10. **Button presence.** On a conversation with exactly one resolved order, the
    "Print invoice" control is visible. On an ambiguous conversation with no
    choice made, it is **absent**. On a non-eBay conversation, absent.
11. **Endpoint agreement.** Requesting
    `/api/conversations/:id/invoice` on an ambiguous conversation with no
    selection returns **409**, not a document.
12. **Selection is validated.** Request with `?selectedOrder=` naming an order
    the conversation never matched → no document.
13. **PDF contents.** Order number, order date, status, items with SKU,
    description, quantity and unit price, subtotal, shipping, discount, tax,
    total, amount paid, payment method, currency line.
14. **Combo SKU.** Find an order line with a combo SKU (`AAA+BBB+CCC`). Confirm
    it prints as **one SKU**, wrapping across lines character-for-character with
    no hyphen and nothing removed, so it can be typed back exactly.
15. **Absence, not zero.** A field the source did not record prints as `—`,
    never `0.00`.
16. **No VAT claim.** The heading reads "INVOICE", never "VAT Invoice". Seller
    VAT registration reads "Not available" where the storefront has no `vat_no`.
17. **Billing.** The BILL TO section reads "Billing details not available." —
    expected today, since the resolver carries the party as presence only.
18. **Warnings.** On a cancelled order, the page says "This order was
    cancelled." On a refunded order, it says the amounts are the original order
    values. Internal warnings (duplicate payment row, discount not reflected,
    missing seller VAT) must **not** appear on the customer's page.
19. **Nothing stored.** After printing, confirm no file was written, no invoice
    record created and no URL minted. The response carries
    `Cache-Control: no-store, private`.

### E. Regression checklist before a risky change

- Order-context marketplace-code matching (eBay is identified by
  `sub_source.source_id`, never by `market_place`).
- Thread-key derivation — a change to it produces new conversations under a new
  rule version rather than corrupting existing ones.
- SKU atomicity — no `parseSku`, `splitSku` or `normalizeSku` may appear.
- The no-send guard must stay green.

## Database / data source

Every validation activity above is read-only against the marketplace source, or
confined to `cst_app`. No validation run may write to the source database.

Results are recorded as counts and pass/fail summaries. **Raw rows containing
customer message text or personal data are never pasted into this folder.**

## User workflow

The checklists above follow the agent's own path: open a conversation, verify
context, draft, review, and — where an order resolved — print an invoice.

## Known limitations

- Checklist D has not been executed and its results are not recorded.
- No coverage summary run is recorded.
- Validation of Amazon, Shopify, B&Q and Temu is limited to message display;
  there is no order context to validate for those marketplaces.

## Next pending items

- Run checklist D and record the results here.
- Record a coverage run.
- Nothing is pending for sending, VAT invoices, invoice email or accounting
  integration — those features do not exist, so there is nothing to validate.
