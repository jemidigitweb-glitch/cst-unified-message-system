# Capability — the DEL-13.1 subject test

**2026-09-30.** What the classifier can and cannot do now.

---

## It can

- **Tell a missed notification from a missed parcel.** "I dont get notifications
  come through" no longer asserts a non-delivery. Nor does a missed message or a
  missed reply.
- **Still read a missing DISPATCH notification as a delivery query.** "No dispatch
  email received", "No shipping confirmation at all", "No notification to collect",
  "No notification about where it was left" all still reach Delivery queries —
  these are CST's own phrases from sheets 5, 2 and 11, and a customer chasing a
  missing dispatch email is reporting a parcel that never left.
- **Read the subject on either side of the verb.** "i dont get NOTIFICATIONS come
  through" and "I did not receive any NOTIFICATION" are both handled.
- **Keep both readings when the customer states both.** "I never got a
  notification from you. My parcel has not arrived either." is still a
  non-delivery, because the window stops at the sentence boundary.

## It cannot, and must not

- **Lose any phrase sheet 13 quotes.** "I have not received my order", "Nothing has
  been delivered", "Order never arrived", "I didn't get the package", "Did not
  receive the item" and "My order still hasn't come" are pinned as controls in
  `tests/knowledge/category-regression.test.ts`.
- **Read a category off an outbound message.** Unchanged.
- **Grow this exclusion list without the corpus agreeing.** A wider list stranded
  corpus row `5.2` and `cst-category-corpus.test.ts` failed. That test is the guard
  on this change: anything added here must keep every PRIMARY_ISSUE family
  reachable from its own bare phrases.

## What it still does not know

- **Whether an unqualified "notification" was about the parcel.** "I got no
  notification" with nothing else in the sentence is now read as a conversation
  matter. Where a parcel word sits next to it — before or after — it stays a
  delivery matter. A customer who means the parcel and says neither will be read as
  the former.
- **Whether a wiring compatibility question is Pre sales or Admin.** 33222 asks
  whether new wire fits an old bulb fitting, and lands on Pre sales because CST's
  `INT-PS19` sheet is titled "PRE-SALES QUERIES · O — WIRING AND INSTALLATION".
  `INSTALLATION_GUIDANCE_CATEGORY` would file installation guidance under Admin.
  Flagged, not decided.
- **How many other conversations this moves.** The classifier is not persisted and
  no sweep was run. The change can only REMOVE `DEL-13.1` matches, so the direction
  is known and the count is not.
