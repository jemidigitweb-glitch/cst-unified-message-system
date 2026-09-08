# Closure status — implemented scope as at 2026-09-08

## Purpose

The record of what is actually finished, so a later contributor does not have to
reconstruct "was this done?" from commit history. Only items that are built,
tested and running are listed as closed.

## Current status

Phase 1 is functionally closed for eBay: message retrieval, threading, order
context, listing context, AI drafting with human review, and on-demand invoice
printing all work against live data. The phase's terminal state is still
`reviewed` and no send capability exists.

The invoice work is the most recent closed item.

## Implemented features (closed items)

### Closed — message pipeline

- Incremental live sync from the marketplace source into `cst_app`
  (`lib/sync/message-sync.ts`). Resumes from a `(timestamp, pk)` watermark in
  `cst_app.sync_state`; safe to re-run.
- Conversation grouping by derived thread key, with the rule version stored on
  the thread so grouping can be recalculated later without corrupting saved work.
- Customer / CST message separation, rendered oldest → newest.
- Five marketplace adapters (eBay, Amazon, Shopify, B&Q, Temu), each keeping its
  own reviewed direction and threading rules.

### Closed — order context

- Strict eBay order matching on storefront + listing item reference + buyer.
- Ambiguity is surfaced, never resolved by the system. A human picks.
- Manual selection is validated by membership of the conversation's own
  candidate set, never trusted as a lookup key.
- Same-storefront fallback order, gated on the stored `no_order` resolution so
  it can never override or pre-empt a real match.
- **Decision recorded:** the listing a customer asks about is resolved separately
  from the order they bought (commit `464f8ef`). They answer different questions
  and have very different coverage — a listing title resolves for 869 of 869
  eBay conversations, the SOT catalogue for 3 of 869.

### Closed — AI draft

- Draft generation grounded in the CST rule corpus, with provider selection in
  one place (`lib/ai/draft-service.ts`, OpenAI primary, Gemini fallback).
- Deterministic post-generation validation, one automatic regeneration on a
  failing draft, and the result always shown to a human.
- Review / edit / regenerate / save / reviewed workflow, append-only revisions.
- **Decision recorded:** the draft is never graded by another model. A wrong
  draft and a wrong grade would otherwise share a cause.

### Closed — invoice

- Invoice data resolver over one already-resolved order.
- Conversation → selected order → invoice context → PDF, on demand only.
- `GET /api/conversations/:id/invoice[?selectedOrder=...]` returning PDF bytes.
- "Print invoice" control in the context panel, gated on the same condition the
  endpoint gates on.
- Improved PDF layout: fixed item columns, right-aligned money, wrapped
  descriptions, page breaks that never split a row, multi-page totals handling.
- **Decisions recorded, and deliberately not reopened without business input:**
  - The order *is* the invoice. There is no invoice table, no invoice number
    sequence and no stored document, because the business does not model an
    invoice as a separate entity.
  - `order_management.shipment.invoice` is a DHL international export document
    path (93 of 1,144,513 shipments) and is never read.
  - No VAT is derived. `tax` is reported exactly as stored.
  - The document is headed "INVOICE", never "VAT Invoice".
  - The billing party crosses the resolver boundary as a presence boolean only,
    so no billing name or address can leak into a sidebar or an AI prompt.
  - The endpoint accepts no order id. `order_management.orders` is keyed by a
    dense integer over 1.1M rows, so an endpoint that took one would expose
    every customer's invoice.

## Database / data source

- Source marketplace database: read-only, session-level enforced.
- Application writes: `cst_app` only.
- Selected order is carried as `orders.id`; the customer-visible order number is
  never used as a lookup key (655 order numbers are reused across 1,608 rows).

## User workflow

Closed as: `live message → thread → verify context → AI draft →
review/edit/regenerate → save → reviewed → STOP`, with **print invoice**
available once exactly one order has resolved.

## Known limitations at closure

- Everything order-derived, including the invoice, is eBay only.
- The invoice has no billing address block and no seller/company block.
- No VAT figure is produced and no VAT invoice can be issued.
- No document is stored anywhere; the PDF exists for the length of the response.

## Next pending items (explicitly NOT closed)

- Marketplace reply sending.
- Automatic sending.
- Invoice email sending.
- VAT invoice generation.
- Seller invoice details.
- Billing address expansion.
- Full accounting integration.
- Phase 2 work of any kind.
