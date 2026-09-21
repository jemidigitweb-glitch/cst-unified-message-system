# Duplicate risk — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-duplication-and-resync-status.md](2026-09-08-duplication-and-resync-status.md).

## The risk

The scan is re-run on a schedule and reads the same source rows every time. A
shipment that produced a work item on Monday is still dispatched on Tuesday. Any
gap in the identity rule produces a second record for the same parcel — and,
once a transport ever exists, a second message to the same customer.

## The natural key

```
(automation_key, sub_source_id, source_shipment_id)
```

The SHIPMENT, not the order. 3,506 orders in the source have two completed
shipments and one has ten; keying on the order would collapse genuinely distinct
dispatch events into one. `automation_key` is included so a second automation
over the same shipments is a separate item, not a collision.

## Both halves of the protection

| Layer | Where | What it stops |
| --- | --- | --- |
| Application check | `itemExistsForShipment`, called before every insert | the ordinary repeated scan — no insert is attempted at all |
| Unique index | `uq_automation_items_shipment` + `ON CONFLICT … DO NOTHING` | two concurrent scans that both looked, both saw nothing, and both inserted |

Neither is sufficient alone and neither is redundant. The check makes the common
case free; the index makes the race impossible.

## Claiming is also race-proof

`selectDueItems` reads `FOR UPDATE SKIP LOCKED` inside one transaction, and every
outcome — `sent`, `skipped`, `failed` — is written inside that same transaction.
Two concurrent runs therefore take disjoint sets, and a crash mid-run leaves rows
`scheduled` rather than half-processed.

There is no intermediate claimed state to move a row into, and none is needed:
the lock is held for the life of the transaction that does the work.

## Evidence

Two scans over the same 43 live shipments: the first created 43, the second
created 0 and reported 43 duplicates, with the table still holding 43 rows.

`tests/automation/post-dispatch-scan.test.ts` covers the repeated scan, a
direct double insert that bypasses the application-side check, a shipment
already processed, and pins the `ON CONFLICT` clause to the key above.

## The key ignores status, deliberately

It takes no account of `status`, so a `sent` record blocks a second one as
firmly as a `scheduled` one does — which is what makes "already successfully
processed for this shipment" an eligibility rule the database enforces rather
than one the application has to remember. A deliberate resend would have to be
a new feature that says so.
