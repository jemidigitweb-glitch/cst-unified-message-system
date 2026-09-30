# Closure — the before-shipping dispatch rule

**2026-09-30.** What was built, and the decisions behind it.

---

## The request

Fix cancellation classification so the category is decided by the dispatch status
of the order the customer is actually asking to cancel — never by another
displayed or matched order's — using the existing taxonomy.

Clarified mid-task by CST: *"the main rule for order before shipping is the
conversation order did not ship when the message was received; if it is shipped it
is not order before shipping."* That widened the rule from cancellations to any
request the classifier files under that case area.

## What was built

| File | What it is |
| --- | --- |
| `lib/domain/before-shipping-dispatch-rule.ts` | NEW. The whole rule, pure. Target-order resolution, the dispatch comparison, the category correction, and the reported outcome. |
| `lib/domain/order.ts` | `MIN_ORDER_IDENTIFIER_LENGTH`, `normaliseOrderIdentifier`, `orderIdentifierQuoted` — moved here from `order-match-evidence.ts` so one definition answers "did the customer type this order number" for both readers. |
| `lib/domain/order-match-evidence.ts` | Uses those. Behaviour unchanged. |
| `lib/repositories/conversation-repository.ts` | `ORDER_KEYS_FOR_CONVERSATIONS` (new statement), `applyBeforeShippingDispatchRule`, `withBeforeShippingCategory`, `orderKeysForDispatchRules`, `verifiedDispatchFor`, `customerMessagesOf`. The urgent rule's inline key collection now calls the shared filter. |
| `tests/domain/before-shipping-dispatch-rule.test.ts` | NEW. 29 tests. |
| `tests/repositories/before-shipping-dispatch-category.test.ts` | NEW. 17 tests. |

## The decisions

**The classifier was not touched.** `lib/knowledge/message-category.ts` is frozen
(`documentation/ai-coding-context.md` §7) and is text-only by design — it cannot
read an order. The correction is a separate pure rule applied to the category the
classifier produced, so the two axes stay apart: the classifier reads the request,
the source reads the order.

**No new vocabulary.** The cancellation reading keys off CST's own evidence row
`INT-OS01`, whose condition already says "CANCELLATION — not dispatched. Check
dispatch status first". Nothing was checking it. Matching the row by id and running
the row's own pattern is what keeps this from being a third classifier — and it is
why the Italian "cancellazione" in eBay 50802 reads as a cancellation with no
pattern written here.

**The cancellation reading is reported, not a condition.** eBay 40467 is a
post-delivery SWAP request on an order dispatched the day before, filed under
before-shipping. Gating the correction on cancellation wording would have left it
wrong. The ORDER decides; `cancellationRequested` travels on the reading because it
is the first thing a reviewer asks of a corrected row.

**The dispatch state names its own order.** `VerifiedDispatch` is
`{orderNumber, dispatched, dispatchedAt}` rather than a bare boolean, and the name
is compared against the resolved target. That makes "never use another order's
status" structural rather than something a caller has to remember, and it is what
the negative tests assert.

**The ordinary inbox projection was left alone.** `LIST_CONVERSATIONS` still does
not join `context_snapshots`: two suites tell it apart from the urgent sweep by
exactly that, and its own header promises every conversation whatever its
placement. The order key is fetched by a third statement scoped to the ids that
could actually use one — usually none.

**Applied after the urgent rule, never before.** `beforeShipmentOutcome` still
reads `already_dispatched` — the explanation for why the row is not urgent — while
the category says what the case now is. Correcting first would make the rule answer
`not_an_order_change` and throw that explanation away.

## Not done

- **The corpus row is not reconciled.** `cst-category-corpus.ts` row `2 A2`,
  "Customer requests cancellation — order ALREADY dispatched", is filed under
  *Order change, before shipping queries* in CST's own workbook. The rule now moves
  exactly that case to Return and refunds. The code follows CST's spoken rule; the
  spreadsheet still says the other thing, and that is the thing to settle.
- **No field on `InboxItem` records that a category was corrected.** The outcome is
  computed and tested but not carried to the browser, so the wire shape and the
  `api-surface` guard are untouched. A reviewer sees the corrected category and the
  `already_dispatched` outcome beside it.
- **The AI draft path is unchanged.** `draft-assembly.ts` and
  `draft-validation.ts` still read `readConversation` directly, so a draft is still
  graded against the classifier's uncorrected category. Deliberate: the brief said
  not to change the draft workflow. It is a real divergence and is recorded in
  `duplicate-risk-reports/`.
