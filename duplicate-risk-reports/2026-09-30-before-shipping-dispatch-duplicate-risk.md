# Duplicate-risk report — the before-shipping dispatch rule

**2026-09-30.** Where the same fact could be established twice, and what stops it.

---

## 1. Two definitions of "did the customer type this order number" — CLOSED

`order-match-evidence.ts` held a private `normaliseIdentifier` /
`MIN_IDENTIFIER_LENGTH` / `quotedInMessage` to show a reviewer "Order number found in
message". The new rule needs the same question answered to pick the cancellation
target.

Two copies would let an evidence line on screen disagree with the category beside
it. So the rule moved to `lib/domain/order.ts` as
`normaliseOrderIdentifier` / `orderIdentifierQuoted` / `MIN_ORDER_IDENTIFIER_LENGTH`,
and `order-match-evidence.ts` now imports it. Behaviour unchanged; its own suite
still passes unmodified.

## 2. Two dispatch readers — NOT CREATED

`shipmentStateForOrders` is still the only place a dispatch state is read, and
`order_info.shipped_time` is still the only signal it reads. The new rule receives
that answer; it issues no query and holds no dispatch vocabulary.

The urgent sweep and the correction want the **same orders**, so they share one key
filter (`orderKeysForDispatchRules`) and, inside `applyBeforeShipmentRule`, one
already-fetched shipment map. No page issues the same source read twice.

## 3. Two cancellation vocabularies — NOT CREATED

The cancellation reading runs CST evidence row `INT-OS01` **by id**, using the row's
own pattern. There is no cancellation regex in the new module, so the wording cannot
drift from the workbook. `explainMessagePriority`'s `cancellation_requested` and the
classifier's `wants_order_change` are untouched and still answer their own questions.

## 4. Two category authorities — ONE, IN SEQUENCE

The classifier reads the text; the rule may then move one category to one other
category. It is applied **once** per item on every path:

| Path | Where |
| --- | --- |
| urgent sweep | `withBeforeShippingCategory` at the end of `applyBeforeShipmentRule`, on the shipment map already read |
| ordinary inbox stream | `applyBeforeShippingDispatchRule` over the page's rows |
| notification feed, before-shipping area | inside `applyBeforeShipmentRule` (above) |
| notification feed, every other area | `applyBeforeShippingDispatchRule` |

`toAwaitingResponseItem` still accepts the already-built base rather than
recomputing, which is what stops a second `toInboxItem` call overwriting the verdict.
The correction is idempotent — a row already reading "Return and refunds" fails the
first gate — so a double application could not double-count even if one were added.

## 5. Counting corrected conversations — A REAL RISK, NOT YET REALISED

No report counts this yet. When one is written, note that **the category is not
stored**: it is computed per request, so a "how many were mis-tagged" figure taken
at two moments can legitimately differ (a parcel ships between them). Any such count
must state the instant it was taken. There is no append-only table here and nothing
to double count in storage.

## 6. The draft path still reads the UNCORRECTED category — KNOWN DIVERGENCE

`lib/ai/draft-assembly.ts` and `lib/ai/draft-validation.ts` call `readConversation`
directly. A conversation the inbox now shows as "Return and refunds" is still
graded against the intent owning "Order change, before shipping queries". That is
not double counting, it is a disagreement: two surfaces reading the same
conversation differently. Deliberately out of scope (the brief said not to change the
draft workflow) and recorded here as the next thing to reconcile.

---

## Addendum — the DEL-13.1 subject test, and the one duplicate it AVOIDED

The second category fix of 2026-09-30 narrowed one trigger pattern
(`documentation/2026-09-30-non-receipt-subject-test-overview.md`).

**No second non-receipt reader was created.** The subject test lives inside
`DEL-13.1`'s own pattern, built from module constants in the same file. The
alternative considered was a new `EvidenceCondition` (`requires: ["not_a_notification"]`)
which would have been a second, whole-message opinion about the same sentence — and
wrong in a way that matters: a message saying both "I got no notification" and "my
parcel has not arrived" would have been vetoed entirely. The window test keeps the
judgement local to the sentence that made it.

**`RECEIPT_NEGATOR` and `RECEIPT_VERB_PHRASE` are now named constants, not a
shared vocabulary.** They are extracted from the one pattern that uses them, so the
pattern can be assembled from readable parts. Nothing else consults them, and
nothing should: `HAS_NOT_ARRIVED` in `message-category.ts` answers a different
question (has a delivery happened) and is deliberately untouched.

**Counting the conversations this moves is not possible from storage.** The category
is computed per request, so a before/after figure taken at two moments is two
classifications rather than one measurement. If a report ever wants it, it must
classify both ways in one pass.
