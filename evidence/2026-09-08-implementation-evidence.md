# Implementation evidence — 2026-09-08

## Purpose

Proof that the implemented system was actually checked, and a record of what the
checks show. No customer data appears in this folder.

## Current status

Full automated suite green on 2026-09-08. The invoice path has unit, guard and
opt-in live-source coverage. No screenshots have been captured for the invoice
feature yet — that is the one gap in this folder.

## Implemented features (evidence held)

### Test run — 2026-09-08

```
npm test   (vitest run)

Test Files  124 passed | 13 skipped (137)
Tests       3365 passed | 32 skipped (3397)
Duration    33.40s
```

The 13 skipped files are opt-in live-source suites. They are skipped by design
and only run when an operator sets the relevant environment variable.

### Standing guards (fail the build if violated)

| Guard | What it proves |
| --- | --- |
| `tests/guards/no-send-capability.test.ts` | Nothing in `app/` or `lib/` can transmit a reply. Scans for sending identifiers and for post-review workflow states (`approved`, `sending`, `sent`, `manual_handoff`). |
| `tests/guards/no-customer-data.test.ts` | No real customer data in tracked files. Scans `git ls-files`. |
| `tests/guards/invoice-route.test.ts` | The invoice endpoint reads only `selectedOrder` from the request, refuses with 409 before rendering when no order resolved, writes nothing, stores nothing, logs no customer data, and never names `order_management.shipment`. |
| `tests/guards/print-invoice-button.test.ts` | The button appears exactly where the endpoint would answer, and the request carries a conversation id and a choice — never an order row id. |
| `tests/guards/draft-workflow.test.ts` | The workflow terminates at `reviewed`. |
| `tests/migrations/cst-core-schema.test.ts` | Migrations touch `cst_app` only, statically, without connecting to a database. |
| `tests/guards/file-naming.test.ts` | Migration naming convention. |

### Behavioural coverage for the invoice path

- `tests/repositories/order-invoice-repository.test.ts` — header/line mapping,
  `real_*` precedence, warning vocabulary, duplicate-row handling, row-id shape
  rejection.
- `tests/context/resolve-invoice-order.test.ts` — the four-branch precedence,
  including "ambiguous without a choice returns null" and "a choice naming an
  order the reviewer was never offered returns null".
- `tests/documents/invoice-document.test.ts` — layout, wrapping, the `—` absence
  marker, the customer-visible warning allow-list, and that no figure is derived.

### Opt-in live-source check

`tests/source-validation/order-invoice-live-source.test.ts`

```
CST_INVOICE_LIVE=1 CST_INVOICE_ROW_IDS=<ids> \
  npx vitest run tests/source-validation/order-invoice-live-source.test.ts
```

- Every statement is a `SELECT` on the read-only pool.
- Asserts on row ids, order numbers, statuses, counts and flags only. No name,
  address, email or phone number is read or logged — the repository returns the
  billing party as a boolean.
- **No row ids are committed.** A source row id identifies one real customer's
  order, so the operator supplies them per run and the file holds none. Without
  them the suite skips.
- `CST_INVOICE_PDF_OUT` can write a rendered PDF to a gitignored directory for
  visual inspection. A rendered invoice carries a real order number, SKUs and
  prices — it is an artefact to look at and delete, never to commit.

### Measured source facts behind the invoice decisions

These were established by read-only investigation and are recorded because they
are the reason the feature is shaped the way it is:

| Finding | Measurement |
| --- | --- |
| The order is the invoice | Billing party exists for 1,133,659 of 1,133,660 orders; 14 of 14 traced real invoice-request orders |
| Billing is a genuinely separate party | 34,926 orders (3.1%) carry a different billing street; 23,756 (2.1%) carry a billing company |
| `shipment.invoice` is not an invoice | DHL export document path on 93 of 1,144,513 shipments (0.008%); absent from all 14 traced orders; 4 on cancelled shipments |
| No VAT can be asserted | 260,833 of 1,101,548 orders (23.7%) record tax above zero; every GBP order sampled records 0.00; 1 of 22 eBay storefronts has a `vat_no` |
| Order numbers are not keys | 655 numbers reused across 1,608 rows |
| Combo SKUs are common | 129,783 of 633,970 live eBay order lines carry one |
| Orders with no lines exist | 7,049 |

## Database / data source

Every check above is either offline (source-text guards, unit tests with
synthetic rows) or read-only against the marketplace source. Nothing in this
folder was produced by a write.

## User workflow

Not applicable — this folder records checks, not usage.

## Known limitations

- **No screenshots exist for the invoice feature.** The evidence README asks for
  visual evidence of a running feature, and none has been captured for the
  "Print invoice" button or the rendered PDF.
- No coverage percentage has been captured recently
  (`npm run test:coverage` exists but no run is recorded here).
- The live invoice check has never been run unattended, by design.

## Added: order-change notification list

**What was built**

| File | Change |
| --- | --- |
| `lib/domain/inbox.ts` | modified — the read contract, the two constants, the feed schema |
| `lib/repositories/conversation-repository.ts` | modified — `LIST_AWAITING_RESPONSE` and `listAwaitingResponseByCategory` |
| `app/api/conversations/awaiting-response/route.ts` | new — GET only |
| `components/notification-bell.tsx` | new — the header control |
| `components/notification-drawer.tsx` | new — the right-side drawer |
| `components/icons.tsx` | modified — `BellIcon`, beside the two existing glyphs |
| `components/workspace.tsx` | modified — one bell, one drawer, one fetch, one boolean |
| `tests/repositories/awaiting-response.test.ts` | new — 26 tests |
| `tests/guards/notification-bell.test.ts` | new — 32 tests |

The list first shipped as a fourth workspace tab (`components/order-change-list.tsx`,
`view === "order_change"`). Both were **removed** when it became a bell and a
drawer: a tab changes what is on screen and this does not — it opens over
whatever the reviewer was already doing and closes when they pick something. A
guard now asserts the tab is gone and that the component file no longer exists.

**Then made global.** The feed followed the selected marketplace, so an Amazon
customer waiting on an order change was invisible while a reviewer worked eBay.
The evidence that the change was needed, and that it worked:

| | Before | After |
| --- | --- | --- |
| Route | `?marketplace=<name>` | no parameters |
| Query scope | `c.marketplace = $1` | `= ANY($1::text[])`, allowlist array |
| Bound | 100, global | 100 **per marketplace** (`row_number() OVER (PARTITION BY ...)`) |
| Filtered mail | included | excluded (`inbox_visibility <> 'filtered'`) |
| Live result | eBay 0 · Amazon 1 · Shopify 2, each read alone | **3 in one list: 2 Shopify, 1 Amazon** |
| Naive global attempt | — | 2 matches, **both Shopify** — Amazon and eBay lost |

The middle row is the finding: a shared window was ~90% Shopify (3,342
unanswered against eBay's 309 and Amazon's 44), so the naive global query
returned nothing for Amazon at all. Partitioning restored it — `id=32973`
appears in the global list.

`EXPLAIN ANALYZE` against the live schema: Postgres pushes the rank bound into
the window as a `Run Condition`, so the CTE narrows 14,915 conversations →
7,077 (marketplace, not filtered) → 6,898 (no draft) → 3,695 (no reply after the
customer) → **246** rows projected. Only those 246 pay for the three correlated
subqueries. Whole request ~2.7s, dominated by classifying 244 conversations.

**Evidence the existing system was not modified**

- `git status` shows three modified files, all additive; no existing function,
  query, component or test was edited.
- `lib/sync/*`, `lib/marketplaces/*`, `lib/knowledge/*`, `lib/ai/*` and
  `lib/context/*` are untouched — message sync, grouping, the classifier, AI
  drafting and order context are byte-identical.
- No migration was added; `migrations/` still ends at `0010`.
- The existing `LIST_CONVERSATIONS`, `listConversations`, `categoryFor`,
  `priorityFor` and `toInboxItem` are unchanged; the new function calls
  `toInboxItem` rather than reimplementing it, so a notification row's category
  and priority are the same readings the inbox shows.
- 3,242 pre-existing tests pass, including every standing guard. Two of them
  bound this work directly and were deliberately not edited:
  `marketplace-ui.test.ts` asserts the workspace has exactly two `<aside>`
  elements, and `review-sidebar.test.ts` asserts the last one is the details
  panel — which is why the list lives in the existing left column rather than a
  new right-hand one.

**Evidence the SQL is correct**

`EXPLAIN` against the live application schema, captured during the work: the
statement plans, and every access path is an index scan
(`ix_conversations_marketplace_sub_source`, a hash anti-join on the 198-row
`draft_replies`, and `ix_conversation_messages_thread_order` for both message
lookups). The three correlated subqueries sit above the `LIMIT`, so they are
evaluated for the returned rows, not for the whole candidate set.

## Added: prior CST replies as agreed decisions

**What was built** (commit `5bc614c`):

| File | Change |
| --- | --- |
| `lib/ai/instructions.ts` | modified — the fifth guard, `PRIOR_REPLIES`, placed after `NEVER_INVENT` because it qualifies it |
| `lib/domain/draft.ts` | modified — `acceptedCommitments`, `CommitmentKind`, the split replacement pattern, two optional parameters |
| `lib/ai/draft-validation.ts` | modified — `threadCommitments`, and the coverage vocabulary widened for "resend" |
| `lib/ai/draft-assembly.ts` | modified — one sentence in `verifiedTrackingBlock`, and commitments passed to `settleReviewRequirement` |
| `lib/knowledge/message-category.ts` | modified — `WANTS_A_RESEND`, wired only into `detectIntents` |
| `tests/ai/accepted-commitments.test.ts` | new — 23 tests |
| `tests/ai/settled-background.test.ts` | new — 13 tests |

### Test run — 2026-09-09

```
npm test   (vitest run)

Test Files  124 passed | 12 skipped (136)
Tests       3406 passed | 30 skipped (3436)
Duration    37.61s
```

Measured on the rebased tree, so the figure includes the 45 body-repair tests
from the merge. The AI suite alone: `npx vitest run tests/ai` → 23 files passed,
4 skipped, **426 passed**, 9 skipped.

`npx tsc --noEmit` reports one error, pre-existing and unrelated: a stale
`.next/types/validator.ts` referencing the deleted invoice route. Proved
pre-existing by `git stash push -u`, re-running, and `git stash pop` — identical
error with the change absent. `npx eslint` reports the same 4 problems as
before, all in files this work did not touch.

### What the tests prove, and what they do not

| Claim | How it is tested |
| --- | --- |
| An offer we made and the customer accepted is read as a commitment | **Behavioural** — the real reader over a real thread shape |
| Order is enforced (acceptance before offer grounds nothing) | **Behavioural** |
| A question about an offer is not acceptance; an acceptance that also asks still is | **Behavioural** — per-sentence |
| An unreadable body grounds nothing | **Behavioural** |
| A confirmation of an agreed remedy raises no critical finding | **Behavioural** — the real validator |
| It buys no regeneration | **Behavioural** — a fake `DraftProvider` counts calls; `calls === 1` |
| "We have dispatched" is still blocked, with agreement | **Behavioural** |
| A resend agreement does not ground a refund claim | **Behavioural** |
| The same promise with no offer is still blocked | **Behavioural** |
| A caller passing no thread is unchanged | **Behavioural** — the `[]` default |
| Tracking is still supplied when the conversation has settled | **Behavioural** — `buildDraftInput`, byte-compared against the re-asked thread |
| The model actually obeys the no-repeat rule | **Not tested, and not testable here** — instruction wording is pinned structurally; compliance is the model's |

The last row is the honest bound on this work. Two of the five changes are
instruction text, and no unit test can prove a model follows it. What the tests
do prove is that the deterministic layer no longer *fights* it.

### The regression that made the second half necessary

Worth recording because it is the non-obvious part. The expected terse draft —

> "Thank you for confirming. As agreed, we will proceed with the resend for you."

— raised **two CRITICAL `intent_not_addressed` findings** and
`regenerationWarranted: true`. The gate would have bought a regeneration
instructing the model to put the tracking sentence back, defeating the
instruction entirely. Cause: `INTENT_COVERAGE.wants_replacement.topic` had a
leading `\b`, so its `send…` alternative could not match inside "resend", and no
alternative named the word. After widening: no critical findings, and one minor
`intent_not_addressed` note remains — asserted explicitly in the test, because a
minor finding buys no model call and changes no word of the draft.

### The prompt cost guard, measured

`tests/ai/draft-validation-cost.test.ts` caps the composed instruction and input
at 2,000 estimated tokens. Measurements taken with a temporary test, since
removed:

| Stage | Tokens |
| --- | --- |
| First attempt | 2,224.75 — **failed** |
| After first rewrite | 2,030.25 |
| After second | 2,004.5 |
| Shipped | **1,984.75** |

The new block alone went from 753 tokens (39% of the whole instruction) to 513.
The ceiling was not raised.

## Added: pre-sale SOT product facts — measured source findings

No code was written. These are read-only `SELECT` results against the source
database, recorded because they answer a question that will be asked again. No
customer data appears; every figure below is catalogue or listing metadata.

| Finding | Measurement |
| --- | --- |
| No product weight exists in SOT | `weight_g` on 1,824 SKUs: 1,155 `NULL`, 669 `[VERIFY]`, **0 usable** |
| Nor in any other weight column | `packaged_weight_g`, `volumetric_weight_kg`, `outer_weight_kg`, `chargeable_weight_kg` — 0 usable each |
| Nor outside SOT | `suppliers.child_item_products`: 119 rows, 0 weights |
| SOT is larger than documented | 1,824 SKUs across 6 tabs, not 1,001 across 3 |
| The parent-listing route barely reaches SOT | 308 of 31,155 parent SKUs match (1.0%) |
| The component route reaches most of it | **19,319 of 31,155 (62%)**, a gain of 19,281 |
| Why the parent route fails | 4,768 parent rows carry `"sku not assigneds"`; 1,089 carry a combo SKU |
| The traced listing IS in SOT | its Pattern-03 variant carries **71 usable attributes** — including `diameter_mm: 150`, `height_mm: 130`, `bulb_base_type: E27` — and `weight_g: [VERIFY]` |
| The bundle path served it correctly | 15 attributes agreed across all 7 patterns were available; `diameter_mm`, `height_mm` and `shade_shape` correctly withheld, the patterns differing (135/150/160/190mm) |

**Evidence the draft was right.** The model was given verified catalogue facts
and no weight, and the standing `NEVER_INVENT` guard forbids stating an
unverified specification. *"I'll check the exact weight and come back to you"* is
the designed behaviour, not a failure.

**Evidence nothing was changed.** `git status` showed no modification to
`lib/context/`, `lib/repositories/` or `lib/ai/` during the investigation. Every
statement run was a `SELECT`.

## Next pending items

- **A test pinning the placeholder-SKU case.** Nothing in `tests/` references
  `"sku not assigned"`, so the 4,768 listings that depend on it matching nothing
  are unguarded. (The `[VERIFY]` filters are well covered, in both resolvers and
  the repository.)
- A test that a pre-sale question whose attribute is `[VERIFY]` produces a draft
  that defers rather than states a number — the actual bug scenario, currently
  unpinned.
- Capture a screenshot of the context panel showing the "Print invoice" control
  against a resolved order, and one of a rendered invoice with synthetic or
  masked data.
- Record a coverage summary run.
- No evidence is needed for sending, VAT invoices or accounting integration —
  none of those exist.

## Added: message body repair — evidence

**The report that started it.** A reviewer asked why the customer messages for
eBay conversation 40017 (`alfie280901`) showed as blank when the customer had
plainly sent text.

**Diagnosis, read-only.**

| Question | Evidence |
| --- | --- |
| Is the message stored? | Yes — conversation 40017, one inbound message, `source_pk = 104212`, `reply_inbox`. |
| Why is it blank? | `body_decode_status = 'empty'`, `body_text IS NULL`. `displayBody` shows the unavailable placeholder for anything but `decoded`. |
| Is the text in the source? | Yes — `ebay_messages` row 88823, 208 characters of JSON-encoded text. |
| Why was it missed? | The body row is 19 below the table's maximum id (88842) — written well after its header. The sync had already passed `id 104212` and reads strictly forward. |
| How widespread? | 791 eBay messages stored blank. Checked every one against the source: **74** had text available, 166 held a JSON `null` body, 551 had no body row at all (all with `ext_message_id IS NULL` and `message_type IS NULL` — eBay's system-notice shape). |

**Repair, dry run then applied (2026-09-08).**

```
examined : 795     repaired : 74     skipped : 721
  still_empty_at_source      721
```

**Effect, measured before and after:**

| Marketplace | decoded before | decoded after | empty before | empty after |
| --- | --- | --- | --- | --- |
| ebay | 5,666 | **5,740** | 791 | **721** |
| amazon | 1,677 | 1,677 | 168 | 168 |
| shopify | 11,242 | 11,242 | 14 | 14 |

Conversation 40017 now reads `body_decode_status = 'decoded'`, 206 characters.

**Second pass across all five marketplaces: 903 examined, 0 repaired.**
Idempotency demonstrated on live data, not only in tests.

**No duplication:** `conversation_messages` holds 23,557 rows and 23,557 distinct
source-coordinate tuples after two passes.

**No cursor movement:** the eBay watermark moved 104225 → 104229 between
observations, and that was the scheduled sync at 08:29, not the repair. Repair
issues no statement mentioning `sync_state`.

**Tests:** `npx vitest run` → 3,370 passed, 30 skipped, 0 failed (was 3,325
before; the repair suite adds 45). `npx eslint` reports the same 4 pre-existing
problems, none in new files. `npx tsc --noEmit` reports the same one pre-existing
stale `.next/types/validator.ts` error.

## Added: the notification draft fix — evidence

**What was built:**

| File | Change |
| --- | --- |
| `lib/repositories/conversation-repository.ts` | modified — draft `NOT EXISTS` deleted; `has_draft` projected; row type, mapper and both doc blocks updated |
| `lib/domain/inbox.ts` | modified — `hasDraft: z.boolean()` on the row schema |
| `components/notification-drawer.tsx` | modified — `draftStatus()` helper, status chip, header and empty-state copy |
| `app/api/conversations/awaiting-response/route.ts` | modified — doc comments only |
| `tests/repositories/awaiting-response.test.ts` | modified — bug-encoding block replaced, 6 tests added |
| `tests/guards/notification-bell.test.ts` | modified — 4 drawer tests added |

**No schema change, no migration.** `migrations/` still ends at `0010`.

### Test run — 2026-09-09

```
npx vitest run tests/repositories/awaiting-response.test.ts \
               tests/guards/notification-bell.test.ts
Test Files  2 passed (2)
Tests       89 passed (89)

npm test   (vitest run)
Test Files  124 passed | 12 skipped (136)
Tests       3413 passed | 30 skipped (3443)
Duration    32.88s
```

Up from 3,406: ten tests added, three removed (the block that asserted the bug).

`npx tsc --noEmit`: one error, pre-existing and unrelated — the stale
`.next/types/validator.ts` invoice-route reference. `npx eslint`: the same 4
problems as before, all in files this work did not touch
(`components/workspace.tsx`, `lib/knowledge/rule-coverage.ts`,
`tests/guards/order-selection-tracking.test.ts`).

### The evidence that the bug existed, and that it is gone

The defect was in the statement, so the proof is the statement. Before:

```sql
AND NOT EXISTS (SELECT 1 FROM cst_app.draft_replies d WHERE d.conversation_id = c.id)
AND NOT EXISTS (SELECT 1 FROM cst_app.conversation_messages o ...)
```

After: only the second clause survives, and `draft_replies` appears in the
`SELECT` list instead.

**Why the first test written for this had to be discarded.** The obvious
assertion — "the statement no longer names `draft_replies`" — would have been
green and wrong, because the projection still names it. The behaviour is pinned
two ways instead:

| Claim | How it is tested |
| --- | --- |
| A drafted conversation stays listed | **Behavioural** — a row with `has_draft: true` is returned |
| Drafted and undrafted are listed alike | **Behavioural** — two rows differing only in the draft, both returned |
| A reviewed conversation with no reply stays listed | **Behavioural** |
| The flag is read strictly | **Behavioural** — `false`, `null`, `undefined`, `0`, `"f"` all map to `false` |
| The draft table is never filtered on | **Structural** — `cst_app.draft_replies` must be present AND must not match `/NOT EXISTS\s*\(\s*SELECT 1 FROM cst_app\.draft_replies/i` |
| The workflow state is not substituted | **Structural** — neither `'received'` nor `'reviewed'` may appear |
| The drawer labels rather than omits | **Structural** — the drawer source names `item.hasDraft`, "Draft ready", "Needs review", "not sent" |

A fake client cannot execute SQL, which is why the two exclusions were structural
before and why one of them still is. That is the same standard the No Rule
queries are held to.

### Evidence the rest of the feed is unchanged

Every other assertion in `awaiting-response.test.ts` passes untouched: category
matching against the real classifier, the per-marketplace `row_number()` bound,
the `filtered` exclusion, the inner `JOIN LATERAL`, the row-value reply
comparison, ordering, `scanned`/`hasMore`, and the read-only guarantee. No
existing test was weakened to make the fix pass; the only one removed asserted
the behaviour being corrected.

### Not yet checked by a person

- **No live run.** The measured live figures in this folder (eBay 0 · Amazon 1 ·
  Shopify 2 from 244 candidates) were taken with the draft exclusion in place.
  The feed will now return MORE rows, and by how many has not been measured
  against the live database.
- Nobody has watched a conversation stay on the list through Generate → Save →
  Reviewed and then leave it when the reply syncs back. That is the end-to-end
  behaviour this change exists for and it is asserted, not observed.

## Added: the tracking-absence rule — evidence

**What was built** (commits `6f6ca66`, `50fd958`):

| File | Change |
| --- | --- |
| `lib/ai/draft-assembly.ts` | `noVerifiedTrackingBlock` (two branches); `conversationCategory` extracted so the thread is read once; `categoryBlock` takes the category |
| `lib/ai/draft-validation.ts` | New `GROUNDED_ASSERTIONS` entry, "tracking reference" |
| `lib/ai/instructions.ts` | Doc comment only — the stale cap figure corrected |
| `tests/ai/tracking-absence.test.ts` | new — 26 tests |
| `tests/ai/draft-validation-cost.test.ts` | five-path fixture table, cap 2,300, two new guard tests |
| `tests/ai/pre-sale-context-guidance.test.ts` | one assertion re-anchored |
| `tests/repositories/awaiting-response.test.ts` | 4 tests — the notification gaps |

No schema change, no migration. `migrations/` still ends at `0010`.

### Test run — 2026-09-09

```
npm test   (vitest run)

Test Files  125 passed | 12 skipped (137)
Tests       3451 passed | 30 skipped (3481)
Duration    33.57s
```

Up from 3,413: 26 tracking tests, 8 from the expanded cost guard, 4 notification.

### The measurements behind the cap

Taken from the real prompt builder, not estimated:

| Path | Composed tokens | Carries |
| --- | --- | --- |
| Pre-sale enquiry | 1,973.50 | no tracking guidance |
| Cancellation before dispatch | 1,984.75 | no tracking guidance |
| Delivery, tracking number no update | 2,095.75 | "no carrier update" |
| **Delivery, no shipment data** | **2,129.25** | "no shipment tracking" |

Cap **2,300**, set against the dearest. The old cap of 2,000 measured only the
cancellation — 1,984.75, comfortably inside — while the real delivery prompt ran
129 tokens over it.

### Evidence the guard now works, rather than merely passes

The failure mode being corrected is a cost guard that measures the wrong thing
and stays green, so "it passes" is not evidence. Two things were checked:

1. **It bites.** `COMPOSED_TOKEN_CAP` lowered to 2,100 → exactly one failure,
   `keeps the composed input for delivery query, no shipment data inside the
   cap`, 20 others passing. Restored and re-confirmed.
2. **It measures the block it claims to.** A test asserts the delivery fixtures
   actually contain `NO SHIPMENT TRACKING FOR THIS ORDER` and `NO CARRIER UPDATE
   FOR THIS SHIPMENT`. Without it a renamed heading or a changed gate would
   leave the guard measuring a prompt with no tracking guidance in it — the
   exact way the old version failed.

### What the tests prove, and the boundary

| Claim | How |
| --- | --- |
| Six real failure sentences are faulted | **Behavioural** — the real validator, critical severity |
| Three near-miss sentences are not | **Behavioural** — "on track", "backtrack", "picked and packed" |
| The three shipment situations produce three different blocks | **Behavioural** — the real prompt builder |
| The gate keeps it off pre-sale and damage | **Behavioural** |
| The duplicated category constant matches `TRACKING_CATEGORY` | **Behavioural** — imported in the test and used to build the block |
| The model obeys the prose | **Not tested** |

### Not yet checked by a person

- **No live draft has been generated in any of the three tracking situations.**
  The rule is proven present and the gate proven to fault; neither proves a model
  follows it.
- No regeneration has been observed end to end: gate rejects a tracking mention,
  second attempt returns without it.
