# Workflow — what a CST agent does, now that the dispatch check runs

**2026-09-30.** Step by step, for a person.

---

## 1. What changed on your screen

The "Order change, before shipping queries" chip now means what it says: **the
order had not shipped when the customer wrote.**

A conversation whose order HAD already shipped carries **"Return and refunds"**
instead. Nothing was added to the list of categories and nothing was removed — one
kind of conversation moved from one existing chip to another existing chip.

The "Order Change Before Shipping Queries" notification drawer changed with it: a
conversation whose parcel had gone is no longer listed there. It is in the Return
and refunds area.

## 2. Opening a "Return and refunds" row that reads like a cancellation

This is the case the change creates, and the reply is different from the one the old
chip invited.

1. **Read the order panel.** "Dispatch status" says *Dispatched* and "Shipment
   status" says *Completed*. That is the reason the row is here.
2. **Do not offer to cancel.** The parcel has left. CST's own guidance for this is
   two options: the customer refuses delivery, or returns it on arrival. Refund
   within 48 hours of receiving the return (CFG_OS11).
3. **If the customer is asking for something else** — a swap, an address change —
   answer that on post-dispatch terms. The chip says the order has gone; it does not
   say what they asked for.

## 3. When the chip still says "Order change, before shipping"

One of three things is true, and they are worth telling apart:

| What you will see | What it means | What to do |
| --- | --- | --- |
| Order panel shows *Not dispatched* | The order is verified and still here | Act now. This is the window. |
| Order panel shows nothing useful, or the order is not identified | The order could not be verified, so nothing was claimed | Find the order yourself before promising anything. The chip is the customer's request, not a statement about a parcel. |
| The parcel shipped AFTER the customer wrote | It WAS a live before-shipping request, and it went out anyway | Answer it as the post-dispatch case it now is, and flag it: a request we could have acted on and did not. |

The third row is not a mis-tagged conversation. The chip deliberately keeps saying
what the customer asked for, because that is the only way the missed window stays
visible.

## 4. A conversation with more than one order on it

If the customer has two orders and has not named which one they mean, **the system
does not guess.** The chip stays on whatever the text said and no dispatch claim is
made.

That is CST's own instruction for the duplicate-order case — *confirm which order to
cancel, never assume* — so:

1. Ask the customer which order, or work it out from the order panel.
2. Handle each order on its own state: cancel the unshipped one, guide them to refuse
   or return the dispatched one.

Quoting the order number back in the thread is the thing that lets the system resolve
it too — a number the customer has typed is what it matches on.

## 5. The URGENT badge is unchanged

Urgency and the chip answer different questions and always did. A dispatched order
was never urgent (`already_dispatched`), and that is still the case — the badge is
absent and the chip now says Return and refunds. An unanswered before-shipping query
still stays URGENT until somebody replies.

## 6. What the system still cannot do

It cannot cancel an order, stop a dispatch, issue a refund, or send your reply. It
reads, files and drafts. Every action happens in the systems that can act.

---

## Addendum — what the DEL-13.1 subject test changed on your screen

A customer apologising for missing our reply — "sorry, I don't get notifications
come through" — used to put the whole conversation under **Delivery queries**. It
no longer does, so a thread like that now shows whatever it is actually about. The
one that was reported was a 2-core / 3-core cable question and now reads **Pre sales
queries**.

**What did NOT change, and you should still see it as a delivery query:** a customer
chasing a missing DISPATCH notification. "No dispatch email received", "no shipping
confirmation at all", "no notification to collect", "no notification about where it
was left" — all still Delivery queries, because all of those are about the parcel.

**If a row looks wrong, the chip and the ribbon are worth comparing.** This defect
was visible because the chip said Delivery queries while the priority ribbon said
`pre_sales_enquiry`, LOW. They read the same text through different rules and are
allowed to differ — but when they disagree flatly about what a conversation IS,
that is worth reporting.
