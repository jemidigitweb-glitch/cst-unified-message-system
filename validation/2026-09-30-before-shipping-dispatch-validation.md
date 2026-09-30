# Validation — the before-shipping dispatch rule

**2026-09-30.** Acceptance tests, including the ones not yet run.

---

## A. Automated — RUN, PASSING

| # | What | Where | Result |
| --- | --- | --- | --- |
| A1 | The reported cancellation thread (eBay 50802's shape) classifies as before-shipping from text alone, becomes Return and refunds when the target order has shipped, and keeps before-shipping when it has not | `tests/domain/before-shipping-dispatch-rule.test.ts` | pass |
| A2 | The reported swap thread (eBay 40467's shape) is corrected too, with `cancellationRequested: false` | same | pass |
| A3 | Target order: quoted number wins; two quoted numbers are ambiguous; the only known order wins; two known and none quoted is ambiguous; none known is unavailable | same | pass |
| A4 | **Negative** — a dispatched SIBLING order's state produces `dispatch_state_for_another_order` and changes nothing | same | pass |
| A5 | **Negative** — with both states supplied, the target's decides and the sibling's is ignored, in both directions | same | pass |
| A6 | **Negative** — while the target is ambiguous, two dispatched orders change nothing | same | pass |
| A7 | A parcel that left unambiguously after the message keeps the before-shipping category; inside the 24-hour margin, or with either instant missing or unreadable, it reads as dispatched | same | pass |
| A8 | The naive source timestamp is read the same way whatever the process timezone is | same | pass |
| A9 | Every other category, and null, is left alone | same | pass |
| A10 | `INT-OS01` exists in `CST_EVIDENCE`, its condition still mentions dispatch, and its pattern still matches `cancel` | same | pass |
| A11 | Through the repository: a dispatched request on the ORDINARY inbox stream becomes Return and refunds; an undispatched one does not; an order the source has never heard of changes nothing | `tests/repositories/before-shipping-dispatch-category.test.ts` | pass |
| A12 | The source is asked for the conversation's own order and nothing else; two rows on one page each keep their own order's answer within one batched read | same | pass |
| A13 | No source query at all when no row could be corrected, when there is no order key, or when no source pool was supplied | same | pass |
| A14 | The page query is unchanged — no `context_snapshots`, no `order_number` — and the key lookup is scoped to the ids that could use one, binds the marketplace, and is skipped where the row already carries the key | same | pass |
| A15 | The notification feed lists the corrected conversation under Return and refunds and no longer under Order change, before shipping | same | pass |
| A16 | All 24 guards, including `no-customer-data` and the 293 assertions in the three suites nearest this change | `tests/guards/`, `tests/repositories/` | pass, unmodified |

`npm run typecheck` and `npm run lint` clean. Full suite 4,909 passing; the only
failures are the three known-failing spreadsheet-corpus tests recorded in
`documentation/ai-coding-context.md` §8.

## B. Live — RUN, PASSING

| # | What | Result |
| --- | --- | --- |
| B1 | eBay 50802 shows **Return and refunds** in the running application | pass |
| B2 | eBay 40467 shows **Return and refunds** | pass |
| B3 | The category still exists: 9 of ~900 conversations across three marketplaces still carry it | pass |
| B4 | Every one of those 9 audited against the source by hand — 4 have no verified order, 5 have `shipped_time IS NULL`. No conversation lost the category while its order was unshipped or unverified | pass |

Re-derive B3/B4 with `sql/2026-09-30-before-shipping-dispatch-audit.sql`.

## C. NOT YET RUN — and each needs a person

| # | What | Why it is not automated |
| --- | --- | --- |
| C1 | **CST reads a sample of corrected conversations and agrees with the destination.** 20 rows, mixed cancellation / swap / address change. | It is a judgement about their own taxonomy, not a property of the code. The address-change case is the one to watch — see C2. |
| C2 | **Decide what a post-dispatch ADDRESS CHANGE should be.** Today it becomes Return and refunds. `marketplaceAddressAdmin` already files it as Admin where the TEXT says the order has gone. | Needs CST's answer. Nobody has counted how many exist. |
| C3 | **Settle `cst-category-corpus.ts` row `2 A2`.** Its `category` field says Order change, before shipping; its `condition` describes a return; the rule implements the condition. | A workbook change, and it is CST's to make. |
| C4 | **A store-wide count of what the rule moves**, by outcome. | The category is not stored, so it needs the two-step sweep in `query-packs/`. |
| C5 | **How often the 24-hour ordering margin decides a reading.** If that set is large, the two databases' timezones need confirming. | Query 2.2 in `query-packs/`; no measurement taken. |
| C6 | **Reconcile the AI draft path.** It still grades against the classifier's uncorrected category. | Deliberately out of scope; see `duplicate-risk-reports/`. |

## D. How to reproduce B1/B2 by hand

1. `npm run dev`, then `GET /api/conversations?marketplace=ebay&limit=200`.
2. Find the conversation by `counterpartyRef` and read `category`.
3. Check the order behind it with Block A then Block B of
   `sql/2026-09-30-before-shipping-dispatch-audit.sql`. `shipped_time` before the
   newest customer message and a category of "Return and refunds" is the pass.
4. Block C of the same file shows every order that buyer holds, which is how a
   target-order decision is checked by eye.
