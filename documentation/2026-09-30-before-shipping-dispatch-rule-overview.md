# Order change before shipping — how the dispatch check works

**2026-09-30.** Read from the working tree. Every file, column and constant named
here was read from the code or the query that uses it.

---

## 1. The rule, in one paragraph

"Order change, **before shipping** queries" makes a claim about an ORDER, not only
about what the customer wrote. CST's rule: *the conversation's order had not shipped
when the message was received; if it is shipped, it is not order before shipping.*
Once the parcel has gone, the case is a return or a refund — the customer refuses
delivery or sends it back — and it is filed under the existing **"Return and
refunds"**.

The category classifier reads WORDS and cannot read an order. Nothing was reading
one for this purpose, so a request made days after dispatch still arrived under a
heading asserting the window was open.

## 2. What was wrong, measured

Two conversations, both read live on 2026-09-30.

**eBay 50802.** A buyer with a 1-light and a 3-light chandelier on order. CST wrote
to say the 3-light was out of stock; the customer replied that the 1-light had
arrived and that they were therefore proceeding with the cancellation of the 3-light
one. The 3-light order's `shipped_time` is nine days before that message. Category
shown: *Order change, before shipping queries*.

**eBay 40467.** "Thanks for sending lights so quickly, but thinking 3 separate
lights might be more suitable, how do we go about swapping them." A post-delivery
exchange, on an order dispatched the day before the customer wrote. Category shown:
*Order change, before shipping queries*. **Not a cancellation** — which is why the
rule turns on the order's state rather than on cancellation wording.

## 3. The flow

```
readConversation(customer messages)            the classifier, unchanged and frozen
        │
        └── category === "Order change, before shipping queries" ?
                  │ no  -> nothing happens. No other category claims anything
                  │        about an order.
                  ▼ yes
        requestTargetOrder({ customerMessages, knownOrders })
                  │
                  ├── an order number the customer TYPED, exactly one  -> resolved
                  ├── two numbers typed                                -> ambiguous
                  ├── none typed, exactly one known order              -> resolved
                  ├── none typed, several known orders                 -> ambiguous
                  └── no known order                                   -> unavailable
                  │
                  ▼ resolved only
        the dispatch state whose orderNumber IS the target's
                  │
                  ├── none supplied            -> target_dispatch_unknown
                  ├── supplied, wrong order    -> dispatch_state_for_another_order
                  ├── not dispatched           -> target_not_dispatched
                  ├── dispatched AFTER the     -> dispatched_after_the_message
                  │   message, unambiguously
                  └── dispatched               -> target_dispatched
                                                  category := "Return and refunds"
```

Every outcome but the last leaves the classifier's category exactly as it was.

## 4. Where each piece lives

| Piece | File |
| --- | --- |
| The rule, pure | `lib/domain/before-shipping-dispatch-rule.ts` |
| "Did the customer type this order number" | `orderIdentifierQuoted` in `lib/domain/order.ts` — one definition, shared with `order-match-evidence.ts` |
| The cancellation reading | CST evidence row `INT-OS01` in `lib/knowledge/cst-category-evidence.ts`, run by id |
| The dispatch read | `shipmentStateForOrders` in `lib/repositories/order-shipment-state-repository.ts` — the only dispatch reader in the system |
| The order key | `ORDER_KEYS_FOR_CONVERSATIONS` in `lib/repositories/conversation-repository.ts` |
| Wiring | `applyBeforeShippingDispatchRule` (ordinary stream, notification feed) and `withBeforeShippingCategory` inside `applyBeforeShipmentRule` (urgent sweep) |

## 5. Three things worth knowing before editing it

**The dispatch state names its own order.** `VerifiedDispatch` is
`{orderNumber, dispatched, dispatchedAt}`. The rule compares that name against the
resolved target and refuses a state that is not the target's, reporting
`dispatch_state_for_another_order`. Replacing it with a bare boolean would make the
original defect re-introducible in one line and untestable.

**The ordering of the two timestamps is only asserted past 24 hours.**
`shipped_time` is naive in the source; the message instant is
`COALESCE(source_ts_utc, ingested_at)` and `source_ts_utc` is populated for none of
the inbound messages today. `DISPATCH_ORDERING_MARGIN_HOURS` is larger than any
inhabited zone offset, so a bigger gap cannot be a zone error. Closer than that
resolves to "the order has gone" — a parcel that left within a day of the message
cannot be stopped now, whatever the clocks say.

**It runs on the ordinary inbox stream.** The before-shipment urgent rule only sees
the urgent sweep's candidates — reply-inbox threads whose newest message is the
customer's. eBay 50802 is not one (our reply is newest), which is why correcting the
category inside the urgent path alone would have fixed nothing.

## 6. Cost

One batched source read for the conversations on the page filed under this one case
area, and one small app query for their order keys where the projection does not
already carry them. Before-shipping is a minority case area, so on most pages both
are skipped and the inbox runs on the app pool alone. Measured on the live store
2026-09-30: 9 of ~900 conversations across three marketplaces still carry the
category after the correction.

## 7. The open question

`lib/knowledge/cst-category-corpus.ts` row `2 A2` is called "Customer requests
cancellation — order ALREADY dispatched" and its own `category` field says *Order
change, before shipping queries*. The rule now moves exactly that case to Return and
refunds. The code follows CST's spoken rule; the workbook still says the other
thing. That contradiction is real and is not resolved by this work.
