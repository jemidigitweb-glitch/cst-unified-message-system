# Handover — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-handover-status.md](2026-09-08-handover-status.md).

## State

Built, migrated and verified against live data. **Nothing is committed** — the
work is in the working tree only.

The automation is currently **switched on** for one storefront
(`sub_source_id = 22`) with a floor of `2026-09-20 05:50:00` and the
"Post-dispatch update with tracking" template, from the proof run. 43 records
exist: 25 processed in test mode, 1 cancelled, the rest scheduled.

## To switch it off

Open `/automations` and press the toggle, or:

```
PATCH /api/automations/settings   {"enabled": false}
```

Off stops both halves — the scan and the processing of records already
scheduled. "Off" should mean off, not "drain the queue first".

## To run it

```
GET /api/cron/automation   Authorization: Bearer $CRON_SECRET
```

One bounded pass: up to 200 shipments discovered, up to 50 processed. Whatever a
call does not reach is picked up next time. It is **not yet in `vercel.json`'s
cron list** — adding it is a deployment decision, and deployment is out of scope.

## Configuration

`cst_app.automation_settings`, one row, `automation_key = 'post_dispatch_message'`.

| Column | Meaning |
| --- | --- |
| `enabled` | master switch |
| `delay_hours` | default 24 |
| `enabled_sub_sources` | `order_management.sub_source.id`; empty = nothing in scope |
| `not_before` | **mandatory**; naive, in `dispatch_time_zone`. Unset = the scan refuses |
| `template_id` | fixed: `post_dispatch_update_with_tracking` v1. Not editable from the screen — change it here |
| `test_mode` | true, and cannot be set false while there is no transport |
| `dispatch_time_zone` | the zone the source's naive dispatch times are written in |

## What a new person needs to know first

1. **`not_before` is the safety.** Without a floor the first scan queues every
   one of the 600,914 dispatched shipments in the source. The scan refuses
   without it, and the settings API refuses to enable without it.
2. **`sent` does not mean sent.** It is this automation's word for "processed
   successfully". Every such row carries `test_mode = true` and
   `processed_mode = 'test_mode'`, the UI shows **Processed (test)** for such a
   row and reserves "Sent" for one a real transport accepted, and the
   database refuses a `sent` row that is not a test-mode row. Building a real
   transport starts by deliberately removing that constraint.
3. **There is no transport, anywhere.** No sender, no credential, no outbound
   URL, no `fetch`. `tests/guards/automation-no-transport.test.ts` fails the
   build if one appears.
4. **The source database is read-only.** SELECT only, on a pool pinning
   `default_transaction_read_only=on`.
5. **This is not the CST draft workflow.** That feature is separate and
   unchanged; the same guard asserts its files are still present.

## Open questions for the owner

- **Which storefronts should be in scope?** One was enabled for the proof run;
  the other 130+ in `sub_source` are a business decision.
- **What should the floor be in production?** It decides how much history the
  first real scan picks up.
- **The template is fixed to "Post-dispatch update with tracking" v1.** It
  requires a verified tracking reference and courier and FAILS a record without
  them. Measured on the last 30 days: 15,597 of 15,600 eligible shipments carry
  both, so ~3 in 15,600 will fail rather than send something wrong. The plainer
  `post_dispatch_update` v1 is also seeded if that trade is not wanted.
- **Return detection covers eBay and Amazon only.** Shopify, B&Q and Temu have
  no equivalent table in the source. Enabling those channels means accepting
  that a return there will not be detected.
- **No authentication on the admin screen**, because the application has none
  anywhere. It should not be exposed outside a trusted network until it does.
- **No resend.** The natural key ignores status, so a shipment is processed once
  and once only. A deliberate resend would be a new feature.
