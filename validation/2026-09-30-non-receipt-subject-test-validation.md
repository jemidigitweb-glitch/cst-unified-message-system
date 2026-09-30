# Validation — the DEL-13.1 subject test

**2026-09-30.** Acceptance tests, including the ones not yet run.

---

## A. Automated — RUN, PASSING

All in `tests/knowledge/category-regression.test.ts`, section 2 ("the reported
misclassifications"), under *"a notification that did not arrive is not a parcel
that did not"*.

| # | What | Result |
| --- | --- | --- |
| A1 | 33222 — the four turns read as **Pre sales queries** | pass |
| A2 | The apology sentence alone is not Delivery queries | pass |
| A3 | A missed email, a missed platform notification and a missed reply are not Delivery queries | pass |
| A4 | **Control** — every phrase sheet 13 quotes is still Delivery queries: "I have not received my order", "Nothing has been delivered", "Order never arrived", "I didn't get the package", "Did not receive the item" | pass |
| A5 | **Control** — "My order still hasn't come" is still Delivery queries, so the bare `come` verb survives | pass |
| A6 | **Control** — "I never got a notification from you. My parcel has not arrived either." is still Delivery queries, so the window stops at the sentence boundary | pass |

Plus, unmodified and passing:

| Suite | Why it matters here |
| --- | --- |
| `cst-category-corpus.test.ts` | The reachability test that **rejected the first, wider fix** by naming row `5.2`. It is the guard on this change. |
| `category-golden-set.test.ts` · `category-ownership.test.ts` · `message-category.test.ts` · `cst-category-evidence.test.ts` · `guards/category-tag.test.ts` | The frozen baseline. **1,292 category tests passing in total.** |

Full suite 4,915 passing; `typecheck` and `lint` clean. The three failures are
pre-existing and were confirmed so by running the same combination with the change
stashed.

## B. Live — RUN, PASSING

| # | What | Result |
| --- | --- | --- |
| B1 | 33222 reads **Pre sales queries** in the running application | pass |
| B2 | Chip and ribbon agree — category Pre sales, priority LOW, reason `pre_sales_enquiry` | pass |

## C. NOT YET RUN — and each needs a person

| # | What | Why it is not automated |
| --- | --- | --- |
| C1 | **A sweep of every conversation whose category changes.** `DEL-13.1` is a catch-all and this change can only remove matches, so some conversations that read Delivery will now read something else. Nobody has counted them or looked at a sample. | The category is not stored; it needs a classify-in-code sweep. |
| C2 | **CST confirms 33222 is a pre-sales enquiry** and not an admin or installation matter. The thread does ask a compatibility question ("can the new wire be used with the old bulb fitting"), and `INSTALLATION_GUIDANCE_CATEGORY` files installation guidance under Admin. CST's own `INT-PS19` sheet is "PRE-SALES QUERIES · O — WIRING AND INSTALLATION", which is why Pre sales is what this produces. | A judgement about their taxonomy. |
| C3 | **A corpus phrase about a parcel that uses "message" or "reply".** The parcel exception was built from a grep that found four such phrases, all using "notification". A phrase phrased differently would be missed. | Needs a reviewer reading the workbooks, not a regex. |
| C4 | **The two suites that fail only inside a larger run** — `cst-rules-files > parses every workbook into rules` and `marketplace-isolation > sends an eBay conversation no Amazon-only rule`. Observed with and without this change; not diagnosed. | Pre-existing ordering/timing sensitivity, §8. |

## D. How to reproduce B1 by hand

1. `npm run dev`, then `GET /api/conversations?marketplace=ebay&limit=100&offset=…`.
2. Find the conversation by `counterpartyRef` and read `category` and `priority`.
3. Pre sales queries + LOW + `pre_sales_enquiry` is the pass. Delivery queries is
   the regression, and the message to look at is the one containing "notifications
   come through".
