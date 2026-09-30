# Data map — the before-shipping dispatch rule

**2026-09-30.** Which value comes from where. Every column below was read from the
statement that selects it, not recalled.

---

## The inputs, and the one database each comes from

| Rule input | Column / expression | Database · schema | Statement |
| --- | --- | --- | --- |
| `category` | computed, not stored — `classifyConversationCategory` over `inbound_texts` | — | `categoryFor` in `conversation-repository.ts` |
| `customerMessages` | `array_agg(conversation_messages.body_text ORDER BY source_ts, source_pk)` for `direction = 'inbound'` | `varmen_db` · `cst_app` | `INBOUND_TEXTS` |
| `knownOrders[].orderNumber` | `context_snapshots.order_number` where `resolution = 'single_order'`, else `conversations.counterparty_ref` (never on eBay) | `varmen_db` · `cst_app` | `orderRefExpression`, via `URGENT_CANDIDATES`, `LIST_AWAITING_RESPONSE` or `ORDER_KEYS_FOR_CONVERSATIONS` |
| `messageAt` | `COALESCE(conversation_messages.source_ts_utc, ingested_at)` of the newest inbound | `varmen_db` · `cst_app` | `LATEST_INBOUND_INSTANT` |
| `dispatch[].orderNumber` | `orders.order_id` | `ledsone` · `order_management` | `SHIPMENT_STATE_FOR_ORDERS` |
| `dispatch[].dispatched` | `max(order_info.shipped_time) IS NOT NULL` | `ledsone` · `order_management` | same |
| `dispatch[].dispatchedAt` | `max(order_info.shipped_time)::text`, naive, verbatim | `ledsone` · `order_management` | same |

## What is NOT read, and why

| Not read | Why |
| --- | --- |
| `shipment.status = 'Completed'` (`labelled`) | A printed label is not a departure — median 78 minutes ahead of it. `order-shipment-state-repository.ts` states the measurement. Treating it as dispatch closed the window more than an hour early. |
| `orders.status` | A lifecycle summary, not a dispatch fact. `Completed` appears on orders with no `shipped_time`, and `Refunded`/`Cancelled` say nothing about whether a parcel left. |
| `conversations.workflow_state` | A state a reviewer sets on a DRAFT. It is not a statement about an order. |
| outbound message text | Lifecycle evidence for the classifier only. Nothing here reads it, and no category is ever taken from it. |
| `context_snapshots.order_status_summary` | A snapshot of a status at resolution time; the source is asked live instead. |

## The new statement

`ORDER_KEYS_FOR_CONVERSATIONS` — `varmen_db` · `cst_app`:

```
conversations c LEFT JOIN context_snapshots cs ON cs.conversation_id = c.id
WHERE c.id = ANY($1::bigint[])
```

Two projections: the order key (the same `orderRefExpression` the two feeds use,
with the `unresolved:` sentinel nulled) and `LATEST_INBOUND_INSTANT` as
`sla_starts_at`. `$2` binds `USERNAME_KEYED_MARKETPLACE`.

**Issued only for conversations the classifier filed under
"Order change, before shipping queries", and only where the projection did not
already carry the key.** On most pages that is nobody and the statement is not
issued at all.

## Direction of access

- `varmen_db` · `cst_app` — **read only** in this feature. No column was added, no
  row is written, and there is no migration.
- `ledsone` · `order_management` — **SELECT only**, on the source pool, which pins
  `default_transaction_read_only = on`. One existing statement, unchanged.
- MariaDB staff directory (`DB_ORDER_*`) — **not touched**.
