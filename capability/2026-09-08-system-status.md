# Capability status — 2026-09-08

## Purpose

What the CST Unified Message System can and cannot actually do today, in plain
language. Everything below describes code that exists and runs. Nothing here is
a plan.

## Current status

Phase 1 is operating end to end for eBay: live customer messages arrive, are
grouped into conversations, verified order and product context is resolved,
an AI draft is generated and reviewed by a human, and an invoice PDF can be
printed for the resolved order.

**The system still cannot send anything to a customer.** `reviewed` is the last
state a conversation can reach.

## Implemented features

### Message retrieval

- Live marketplace messages are pulled from the source database into `cst_app`
  by `lib/sync/message-sync.ts` on a schedule (`npm run sync:auto`, registered
  as a Windows task by `scripts/register-message-sync.ps1`, plus
  `/api/cron/sync`).
- Messages are grouped into conversations by a derived thread key
  (`lib/domain/threading.ts`). No marketplace source exposes a thread id, so the
  key is derived and carries the identifier of the rule that produced it.
- Customer messages and CST replies are separated and rendered on opposite
  sides of the thread (`components/conversation-view.tsx`).
- A thread renders oldest → newest, opened at the newest message.

### Per-marketplace capability (`lib/domain/marketplace-capabilities.ts`)

| Marketplace | Mode | Direction verified | Previous CST replies | Grouping verified | Customer identity verified | Listing link |
| --- | --- | --- | --- | --- | --- | --- |
| eBay | full | yes | yes | yes | yes | yes |
| Amazon | full | yes | yes | no | no | no |
| Shopify | full | yes | yes | no | no | no |
| B&Q | degraded | yes | no | no | no | no |
| Temu | degraded | yes | no | no | no | no |

The interface reads these flags rather than testing for a marketplace by name.
An inbound-only source never renders a reply column.

### Order context

- eBay only. Every other marketplace returns no order facts.
- One order is matched from the conversation's own keys — storefront
  (`sub_source_id`), listing item reference and buyer username.
- Exactly one match → verified facts. Several matches → the candidates are
  shown and the system waits for a human to choose. No match → a same-storefront
  fallback order is offered only where the buyer has exactly one.
- Eight facts and no others reach a draft: `order_number`, `order_status`,
  `order_date`, `tracking_number`, `delivery_courier`, `delivery_address`,
  `sku`, `product_title`.
- The selected order is carried by the internal row id `orders.id`. The
  customer-visible order number is display and filter only.

### Product and listing information

- Marketplace, order number, SKU, product title and order status are shown for
  the resolved order.
- The listing a customer is asking about is resolved separately from the order
  they bought (`lib/context/resolve-listing-context.ts`) — listing title and the
  variation options the listing offers.
- Combo SKUs such as `AAA+BBB+CCC` are one SKU throughout. There is no
  `parseSku`, `splitSku` or `normalizeSku` anywhere in the codebase, and
  `lib/domain/sku.ts` exists to make that absence testable.

### AI draft

- Grounded in the CST rule documents, not in the model's own knowledge.
- Rule-based business context: category and intent are read from the whole
  thread before the model is called.
- Generate → review → edit → regenerate → save → reviewed.
- A deterministic validation layer checks the draft against the verified facts
  before a reviewer sees it, and can force one regeneration.
- No send. `tests/guards/no-send-capability.test.ts` fails the build if any code
  capable of transmitting a reply is introduced.

### Invoice

- Invoice data resolver over one already-resolved order
  (`lib/repositories/order-invoice-repository.ts`).
- Selected order → invoice context → PDF, generated on demand.
- Backend endpoint `GET /api/conversations/:id/invoice[?selectedOrder=...]`
  returns PDF bytes.
- "Print invoice" button in the context panel, shown only where exactly one
  order has resolved.
- The PDF carries order number, order date, status, items (SKU, description,
  quantity, unit price), subtotal, shipping, discount, tax, total, amount paid,
  payment method, currency, seller VAT registration availability, a billing
  section, and any customer-relevant warning (cancelled / refunded).

## Database / data source

- Marketplace source database: **read-only**. The pool pins
  `default_transaction_read_only=on` at session level.
- Application database: `cst_app` schema only. This is where conversations,
  messages, drafts, context snapshots and usage records are written.
- Knowledge database: read-only.
- No ORM. The source database has no foreign keys, so every join is explicitly
  reviewed SQL, parameterised.

## User workflow

```
Live message → thread → verify context (order / listing / return)
→ AI draft → review / edit / regenerate → save → reviewed → STOP
```

Print invoice is available at any point once exactly one order has resolved.

## Known limitations

- Order, listing, return, tracking and invoice context are **eBay only**.
- Amazon, Shopify, B&Q and Temu conversations show messages, but no verified
  order context and no invoice.
- eBay customer messages carry no attachment data at the source, so a
  customer-uploaded photo cannot be shown for eBay.
- The invoice carries no billing address or seller company block: the resolver
  deliberately returns the billing party as a presence boolean only, so there is
  nothing to print. The section reads "Billing details not available."
- The document is headed "INVOICE", never "VAT Invoice". Only 23.7% of orders
  record a tax above zero and 1 of 22 eBay storefronts records a VAT number.
- No VAT is calculated anywhere. `tax` is reported exactly as stored.
- No invoice PDF is stored. `order_management.shipment.invoice` is a DHL export
  document path and is never read.

## Next pending items

- Marketplace reply sending — not built, out of Phase 1 scope.
- Automatic sending.
- Invoice email sending.
- VAT invoice generation (needs the business VAT rule stated first).
- Seller / company details on the invoice.
- Billing address rendering on the invoice.
- Full accounting integration.
- Order context for marketplaces other than eBay.
