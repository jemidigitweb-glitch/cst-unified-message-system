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

## Added: order-change notification list — decisions taken

**Superseded in part — see "Made global" below.** Originally a per-marketplace
read layer listing
`"Order change, before shipping queries"` conversations with no draft and no
reply after the customer's newest message.

**The decisions, and why each went the way it did:**

1. **No new table, no migration.** Every condition is answerable from
   `conversations`, `conversation_messages` and the existence of a
   `draft_replies` row. Migration `0009` set the standard for when a table IS
   required — a finding that has to outlive the page — and nothing here is such
   a finding. A stored flag would drift the moment the phrase table changed.
2. **The category is filtered in application code, not in SQL.** It is not a
   column and must not become one; see `data-maps/`.
3. **The draft test is the absence of the ROW, not `workflow_state`.** A saved
   human edit appends a revision and advances no state, so the state is a proxy
   that would show an edited conversation as untouched.
4. **"No CST reply" was read as "no reply after the customer's newest message",**
   not as "no outbound message ever". A thread we answered in June and the
   customer wrote to again in August is unanswered work. This was the one
   genuinely ambiguous requirement; the stricter reading would have hidden
   exactly the conversations most likely to need attention.
5. **A bell and a right-side drawer.** This replaced a first attempt that put
   the list in the left column under an "Order Change" tab. The tab was the
   wrong shape: No Rule and AI Usage change WHAT IS ON SCREEN, and a
   notification does not — it opens over whatever the reviewer was doing and
   closes when they pick something. The drawer is a `fixed` overlay rather than
   a grid column for the same reason, and because two standing guards fix the
   workspace at exactly two `<aside>` elements with the details panel last.
   The tab, its `view` value and `components/order-change-list.tsx` were all
   removed; a guard asserts they stay removed.
6. **No global notification framework.** No provider, no store, no context, no
   toast, no browser Notification, no sound, no polling, no read/unread state
   and no dismissal. One boolean, one already-fetched list. A row leaves the
   list when a draft is written or a reply lands, and by no other means —
   there is deliberately nowhere to record "I have seen this".
7. **Bounded, and it says so.** The query bounds the unanswered conversations
   and the classifier narrows them afterwards, so the response carries `scanned`
   and `hasMore` and the drawer prints a line when it did not reach the end. A
   silent cap would read as "there are none".

   **Measured live, this is now a known gap rather than a caveat.** eBay returns
   0 matches from 100 candidates with more below, so its bell reads empty while
   unanswered order-change conversations may exist. The drawer can say so; a
   badge cannot. **Open for the requester**: raise the bound, narrow the
   candidate set further in SQL, or accept a recent-window notification. Nothing
   was changed unilaterally, because each option costs something different
   (classifier time, query complexity, or coverage).

**Explicitly not done:** no migration, no write, no stored category, no change
to sync, grouping, the classifier, AI drafting, the draft workflow, the reply
workflow or order context.

## Made global — decisions taken

The feed followed the selected marketplace tab, which meant an Amazon customer
waiting on an order change was invisible to a reviewer working eBay. It is now
cross-marketplace and independent of the tab.

1. **One query, not one per marketplace.** `= ANY($1::text[])` over an allowlist
   array built server-side, so the route takes no parameter at all and there is
   nothing to validate.
2. **The bound had to become per marketplace, and this was not optional.** A
   naive global `LIMIT 100` over the newest unanswered conversations was ~90%
   Shopify (3,342 unanswered, against eBay 309 and Amazon 44) and returned
   **zero** Amazon and **zero** eBay notifications — it failed the requirement
   it was written for. `row_number() OVER (PARTITION BY marketplace)` gives each
   its own window; the Amazon notification came back immediately.
3. **`filtered` conversations were excluded.** Not asked for, and worth stating
   plainly as a judgement: a bounce or a courier notice is not a customer
   waiting for a reply, and 4,452 of Shopify's unanswered conversations are
   these. They still appear in the inbox, labelled; they just no longer notify.
   **Reversible in one predicate** if the business disagrees.
4. **Clicking a notification switches the tab.** The detail route 404s a
   conversation that does not belong to the marketplace named in the request —
   a deliberate guard — so `select()` now takes the marketplace explicitly,
   defaulting to the selected one. Every existing caller is unchanged.
5. **A standing guard was strengthened, not relaxed.**
   `marketplace-ui.test.ts` pinned the detail request to the selected tab by
   literal. That guarantee still holds but is now upheld by a default plus a
   rule, so the assertion was rewritten to check all three parts — including
   that any caller overriding the marketplace switches the tab to the same
   value. It is a stricter test than the one it replaced.
6. **The feed is no longer per-marketplace state.** It is not cleared on a tab
   switch and not refetched by the `[marketplace]` effect; it refreshes when a
   draft is generated, so a conversation just answered leaves the badge.

## Next pending items (explicitly NOT closed)

- Marketplace reply sending.
- Automatic sending.
- Invoice email sending.
- VAT invoice generation.
- Seller invoice details.
- Billing address expansion.
- Full accounting integration.
- Phase 2 work of any kind.
