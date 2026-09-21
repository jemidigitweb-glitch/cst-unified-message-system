# Workflow — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-workflow-status.md](2026-09-08-workflow-status.md).

> **Superseded within the day.** An earlier version put each item through
> drafting and human review. It was simplified to the specified requirement:
> saved template, rendered deterministically, processed in test mode.

## The workflow

```
Order dispatched (shipment.status = 'Completed')
  → detect dispatch timestamp        order_info.shipped_time (naive)
  → check configuration              on? storefront in scope? floor set? template?
  → create ONE scheduled record      unique on (automation, storefront, shipment)
  → scheduled_at = dispatched_at + delay_hours        never scan time
  → when due, RECHECK the source     cancelled / refunded / returned / gone?
  → load the stamped saved template  by id AND version
  → render from verified values      test mode: local only, no network
  → record the result                sent · skipped · failed
```

## The states

| State | Set by | Meaning |
| --- | --- | --- |
| `scheduled` | the scan | waiting for `scheduled_at` |
| `sent` | the runner | processed successfully — in this phase always test mode |
| `skipped` | the runner | the recheck found the order no longer qualified |
| `failed` | the runner | the template could not be rendered or used |
| `cancelled` | an operator | stopped before it was processed |

Every state but `scheduled` is terminal. `failed` is terminal too, deliberately:
an automatic re-queue turns one bad afternoon into an unbounded loop.

There is no `sending`, no `drafting`, no `pending_review` and no `reviewed`.

## What stops a record continuing

`selectDueItems` reads `status = 'scheduled'` and nothing else, so cancelling is
what guarantees a record is never picked up — and `cancelItem` only accepts a
`scheduled` row, so a processed record cannot be retrospectively cancelled.

## The two safety gates

1. **`not_before`.** 600,914 shipments in the source carry a dispatch time, all
   older than `dispatched_at + 24h`. Without a floor the first scan queues all
   of them. Unset, the scan refuses; and the settings API refuses to switch the
   automation on at all.
2. **The recheck.** The scan's snapshot is a day old when the record comes due,
   and a day is exactly how long it takes an order to be cancelled, refunded or
   returned. The source row is re-read immediately before rendering.

## Admin actions

Update settings, and cancel a scheduled record. That is all of them. There is no
edit, no regenerate, no review, no resend and no send.

## Running it

`GET /api/cron/automation` with `Authorization: Bearer $CRON_SECRET`. One bounded
pass: up to 200 shipments discovered, up to 50 processed.

There is **no on-demand trigger in the interface**. The operator run route was
removed: the schedule is what drives this, it is authenticated, and it is the
path a real transport would eventually run on — a button that starts real work
from an unauthenticated page is the wrong shape for that.
