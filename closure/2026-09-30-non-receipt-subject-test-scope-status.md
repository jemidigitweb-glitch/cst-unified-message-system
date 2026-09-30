# Closure — the DEL-13.1 subject test

**2026-09-30.** What was built, and the decisions behind it. The second of two
category fixes made today; the other is
`closure/2026-09-30-before-shipping-dispatch-rule-scope-status.md` and they share
no code.

---

## The request

eBay conversation 33222 (`jela.uk.…`) reported as wrongly tagged **Delivery
queries**. It is a 2-core / 3-core cable enquiry.

## What was built

| File | What changed |
| --- | --- |
| `lib/knowledge/cst-category-evidence.ts` | `DEL-13.1`'s pattern gained a SUBJECT test. New module constants above the evidence map: `CONVERSATION_CHANNEL_NOUN`, `PARCEL_QUALIFIER_BEFORE`, `PARCEL_QUALIFIER_AFTER`, `NOT_A_CONSIGNMENT`, `RECEIPT_NEGATOR`, `RECEIPT_VERB_PHRASE`, `NON_RECEIPT_OF_A_CONSIGNMENT`. |
| `tests/knowledge/category-regression.test.ts` | A section-2 block for 33222 with six assertions, three of them controls. |

Nothing else. **`lib/knowledge/message-category.ts` was not edited** — the frozen
classifier's own module is untouched; this is one trigger pattern in the evidence
map it consults.

## The decisions

**The defect was a missing subject, not a greedy verb.** `DEL-13.1` asked whether
a receipt had been *negated* and never asked *what* had failed to arrive, so the
19 characters between `dont` and `come` — " get notifications " — went untested.
The fix tests them.

**Two lookaheads, because the subject lands on either side of the verb.**
"i dont get NOTIFICATIONS come through" puts it before; "I did not receive any
NOTIFICATION" puts it after. A fix on one side alone leaves the other.

**The verb list is unchanged.** Dropping the bare `come|came` alternative was the
obvious cheap fix and is wrong: *"my order still hasn't come"* is the commonest
British phrasing of what sheet 13 exists for. There is a control test for it.

**THE CORPUS CUT THE EXCLUSION LIST DOWN, and this is the part worth reading.**
The first attempt excluded everything that arrives by wire — `notification`,
`email`, `update`, `confirmation`, `alert`, `text`, `sms`.
`cst-category-corpus.test.ts` failed and named row `5.2`: **sheet 5 – Not
Dispatched owns "No dispatch email received", "No shipping confirmation at all"
and "No update at all since I ordered".** A customer chasing a missing dispatch
email is reporting a parcel that never left, which is a delivery query. My model
of the distinction was wrong and the guard said so.

So the list is only the conversation's own vocabulary — notification, message,
reply — plus a parcel exception, because three more corpus phrases had to survive:
"No notification about where it was left", "No notification to collect", "Parcel
was taken to a collection point but customer was not notified". A channel noun
adjacent to parcel vocabulary is never excluded.

**The first `new RegExp` in that file, deliberately.** The subject test is needed
twice in one pattern and two 400-character literals would be unreviewable. The
existing assertions in `cst-category-evidence.test.ts` — every pattern non-global
and case-insensitive — still pass.

**Three of my own invented test cases were nearly allowed to drive the design.**
"I never got your email", "I did not receive any notification from eBay", "I have
not had a reply come through" are mine, not reported, and the first version of the
list existed to satisfy them. When they collided with CST's own workbook the
workbook won. They survive under the narrow list by coincidence and are kept
because they are the shapes a reviewer will ask about.

## Not done

- **No sweep of what else changes category.** `DEL-13.1` is a catch-all and this
  change can only REMOVE matches, so some conversations reading Delivery will now
  read something else. Direction known, count not measured — see `evidence/`.
- **Conversation 38749 (`jessicamariarodriguez`) inspected and left alone.** It
  reads Delivery queries, HIGH. The thread opens as a pre-sales size question and
  becomes a delivery-delay dispute with a deadline and a UPS label created but not
  scanned. Delivery queries appears correct; no defect was identified, so nothing
  was changed. Put back to CST for a view rather than guessed at.
- **Whether a wiring compatibility question should be Pre sales or Admin.**
  `INSTALLATION_GUIDANCE_CATEGORY` files installation guidance under Admin, and
  33222 does ask whether new wire fits an old bulb fitting. It lands on Pre sales
  because CST's `INT-PS19` sheet is titled "PRE-SALES QUERIES · O — WIRING AND
  INSTALLATION". Flagged, not decided.
