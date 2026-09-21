# Post-dispatch automation — system overview — 2026-09-21

Supplements [2026-09-08-implemented-system-overview.md](2026-09-08-implemented-system-overview.md).

## What it is

A dispatched parcel is scheduled, rechecked when it comes due, and processed
against a saved message template. It is **deterministic**: no model runs, no
corpus is retrieved, nothing is drafted or reviewed.

```
Order dispatched
  → detect dispatch timestamp   order_info.shipped_time (naive, source zone)
  → check configuration         on · storefront in scope · floor set · template
  → create ONE scheduled record unique on (automation, storefront, shipment)
  → scheduled_at = dispatched_at + delay_hours          never scan time
  → when due, RECHECK the source
  → load the stamped template   by id AND version
  → render and record           test mode: local only, nothing transmitted
```

## The admin page

`/automations` — reachable from **Dispatch Automation** in the main workspace
tab row, beside AI Usage.

- **On/off**, and three settings on one row: earliest dispatch date, delay
  hours, storefronts in scope. Plus a stated **Test mode: on**, which cannot be
  switched off because there is no transport.
- The **template is not on this screen**. One approved template governs the
  automation; it is set with `PATCH /api/automations/settings` and read back on
  each record's own row, which is where knowing it matters.
- **Records**: customer, order, shipment, channel, dispatch time, scheduled time
  (in the source zone, with local underneath), template, status, updated, and
  the result — the skip reason, the failure, or the rendered message behind a
  **View** toggle.
- **Filter chips** doubling as per-status counts; pagination with totals.
- **Cancel** on a scheduled record. There is no Run button: the schedule is the
  trigger, and this page does not start one.
- No Send button, and the page says so.

## Statuses

`scheduled · sent · skipped · failed · cancelled`.

`sent` means processed successfully. The interface labels it
**Processed (test)** for a test-mode row, keeping "Sent" for one a real
transport accepted; the row carries `test_mode = true` and
`processed_mode = 'test_mode'`; and
`ck_automation_items_sent_requires_test_mode` means the database refuses a
`sent` row that is not a test-mode row.

## The two safety gates

1. **`not_before`.** 600,914 shipments in the source carry a dispatch time, all
   older than `dispatched_at + 24h`. Without a floor the first scan queues every
   one. Unset, the scan refuses; and the settings API refuses to enable at all.
2. **The recheck.** The scan's snapshot is a day old by the time the record is
   due, and a day is how long it takes an order to be cancelled, refunded or
   returned. The source is re-read immediately before rendering, including
   authoritative eBay/Amazon return and eBay cancellation records.

## Templates

`cst_app.automation_templates`: versioned, approved, active. A record stamps the
template **id and version** when it is scheduled, so changing the selection
tomorrow does not rewrite what governed a record queued today — and a version
that moved underneath a record fails it rather than rendering different words.

Placeholders are substituted from verified source values only. A missing value
**fails the record, naming the value**, rather than rendering a blank.

## What this is not

It is not the CST conversation draft workflow. That feature — AI drafting,
grounding against the approved corpus, citations, human review ending at
`reviewed` — is unchanged and continues to serve customer replies. The
automation imports nothing from `@/lib/ai/` or `@/lib/knowledge/`, and a guard
test fails the build if it ever does.

## Running it

- Scheduled: `GET /api/cron/automation` with `Authorization: Bearer $CRON_SECRET`.

It fails closed, asserts the application database is really the application
database, and asserts the source session is really read-only, before doing
anything.
