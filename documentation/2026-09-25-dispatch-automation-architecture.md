# Post-dispatch automation — how it works, the flow, and the tables

**2026-09-25.** Read from the working tree. Every table, column and constraint
named here was read from the migration or the query that uses it, not recalled.

---

## 1. What it is, in one paragraph

A parcel goes out. Twenty-four hours later this automation looks at that
shipment again, checks the order has not since been cancelled, refunded or
returned, fills a saved message template from verified source columns, and
**records the rendered text in our own database**. That is the whole of it.

**It schedules, rechecks and renders. It contacts nobody.** There is no
marketplace client, no mail client, no credential read and no outbound network
call in the runner or anything beneath it. It is also the only scheduled writer
in the system besides the message sync.

**No model runs.** No corpus is retrieved, nothing is drafted, nothing is
reviewed. It is a template, a set of column values, and string substitution.
The CST draft workflow is a different feature and shares no code or table with
it.

---

## 2. The lifecycle

Five statuses, and the absences are the design (`automation-types.ts`):

| Status | Means |
| --- | --- |
| `scheduled` | discovered, waiting for `scheduled_at` |
| `sent` | processed successfully — in this phase **always** in test mode |
| `skipped` | the recheck found the order no longer qualified |
| `failed` | processing could not complete |
| `cancelled` | an operator stopped it before processing |

There is deliberately no `sending`, no `drafting`, no `pending_review` and no
`reviewed`. `PROCESSED_MODES` has exactly one member, `test_mode` — a second
would mean a transport exists.

---

## 3. The flow

```
runPostDispatchAutomation({ app, source, scanLimit ≤ 1000, draftLimit ≤ 200 })
│
├── REFUSALS FIRST  (nothing is read from the source until these pass)
│     settings row missing        → refuse. A missing row is NOT "use defaults";
│                                   it means 0011 was never seeded
│     scanRefusal(settings)       → off / no storefront in scope / not_before unset
│                                   ONE refusal covers BOTH halves: switching the
│                                   automation off stops the queue too
│     template missing, unapproved or inactive → refuse
│
├── SCAN     findDispatchedShipments(source, { notBefore, subSourceIds, limit })
│     └── per shipment:
│           eligibilityForPostDispatch()   SQL floor and scope re-applied IN CODE
│           itemExistsForShipment()        app asks first, status-blind
│           insertScheduledItem()          stamps template_id + template_version NOW
│
└── PROCESS  processDueItems() → claimAndProcessDue()   oldest first
      SELECT … FOR UPDATE SKIP LOCKED, every outcome written in the SAME
      transaction
        ├── dispatchEventForShipment()  FRESH source read
        ├── eligibilityForPostDispatch() again        → skipped
        ├── refreshRecipientName()
        ├── template by id AND version                → failed if either moved
        ├── renderTemplate()                          → failed on any unresolved hole
        ├── test-mode assertion in code               → failed: NO_TRANSPORT_CONFIGURED
        └── markItemProcessed(test_mode)              → sent
```

### Why eligibility runs three times

Once in SQL (so an ineligible shipment is never transferred), once in code at
scan time (so the query is an *optimisation*, not the policy — two
implementations agreeing is the point), and once more immediately before
processing **on a fresh source read**. That last one is the safety property of
the whole feature: the delay between scheduling and processing is exactly when
an order gets cancelled, refunded or returned, and rendering from the scan's
day-old snapshot would produce a cheerful dispatch update about a parcel the
customer has already sent back.

### What "dispatched" means

`shipment.status = 'Completed'` and nothing else — `New` is a shipment that has
not gone out. Compared case-insensitively, because the source's capitalisation
is a display choice rather than a contract. Live distributions recorded in
`automation-eligibility-service.ts`:

| Column | Values |
| --- | --- |
| `shipment.status` | Completed (1,005,997) · New (141,623) · Cancelled (7,045) |
| `orders.status` | Completed (1,079,963) · Refunded (18,887) · Cancelled (10,726) · Deleted (879) · Inprogress (699) · Hold (29) · New (8) |

Refusal reasons, each stored on the record: `AUTOMATION_DISABLED`,
`SUB_SOURCE_NOT_ENABLED`, `NOT_BEFORE_UNSET`, `DISPATCHED_BEFORE_FLOOR`,
`SHIPMENT_NOT_DISPATCHED`, `SHIPMENT_CANCELLED`, `ORDER_STATUS_UNKNOWN`,
`ORDER_CANCELLED` / `ORDER_REFUNDED` / `ORDER_DELETED`,
`ORDER_CANCELLATION_RAISED`, `ORDER_RETURNED`, `ORDER_NUMBER_MISSING`,
`CUSTOMER_CONTEXT_MISSING`.

**A return row means "returned" whatever state it is in.** 37,814 eBay return
rows carry a null state, and the safe reading of a return whose outcome is
unrecorded is to say nothing.

### Rendering

Substitution only — no expression language, no conditionals, no fallback text,
no defaults. Every `{{placeholder}}` is replaced by a value copied from a source
column, **or the render fails and the record is marked `failed` naming the
missing values**. "Your order  has been dispatched" and "Your order null has
been dispatched" are both messages this business would not send, and a literal
`{{courier}}` reaching a customer is worse than either.

Variables offered (`templateVariables`): `customer_name`, `order_number`,
`marketplace`, `storefront`, `dispatch_date`, `tracking_number`, `courier`,
`product_title`, `sku`. The customer's name is there because the message is
addressed to them; **their email, address and phone are not**, because a
dispatch update needs none.

---

## 4. Tables

### 4.1 Application database — `varmen_db`, schema `cst_app` (the only place it writes)

All three created by migration **0011**; **0013** relaxes one CHECK; **0015**
adds the wake function and triggers.

| Table | Holds |
| --- | --- |
| `cst_app.automation_templates` | the saved, approved message, versioned |
| `cst_app.automation_settings` | one row per automation — the switches |
| `cst_app.automation_items` | one record per dispatched shipment |

**`automation_templates`** — `id`, `template_key`, `version`, `name`,
`body_template`, `required_variables text[]`, `approved`, `active`,
`created_at`, `updated_at`.
Unique on `(template_key, version)`. `ck_automation_templates_active_needs_approval`
lets an inactive template stay approved (it governed past records) but never
lets an unapproved one be live. Two rows are seeded: `post_dispatch_update` v1
and `post_dispatch_update_with_tracking` v1.

**`automation_settings`** — `automation_key` (`post_dispatch_message`),
`enabled`, `delay_hours` (default 24, bounded 0–8760), `enabled_sub_sources int[]`,
`not_before timestamp` (**naive**), `dispatch_time_zone` (default
`Europe/Berlin`), `template_id` → FK to templates, `test_mode` (default true).
Unique on `automation_key`.

> `not_before` **is the backfill guard**. The source holds 600,914 dispatched
> shipments with a recorded dispatch time, every one already older than
> `dispatched_at + 24h` and therefore immediately due. A NULL floor refuses the
> scan outright rather than scheduling all of them.

**`automation_items`** — `automation_key`, `channel`, `sub_source_id`,
`source_order_id`, `source_order_number`, `source_shipment_id`,
`recipient_name` (a display name and nothing else), `dispatched_at` (naive,
copied verbatim), `dispatch_source`, `dispatch_time_zone`,
`scheduled_at timestamptz` (= dispatched_at + delay, resolved through the zone —
**never scan time**), `template_id`, `template_version`, `status`, `test_mode`
(NOT NULL, **no default**), `processed_mode`, `processed_at`, `rendered_body`,
`skip_reason`, `last_error`, `cancelled_at`, `cancelled_reason`.

Constraints worth knowing by name:

| Constraint | Enforces |
| --- | --- |
| `ck_automation_items_sent_requires_test_mode` | a row can only reach `sent` while `test_mode` is true |
| `ck_automation_items_processed_mode` | `processed_mode` is null or `'test_mode'` |
| `ck_automation_items_processed_pair` | a `sent` row states how, when and what it produced |
| `ck_automation_items_status` | the five statuses, exhaustively |
| `uq_automation_items_shipment` | one record per `(automation_key, sub_source_id, source_shipment_id)` |
| `ix_automation_items_due` | partial index on `(scheduled_at, id) WHERE status='scheduled'` |
| `ix_automation_items_status` | the admin page's status counts |

**The natural key is the SHIPMENT, not the order** — 3,506 orders in the source
have two completed shipments and one has ten; each parcel is its own dispatch
event.

**Migration 0015** adds `cst_app.automation_wake(payload)` calling
`pg_notify('cst_automation_wake', …)`, plus four triggers (items insert, items
status change, items schedule change, settings change). Fired inside the writing
transaction, so a rolled-back insert wakes nobody.

**There are no foreign keys to the source.** Source ids are plain columns, by
design: the source is a different, read-only database this schema may not couple
itself to.

### 4.2 Source database — `SOURCE_DB`, read-only (SELECT only, `default_transaction_read_only=on`)

Read by `lib/repositories/dispatch-event-repository.ts`, one `DISTINCT ON (sh.id)`
query:

| Table | Alias | Join | Used for |
| --- | --- | --- | --- |
| `order_management.shipment` | `sh` | the dispatch event, PK `id` | status, `cancelled_at`, `tracking_number`, `carrier_service_id` |
| `order_management.orders` | `o` | `o.id = sh.order_id` | `o.order_id` = the marketplace order number, `o.status`, `o.sub_source_id` |
| `order_management.order_info` | `oi` | `oi.order_id = o.id` | **`shipped_time` — the dispatch moment** |
| `order_management.sub_source` | `ss` | `ss.id = o.sub_source_id` | storefront name, `ss.source_id` = platform |
| `order_management.carrier_service` | `cs` | `cs.id = sh.carrier_service_id` | `carrier` |
| `order_management.order_item_info` | `oii` | `oii.order_id = o.id` | `item_sku`, `real_sku`, `item_title` |
| `customers.customer_info` | `ci` | `ci.order_id = o.id` | `first_name`, `last_name` |
| `customers.shipping_address` | `sa` | `sa.order_id = o.id` | `address_name` (recipient fallback) |
| `customer_service.ebay_returns` | — | `EXISTS (order_id, sub_source)` | `returned` |
| `customer_service.amazon_returns` | — | `EXISTS (order_id, sub_source)` | `returned` |
| `customer_service.ebay_order_cancellations` | — | `EXISTS (order_id, sub_source)` | `cancellation_raised` |

`order_management.source` is where the platform ids come from: 1 AMAZON,
2 EBAY, 3 SHOPIFY, 16 B&Q, 17 TEMU.

**`DISTINCT ON (sh.id)`** because `customer_info`, `shipping_address` and
`order_item_info` can each carry several rows per order and would otherwise
multiply one shipment into several dispatch events.

**The dispatch time is `order_info.shipped_time`**, not
`shipment.shipment_created_at` — the latter is when the *label* was made, runs
~1.8 hours ahead on average, and covers fewer rows (593,905 against 600,914 on
completed shipments). It is ORDER-level, so an order dispatched in several
parcels gives each parcel the same time, recorded honestly as such. It is
**naive**; the repository never casts it, and interpreting it with the
configured zone is the scheduler's job, done once.

Join coverage verified live: eBay returns matched 42,185 of 42,185 rows,
cancellations 4,551 of 4,551, Amazon returns 13,085 of 15,636.

### 4.3 Tables it does NOT touch

No `conversations`, `messages`, `draft_replies`, `draft_revisions`,
`ai_usage_log`, `internal_notes`, `cst_rules` or `context_snapshots`. The draft
workflow (migrations 0004, 0005) is untouched and nothing here reads or writes
any of its tables.

---

## 5. Entry points

| Entry point | Cadence |
| --- | --- |
| `GET /api/cron/automation` | Fails closed without `CRON_SECRET`; asserts app DB + read-only source first. **No `vercel.json` cron entry exists for it** |
| `npm run worker:automation` | Long-running. Sleeps until the soonest `scheduled_at` rather than polling |
| `npm run worker:automation:once` | One pass, exit |

The worker is woken by **two mechanisms, deliberately**: the `pg_notify` above
(speed), plus one small indexed `SELECT` every 15 seconds against
`ix_automation_items_due` (the guarantee). Nothing is processed early, because
of the recheck.

Operator surface: `GET /api/automations` (settings + records + status counts),
`GET|PATCH /api/automations/settings`, `POST /api/automations/[itemId]/cancel`,
`POST /api/automations/[itemId]/restore`. The screen is its own page, linked
from the workspace header as **Dispatch Automation** and opened in a new tab —
`components/automation-admin.tsx`.

**Undo Cancel is only the inverse of Cancel.** It moves `cancelled` back to
`scheduled` and nothing else: no scan, no source read, no render, no write
beyond the status. That separation is what keeps the button from acquiring a
send path later — it can only make a record *eligible* again, and eligibility is
re-tested from the source at the moment of processing. A `skipped` or `failed`
record has a verdict against it and there is deliberately no way to reverse one.

---

## 6. Safety, enforced rather than asserted

| Level | Mechanism |
| --- | --- |
| Database | `ck_automation_items_sent_requires_test_mode` — a row cannot reach `sent` unless it is a test-mode row |
| Database | `uq_automation_items_shipment` — one record per shipment |
| Domain | `PROCESSED_MODES` has one member; the runner fails a non-test-mode record with `NO_TRANSPORT_CONFIGURED` |
| Build | `tests/guards/automation-no-transport.test.ts` — no marketplace client, mail host, credential, outbound URL or sender anywhere beneath the runner |

`no-send-capability.test.ts` grants this automation — and only it — the literal
word `sent`, by exact path. The prohibition is on a **capability**, not a
spelling, and the database refuses a non-test-mode `sent` row regardless.

Migration 0013 exists because 0011's original cancel CHECK was a biconditional
(`cancelled_at` set **iff** `status = 'cancelled'`), which forbade Undo Cancel:
restoring sets `status` back to `scheduled` while deliberately keeping
`cancelled_at` as history. 0013 relaxes it to one direction only.

---

## 7. Current state

Working, in **test mode only**. Every processed record is a rendered string in
`cst_app.automation_items`; nothing has ever been transmitted. Turning that into
real customer contact means **adding the transport it was deliberately built
without** — new capability requiring business approval, not a configuration
change, and the first thing it would have to do is deliberately drop
`ck_automation_items_sent_requires_test_mode`.

Coverage measured 2026-09-24 — 145 tests across five files, all passing:

```
tests/automation/post-dispatch-scan.test.ts        tests/guards/automation-undo-cancel.test.ts
tests/automation/post-dispatch-processing.test.ts  tests/guards/automation-worker.test.ts
tests/guards/automation-no-transport.test.ts
```

Further reading: `documentation/2026-09-21-post-dispatch-automation-overview.md`,
`workflows/2026-09-21-post-dispatch-workflow.md`,
`sql/2026-09-21-post-dispatch-source-verification.sql`, handover §8.
