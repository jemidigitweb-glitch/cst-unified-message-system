# Evidence — the before-shipping dispatch rule

**2026-09-30.** What was measured, and what was NOT.

---

## Measured

### The two reported conversations, read from both databases

| Conversation | Marketplace | Snapshot resolution | Order key | `shipped_time` | Newest customer message | Category before | Category after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50802 | eBay | `single_order` | resolved | 2026-09-21 10:26 | 2026-09-29 | Order change, before shipping queries | **Return and refunds** |
| 40467 | eBay | `single_order` | resolved | 2026-09-07 08:19 | 2026-09-29 | Order change, before shipping queries | **Return and refunds** |

Both dispatches precede the newest customer message by more than a week, so the
24-hour ordering margin is nowhere near being the deciding factor in either.

50802's thread is the multi-order case the brief describes: the buyer has orders for
both a 1-light and a 3-light variant of the same listing, the customer says the
1-light arrived and asks for the 3-light to be cancelled, and the 3-light order is
the one the conversation resolved to. The request target and the resolved order agree
here; the rule does not depend on that and refuses to decide where they cannot be
told apart.

40467 is **not** a cancellation — it is a post-delivery swap request — which is what
established that the rule must turn on the order's state rather than on cancellation
wording.

### The whole inbox, after the change

Read from the running application on 2026-09-30, three marketplaces, nine pages of
100 (`/api/conversations`):

- **9 conversations still carry "Order change, before shipping queries"** out of
  ~900 rows. Each was audited against the source by hand:
  - **4** have **no verified order** (`resolution = 'no_order'`, or an
    `unresolved:` counterparty). Nothing was claimed and the category is untouched —
    which is the honest answer, not a pass.
  - **5** have a verified order with **`shipped_time IS NULL`**. Genuinely still
    here, so the category stands. One of them (Shopify 42497) is also
    `urgent: true`, `beforeShipmentOutcome: "eligible"`.
- **0 false corrections found** in that audit: no conversation lost the category
  while its order was unshipped or unverified.

### The cancellation reading

`INT-OS01`'s pattern (`\bcancel\w*\b|\bstorni\w*\b|\bkaufabbruch\b`) was run against
the real 50802 message text: it matches the Italian "cancellazione". It does **not**
match the 40467 swap request, a delivery chase, or "please change my delivery
address" — tested in `tests/domain/before-shipping-dispatch-rule.test.ts`.

The per-message readers were measured on the same text before the design was
settled: `explainMessagePriority` returns **no** `cancellation_requested` for the
Italian (its vocabulary is English-only), and `classifyMessageCategory` on that one
message returns **null**. The thread-level `readConversation` returns
`Order change, before shipping queries` with `requestedAction: "order_amendment"`.
That is why the rule reads the thread rather than the newest message, and why it uses
the evidence row rather than the priority engine.

### Tests

- `tests/domain/before-shipping-dispatch-rule.test.ts` — 29 passing.
- `tests/repositories/before-shipping-dispatch-category.test.ts` — 17 passing.
- Full suite: **4,909 passing**, 35 skipped (the opt-in files), **3 failing** — the
  three in `tests/knowledge/cst-rules-files.test.ts` and
  `tests/ai/knowledge-allowlist.test.ts` that fail on a clean checkout and concern
  the gitignored spreadsheet corpus. `npm run typecheck` and `npm run lint` clean.
- All 24 guards pass, including `no-customer-data` and `before-shipment-urgency`
  (293 assertions across the three suites nearest this change, unmodified).

## NOT measured, and stated plainly

- **How many conversations the change moves across the whole store.** The nine pages
  above are the newest ~900 conversations, not all 9,700. The category is computed
  per request and not stored, so a store-wide figure needs a deliberate sweep — the
  query for it is in `query-packs/`.
- **The two databases' timezones.** Still unconfirmed, which is why the ordering test
  carries a 24-hour margin rather than comparing directly. No measurement was taken
  of how often a real conversation falls inside that margin.
- **Whether "Return and refunds" is the right destination for a post-dispatch
  ADDRESS CHANGE.** The rule sends it there. Nobody has looked at how many such
  conversations exist, and `cst-category-corpus.ts` row `2 A2` disagrees with the
  destination for cancellations too. Recorded in `closure/` as the open question.
- **The AI draft path.** Not exercised. It still reads the uncorrected category —
  see `duplicate-risk-reports/`.
- **Query cost on a large page.** The extra app query and source read were
  reasoned about (both skipped when no before-shipping row is on the page) but not
  timed against production.
