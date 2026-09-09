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

## Added: order-change notification list

```
npm test   →   Test Files 121 passed | 12 skipped (133)
               Tests     3293 passed |  30 skipped (3323)
```

Measured before and after, so the delta is attributable: 3,242 pre-existing
tests pass with the change applied and the two new files excluded; the two new
files add 51. No existing test or guard was edited.

Note the totals above are lower than the figures at the head of this file, and
not because of this work — the invoice suites left the tree in `ef18a74`. The
head of this document has not been reconciled with that; see the limitation
below.

`npx tsc --noEmit` reports one error, pre-existing and unrelated: a stale
`.next/types/validator.ts` still references the deleted invoice route.
`npx eslint` reports the same 2 errors and 2 warnings as before the change, all
in files this work did not touch; the new files are clean.

**What the automated tests can and cannot prove**, stated because it bounds the
claim:

| Condition | How it is tested |
| --- | --- |
| category matches | **Behavioural** — the real classifier, via an injected fake client |
| suppressed marketplace returns nothing | **Behavioural** |
| every mapping, bound, ordering, parameter | **Behavioural** |
| no draft exists | **Structural** — the predicate text is pinned |
| no reply after the customer's message | **Structural** — the predicate text is pinned |

A fake client cannot execute SQL, so the two exclusions are asserted as query
text, the same standard the No Rule queries are already held to. The statement
itself was separately **validated by `EXPLAIN` against the live application
schema** — it plans, and every access path is an index scan — but no live run
has confirmed the rows it returns.

### Live check of the endpoint (2026-09-08)

`GET /api/conversations/awaiting-response`, called against the running dev
server. Three stages, and the middle one is why the query looks the way it does.

**Stage 1 — per marketplace (the original design).** Each read alone:

| Marketplace | Matches | Candidates scanned | Older ones exist |
| --- | --- | --- | --- |
| eBay | 0 | 100 | yes |
| Amazon | 1 | 44 | no — a complete answer |
| Shopify | 2 | 100 | yes |
| B&Q / Temu | 0 | — | category suppressed |

**Stage 2 — naive global (`LIMIT 100` shared).** 2 matches, **both Shopify**.
The Amazon conversation that stage 1 found had vanished: the unanswered queues
are 3,342 Shopify / 309 eBay / 44 Amazon, so a shared recency window is ~90%
Shopify. This failed the requirement it was written for, and it failed silently
— an empty bell looks exactly like a quiet queue.

**Stage 3 — per-marketplace bound (`PARTITION BY marketplace`).** 3 matches:
2 Shopify **and 1 Amazon** (`id=32973`), from 244 candidates across three
marketplaces, `hasMore: true`, ~2.7s. The cross-marketplace requirement is met.

`EXPLAIN ANALYZE` confirms the shape: 14,915 conversations → 3,695 candidates →
246 rows projected, with the rank bound pushed into the window as a
`Run Condition` so it stops early per partition.

The rendered page was also checked over HTTP: the bell is present
(`aria-label="Notifications"`), the string "Order Change" appears nowhere, and
the No Rule and AI Usage tabs are unchanged.

### Not yet checked by a person

- **No screenshot was captured.** The browser automation could not render
  `localhost` — three attempts across two hostnames returned a Chrome error page
  while `curl` returned HTTP 200 from the same server — so the drawer has not
  been seen. This is the one requested deliverable that is outstanding.
- The bell has not been clicked, and the drawer has not been opened or closed by
  a person.
- Clicking a notification has not been observed to open the conversation. **The
  cross-marketplace case is the one most worth a human check**: opening the
  Amazon notification from the eBay tab has to switch the tab AND open the
  thread, and that is asserted structurally rather than exercised.
- No live conversation has been confirmed to leave the list once a draft is
  generated for it.
- The row-value reply comparison has not been observed on a real conversation
  where a reply and a customer message share a second.

## Added: prior CST replies as agreed decisions

```
npm test   →   Test Files  124 passed | 12 skipped (136)
               Tests      3406 passed | 30 skipped (3436)
```

Run 2026-09-09 on the rebased tree, so this includes the 45 body-repair tests
merged from `167092f`. The 36 new tests are 23 in
`tests/ai/accepted-commitments.test.ts` and 13 in
`tests/ai/settled-background.test.ts`. **No existing test or guard was edited**,
and every standing guard is green — including the no-send guard, which this work
came nowhere near but which any change to the drafting layer should be seen to
pass.

`npx tsc --noEmit`: one pre-existing, unrelated error (stale
`.next/types/validator.ts` invoice route), confirmed pre-existing by stashing.
`npx eslint`: the same 4 problems as before, none in a touched file.

**One type error was caught only by `tsc`**, and it is worth recording as a
process note rather than a defect: vitest does not typecheck, so a test fixture
missing `TrackingSource.provider` passed 13 green tests before `npm run
typecheck` rejected it. A green vitest run is not evidence that the suite
compiles.

### What is proven and what is asserted

| Condition | How it is tested |
| --- | --- |
| offer/acceptance reading, in order, per sentence | **Behavioural** — the real reader |
| an agreed remedy raises no critical finding | **Behavioural** — the real validator |
| it buys no regeneration | **Behavioural** — a fake provider counts `generate` calls |
| "we have dispatched" still blocked, agreement or not | **Behavioural** |
| a resend agreement does not ground a refund | **Behavioural** |
| callers passing no thread are unchanged | **Behavioural** — the `[]` default |
| tracking is still supplied on a settled thread | **Behavioural** — byte-compared against the re-asked thread |
| the instruction says what it should | **Structural** — the wording is pinned |
| the model obeys it | **Not tested** — see below |

**The bound on this work, stated plainly.** Two of the five changes are
instruction prose. No unit test can show that a model follows an instruction, so
what is proven is one-sided: the deterministic gate no longer penalises a draft
that carries an agreed action forward, and no longer penalises one that leaves
settled background out. Whether the model takes the offer is a question for live
observation.

### Manual checklist — F. Prior replies and settled background (not yet run)

20. **The originating case.** Find or construct an eBay conversation where a CST
    reply offered a resend and the customer accepted. Generate a draft. It must
    confirm the resend and say what happens next — not refuse it, not ask the
    customer to justify it again, and not ask for something a colleague already
    said was not needed.
21. **The outcome boundary.** The same draft must **not** say the item has been
    sent, dispatched, posted or processed, and must give no date, courier or
    tracking number, unless the verified context establishes it. This is the one
    check that matters most; it is the line between the fix and a licence.
22. **No repetition.** The draft should not restate the tracking position the
    earlier reply already gave. Expected shape: *"Thank you for confirming. As
    agreed, we will proceed with the resend for you."*
23. **The re-ask.** On a conversation where the customer accepts AND asks where
    the original parcel is, the tracking position must reappear. If it does not,
    the no-repeat rule has been read too broadly and that is the failure mode to
    watch for.
24. **First contact unchanged.** A plain "where is my parcel?" with no prior
    reply must answer from tracking exactly as it did before.
25. **No retraction.** Confirm no draft anywhere writes "correction", "to clarify
    my previous message", "please disregard" or "the previous information was
    incorrect".
26. **The reviewer note.** A correct terse confirmation still carries one minor
    `intent_not_addressed` finding. Confirm reviewers are not misled by it — it
    is expected, and it changes no text.

### Not yet checked by a person

- **No live draft has been generated against a real accepted-commitment
  conversation.** Everything above is unit-level. This is the outstanding gap
  for this change.
- The under-inclusion risk has not been observed either way: whether the
  no-repeat rule ever omits something a CST rule required.

## Added: pre-sale SOT product facts — validated by measurement, no code changed

The reported bug — a pre-sale draft declining to state a product's weight — was
**not reproduced as a defect**, because the behaviour is correct. Validated by
read-only query rather than by inspection:

| Checked | Result |
| --- | --- |
| Does SOT hold a weight for this product? | No — `weight_g` is `[VERIFY]` for the traced SKU |
| For any product? | No — 0 usable values across all 1,824 SKUs |
| Anywhere else in the source? | No — `suppliers.child_item_products` holds 119 rows, 0 weights |
| Did the pipeline reach the product at all? | Yes, via the bundle route — 15 verified attributes supplied |
| Did the parent-listing route resolve? | No — the parent SKU is the placeholder `"sku not assigneds"` |

**The premise of the report was wrong**, and this is recorded so it is not
re-investigated: the source database does not contain the weight. No code fix
produces it. The remaining actions are a data task (populate `Weight_g`) and one
piece of optional hardening (reject the placeholder SKU), both listed below.

## Next pending items

- **Run checklist F against a live conversation.** This is the highest-value
  outstanding check in this document: the accepted-commitment behaviour has
  never been observed end to end with a real model call.
- Add a regression test for the placeholder SKU, and one for a `[VERIFY]`
  attribute producing a deferring draft rather than a stated number.
- Run checklist D and record the results here.
- Record a coverage run.
- Nothing is pending for sending, VAT invoices, invoice email or accounting
  integration — those features do not exist, so there is nothing to validate.

## Added: message body repair

```
npx vitest run   →   Test Files 122 passed | 12 skipped (134)
                     Tests     3370 passed |  30 skipped (3400)
```

Measured before and after, so the delta is attributable: 3,325 before, 3,370
after — the repair suite adds 45 and no existing test was edited. `npx tsc
--noEmit` reports the same single pre-existing error (stale
`.next/types/validator.ts`); `npx eslint` the same 4 pre-existing problems, none
in new files.

### What the 45 tests cover

The four cases the task named, plus the ones that bound the blast radius:

| Case | How |
| --- | --- |
| body arrives after header | **Behavioural** — a fixture with `body_raw: null` skips, the same fixture with a body repairs |
| repair updates the existing message | **Behavioural** — the stored `conversation_id` is the value written back |
| already-correct message unchanged | **Structural** on the predicate, **behavioural** on the empty candidate set (no source read at all) |
| no duplicate conversation messages | **Behavioural** — two passes, one source-coordinate key |
| idempotency | **Behavioural** — second pass writes identical values; skips repeat identically |
| no source writes | **Structural** — every source statement asserted to start `SELECT` and contain no DML keyword |
| `sync_state` untouched | **Structural** — no statement in a pass may contain `sync_state` or `watermark` |
| only body columns updatable | **Structural** — the upsert's `DO UPDATE` list is asserted to exclude `direction` and `source_ts` |
| identity checked before content | **Behavioural** — a row with a changed direction AND a new body is refused |
| every skip reason reachable | **Behavioural** — one fixture per reason; every candidate accounted for exactly once |

The fixtures use eBay's real two-table shape and go through the real
`classifyRows` / `normalizeRow`, so decoding, direction and the JSON body
encoding are exercised rather than mocked.

### Live validation (2026-09-08) — this one WAS run

Unlike checklist D, this was executed against the live databases.

```
dry run  : examined 795   repaired 74   skipped 721 (all still_empty_at_source)
apply    : examined 795   repaired 74   skipped 721
re-run   : examined 903   repaired  0   skipped 903     ← all five marketplaces
```

- eBay decoded 5,666 → **5,740**; empty 791 → **721**.
- Conversation 40017 (`alfie280901`), the reported case: `empty` → `decoded`,
  206 characters. The reviewer's original complaint is resolved.
- `conversation_messages`: 23,557 rows, 23,557 distinct source-coordinate tuples
  after two passes — no duplication.
- The eBay watermark moved only by the 08:29 scheduled sync, not by the repair.

### Manual checklist — body repair

1. Open eBay conversation 40017 and confirm the customer's message renders as
   text rather than the unavailable placeholder. **Not yet done by a person.**
2. Confirm the thread's message order and read/unread state are unchanged.
3. Run `npm run repair:bodies` with no `--apply` and confirm it writes nothing.
4. Run it twice with `--apply` and confirm the second pass reports 0 repaired.
5. Confirm no `MORE AVAILABLE` line appears once the queue is below the limit.

### Not yet checked by a person

- No screenshot. The browser automation still cannot render `localhost`.
- Whether any draft was generated against a message while it was blank, and
  therefore ought to be regenerated now that the text is present. Nothing
  automatic touches `draft_replies`; this needs a human decision.
