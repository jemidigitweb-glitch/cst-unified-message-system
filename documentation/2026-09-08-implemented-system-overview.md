# Implemented system overview — 2026-09-08

## Purpose

A single technical description of the CST Unified Message System as it exists
today, for a developer or team member picking it up. It describes what is built,
not what is planned.

## Current status

Running Phase 1. Live eBay, Amazon, Shopify, B&Q and Temu customer messages are
retrieved, threaded and displayed. eBay conversations additionally resolve
verified order, listing, return and tracking context, ground an AI draft reply
for human review, and can produce an on-demand invoice PDF.

`npm test` on 2026-09-08: **3,365 tests passed, 32 skipped, 124 test files
passed, 13 skipped** (the skipped files are opt-in live-source suites).

Nothing in the system can send a reply to a customer.

## Implemented features

### 1. Marketplace message retrieval

`lib/sync/message-sync.ts` orchestrates the sync. Each marketplace keeps its own
reviewed adapter, message repository and thread builder under
`lib/marketplaces/<name>/`; the sync loop only moves rows.

- Incremental: each feed resumes from a `(timestamp, pk)` watermark in
  `cst_app.sync_state`, using a row-value comparison so a page boundary neither
  skips nor replays a row.
- Idempotent: uniqueness on `conversations(threading_rule_version, thread_key)`
  and `conversation_messages(source_database, source_schema, source_table,
  source_pk)` means a repeated run upserts rather than duplicates.
- Scheduled by `npm run sync:auto` (`scripts/run-message-sync.mjs`), registered
  as a Windows scheduled task by `scripts/register-message-sync.ps1`. There is
  also `/api/cron/sync`.

### 2. Threading and display

- No marketplace source exposes a thread id, so a thread key is derived
  (`lib/domain/threading.ts`) as a canonical JSON array — a delimiter join would
  let two different customers collide into one thread.
- Conversations segment when the gap between consecutive messages exceeds
  30 days.
- The key carries the identifier of the rule that produced it, so grouping can
  be recalculated later without corrupting saved work.
- `components/conversation-view.tsx` renders messages oldest → newest, customer
  on one side and CST replies on the other, opening the thread at its newest
  message.
- A conversation only enters the reply inbox if it holds at least one inbound
  customer message.

### 3. Order context (eBay)

`lib/context/resolve-order-context.ts` matches on the conversation's own keys —
storefront `sub_source_id`, listing item reference, buyer username.

- **Exactly one match** → eight verified facts: `order_number`, `order_status`,
  `order_date`, `tracking_number`, `delivery_courier`, `delivery_address`,
  `sku`, `product_title`. Recorded as `deterministic_single`, which states
  plainly that no human confirmed it.
- **Several matches** → ambiguous. The candidates are shown and the system
  waits. No ranking, no newest, no first. Order-derived facts stay out of the
  draft until a human selects.
- **No match** → `lib/context/resolve-fallback-order-context.ts` offers the one
  same-storefront order for that buyer, if there is exactly one. Gated on the
  stored `no_order` resolution so it can never pre-empt a real match.
- A human's selection is validated by membership of the candidate set
  (`lib/context/resolve-selected-order-context.ts`). It is an input to one
  generation and is never written down as a resolution.
- The selected order travels as the internal `orders.id`. The customer-visible
  order number is display and filter only.
- Resolved once, then cached in `cst_app.context_snapshots`.

### 4. Listing and product context

- `lib/context/resolve-listing-context.ts` — the listing the customer clicked:
  title and the variation options the listing offers. Separate from the order,
  because a pre-sales question is about the listing, not a purchase.
- `lib/context/resolve-listing-link.ts` + `/api/conversations/:id/listing` — the
  listing URL, on its own route so it works where no order resolved.
- `lib/context/resolve-sot-product-context.ts` — the SOT catalogue, where it
  resolves (3 of 869 eBay listings).
- SKUs are atomic everywhere. A combo SKU such as `AAA+BBB+CCC` is one
  identifier with its own product master row. There is no `parseSku`,
  `splitSku` or `normalizeSku` in the codebase.

### 5. AI draft

- `lib/ai/draft-service.ts` picks the provider in one place: `DRAFT_PROVIDER`
  when set, otherwise OpenAI (CST knowledge in a vector store, retrieved per
  conversation) and Gemini as fallback (all rules inline).
- `lib/ai/instructions.ts` holds the shared CST instruction — reproducing the
  CST ChatGPT project instruction plus four guards written after specific
  failures: marketplace isolation, never invent, stated vs verified, nothing
  internal.
- `lib/ai/draft-assembly.ts` builds the prompt: the conversation, the verified
  context block (stating plainly when there is none), the classifier's reading
  of the customer's intent marked as internal guidance rather than fact, and the
  applicable CST rules.
- `lib/ai/draft-validation.ts` checks the returned draft deterministically —
  contradicts a verified fact, rule not followed, intent not addressed,
  unsupported claim, internal language leaked. A failing draft is regenerated
  **once** with the findings as corrections, and whatever comes back is still
  shown to a human. No model grades another model.
- `GET`/`POST`/`PATCH` on `/api/conversations/:id/draft` are the only mutating
  handlers in the application. There is no `DELETE` — revision history is
  append-only.

### 6. Invoice

- `lib/context/resolve-invoice-order.ts` decides which order, if any, a
  conversation may invoice. Same precedence as the order routes: single strict
  match → that order; ambiguous with a valid reviewer choice → that order;
  `no_order` with a valid reviewer choice → that order; anything else → none.
- `lib/repositories/order-invoice-repository.ts` reads the invoice context for
  that one order by `orders.id`. It has no buyer, listing or storefront
  predicate, no `ORDER BY` over orders and no `LIMIT` — it can never pick.
- `lib/documents/invoice-document.ts` lays the document out;
  `lib/documents/pdf.ts` is a 430-line minimal PDF writer (no new dependency —
  the project's runtime dependencies are only `next`, `pg`, `react`,
  `react-dom`, `server-only`, `zod`).
- `GET /api/conversations/:id/invoice[?selectedOrder=...]` returns PDF bytes
  with `Cache-Control: no-store, private`.
- The "Print invoice" button appears in the context panel exactly where the
  endpoint would answer.

**PDF contents:** order number, order date, order status, seller VAT
registration availability, a billing section, item lines (SKU, description,
quantity, unit price), subtotal, shipping, discount, tax, total, amount paid,
payment method, paid-at, the currency the amounts are in, and any
customer-relevant warning (cancelled / refunded).

**Nothing on the page is calculated.** Every figure is a string that came out of
the database — no line total, no VAT rate, no net/gross split, not even a
reformat. A field the source did not record prints as `—`, never `0.00`. The one
numeric operation is text measurement, for wrapping and right-alignment.

### 7. Supporting features

- Category and priority classification of conversations, with a rule-coverage
  check and a "no applicable rule" flag.
- Verified tracking context with customer-safe language (a scan says the parcel
  is moving; a dispatch note does not).
- Return context, matched on `order_id` + `item_id` + `sub_source`, only after a
  verified single order.
- AI usage logging (`cst_app.ai_usage_log`) and a usage panel.
- Conversation export.

## Database / data source

Three pools (`lib/db/pools.ts`), created lazily:

| Pool | Access |
| --- | --- |
| Source marketplace database (`ledsone`) | **read-only**, `default_transaction_read_only=on` pinned at session level |
| Application database (`cst_app` schema) | read/write |
| Knowledge database | read-only |

- No ORM. The source has no foreign keys, so every join is explicitly reviewed
  SQL. All queries are parameterised.
- Migrations are forward-only numbered `.up.sql` / `.down.sql` pairs under
  `migrations/`, targeting `cst_app` only. `0001`–`0010` exist on disk.
- TLS: `DB_SSL_MODE` defaults to `require` (encrypted, certificate not
  verified). `verify` is a production hardening step once a CA certificate is
  available.
- Every credential is server-side only. Nothing is exposed under
  `NEXT_PUBLIC_`, and config modules are marked `server-only`.

## User workflow

```
Live message → thread → verify context → AI draft
→ review / edit / regenerate → save → reviewed → STOP
```

1. Agent opens a marketplace tab and picks a conversation.
2. The context panel shows the verified order, listing and (where relevant)
   return and tracking context. If several orders matched, the agent picks one.
3. Agent generates a draft, edits or regenerates it, saves it, and marks it
   reviewed. `reviewed` is terminal.
4. At any point once one order has resolved, "Print invoice" opens the invoice
   PDF in a new tab for printing or saving.

## Known limitations

- Order, listing, return, tracking and invoice context are eBay only.
- Amazon and Shopify grouping and customer identity are unverified at the
  source; B&Q and Temu carry no item reference and no CST reply history.
- eBay customer messages carry no attachment data at the source, so a
  customer-uploaded photo cannot be shown for eBay.
- The invoice prints no billing address and no seller/company block — the
  resolver carries the billing party as a presence boolean only.
- No VAT figure is produced and the document is never headed "VAT Invoice".
- No invoice is stored: the PDF exists only for the length of the response.
- The application has no user identity, so a selection cannot be recorded as
  `user_confirmed`.
- The source timestamp zone is unconfirmed; timestamps are stored naive and
  copied verbatim.

### 8. Order-change notification list

A **notification bell** at the top right of the header, counting the
conversations classified `"Order change, before shipping queries"` that nobody
has answered — **across every marketplace, independently of the selected tab**.
Clicking it opens a right-side drawer; clicking a row closes the drawer,
switches to that conversation's own marketplace and opens it.

Global by design: an Amazon customer waiting on an order change is waiting
whether or not the reviewer is looking at eBay. This is the only global list in
the workspace — the inbox, the No Rule list and the unresolved feed are the
working lists read inside one tab and stay scoped to it.

- `lib/repositories/conversation-repository.ts :: listAwaitingResponseByCategory`
  runs one statement: a CTE with an inner `JOIN LATERAL` for the newest customer
  message, `inbox_visibility <> 'filtered'`, a `NOT EXISTS` on the draft row, a
  `NOT EXISTS` on any reply ordered after that message by row-value comparison,
  and a `row_number()` partitioned by marketplace. Then the category is matched
  in application code, because it is not stored.
- **The bound is per marketplace, not global.** Measured live: Shopify has 3,342
  unanswered conversations to eBay's 309 and Amazon's 44, so one shared window
  is ~90% Shopify and the single Amazon conversation waiting for an order-change
  reply fell out of it entirely. Every marketplace gets a window of the same
  size; the expensive per-row reads run only on what survives it.
- `GET /api/conversations/awaiting-response` — read-only, GET only, **no
  parameters**: the marketplace list is built server-side from a fixed
  allowlist, so there is nothing to supply and nothing to validate.
- `components/notification-bell.tsx` is the header control and the whole of the
  indicator: no provider, no store, no browser notification, no sound, no
  polling. `components/notification-drawer.tsx` is a `fixed` overlay, not a
  layout column — it is read INSTEAD of a conversation, not alongside one, so
  giving it a grid track would narrow the conversation permanently for something
  on screen for two seconds. Selecting a row calls the same `select(id)` the
  inbox list calls, so the conversation view, context panel and draft panel are
  reached exactly as they always were and know nothing about it.
- **Bounded by candidates, not by matches.** The query limits the unanswered
  conversations and the classifier narrows them afterwards, so a page can
  legitimately return two matches from a hundred candidates. `scanned` and
  `hasMore` travel with the response and the drawer prints them when it did not
  reach the end. See `capability/` for what that measures live per marketplace.
- Nothing here writes, classifies or advances anything. No migration, no stored
  category, no workflow state.

The design analysis behind it, including why no table was added, is
[2026-09-08-order-change-notification-analysis.md](2026-09-08-order-change-notification-analysis.md).

## Next pending items

- Marketplace reply sending — not built; no send button, endpoint, queue,
  connector or credential exists.
- Automatic sending.
- Invoice email sending.
- VAT invoice generation.
- Seller invoice details and billing address rendering.
- Full accounting integration.
- Phase 2 work.

## Added: message body repair

**The symptom.** A customer's message appears in the thread as an empty bubble,
even though they plainly sent text.

**The cause.** eBay writes a message header and its body into two different
tables, and not at the same time. The sync reads strictly forward of a
`(timestamp, pk)` watermark — which is what makes it resumable — so a header
ingested before its body existed is stored honestly as `empty` and is never
looked at again.

**The fix.** `npm run repair:bodies` asks `conversation_messages` which rows have
no usable body, re-reads exactly those source rows by primary key, and writes the
body back through the sync's own upsert statement. No cursor is consulted, so it
can run at any time, including during a sync.

```
cst_app.conversation_messages          source, read-only
  where body_decode_status <> 'decoded'
        │
        └── source coordinates ──▶ re-read those rows by pk
                                        │
                        marketplace's own normaliser
                                        │
                   decoded and non-blank?  ── no ──▶ skip, with a named reason
                                        │ yes
                                        ▼
                    the sync's UPSERT_MESSAGES, body columns only
```

Dry run is the default. Idempotent: a repaired message is `decoded` and drops out
of the candidate set, so a second pass finds nothing.

First run, 2026-09-08: 795 eBay messages examined, **74 repaired**, 721 skipped
as still empty at source. Second pass repaired 0.
