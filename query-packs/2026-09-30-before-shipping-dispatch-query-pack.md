# Query pack — the before-shipping dispatch rule

**2026-09-30.** The queries this feature runs, and the ones a report will need.

---

## Part 1 — what the feature runs

### 1.1 The order key and the message instant (`varmen_db` · `cst_app`)

`ORDER_KEYS_FOR_CONVERSATIONS`, in `lib/repositories/conversation-repository.ts`.
Issued only for conversations the classifier filed under
"Order change, before shipping queries", and only where the projection did not
already carry the key.

```sql
SELECT c.id::text AS id,
       CASE
         WHEN c.counterparty_ref LIKE 'unresolved:%'
           THEN CASE WHEN cs.resolution = 'single_order' THEN cs.order_number END
         ELSE COALESCE(
                CASE WHEN cs.resolution = 'single_order' THEN cs.order_number END,
                CASE WHEN c.marketplace <> $2::text THEN c.counterparty_ref END
              )
       END AS order_number,
       (SELECT COALESCE(cm.source_ts_utc, cm.ingested_at)
          FROM cst_app.conversation_messages cm
         WHERE cm.conversation_id = c.id AND cm.direction = 'inbound'
         ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
         LIMIT 1) AS sla_starts_at
FROM cst_app.conversations c
LEFT JOIN cst_app.context_snapshots cs ON cs.conversation_id = c.id
WHERE c.id = ANY($1::bigint[]);
```

`$2` is always `USERNAME_KEYED_MARKETPLACE` from the module. Nothing a caller
supplies reaches it.

### 1.2 The dispatch state (`ledsone` · `order_management`)

`SHIPMENT_STATE_FOR_ORDERS`, unchanged, in
`lib/repositories/order-shipment-state-repository.ts`. Read-only pool.

## Part 2 — the queries a report will need

### 2.1 Every conversation this rule would move, store-wide

**This cannot be answered in SQL alone.** The category is not stored: it is computed
per request by `classifyConversationCategory`. So the sweep is two steps, and a
report that skips the first is measuring something else.

**Step 1 (`varmen_db`) — candidates with a verified order and their text:**

```sql
SELECT c.id::text                        AS conversation_id,
       c.marketplace,
       CASE
         WHEN c.counterparty_ref LIKE 'unresolved:%'
           THEN CASE WHEN cs.resolution = 'single_order' THEN cs.order_number END
         ELSE COALESCE(
                CASE WHEN cs.resolution = 'single_order' THEN cs.order_number END,
                CASE WHEN c.marketplace <> 'ebay' THEN c.counterparty_ref END
              )
       END                               AS order_number,
       (SELECT array_agg(cm.body_text ORDER BY cm.source_ts, cm.source_pk::bigint)
          FROM cst_app.conversation_messages cm
         WHERE cm.conversation_id = c.id
           AND cm.direction = 'inbound'
           AND cm.body_text IS NOT NULL) AS inbound_texts,
       (SELECT COALESCE(cm.source_ts_utc, cm.ingested_at)
          FROM cst_app.conversation_messages cm
         WHERE cm.conversation_id = c.id AND cm.direction = 'inbound'
         ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
         LIMIT 1)                        AS message_at
FROM cst_app.conversations c
LEFT JOIN cst_app.context_snapshots cs ON cs.conversation_id = c.id
WHERE c.marketplace NOT IN ('bandq', 'temu')   -- category is suppressed for these
  AND c.inbox_visibility <> 'filtered';
```

**Step 2 — classify each row in application code** with
`classifyConversationCategory`, keep those returning
`Order change, before shipping queries`, then ask `shipmentStateForOrders` for their
order numbers and apply `categoryForBeforeShipping`. Count by `BeforeShippingOutcome`.

**Trap:** counting only `target_dispatched` under-reports the problem. A report that
does not also show `target_order_unresolved` and `target_dispatch_unknown` reads as
"everything else is fine", when those are the conversations nobody has verified.

### 2.2 How often the 24-hour ordering margin actually decides

```sql
-- ledsone. Per order, the gap between dispatch and a supplied message instant.
-- Run with the conversation/order/message_at triples from 2.1 step 1 as the input.
SELECT o.order_id,
       max(oi.shipped_time)                                       AS shipped_time,
       $2::timestamptz                                            AS message_at,
       extract(epoch FROM (max(oi.shipped_time) - $2::timestamptz)) / 3600
                                                                  AS hours_after_message
  FROM order_management.orders o
  JOIN order_management.order_info oi ON oi.order_id = o.id
 WHERE o.order_id = $1
 GROUP BY o.order_id;
```

Anything with `abs(hours_after_message) < 24` is a conversation whose reading the
margin decided. If that set is large, the margin is doing real work and the
timezones need confirming; if it is empty, the margin costs nothing.

### 2.3 Conversations that WERE a before-shipping request and shipped anyway

`dispatched_after_the_message` is the outcome that names these: a live request the
warehouse shipped through. **It is a different finding from a mis-categorised
conversation** and belongs in a service-failure report, not a category report. Filter
step 2 above on that outcome.

### 2.4 The corpus contradiction, for whoever settles it

```
lib/knowledge/cst-category-corpus.ts, row id "2 A2"
  name:     "Customer requests cancellation — order ALREADY dispatched"
  category: "Order change, before shipping queries"
  condition: "Cannot cancel after dispatch. Two options: refuse delivery or return
              on arrival. Refund within 48hrs of receiving return (CFG_OS11)."
```

The condition describes a return; the `category` field says order change. The rule
implements the condition. Nothing in this pack resolves which the workbook should say.

---

## Addendum — the DEL-13.1 subject test runs no query

The second category fix of 2026-09-30 is a pattern in
`lib/knowledge/cst-category-evidence.ts`. It issues no statement against either
database and adds no projection.

**The query a report WILL need, and why it is not SQL.** "Which conversations
changed category" cannot be answered from storage: the category is computed on the
read path and never written. It needs one pass that classifies each conversation's
`inbound_texts` **twice** — once with the subject test and once without — and
reports the pairs that differ. Step 1 of query 2.1 above supplies exactly the rows;
the two classifications happen in application code, in one pass, so nothing is
measured at two different moments.

**The direction is known even without the count.** The change can only ever REMOVE a
`DEL-13.1` match, so every difference is a conversation that read Delivery queries
and now reads something else. None can move the other way.
