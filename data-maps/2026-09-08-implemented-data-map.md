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
  `components_sot_attribute_values` — the SOT catalogue. **1,824 SKUs across six
  sheet tabs** (lampshade, ceilingrose, bulb, lampholder, pendantholder,
  wallarm), one row per (sku, attribute) pair. Resolves for 3 of 869 eBay
  conversations *by the parent-listing route*, which is why the listing path
  exists alongside it — but see "Added: two routes into the catalogue" below,
  because that figure describes only one of the two routes in use.
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

## Added: no new mapping

The order-change notification list introduces **no source mapping, no column and
no table**. It reads application state three existing mappings already produced:

| Read | Already written by |
| --- | --- |
| `cst_app.conversations` | `lib/sync/conversation-writer.ts` |
| `cst_app.conversation_messages` | the same writer |
| `cst_app.draft_replies` (existence only) | `lib/sync/draft-writer.ts` |

It never reaches the marketplace source database, and it reads **every**
conversation-backed marketplace in one statement rather than one at a time —
the feed is global by design.

**`inbox_visibility` is now read, and the distinction matters.** The
notification query excludes `filtered` conversations: the bounces, courier
notices, other-channel notifications and unsolicited mail the ingestion layer
already placed there, each with its reason recorded beside it. 4,452 of
Shopify's 7,794 unanswered conversations are these.

This is **not** the `reply_inbox`-only filter the inbox query removed on
purpose. That one decided what EXISTS and made 3,046 stored conversations
unreachable from every view in the application. This decides what NOTIFIES.
Every one of these conversations is still listed, still labelled and still
openable in the inbox; what it no longer does is claim a customer is waiting for
an answer.

**The category is still not stored, and deliberately.** It is read on every
request by `classifyConversationCategory` from the customer's own text, exactly
as the inbox chip is — so the notification filter is applied in application code
against the value `toInboxItem` already produced, not as a SQL predicate. A
stored category column would be a second source of truth that drifts the moment
the phrase table changes, and would need the backfill the current design exists
to avoid.

## Added: the thread itself, as a second and narrower grounding source

No source mapping, no column and no table. Drafting now reads one more thing out
of data it was already given: `cst_app.conversation_messages`, in order, for this
conversation.

| Read | Already written by | Read as |
| --- | --- | --- |
| `conversation_messages.direction` | `lib/sync/conversation-writer.ts` | whose turn it is |
| `conversation_messages.body_text` (via `displayBody`) | the same writer | an offer, or an acceptance |

`acceptedCommitments` in `lib/domain/draft.ts` maps that sequence to at most two
values, `replacement` and `refund`, and to nothing else. The mapping is one-way
and derived per request:

```
outbound turn containing an offer construction AND a named remedy
   followed by
inbound turn containing acceptance wording in a non-question sentence
   ⇒  that remedy is an agreed commitment for this draft only
```

**Nothing is stored, and that is the mapping decision.** No column, no snapshot,
no migration. The commitment is re-derived from the thread on every draft call,
exactly as the category and the intent already are, for the same reason recorded
in the notification section above: a stored reading would be a second source of
truth that drifts the moment the offer wording changes, and would need a
backfill.

**It maps to grounding, not to facts.** A commitment never becomes a
`VerifiedFact`, never appears in the VERIFIED CONTEXT block, and never reaches
the sidebar. It is consumed only by `ungroundedClaims` and
`settleReviewRequirement`, where it can license exactly one thing — a statement
that we are ARRANGING a remedy. The claim that a remedy has HAPPENED still maps
only from the verified order and shipment facts above.

Direction is what makes this readable at all, so it is worth naming which
marketplaces can support it: eBay, Amazon and Shopify have verified direction;
B&Q and Temu are inbound-only and therefore contain no `OUR PREVIOUS REPLY` for
an offer to sit in.

## Added: two routes into the product catalogue, measured

Section 4 above lists the SOT tables. There are **two** mappings from a
conversation into them, and the coverage figure quoted for the first has been
read as the coverage of the catalogue as a whole, which understates it.

```
conversations.listing_item_ref
   ├── listings.ebay_listings (is_parent = 1) → el.sku → components_sot_skus.sku
   │      the PARENT route. Reaches 308 of 31,155 parent listings (1.0%).
   │
   └── listings.ebay_listings (is_child = 1) → el.sku
          → order_management.order_item_info.item_sku
          → order_management.order_combo.sku → components_sot_skus.sku
          the COMPONENT route. Reaches 19,319 of 31,155 (62%).
```

Measured 2026-09-09 across every parent listing. The parent route fails for a
structural reason, not a matching one: **4,768 parent rows carry the literal
placeholder `"sku not assigneds"`** and 1,089 carry a combo SKU that no
catalogue indexes. The parent SKU field is also frequently prose rather than an
identifier — `"Table Lamp"`, `"Multi colour Hand Made Glass Lamp"` — because it
is a listing-admin field, not a catalogue key.

The component route works because `order_combo` already holds the decomposition
the application is forbidden to derive itself (`lib/domain/sku.ts` — no
`parseSku`, no split on `+`). It is the mapping `resolveBundleProductContext`
uses, which is why a listing with a placeholder parent SKU still produces
verified product facts.

**SOT is bigger than recorded here:** 1,824 SKUs across six sheet tabs
(lampshade, ceilingrose, bulb, lampholder, pendantholder, wallarm), not the
1,001 across three the module doc comments still state.

**One attribute maps to nothing, on every SKU.** `weight_g` is `NULL` for 1,155
SKUs and `[VERIFY]` for 669 — no usable value exists anywhere in the catalogue,
and the same is true of `packaged_weight_g`, `volumetric_weight_kg`,
`outer_weight_kg` and `chargeable_weight_kg`. Outside SOT,
`suppliers.child_item_products.weight` is null on all 119 rows. There is
currently **no mapping from any product to a weight**, so no draft can state
one.

## Next pending items

- **A weight mapping, once a weight exists to map.** `Weight_g` is unset for all
  1,824 SOT SKUs; the column and the resolver already exist, so this is a data
  task and needs no code.
- Carry the billing party (name/address) through the invoice resolver — a
  deliberate decision about where personal data may travel, not a layout task.
- Seller/company details for the invoice header.
- A VAT mapping, once the business states the authoritative VAT rule.
- Order-context mappings for Amazon / Shopify, if and when their direction and
  identity sources are settled.

## Added: message body repair — the two-table eBay message

The map was incomplete in one place, and that gap is the bug repair fixes.

```
customer_service.ebay_message_headers        customer_service.ebay_messages
  id            (pk, source_pk)                id
  ext_message_id  ──────────────────────────▶  message_id   (UNIQUE)
  message_id      (external_message_id)        message      (JSON-encoded text)
  folder_id       (0 inbound, 1 outbound)
  receive_date    (source_ts)
```

**The two tables are not written together.** Measured 2026-09-08: ~104k header
rows against 73,913 body rows, and the body row for a message received at
05:52:46 carried id 88823 against a maximum of 88842 — written well after its
header. A header ingested in that gap normalises to
`bodyDecodeStatus = "empty"`, `bodyText = null`.

Repair re-reads `ebay_message_headers` by `id` with the same LEFT JOIN, so the
body is picked up whenever it lands.

| Marketplace | Body location | Can a body arrive late? |
| --- | --- | --- |
| eBay | separate `ebay_messages` row | **yes** — this is the failure |
| Amazon | `amazon_messages.message_content`, inline | no |
| Shopify | `.message_content`, inline | no |
| B&Q | `.message_content`, inline | no |
| Temu | `.message_content`, inline | no |

Repair covers all five anyway: an inline body cannot arrive late, but a row can
still be corrected upstream, and a uniform path costs nothing to keep.

`cst_app.conversation_messages` gains no column. The repair writes `body_text`
and `body_decode_status` and nothing else — `direction`, `source_ts` and
`external_message_id` are INSERT-only in the upsert.

## Added: no new mapping — one existing read moved from filter to projection

The notification fix introduces **no source mapping, no column and no table**. It
reads exactly the three application tables the feed already read:

| Read | Already written by | Role before | Role after |
| --- | --- | --- | --- |
| `cst_app.conversations` | `lib/sync/conversation-writer.ts` | candidate set | unchanged |
| `cst_app.conversation_messages` | the same writer | newest inbound; reply test | unchanged |
| `cst_app.draft_replies` (existence only) | `lib/sync/draft-writer.ts` | **exclusion predicate** | **projected label `has_draft`** |

The last row is the whole change. The same existence test, against the same
table, moved out of the `WHERE` clause and into the `SELECT` list.

**Why that is a mapping question and not just a query one.** A predicate and a
projection make different claims about what the data MEANS. As a predicate, the
presence of a draft row was being read as "this customer has been dealt with" —
a claim about the customer. The row does not support it: `draft_replies` records
what WE wrote, and nothing in `cst_app` records that anything was sent, because
nothing can send. As a projection it makes the claim it can support: a draft
exists.

The only mapping that can answer "has this customer been replied to" is
`conversation_messages.direction = 'outbound'` ordered after their newest
inbound message, which is what the surviving predicate uses — the same
`(source_ts, source_pk)` row-value ordering `sync_state` uses for its watermark,
so a reply landing in the same second is ordered rather than missed.

It still never reaches the marketplace source database.
