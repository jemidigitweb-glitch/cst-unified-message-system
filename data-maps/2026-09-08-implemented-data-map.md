# Implemented data map — 2026-09-08

## Purpose

How data actually flows from the live marketplace source database into this
application today, including the invoice path. Mappings only — the SQL that
implements them lives in `lib/repositories/` and `lib/marketplaces/`.

## Current status

All mappings below are implemented, running against live data, and covered by
tests. Order-derived mappings (order, listing, return, tracking, invoice) are
**eBay only**.

## Implemented features

### 1. Messages → conversations

Source database `ledsone`, schema `customer_service`:

| Marketplace | Source table(s) |
| --- | --- |
| eBay | `ebay_message_headers` + `ebay_messages` (1:1 on `message_id`) |
| Amazon | `amazon_messages` |
| Shopify | `shopify_messages` |
| B&Q | `bandq_messages` |
| Temu | `temu_messages` |

Written to `cst_app.conversations` and `cst_app.conversation_messages` by
`lib/sync/conversation-writer.ts`.

Key mappings:

- `ebay_message_headers.item_id` → `cst_app.conversations.listing_item_ref`
- eBay buyer → `cst_app.conversations.counterparty_ref`
- eBay `folder_id` → `cst_app.conversation_messages.direction`
- storefront → `cst_app.conversations.sub_source_id`
- derived thread key (`lib/domain/threading.ts`) →
  `cst_app.conversations.thread_key`, with `threading_rule_version` beside it
- sync position → `cst_app.sync_state` as a `(timestamp, pk)` watermark

Direction is only ever written where the source proves it. Amazon direction is
mapped from two stored sender fields; Shopify direction is decided by the two
addresses against a reviewed company-domain list; B&Q and Temu are inbound-only.

### 2. Conversation → order (eBay)

The verified chain, matched on the conversation's own keys and nothing else:

```
conversations.listing_item_ref + counterparty_ref + sub_source_id
  → order_management.order_item_info   (item_id, real_sku / item_sku)
  → order_management.orders            (orders.id — the internal key)
  → customers.shipping_address         (delivery address)
  → order_management.shipment          (tracking number)
  → order_management.carrier_service   (courier name)
```

Result is cached in `cst_app.context_snapshots` / `cst_app.context_items`, with
candidates in `cst_app.context_order_candidates`.

Source-side quirks that shape this mapping:

- `order_management.market_place` is a country/region code shared across every
  marketplace, **not** a platform identifier. eBay is identified by
  `sub_source.source_id`.
- `orders.order_id` (the number a customer quotes) is **not unique**: 655 order
  numbers are reused across 1,608 rows, and pairing with `sub_source_id` does
  not separate them. It is display and filter only.
- A single eBay `item_id` is not unique to one listing — a multi-variation
  listing stores one row per SKU variant under the same item id.

### 3. Conversation → listing (eBay)

`conversations.listing_item_ref` → `listings.ebay_listings` for the listing URL,
listing title and the variation options the listing offers. This is separate
from the order path on purpose: it answers "what is the customer asking about",
not "what did they buy". Coverage measured over every eBay conversation CST
holds: a title resolves for 869 of 869, variation options for 867.

`listings.ebay_listings.product_description` is deliberately excluded (≈53KB of
seller HTML, marketing rather than specification).

### 4. Product catalogue

- `configurator.components_sot_skus` / `components_sot_attributes` /
  `components_sot_attribute_values` — the SOT catalogue. Resolves for 3 of 869
  eBay listings, which is why the listing path exists alongside it.
- `order_management.order_combo` — component decomposition for a combo SKU. The
  application never parses a SKU itself; the decomposition already exists here.
- `inventory.products` — product master.

### 5. Selected order → invoice (new)

`lib/repositories/order-invoice-repository.ts`. **Two SELECTs, keyed on
`orders.id` only.**

Header:

| Source | Invoice field |
| --- | --- |
| `order_management.orders.id` | `sourceOrderRowId` (the lookup key) |
| `orders.order_id` | `orderNumber` (display only) |
| `orders.order_date` | `orderDate` (text, verbatim) |
| `orders.status` | `orderStatus` |
| `orders.sub_total` / `shipping_cost` / `tax` / `discount` / `total` | `subtotal` / `shippingCost` / `tax` / `discount` / `total` (all text, verbatim) |
| `order_management.sub_source.vat_no` | `sellerVatNumberAvailable` (boolean only) |
| `order_management.order_info` | `currency`, `amountPaid`, `paidTime`, `paymentMethod` |
| `customers.billing_address` | `billingPartyPresent`, `billingCompanyPresent` — **booleans only** |
| `customers.customer_info.email_invoice` | `invoiceEmailOnFile` — **boolean only** |

Lines, from `order_management.order_item_info`:

| Source | Invoice field |
| --- | --- |
| `oii.id` | `lineId` |
| `oii.line_item_id` | `lineItemRef` |
| `oii.item_id` | `itemRef` |
| `oii.real_sku` else `oii.item_sku` | `sku` — one opaque value, never split |
| `oii.item_title` | `productTitle` (the title on the order line, not the listing's current title) |
| `oii.real_price` else `oii.item_price` | `unitPrice` (text) |
| `oii.real_qty` else `oii.item_quantity` | `quantity` (text) |

Confirmed relationships behind this mapping:

- The order **is** the invoice. There is no invoice table, no invoice number
  sequence, no stored PDF and no document path. `orders.order_id` is described
  in the business's own curated table definition as the "Invoice identifier",
  and the customer/billing table as holding details "for each invoice, one row
  per order_id".
- Billing party presence measured at 1,133,659 of 1,133,660 orders. It is a
  genuinely separate party: 34,926 orders (3.1%) carry a different billing
  street and 23,756 (2.1%) carry a billing company name — the B2B invoice case.
- Fan-out (billing, payment, contact) is read through LATERALs and **counted,
  never collapsed by a pick**. Where more than one row exists the value columns
  come back NULL and the count travels alongside as a warning.

### 6. What is deliberately NOT mapped

- `order_management.shipment.invoice` — a DHL international export document
  path, present on 93 of 1,144,513 shipments (0.008%), shipment-scoped, and
  absent from all 14 real invoice-request orders traced. Never read; a guard
  test asserts the SQL does not name it.
- Billing name, street, company, phone and invoice email **values**. Only
  presence booleans cross the resolver boundary.
- Any VAT derivation. `tax` is relayed exactly as stored.

## Database / data source

- Marketplace source (`ledsone`): read-only, `default_transaction_read_only=on`.
- Application: `cst_app` schema only.
- No ORM, no inferred joins. The source has no foreign keys, so every join above
  was verified by hand against live data.
- All queries parameterised.
- Money is cast to text in SQL and never parsed into a JavaScript number, so no
  float artefact can reach a document.

## User workflow

A reviewer never sees these mappings. They see: conversation → order context
panel → (choose an order if several matched) → draft and/or print invoice.

## Known limitations

- Order/listing/return/tracking/invoice mappings exist for eBay only.
- Amazon grouping and customer identity are unverified at the source; Shopify
  the same. B&Q and Temu carry no item reference at all.
- The source timestamp zone is still unconfirmed. Timestamps are stored naive
  and copied verbatim; only gap arithmetic uses a fixed offset.
- The billing address is mapped as presence, not content, so no invoice can
  print a bill-to block today.

## Next pending items

- Carry the billing party (name/address) through the invoice resolver — a
  deliberate decision about where personal data may travel, not a layout task.
- Seller/company details for the invoice header.
- A VAT mapping, once the business states the authoritative VAT rule.
- Order-context mappings for Amazon / Shopify, if and when their direction and
  identity sources are settled.
