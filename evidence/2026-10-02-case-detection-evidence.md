# Case Detection Indicator — evidence

**Date:** 2026-10-02
**Branch:** `sync-reconcile-late-arrivals`

Every number here was measured on this date against `varmen_db.cst_app` with
`SET default_transaction_read_only = on` on the session. Re-derive any of them
with `sql/2026-10-02-case-detection-verification.sql`.

**Section 7 states what was NOT measured.** Read it before trusting a number
that is not in sections 1–6.

---

## 1. The import run

| | |
| --- | --- |
| Migration | `0022_marketplace_cases`, applied 2026-10-02 |
| `cst_app` base tables | 33 → 35, no existing table gained, lost or changed a row |
| Published run | id **3**, `published_at` **2026-10-02 09:07:49.25604+02** |
| Cases read | **21,150** |
| Inserted | **21,022** |
| Updated | **0** (first apply run to complete) |
| Rejected | **128** |
| Source tables covered | all **9** |
| MySQL connections | **1** |
| MySQL queries | **12** |

Runs 1 and 2 are `failed` and own **zero** rows. Run 1 was killed at a ten-minute
command timeout mid-transaction; run 2 violated
`ck_marketplace_cases_refund_pair`. Both rolled back completely, which is the
evidence that publication is atomic — and both remain on the ledger, which is the
evidence that an attempt that dies is still on record.

### Rejections, by reason

| Reason | Cases | Source rows |
| --- | --- | --- |
| `superseded_by_inquiries` | 69 | 595 |
| `unmapped_case_type` | 58 | 421 |
| `no_case_id` | 1 | 1 |
| **Total** | **128** | **1,017** |

**No case was rejected for an unverified storefront.** The allowlist is resolved
from the order source at run time (`sub_source.source_id → source.id`) and covers
every marketplace, not only eBay; the run cross-checks the eBay slice against
`findEbaySubSourceIds` and refuses to proceed if the two disagree.

---

## 2. What is stored

**21,022 rows. 0 duplicate `(source_database, source_table, source_case_id)`
identities.**

| Source store | Marketplace | Case type | Cases | Source rows |
| --- | --- | --- | ---: | ---: |
| `amazon_returns` | amazon | RETURN | 12,398 | 15,920 |
| `ebay_returns` | ebay | RETURN | 4,082 | 4,427 |
| `shopify_returns` | shopify | REFUND | 2,019 | 2,019 |
| `cancellation` | ebay | CANCELLATION | 1,263 | 1,263 |
| `inquiries` | ebay | ITEM_NOT_RECEIVED | 875 | 7,240 |
| `inquiries` | ebay | RETURN | 129 | 393 |
| `shopify_cancellations` | shopify | CANCELLATION | 153 | 153 |
| `cases` | ebay | ITEM_NOT_RECEIVED | 48 | 415 |
| `payment_disputes` | ebay | PAYMENT_DISPUTE | 36 | 36 |
| `cases` | ebay | RETURN | 10 | 28 |
| `amz_cancellations` | amazon | CANCELLATION | 9 | 9 |

The event-log collapse is visible in the right-hand column: 7,240 inquiry event
rows became 875 cases. **Summing `source_row_count` is never a case count.**

`opened_at` spans **2020-09-10** to **2026-10-01**.

### Lifecycle

| | Cases |
| --- | ---: |
| `active` | 99 |
| `closed` | 6,487 |
| `unknown` | **14,436** |

`unknown` is the majority and is a measured, expected answer — 12,397 Amazon
returns read `Approved` (approved, with no closure event or date recorded) and
2,019 Shopify rows have no status column at source.

### Order matching

| Method | Cases |
| --- | ---: |
| `source_order_id_verified` | 19,805 |
| `item_transaction` | 1,055 |
| `source_order_id_unverified` | 155 |
| `unmatched` | 7 |

### Flags

| | Cases |
| --- | ---: |
| `damage_reported` | 1,215 |
| `replacement_confirmed` | **15** |
| `escalation = escalated` | 791 |
| `escalation = not_escalated` | 16,693 |
| `escalation = not_recorded` | 3,538 |
| `source_disposition` present | **1** |
| `counterparty_ref` present | 1,098 |

---

## 3. The three traps, measured as closed

**Amazon warehouse dispositions are not in `source_status`.** The only two values
in `source_status` across all 12,398 Amazon return cases are `Approved` (12,397)
and NULL (1). The single warehouse disposition in the snapshot sits in
`source_disposition` — `Unit returned to inventory`. No stockroom vocabulary
reached the status column.

**An escalated case can be closed.** 765 cases are `escalation = 'escalated'` AND
`lifecycle = 'closed'`. On the eBay return store, 146 rows whose `source_status`
is `ESCALATED` carry `source_state = CLOSED`, and a further 68 carry both
`CLOSED` and an escalation from the buyer/seller flags. Both facts render.

**Replacements come from one field.** 15 cases carry `replacement_confirmed`, all
from `amazon_returns`; `ck_marketplace_cases_replacement_source` makes any other
store unrepresentable, so the 54 eBay available-action near-misses cannot be
stored as confirmations.

---

## 4. The existing warning is untouched

`cst_app.customer_case_history` holds **1,098 rows**, `max(imported_at)`
**2026-10-01 10:19:30.707+02** — unchanged by the 0022 apply and by the import.

**Overlap, measured rather than estimated: 1,098.** Every row of 0021's table has
a matching `(source_database, source_table, source_case_id)` in
`marketplace_cases`. An earlier working estimate of ~1,225 was wrong and is
superseded by this figure. See
`duplicate-risk-reports/2026-10-02-case-detection-duplicate-risk.md` for why
that overlap cannot surface as a duplicate on screen.

---

## 5. Reach on today's conversations

| | Conversations |
| --- | ---: |
| whose resolved order has at least one published case | **70** |
| whose buyer handle matches at least one published case | **84** |

These are the conversations on which the indicator renders anything. The figure
is low because it is bounded by how many conversations have a resolved order
snapshot, not by how many cases exist.

---

## 6. Verified in the running application

Against `localhost:3000` on 2026-10-02, reading the DOM rather than a screenshot:

- A conversation with an open escalated return renders the flag above the thread
  at y=165 — visible with no scrolling — reading
  *"MARKETPLACE CASE ALREADY OPEN ON THIS ORDER / Return · Open · on this order ·
  opened 2026-10-01 · escalated"*, and the details column renders the full case
  with status, reason, resolution, escalation, action owed, quantity, refund and
  both dates.
- A conversation with no cases renders **no flag**, and the section reads
  *"No marketplace cases recorded for this order or customer."* with the import
  timestamp beneath it.
- `GET /api/conversations/:id/cases` returns `state: "found"` with
  `coverage: { covered: 5, neverImported: 0 }` and `stale: false` for an eBay
  conversation.

**Why the flag exists at all, measured:** before it was added, the details
column's case section sat **1,305px down a 2,174px scroller**, below the
root-cause chip grid. The section was correct and a reviewer answering a message
never reached it.

---

## 7. What was NOT measured

- **No fresh MySQL extraction was run on 2026-10-02 for this work.** The read
  path, the API and the UI were built and verified entirely against the snapshot
  run 3 published. The importer's own behaviour is covered by its tests and by
  the ledger above, not by a new extraction.
- **No second apply run has been performed**, so the `cases_updated` path and the
  re-run idempotency of the upsert are proven by `tests/sync/marketplace-case-import.test.ts`
  and by the unique index, **not** by a live second run. `cases_updated` is 0 in
  the only successful run.
- **The staleness threshold of 24 hours is a decision, not a measurement.**
  Nothing schedules the import; no study was done of how long a snapshot stays
  useful.
- **Per-case Amazon fulfilment channel is decided by the event collapse.** 2,577
  FBA rows exist at source but only 1 case carries a disposition, because an FBA
  row usually shares a return authorisation with a merchant-fulfilled row whose
  status wins. This is safe in the direction that matters — no disposition
  reached a status field — but it means the panel under-reports FBA outcomes and
  nobody has counted by how much.
- **Conversations whose order was chosen manually by a reviewer are not matched
  on that order.** The choice is held in the browser and never stored. No count
  was taken of how many conversations this affects.
- **Nothing was measured about B&Q or Temu**, which have no case source at all.
