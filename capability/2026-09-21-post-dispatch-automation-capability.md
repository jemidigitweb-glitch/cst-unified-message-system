# Capability status — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-system-status.md](2026-09-08-system-status.md), which
remains accurate for everything else.

> **Superseded within the day.** An earlier version of this automation generated
> an AI draft and put it through the CST review workflow. It was simplified to
> match the specified requirement: a saved template, rendered deterministically,
> processed in test mode. What follows describes the implementation that exists.

## What the system can now do

A shipment recorded as dispatched is scheduled for `dispatched_at + delay`,
rechecked against the source when it comes due, and processed against a saved
message template. Discovery, scheduling, the recheck, rendering, cancellation
and the admin screen all work end to end and have been run against live data.

## What it cannot do

**It cannot contact a customer.** There is no marketplace client, no mail client,
no credential read and no outbound URL anywhere beneath this feature — a guard
test fails the build on any of them. Every processed record is stored with
`test_mode = true` and `processed_mode = 'test_mode'`, and the database refuses a
`sent` row that is not a test-mode row.

**It does not draft and does not use AI.** No model runs, no corpus is
retrieved. The CST conversation draft workflow is a separate feature and is
untouched.

## Statuses

`scheduled · sent · skipped · failed · cancelled`. `sent` means "processed
successfully"; the interface labels it **Processed (test)** for a test-mode row.
The "Sent" label exists in the code for the day a real transport is connected,
and nothing can reach it today.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Automation on/off | **off** | cannot be switched on without the three below |
| Delay hours | **24** | any whole number of hours up to a year |
| Storefronts in scope | **none** | `order_management.sub_source.id` values |
| Message template | seeded | approved, active templates only |
| Earliest dispatch date | **unset** | mandatory; unset refuses the scan |
| Test mode | **on** | cannot be switched off — there is no transport |

## Per-channel coverage

Resolved from `order_management.sub_source.source_id`, confirmed against
`order_management.source`: 1 amazon, 2 ebay, 3 shopify, 16 bandq, 17 temu. The
other twelve platforms (Etsy, OnBuy, Wayfair, Avasam, ManoMano, Bol, Faire, Woo
and the manual/resend/replacement pseudo-sources) have no channel here and are
**dropped at discovery, not guessed**.

## Known limitations

- **Dispatch time is order-level.** `order_info.shipped_time` is the only
  recorded dispatch moment. An order shipped in several parcels gives every
  parcel the same time; 3,506 orders have two completed shipments, one has ten.
- **Dispatch time is naive.** Interpreted with the configured
  `dispatch_time_zone` (default `Europe/Berlin`), once, at scheduling.
- **Coverage is partial.** 600,914 of 974,474 completed shipments carry a
  dispatch time. A shipment without one is never discovered.
- **Return detection is per-marketplace.** eBay and Amazon returns and eBay
  cancellations are authoritative and joined. Shopify, B&Q and Temu have no
  equivalent table in the source, so a return on those channels is not detected.
- **A record is processed once.** The natural key is the shipment and takes no
  account of status, so there is no resend. A deliberate one would be a new
  feature.

## Where it lives

`lib/domain/automation/`, `lib/repositories/{automation,dispatch-event}-repository.ts`,
`app/api/automations/`, `app/automations/`, `components/automation-admin.tsx`.
