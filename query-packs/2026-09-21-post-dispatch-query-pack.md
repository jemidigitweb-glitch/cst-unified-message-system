# Query pack — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-query-pack-status.md](2026-09-08-query-pack-status.md).

All source queries are **SELECT only**, on a pool pinning
`default_transaction_read_only=on`.

## Source: discovery

`findDispatchedShipments` — `lib/repositories/dispatch-event-repository.ts`

Filters in SQL so an ineligible shipment is never transferred:

```
sh.status = 'Completed'
AND sh.cancelled_at IS NULL
AND oi.shipped_time IS NOT NULL
AND oi.shipped_time >= $1::timestamp          -- the mandatory floor
AND o.sub_source_id = ANY($2::int[])          -- enabled storefronts
AND lower(COALESCE(o.status,'')) NOT IN ('cancelled','refunded','deleted')
```

`DISTINCT ON (sh.id)`, because `customer_info`, `shipping_address` and
`order_item_info` can each carry several rows per order and would otherwise
multiply one shipment into several dispatch events. Ordered
`dispatched_at ASC, shipment_id ASC` — oldest first — and bounded by `LIMIT`.

The SQL is an optimisation, not the policy: `eligibilityForPostDispatch`
re-applies every one of these rules in code, to every row, and again to a fresh
read before a message is prepared.

## Source: revalidation

`dispatchEventForShipment` — the same SELECT list, `WHERE sh.id = $1::bigint`,
**deliberately unfiltered**. It must be able to return a cancelled order and a
cancelled shipment: telling those apart from "this shipment no longer exists" is
the whole point of the revalidation step, and a filtered query would make every
ineligible item look deleted.

## Source: the return and cancellation check

Two `EXISTS` sub-selects on the same row, joined on the marketplace order
number and the storefront — the only keys those tables carry:

```
customer_service.ebay_order_cancellations c  ON c.order_id = o.order_id
                                            AND c.sub_source = o.sub_source_id
customer_service.ebay_returns  r             ON r.order_id = o.order_id
                                            AND r.sub_source = o.sub_source_id
customer_service.amazon_returns ar           ON ar.order_id = o.order_id
                                            AND ar.sub_source = o.sub_source_id
```

PRESENCE is what counts, not state: 37,814 eBay return rows carry a null
state, and the safe reading of a return whose outcome is unrecorded is to say
nothing to the customer.

## Application: the statements that write

| Statement | Guard |
| --- | --- |
| `INSERT … automation_items … ON CONFLICT (automation_key, sub_source_id, source_shipment_id) DO NOTHING` | the natural key, status-blind |
| `SELECT … FOR UPDATE OF i SKIP LOCKED` | concurrent runs take disjoint sets; the lock is held for the whole processing transaction |
| `UPDATE … SET status='sent', processed_mode='test_mode' … WHERE status='scheduled' AND test_mode` | re-asserts test mode in SQL; the table's CHECK refuses the row otherwise |
| `UPDATE … SET status='skipped'/'failed' … WHERE status='scheduled'` | cannot overwrite a finished record |
| `UPDATE … SET status='cancelled' … WHERE status='scheduled'` | only a scheduled record may be cancelled |
| `UPDATE automation_settings SET <named columns only>` | cannot be steered into touching a record |

Every one is parameterised. None can record a `sent` row that is not a
test-mode row.

## Scheduling, in SQL

```
(dispatched_at::timestamp AT TIME ZONE $zone) + ($delay::int * interval '1 hour')
```

`AT TIME ZONE` on a naive timestamp reads it AS being in that zone and returns
the instant — exactly the conversion the source's zone-less `shipped_time`
needs, done once, in one place. **Never `now()`**: scheduling from scan time
would silently make every late discovery a day late again.

## Inspection queries used to verify the mapping

Kept in `sql/2026-09-21-post-dispatch-source-verification.sql`.
