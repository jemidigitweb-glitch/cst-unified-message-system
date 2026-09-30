# Capability — the before-shipping dispatch rule

**2026-09-30.** What the system can and cannot do now that
`lib/domain/before-shipping-dispatch-rule.ts` exists.

---

## It can

- **Refuse the "Order change, before shipping queries" tag on an order that had
  already shipped when the customer wrote**, and file the conversation under the
  existing **"Return and refunds"** instead. Both values are the classifier's own;
  no category was added and `MESSAGE_CATEGORIES` still has eleven members.
- **Identify which order a request is about** before reading any dispatch state —
  from an order number the customer typed, or from there being only one order the
  conversation is verified against.
- **Say that it does not know.** `ambiguous` (several orders, none quoted),
  `unavailable` (no order at all), `target_dispatch_unknown` (nothing read) and
  `dispatch_state_for_another_order` (a sibling's state was offered) are four
  distinct reported outcomes, and each leaves the classifier's category standing.
- **Tell "shipped before the message" from "shipped after it".** A parcel that
  left after the customer wrote keeps the before-shipping category — that is a
  failure to act on a live request, not a mis-categorised conversation.
- **Apply on the ordinary inbox stream**, not only on the urgent sweep. The
  conversation that forced the work (eBay 50802) has our reply as its newest
  message, so it was never an urgent candidate.

## It cannot, and must not

- **Use another order's dispatch state.** A `VerifiedDispatch` carries the order
  number it was read for, and the rule compares it against the resolved target
  before believing it. Passing the sibling's state produces
  `dispatch_state_for_another_order` and changes nothing.
- **Choose between two candidate orders.** CST's own duplicate-order row says
  "confirm which order to cancel — never assume", and the rule reports `ambiguous`
  rather than picking the displayed one.
- **Read dispatch from text.** No sentence, ours or the customer's, can set the
  dispatch state: it comes from `order_management.order_info.shipped_time` through
  `order-shipment-state-repository.ts`, the one dispatch reader that exists.
- **Correct any other category.** Only "Order change, before shipping queries"
  makes a claim about an order, so only it can be made wrong by one.
- **Act on an order.** Nothing here cancels, refunds, holds a dispatch, writes to
  the source or sends anything. `reviewed` is still terminal.

## What it deliberately does not know

- **Whether the two timestamps are in the same zone.** `shipped_time` is naive in
  the source and the message instant is `COALESCE(source_ts_utc, ingested_at)`, so
  the ordering is asserted only past a 24-hour margin — see
  `DISPATCH_ORDERING_MARGIN_HOURS`. Closer than that resolves to "the order has
  gone", which is the operational truth an agent needs.
- **Whether a post-dispatch ADDRESS CHANGE should be a return.** Today it becomes
  one, because CST's rule is "if it is shipped it is not order before shipping" and
  Return and refunds is the stated destination. `marketplaceAddressAdmin` already
  files it as Admin where the TEXT says the order has gone. Flagged, not resolved.
