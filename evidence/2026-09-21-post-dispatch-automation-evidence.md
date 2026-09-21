# Implementation evidence — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-implementation-evidence.md](2026-09-08-implementation-evidence.md).
Everything below was observed, not inferred.

> Describes the simplified implementation: saved template, no AI, test mode.

## Source inspection (read-only)

| Question | Answer | How |
| --- | --- | --- |
| Is the source session read-only? | `default_transaction_read_only = on` | `SHOW default_transaction_read_only` |
| Shipment statuses? | Completed 1,005,997 · New 141,623 · Cancelled 7,045 · null 1 | `GROUP BY status` |
| Order statuses? | Completed 1,079,963 · Refunded 18,887 · Cancelled 10,726 · Deleted 879 · Inprogress 699 · Hold 29 · New 8 | `GROUP BY status` |
| Is `order_info` 1:1 with `orders`? | Yes, across all 1,111,189 | `GROUP BY order_id` histogram |
| Several shipments per order? | 3,506 have two, one has ten | same, on completed shipments |
| Which dispatch timestamp? | `order_info.shipped_time` — 600,914 of 974,474 completed shipments (vs 593,905 for `shipment_created_at`, which runs ~1.8h earlier) | coverage + drift query |
| Customer reachable from the order? | Yes — `customers.customer_info.order_id = orders.id`; 4,044/4,044 recent completed shipments also had a shipping address | join coverage |
| **Are returns authoritative?** | **Yes.** `customer_service.ebay_returns` matched 42,185 of 42,185 rows to an order; `ebay_order_cancellations` 4,551 of 4,551; `amazon_returns` 13,085 of 15,636 | join coverage |
| Which platforms exist? | 17 in `order_management.source`; this application has channels for 5 | `SELECT * FROM order_management.source` |

## Migration

Re-applied to `varmen_db` as `varmen_user` on 2026-09-21 after the rewrite.
Creates `automation_templates`, `automation_settings`, `automation_items` — all
in `cst_app`. Seeded state observed:

```json
{"automation_key":"post_dispatch_message","enabled":false,"delay_hours":24,
 "enabled_sub_sources":[],"not_before":null,"template_id":"1","test_mode":true}
```

Two approved templates seeded: `post_dispatch_update` v1 and
`post_dispatch_update_with_tracking` v1.

## Settings safety rails, observed

```
PATCH {"enabled":true}
→ 400 "Set an earliest dispatch date before switching this on…"

PATCH {"testMode":false}
→ 400 "Test mode cannot be switched off: this phase has no marketplace
       transport, so there is nothing for a live run to do."

PATCH {"enabled":true,"notBefore":"2026-09-20 05:50:00",
       "enabledSubSources":[22],"delayHours":24,"templateId":"2"}
→ 200 scanStatus.running = true
```

## Live run

```json
run 1: {"scan":{"ran":true,"examined":43,"created":43,"duplicates":0,"ineligible":0},
        "due":{"claimed":24,"processed":24,"skipped":0,"failed":0}}
run 2: {"scan":{"ran":true,"examined":43,"created":0,"duplicates":43,"ineligible":0},
        "due":{"claimed":1,"processed":1,"skipped":0,"failed":0}}
```

Counts after: `scheduled 19 · sent 24 · skipped 0 · failed 0 · cancelled 0`
(later 18 scheduled / 1 cancelled, see below).

### Scheduling, checked on a real record

```
dispatched_at  2026-09-21 07:27:51   (naive, Europe/Berlin)
scheduled_at   2026-09-22 07:27:51+02
gap            24.0 hours exactly
```

### A processed record

```
status:         sent
test_mode:      true
processed_mode: test_mode
processed_at:   2026-09-21 09:08:00+02
template:       Post-dispatch update with tracking v1
```

Rendered body, stored — produced, not delivered:

```
Hello <customer name>,

Your order <order number> was dispatched on 2026-09-20 09:06:56 with Royal Mail.
Your tracking reference is <tracking reference>.

If anything is not right with your order, reply to this message and we will help.

Kind regards,
Customer Service
```

(Identifying values redacted here; the record itself carries the real ones.)

### Cancellation

```
POST /api/automations/43/cancel {"reason":"Not wanted"} → {"status":"cancelled"}
POST /api/automations/43/cancel {}                      → 409 not_cancellable
```

A subsequent run claimed nothing for it: `selectDueItems` reads only `scheduled`.

## Automated checks

`npx vitest run` — 128 files, **3,547 tests passing**, 12 files / 30 tests
skipped (live-provider suites). 71 of those are the automation's own, plus 30
guard assertions. `npx eslint` on the automation files: clean.

## Safety

- **Source database writes: none.** Every statement issued to the source is
  asserted to begin with `SELECT`, in two test files and observed live.
- **Marketplace/mail/model hosts contacted: none.** The guard now permits **zero**
  outbound URLs anywhere in the feature, and no `fetch` outside the browser
  component that calls this application's own API.
- **Credentials read: none.** No marketplace, mail or model credential appears.
- **Customer messages transmitted: zero.**
