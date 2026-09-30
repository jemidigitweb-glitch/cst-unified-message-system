# A negated receipt needs a subject — the DEL-13.1 fix

**2026-09-30.** Read from the working tree. The second of two category fixes made
today; the other is
`documentation/2026-09-30-before-shipping-dispatch-rule-overview.md` and they share
no code.

---

## 1. What was wrong

eBay conversation **33222** was tagged **Delivery queries**. It is a wiring
enquiry. The customer asked whether a cable is 2-core or 3-core, we asked which
they wanted, and a month later they answered — with an apology for missing the
reply:

> "Hi i need a 3 core. So sorry, i dont get notifications come through."

`DEL-13.1`, the sheet 13 non-receipt catch-all, matched:

```
dont                        the negator
 get notifications          the window — 19 characters, contents never checked
come                        the receipt verb
```

The pattern asked whether a receipt had been **negated** and never asked **what**
had failed to arrive. So a sentence about eBay's email alerts was recorded as a
parcel that never came.

**It cost the thread its category.** `INT-PS19` matched "3 core" in the very same
sentence, but Delivery queries is a CASE category and Pre sales is not, so
earliest-case-wins handed the whole conversation to the fabricated parcel report.

The priority engine had it right all along — `pre_sales_enquiry`, LOW. That
disagreement between the chip and the ribbon is what made the bug visible.

## 2. The fix

A subject test on `DEL-13.1`'s window. Two lookaheads, because the subject lands
on either side of the verb:

```
"i dont get NOTIFICATIONS come through"   subject before  → leading lookahead
"I did not receive any NOTIFICATION"      object after    → trailing lookahead
```

Both windows stop at a sentence boundary, so a customer who mentions both — *"I
never got a notification from you. My parcel has not arrived either."* — is still
reporting a non-delivery.

## 3. Two wider fixes were tried and rejected, and the corpus rejected one of them

**Dropping the bare `come|came` verb.** Wrong: *"my order still hasn't come"* is
the commonest British phrasing of exactly what sheet 13 is for.

**A long list of things that arrive by wire** — `notification`, `email`,
`update`, `confirmation`, `alert`, `text`, `sms`. This failed
`cst-category-corpus.test.ts`: **sheet 5 – Not Dispatched owns "No dispatch email
received", "No shipping confirmation at all" and "No update at all since I
ordered".** A customer chasing a missing dispatch email is reporting a parcel that
never left, and that IS a delivery query. Row `5.2` was stranded, and the
reachability test named it.

So the list is only the vocabulary of the conversation itself —
**notification, message, reply** — and it carries an exception for the parcel:

| Owned by Delivery, and still matched | Sheet |
| --- | --- |
| "No notification about where it was left" | 2 – Delivered Not Received |
| "No notification to collect" | 11 – Collection point |
| "Parcel was taken to a collection point but customer was not notified" | 11 |

`PARCEL_QUALIFIER_BEFORE` and `PARCEL_QUALIFIER_AFTER` are what keep those. A
channel noun sitting next to parcel vocabulary is never excluded.

## 4. Where it lives

All of it is in `lib/knowledge/cst-category-evidence.ts`, above the evidence map:
`CONVERSATION_CHANNEL_NOUN`, `PARCEL_QUALIFIER_BEFORE`, `PARCEL_QUALIFIER_AFTER`,
`NOT_A_CONSIGNMENT`, `RECEIPT_NEGATOR`, `RECEIPT_VERB_PHRASE`, and
`NON_RECEIPT_OF_A_CONSIGNMENT` which `DEL-13.1` now uses as its pattern.

**`lib/knowledge/message-category.ts` is not edited.** The frozen classifier's own
module is untouched; this is one trigger pattern in the evidence map it consults.

It is the first `new RegExp` in that file. Justified: the subject test is needed
twice in one pattern, and two 400-character literals would be unreviewable.
`cst-category-evidence.test.ts` already asserts every pattern is non-global and
case-insensitive, and it still passes.

## 5. Verification

- `tests/knowledge/category-regression.test.ts` — a new section-2 block for 33222,
  with the controls that keep sheet 13 whole: every phrase the sheet quotes, the
  bare `come` phrasing, and the both-in-one-message case. 288 passing.
- **1,292 category tests pass**, including `category-golden-set`,
  `category-ownership` and the corpus reachability test that rejected the wider
  fix. The frozen baseline is otherwise untouched.
- Live: 33222 now reads **Pre sales queries** in the running application.
- Full suite 4,915 passing; the only failures are the three known-failing
  spreadsheet-corpus tests in `documentation/ai-coding-context.md` §8.
