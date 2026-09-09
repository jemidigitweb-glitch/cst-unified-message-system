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

## Added: order-change notification list

A **notification bell** sits at the top right of the workspace header, carrying
a count of conversations classified `"Order change, before shipping queries"`
that nobody has answered — a customer message exists, no draft was ever written,
and no reply of ours came after that message. Clicking it opens a right-side
drawer listing them; clicking one closes the drawer, switches to that
conversation's own marketplace and opens it.

**GLOBAL, NOT SCOPED TO THE SELECTED TAB.** An Amazon customer waiting on an
order change is waiting whether or not the reviewer is looking at eBay, so the
bell counts every marketplace and each row names its own. This is the only
global list in the workspace; the inbox, the No Rule list and the unresolved
feed remain per-marketplace, because those are the working lists read inside one
tab.

The count is on screen whichever view is open, because the list is fetched up
front rather than when the bell is clicked, and it is refreshed when a draft is
generated so a conversation just answered leaves the badge. There is no
notification store, no read/unread state, no dismissal, no polling, no browser
notification and no sound — the bell reads a list and opens a drawer.

**A measured limitation, not a theoretical one.** The case area is read from the
customer's own words on every request rather than stored, so it cannot be a
database filter: the query bounds the UNANSWERED conversations and the reading
narrows them afterwards. The unanswered queues are wildly uneven, so the bound
is applied PER MARKETPLACE rather than globally — measured live on 2026-09-08:

| Marketplace | Unanswered (reply inbox) | Also unanswered but filtered out of the inbox | Window | Complete? |
| --- | --- | --- | --- | --- |
| Shopify | 3,342 | 4,452 | 100 | no |
| eBay | 309 | 0 | 100 | no |
| Amazon | 44 | 0 | 100 | **yes** |
| B&Q / Temu | — | — | not read | category suppressed at source |

A single shared window of 100 was ~90% Shopify and returned **nothing** for
Amazon or eBay; the one Amazon conversation waiting for an order-change reply
was invisible. Partitioning the bound restored it. The drawer says how far it
looked; the bell cannot, because a badge has nowhere to put a caveat.

Live result on 2026-09-08: **3 notifications** (2 Shopify, 1 Amazon) from 244
candidates read across three marketplaces, in ~2.7s.

It is a READ layer. Selecting a row opens the same conversation, context panel
and draft panel as the inbox does; nothing about the list writes, decides or
advances anything. B&Q and Temu produce no rows, because their category is
suppressed at source (see `CATEGORY_SUPPRESSED_MARKETPLACES`) — that is
inherited, not a new rule.

Still cannot send anything to a customer. Nothing here adds a state after
`reviewed`.

## Added: the AI can now act on what we already told this customer

A draft can carry forward a remedy this team offered and the customer accepted,
and it no longer repeats what has already been settled.

**What it can do that it could not.** Where a previous reply offered a resend,
replacement, refund, return or collection and the customer has since accepted
it, the draft confirms the action and says what happens next. Before this, the
model treated its own team's offer as an unverified claim and refused it — the
traced case is a customer told there was no tracking update, offered a resend,
who replied "Yes please resend asap" and was answered with a refusal.

**What it still cannot do, and this is the boundary that matters.** An
agreement establishes the DECISION, never the OUTCOME. The draft may say we are
arranging something. It may **not** say it has been sent, dispatched, posted,
processed or issued, and may not give a date, a courier or a tracking number,
unless the verified context establishes it. That restriction is enforced
deterministically, not by instruction: "we have arranged a replacement" can be
grounded on the agreement, "we have dispatched a replacement" cannot, agreement
or no agreement.

**It also stops repeating itself.** Once a fact has been given to the customer
and the conversation has moved to an agreed action, the draft carries the
action forward instead of restating the background. It still states it again
when it answers the latest message, clarifies the agreed action, the customer
asks again, or a CST rule requires it. Nothing was removed from what the model
is given — the tracking block, scan history and delivery status reach it
identically whether the conversation has settled or not.

Still cannot send anything. Nothing here adds a state after `reviewed`.

## Added: what the system knows about a product, measured

Investigated after a pre-sale draft answered *"I'll check the exact weight and
come back to you"* to a customer asking the weight of a lampshade. The draft
was correct, and the investigation is recorded here because the capability
question it answers is not the one the report assumed.

**The system cannot state the weight of any product, because no weight is
recorded anywhere it can read.** `weight_g` exists on all 1,824 SOT SKUs and is
unusable on every one — 1,155 `NULL`, 669 `[VERIFY]`, zero real values. The
same holds for `packaged_weight_g`, `volumetric_weight_kg`, `outer_weight_kg`
and `chargeable_weight_kg`. `suppliers.child_item_products` holds 119 rows and
no weights. This is a **data gap, not a capability gap**: no code change
produces the answer, and the drafting layer behaved exactly as designed by
declining to invent a number.

**What the system CAN state about a product is better than previously
recorded.** The figure repeated in these folders — the SOT catalogue resolving
for 3 of 869 eBay listings — describes only the parent-listing route. Measured
2026-09-09 across all 31,155 parent listings:

| Route to the SOT catalogue | Listings reached |
| --- | --- |
| Parent listing SKU (`resolveSotProductContext`) | 308 (1.0%) |
| Component decomposition (`order_combo`, used by the bundle resolver) | **19,319 (62%)** |

The parent route is the weak leg: 4,768 parent rows carry the placeholder
`"sku not assigneds"` and 1,089 carry a combo SKU no catalogue indexes. The
bundle resolver already reads the component route, which is why the traced
pre-sale conversation received verified catalogue facts at all.

On that listing (a 7-pattern mosaic shade) the bundle path supplied the 15
attributes every pattern agrees on — `E27`, `E26 / E27` compatible, Easy Fit,
Glass, 40mm hole, 42mm ring, max bulb 60W / 80mm / 140mm — and correctly
withheld `diameter_mm`, `height_mm` and `shade_shape`, because the patterns
genuinely differ (135/150/160/190mm). The variant-agreement rule works as
designed.

## Next pending items

- **Populate `Weight_g` in the SOT sheet.** It is unset for all 1,824 SKUs, so
  every weight question is unanswerable today. This is a data owner's task, not
  a code change.
- Marketplace reply sending — not built, out of Phase 1 scope.
- Automatic sending.
- Invoice email sending.
- VAT invoice generation (needs the business VAT rule stated first).
- Seller / company details on the invoice.
- Billing address rendering on the invoice.
- Full accounting integration.
- Order context for marketplaces other than eBay.

## Added: message body repair

A message can now be shown that could not be shown before, without any new
capability being granted. Repair reads rows CST already holds and fills in text
CST already had permission to read.

- **New:** `npm run repair:bodies` re-reads the source rows behind messages
  stored without a usable body, and updates the body only.
- **Unchanged:** the system still cannot send, still cannot write to a
  marketplace, and still holds no capability it did not hold yesterday.
- Measured on 2026-09-08: 795 eBay messages were displaying as blank; 74 had text
  waiting in the source and now render. The remaining 721 are blank at source.
- Amazon (168) and Shopify (14) blanks were examined and are genuinely empty at
  source — those sources keep the body inline, so there is no late-arriving row
  for repair to find.

Not a workflow state, not a background job, not a schedule. An operator runs it.
