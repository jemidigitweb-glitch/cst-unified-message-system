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
  eBay conversations, the SOT catalogue for 3 of 869 *by the parent-listing
  route*. See the SOT section below: the component route reaches far more, and
  the bare figure understates what the system can describe.

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

**Superseded in part — twice.** See "Made global" below, and "the notification
draft condition" below that, which **reverses decision 3 and the first half of
decision 6**: a draft no longer removes a row from the list. Originally a
per-marketplace read layer listing
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

## Added: prior CST replies as agreed decisions — decisions taken

Closed. A draft now carries forward a remedy this team offered and the customer
accepted, and does not restate background the conversation has moved past.
Commit `5bc614c`.

**The decisions, and why each went the way it did:**

1. **Agreement establishes the DECISION, never the OUTCOME.** This is the whole
   safety argument and it is enforced in code, not only in the instruction. The
   replacement claim pattern in `lib/domain/draft.ts` was **split in two**:
   "we have arranged a replacement" carries `commitment: "replacement"` and can
   be grounded on an agreement; "we have dispatched a replacement" carries
   nothing and is blocked exactly as before. Exactly one pattern carries a
   commitment. A refund claim is not grounded by a resend agreement.
2. **The offer must be OURS and the acceptance must come AFTER it.**
   `acceptedCommitments` reads the turns in order and an acceptance only counts
   for an offer already seen. A customer asking for a resend unprompted grounds
   nothing, and neither does a reply that merely NAMES a remedy while declining
   it — an offer construction has to be present.
3. **Acceptance is read per sentence, not per message.** "Yes but how long would
   a resend take?" is a question, not agreement. "Yes please resend asap. How
   long will it take?" is agreement that also asks. Reading the whole message
   would have got one of those wrong whichever way it went.
4. **An unreadable body grounds nothing.** The commitment reader goes through
   `displayBody`, so an offer whose body did not survive decoding cannot be
   asserted to have been made.
5. **Nothing is stored.** No table, no column, no migration, no snapshot. The
   commitment is re-read from the thread on every draft call, like the category
   and the intent. A stored decision would drift the moment the offer wording
   changed, and would need the backfill this avoids.
6. **The default is the old behaviour.** `ungroundedClaims` and
   `settleReviewRequirement` both take the commitments list as a parameter
   defaulting to `[]`, so every existing caller — including
   `lib/ai/draft-generator.ts`, which is off the live path — is byte-identical
   and still blocks the promise.
7. **The classifier was not touched.** `WANTS_A_RESEND` was added **beside**
   `WANTS_A_REPLACEMENT` and wired only into `detectIntents`, deliberately not
   merged into it: `WANTS_A_REPLACEMENT` is also read by `refine` for the
   `exchange_or_replacement` CATEGORY decision, and the classifier is frozen
   against a compiled baseline. Widening it there would have moved the baseline.
8. **The cost guard was respected, not raised.** The instruction addition first
   broke `draft-validation-cost.test.ts` at 2,224 tokens against a 2,000 ceiling.
   The guard exists to catch the ~127,000 token corpus going inline, so it was
   left alone and the block was rewritten from 753 to 513 tokens. Composed input
   now measures 1,984.75.
9. **The accuracy gate had to change too, and this was not optional.** The
   correct terse reply raised **two critical** `intent_not_addressed` findings,
   so the gate would have bought a regeneration telling the model to put the
   background back. The reply-side coverage vocabulary did not know the word
   "resend". Widening it can only remove findings, never create them.

**Explicitly not done:** no migration, no write, no stored commitment, no change
to sync, grouping, threading, message ordering, the classifier's category
decision, the draft workflow or order context. Nothing was removed from the
model's input.

**Left open deliberately:** a separate, quantified ordering defect surfaced
during the investigation and was **not** fixed, because it was outside the
brief. Outbound eBay messages are timestamped from `receive_date`, which runs a
mean ~4.4 hours earlier than the unused `response_date`; 23.5% of replies are
ordered earlier in the thread than they were actually sent. It did not cause
this bug — the thread reached the model complete and in a consistent order —
but it is a real finding and it is recorded here rather than lost.

## Added: pre-sale SOT product facts — investigated, nothing closed

A pre-sale draft declined to state a product's weight. **No code change was
made and none is warranted**; recorded here so the question is not reopened
from zero.

The finding: **no weight exists to state.** `weight_g` is `NULL` or `[VERIFY]`
on all 1,824 SOT SKUs, and the same holds for every packaged, volumetric, outer
and chargeable weight column. The pipeline resolved the listing correctly, the
bundle path supplied 15 verified attributes, and the model declined to invent
the one number nobody has recorded. That is the designed behaviour.

**One figure in this document was wrong and is now corrected.** "The SOT
catalogue for 3 of 869" describes the parent-listing route only. Across all
31,155 parent listings the parent route reaches 308 (1.0%); the component route
the bundle resolver already uses reaches **19,319 (62%)**.

**Open, and deliberately not taken unilaterally:** `resolveSotProductContext`
passes the placeholder SKU `"sku not assigneds"` (4,768 parent rows) to the
catalogue lookup as though it were a SKU. It misses harmlessly today, so those
4,768 listings depend on the *absence* of a catalogue row under that literal
string. Rejecting the placeholder before the lookup is ~3 lines and changes no
draft. **Not** done: it is hardening, not a fix, and this task was an
investigation.

**Explicitly rejected:** matching a customer's words to a variation ("style3" →
"Pattern 03"). It is the guess the resolver's whole design exists to prevent,
and it would not have produced a weight anyway.

## Next pending items (explicitly NOT closed)

- Marketplace reply sending.
- Automatic sending.
- Invoice email sending.
- VAT invoice generation.
- Seller invoice details.
- Billing address expansion.
- Full accounting integration.
- Phase 2 work of any kind.

## Added: message body repair — what is closed and what is not

**Closed.** Messages stored blank because their body had not yet reached the
source can now be repaired, for every marketplace, from one command. The path is
idempotent, bounded, dry-run by default, and reuses the sync's own upsert.

**Deliberately NOT in scope, and each was considered:**

- **No schedule.** Repair is not wired into `sync:auto` or the cron route. It is
  a second read of the same source rows, and making it automatic would double
  the source load every hour to catch a handful of rows. An operator decides.
- **No rewind.** `sync_state` is never read or written. The forward-only
  watermark is what makes the sync resumable; repair works around it by naming
  rows instead of moving the cursor.
- **No re-threading.** The thread builder is not called. A repaired message keeps
  the `conversation_id` it already had.
- **No backfill of history.** Repair only considers rows already stored. It
  cannot import a message the sync never saw.
- **No UI change.** A repaired body renders through the existing `displayBody`
  path. The blank-message placeholder still reads the same for a message that is
  genuinely empty — telling those two apart on screen is not built.

## Added: the notification draft condition — closed, and a decision reversed

Closed. The notification feed no longer treats a generated draft as an answer.
Commit follows this document.

**This reverses decision 3 of "order-change notification list — decisions taken"
above**, which chose the absence of the draft ROW over `workflow_state` as the
test for "nobody has dealt with this". That reasoning was right about
`workflow_state` and wrong about the question. Both measure OUR progress; the
notification asks about the CUSTOMER's. Only an outbound reply answers it.

**The decisions, and why each went the way it did:**

1. **The predicate was deleted, not narrowed.** There is no version of "a draft
   means answered" that is true here: `reviewed` has no outgoing transition and
   a standing guard fails the build if any send capability appears, so a draft
   is work in progress by construction. A weaker form — say, excluding only
   `reviewed` conversations — would reintroduce the same bug for the same reason.
2. **`has_draft` moved to the projection rather than being dropped.** The
   information is useful; using it as a filter was the mistake. The drawer now
   labels a row "Draft ready" / "Needs review" / "Reviewed · not sent" and
   removes none of them.
3. **The label is read in the OUTER query.** Ranking happens in the CTE and the
   expensive per-row reads sit outside it, so the new `EXISTS` costs only rows
   that survived the per-marketplace window — the same discipline the three
   existing correlated subqueries already follow.
4. **`workflow_state` still does not become the filter.** A saved human edit
   appends a revision and advances no state, so it under-reports work; and
   `reviewed` means reviewed HERE, not sent. A test pins that neither
   `'received'` nor `'reviewed'` appears in the statement.
5. **The refresh-on-draft-generation was kept.** It no longer removes the row —
   that was the bug — but writing a draft still changes what the row says about
   itself, so the feed must re-read. It remains the only refresh: no interval,
   no polling, no subscription.
6. **The boolean is coerced, not trusted.** `row.has_draft === true`, so a
   driver returning `"t"`, `1` or `null` cannot silently label every row as
   drafted.

**Explicitly not done:** no migration, no schema change, no new table, no change
to AI drafting, draft generation, the draft workflow, the sending workflow (there
is none) or order context. No existing filter was touched — the category
matching, per-marketplace bound, `filtered` exclusion and ordering are unchanged.

**Accepted consequence, recorded rather than hidden.** A reply sent outside this
system retires its notification only when the outbound message syncs back from
the marketplace. Until then the conversation keeps notifying, labelled
"Reviewed · not sent". This is the honest reading — nothing here observes
sending — and the alternative was rejected under decision 1.
