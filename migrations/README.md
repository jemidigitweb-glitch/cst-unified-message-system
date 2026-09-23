# Migrations

Forward-only, numbered SQL pairs. **No migration framework** — a heavy dependency
is not justified for the number of migrations this project will have.

```
NNNN_<description>.up.sql     applies the change
NNNN_<description>.down.sql   reverses it
```

| Migration | Purpose | Status |
| --------- | ------- | ------ |
| `0001_cst_core_schema` | Core schema: users, conversations, messages, sync state, verified context, audit | Applied |
| `0002_unresolved_marketplace_messages` | Storage for source messages whose direction, identity and grouping are unverified | **Written, NOT executed — awaiting review** |
| `0005_cst_knowledge_base` | CST rule corpus: sources and sign-off, categories, rules, examples, triggers | **Written, NOT executed — awaiting review** |
| `0011_post_dispatch_automation` | Post-dispatch automation: templates, settings, records | Applied 2026-09-21 |
| `0012_internal_notes` | Internal notes: CST staff notes about a conversation | Applied 2026-09-22 |
| `0013_automation_restore_cancel_pair` | Relaxes `ck_automation_items_cancel_pair` so Undo Cancel can keep `cancelled_at` | Applied 2026-09-22 |
| `0014_follow_up_reminders` | Shared CST follow-up reminders: one row per promise made in a conversation | Applied 2026-09-22 |
| `0015_automation_worker_wake` | Wake signal for the always-running automation worker: one function, four triggers | **Written, NOT executed — awaiting review** |
| `0016_conversation_message_media` | eBay customer message images, one row per image, URLs only | Applied 2026-09-23 |
| `0017_agent_activity` | Which CST agent did what, imported from the message application's activity log | Applied 2026-09-23 |
| `0018_agent_directory` | Minimal agent-id → display-name lookup | Applied 2026-09-23 |
| `0019_response_sla_policy` | The message application's response-time target, per marketplace and seller account | **Written, NOT executed — awaiting review** |

## Why `0019` exists

**NOT EXECUTED.** The table exists in no database and holds no row. Its importer
(`npm run import:sla-policy`) defaults to a dry run and has been run in that mode
only.

CST's SLA performance KPI cannot be computed because the approved target is not
in CST. It is in `message_app.sla_configs`: **16 hours on a weekday, 24 at the
weekend**, per seller account, set 2026-04-15. This copies those 42 rows and
nothing else.

**It stores what the policy SAYS; it does not decide which policy GOVERNS.** CST
applies its own 24-hour rule (`lib/domain/response-sla.ts`) and the two
disagree — measured on identical data the gap is worth up to 30 percentage
points, so it is a business decision, recorded in
`handover/2026-09-23-response-time-sla-handover.md` (A1). That is precisely what
makes this safe to apply while the decision is open: no compliance percentage is
computed from these rows, no dashboard tile changes value, and
`RESPONSE_SLA_MINUTES` is untouched.

**42 rows of 1,081, and the filter is the point.** `sla_configs` holds two
populations under one table name: `type='response'` is the policy (42 rows,
`key_value` NULL on every one), and `type='urgent'` is **1,039 rows of per-case
escalation log**, written 2026-04-16 and stopped 2026-05-06, each carrying a
customer's marketplace message id and a `reason` column quoting phrases from
their conversation. Only the 42 are read, and no column in this migration could
hold either field — `tests/migrations/sla-policy-schema.test.ts` asserts that
statically.

**`sub_source_id` is nullable because one target genuinely has no account.**
Amazon's policy row carries `mail_id = 1`, and `mails.id = 1` has `sub_source`
NULL — the source does not say which seller account it belongs to. CST holds
exactly one Amazon account (8), so writing 8 would very probably be right and
would be a fabricated join, indistinguishable from the 14 eBay rows where the
source states the account outright. NULL means "the whole channel", and it is a
verified reading rather than a missing value.

PostgreSQL treats NULLs as distinct in a unique index, so
`uq_response_sla_policy_scope` coalesces it to `-1`. Without that, the
channel-wide row is insertable twice and every re-run appends another pair.

**There is deliberately no unique index on source identity**, which is a
departure from 0016, 0017 and 0018. Three Shopify mailboxes (`mail_id` 2, 3 and
8) resolve to one seller account (104), so the mapping from source row to policy
row is **many-to-one** — six source rows become two — and a unique index on
`source_pk` would assert a one-to-one relationship the data does not have.
`source_pk` here is provenance; the scope key is the identity, and it is what
makes the import idempotent. The importer collapses the duplicates, picks the
lowest source id so a re-run is deterministic, and **refuses the whole run** if
two rows collapsing to one account disagree on the target.

**Coverage is incomplete, and that is data.** After a full import, 7 of CST's 25
seller accounts have no target: Shopify 109, 198, 233, 245 and 248 (their
mailboxes were created 2026-04-21, six days after the policy was written), B&Q
104, and Temu 248. `target_hours` therefore has **no DEFAULT**: those accounts
must resolve to no policy at all, never to a borrowed number.

## Why `0016`, `0017` and `0018` exist

**Applied 2026-09-23** to the application database only — `varmen_db`, schema
`cst_app` — in that order, each as its own transaction. The `cst_app` base-table
count went from **27 to 30**; three tables, ten indexes (3 PK + 3 unique source
identity + 4 lookup) and twelve COMMENTs were created. **No existing table
gained, lost or changed a row**, `conversation_messages.attachments` was
identical before and after (848 of 31,993 rows, with its CHECK and index
intact), `app_users` still holds zero rows, and **no source-database object was
read or written**. All three tables were deployed **empty** — no data was
imported.

Three new sources became available: `message_app` and `order_management`, both
**MariaDB**, both owned by other projects, both **strictly read-only**. No
migration creates, alters or writes a single object in either — they appear in
no migration in any form, and `tests/migrations/mysql-source-schema.test.ts`
asserts that statically.

**`0016`** stores eBay customer message images. 0007 chose a `jsonb` column for
Shopify and B&Q because "an attachment has no identity of its own in the
source"; eBay media does have one (`message_app.files.id`, plus `view_order` and
a UNIQUE key), so 0016 keeps it in a child table. That is 0007's reasoning
applied to a differently-shaped source, not a reversal of it —
`conversation_messages.attachments` is untouched and keeps serving Shopify and
B&Q. **Return-case photographs are deliberately not stored**: they are already
readable through `lib/repositories/ebay-image-repository.ts`, which requires a
verified order number because `ebay_returns` has no buyer column.

It keeps `source_ref_id` — the `files.ref_id` the row was matched on — so
reconciliation is a local join. Without it, re-checking one row walks back
through two databases against an account capped at **50 MySQL connections per
hour**.

**`0017`** stores which agent did what. Nothing in `cst_app` records this today —
`draft_revisions.created_by_user_id` is NULL on all 434 rows,
`context_snapshots.confirmed_by_user_id` on all 405, `internal_notes
.author_user_id` on both, `audit_log` is empty. The activity log is the only
verified record that exists. Its `data` JSON payload — which contains the full
reply text and the customer's email address — is **not** copied; only the one
identifier the join needs is lifted out.

Its matched/conversation CHECK is a **one-way implication on purpose**, and 0013
is why: the natural biconditional would collide with `ON DELETE SET NULL` and
reject a conversation delete with `23514`, exactly as
`ck_automation_items_cancel_pair` broke Undo Cancel. Both forms were run against
PostgreSQL in a rolled-back transaction — the biconditional fails the delete with
`23514`, the one-way form passes and preserves the activity row.

The price, recorded rather than left to be rediscovered: the same looseness
accepts `INSERT (match_status='matched', conversation_id=NULL)`. A CHECK cannot
tell an INSERT from a cascade. The importer owns that one, and a test pins the
admission.

**`0018` is blocked on a decision, not on work.** `cst_app.app_users` looks like
the right home and is not: `management_user_id` documents a logical reference to
`issue_tracking.management_users`, a system this project is **not connected
to**, and the two id spaces overlap with every overlapping id naming a different
person — id 43 is "Bietrick" there and "mathusha" (17,788 CS actions) in
`order_management`. Reading `ledsone.staff.users` instead was measured and is
insufficient: stale by ~2.5 months, and missing 3 of the 13 agents including the
second most active. `app_users` is left entirely untouched either way. 0016 and
0017 do not depend on 0018 and can be applied without it.

## Why the worker wake migration is `0015` and not `0012`

It was written as `0012` on a branch while `0012_internal_notes` was being
written as `0012` on another, and both reached this file. Two migrations cannot
share a sequence number: the number is what orders them, and a database that ran
one `0012` has no way to say which.

The **unapplied** one moved. `0012_internal_notes` is applied to `varmen_db`;
renumbering an applied migration would leave every database that ran it claiming
a number this repository no longer has. The wake migration had not been executed
anywhere, so renaming it costs nothing and breaks nothing.

`tests/migrations/follow-up-reminders.test.ts` now asserts that **no two
migrations share a number**, so the next collision fails a test rather than
reaching a reviewer.

## Why `0014` exists

**Applied 2026-09-22** to the application database only — `varmen_db`, schema
`cst_app` — creating `cst_app.follow_up_reminders` and its two indexes. The
`cst_app` base-table count went from 26 to 27; nothing else in the schema was
added, altered or removed, `cst_app.internal_notes` was byte-identical before and
after, and **no source-database object was read or written**. No row was
inserted: the table was deployed empty, and the constraint behaviour was proved
beforehand in a rolled-back transaction rather than against live data.

When CST tells a customer "we will update you within 48 hours", that promise is
recorded nowhere. It is not derivable either: no message text may be scanned for
it — the before-shipment rule exists because reading wording to decide priority
was wrong in three separate ways — and the response SLA measures how fast we
answer a message, not a commitment somebody made inside one. A promise is a
decision a person took, so it is stored as one.

**Shared, not owned.** There is deliberately no `assigned_user_id`,
`created_by_user_id` or `completed_by_user_id`. This application has no
authentication, no session and no current user: `cst_app.app_users` holds zero
rows, and `draft_revisions.created_by_user_id` is null on all 434 revisions
because no caller has ever had a user to supply. An ownership column added now
could only be filled with NULL, and a nullable owner that is always null teaches
readers to ignore the field. Ownership is a later migration, once identity
exists.

**Three states stored, four shown.** `upcoming`, `due soon` and `overdue` are the
same `scheduled` row read against a clock; only `completed` is a fact about the
reminder. Persisting the derived three would create rows that are wrong between
the moment they come due and the moment something remembers to update them —
exactly the bug a derived reading cannot have. `ix_follow_up_reminders_due` is
the partial index that makes the derived reading cheap, the same shape as
`ix_automation_items_due`.

`ck_follow_up_reminders_completed_pair` is a **one-way implication** and `0013`
is why: completed implies a timestamp, a timestamp does not imply completed, so
reopening a completed reminder cannot hit the `23514` that Undo Cancel did.

**It reminds a person; it cannot contact a customer.** No template, no body, no
recipient, no channel, no marketplace, no scheduled send, and no status meaning
"sent". `note` is CST's own words to CST.

`cst_app.internal_notes` is **not touched** by either direction. It was written
in parallel on another branch as `0012_internal_notes`, so while 0014 was being
written the table existed in `varmen_db` with no migration on this branch to
explain it; it has one, and a feature behind it. Leaving it alone was the right
call for the wrong reason, and the reason is corrected here.

## Why `0013` exists

`0011` shipped `ck_automation_items_cancel_pair` as a **biconditional** —
`cancelled_at` set if and only if `status = 'cancelled'`. That is right for
Cancel and fatal for Undo Cancel: restoring a record sets `status` back to
`scheduled` and deliberately leaves `cancelled_at` in place, so the row still
shows that it was cancelled and put back. PostgreSQL rejected that UPDATE with
`23514`, and because the restore route only special-cases a missing store, the
admin page got a bare 500 — "Unable to restore this record".

`0013` changes **only that CHECK**. No column, no table, no row. A cancelled row
must still record when it was cancelled; a `scheduled`, `sent`, `skipped` or
`failed` row MAY keep the timestamp as history. `0011.up.sql` carries the same
relaxed form so a fresh database never needs `0013`; this file is the identical
change for a database that already ran the original.

Its `down` migration is **destructive to Undo Cancel** and says so: any restored
row (`scheduled` with `cancelled_at` set) fails the old biconditional, so the
rollback refuses until those rows are cancelled again or the timestamp cleared.
The old constraint and Undo Cancel cannot coexist.

## Why `0015` exists
`scripts/run-automation-worker.mjs` starts once and waits on the exact
`scheduled_at` of the next due record instead of polling every fifteen minutes.
It cannot see a row appear, so the writer tells it: every statement that can
change which record is next calls `cst_app.automation_wake()`, which performs
`pg_notify('cst_automation_wake', reason)`.

**`pg_notify` inside a transaction is delivered only on COMMIT.** A rolled-back
insert wakes nobody, so the worker never wakes to find nothing there. The four
triggers are **statement-level**: a scan that inserts 500 records costs one
notification, not 500, and the insert trigger's `WHEN` clause reads the
statement-level transition table `new_rows` to announce only rows that arrived
`scheduled`.

**This is latency, not correctness.** The worker also re-reads the soonest moment
on its own interval (15s by default) and claims nothing early because of it, so an
unwakeable case — 0015 not applied, a direct SQL edit, a dropped listener
connection — degrades the delay, never the outcome. Correctness comes from
`FOR UPDATE SKIP LOCKED` in `selectDueItems`, untouched by this migration.

It adds **no column, no table and no row**, and alters no existing constraint.
The honest caveat: five triggers and one function are new objects against tables
that already exist, which is a real change to the database even though the schema
of the data is unchanged. `0015.down.sql` drops them with `RESTRICT` and is
non-destructive — the worker falls back to its interval.

## Why `0012` exists

A CST agent needs somewhere to record where a case stands — a courier update, an
instruction from a supervisor, a fault in a listing, what happened last time
this customer wrote in. There was nowhere for that to live.
`conversation_messages` is the customer thread, and a row there IS a message
exchanged with a customer; `audit_log` records state changes from a closed
action list, not prose; `draft_revisions` describes a reply. A note about the
case is none of the three.

**These notes are staff-only, and the schema is where that is stated.**
`internal_notes.visibility` is `NOT NULL` and constrained to the single value
`'internal'`. A customer-visible note would require altering
`ck_internal_notes_visibility` on purpose — it cannot be reached by an insert
that simply omits the column, and it cannot be forgotten. Same device as
`automation_items.test_mode` in `0011`.

`author_user_id` is **nullable and always written NULL today**. This application
still has no interactive sign-in, so there is no agent identity to stamp on a
note — the same reason `draft_revisions.created_by_user_id` and
`context_snapshots.confirmed_by_user_id` are null. The column is already here,
so nothing needs backfilling with a guess when sign-in arrives.

`source_order_id` is a plain column with no foreign key, because the order lives
in the read-only source database this schema must not couple itself to — the
rule `0011` states for `automation_items.source_order_id`.

Create and view only. Edit and delete are a later phase; `updated_at` exists so
that phase needs no migration of its own.

## Why `0011` exists

A dispatched shipment is scheduled, rechecked when it comes due, and processed
against a saved message template. It is deterministic: no model runs, no corpus
is retrieved, and nothing is drafted or reviewed.

**There is no transport in this phase, and the schema is where that is
enforced.** `automation_items.test_mode` is `NOT NULL` with no default, and
`ck_automation_items_sent_requires_test_mode` permits `status = 'sent'` only
while it is true. Every processed row therefore states, as a stored fact rather
than as a convention, that it was processed locally and that no message left the
system. Building a real transport has to start by deliberately changing that
constraint; it cannot be forgotten.

`sent` is the lifecycle word this automation was specified with — the full set is
`scheduled`, `sent`, `skipped`, `failed`, `cancelled`. A private synonym was
considered and rejected: it would put a translation step in every screen, query
and report. The honesty is carried by `test_mode` and `processed_mode`, which
travel with the row, and by the interface, which labels the status
"Processed (test)" for a test-mode row, reserving "Sent" for a row a real
transport accepted — a branch nothing can reach while the CHECK above stands.
`tests/guards/no-send-capability.test.ts`
and `tests/guards/draft-workflow.test.ts` each carry a narrow, documented
exemption for this one word in these files, and
`tests/guards/automation-no-transport.test.ts` is the price of it: no marketplace
or mail host, no credential, no outbound URL at all, no `fetch`.

`automation_settings.not_before` is seeded NULL **on purpose**. The source holds
600,914 dispatched shipments with a recorded dispatch time, every one older than
`dispatched_at + 24h` and therefore immediately due. Without a floor the first
scan would queue every order this business has ever shipped, so the scan refuses
to run until an operator sets one.

This migration holds no drafts, no revisions and no citations. **The CST
conversation draft workflow (0004, 0005) is untouched** and continues to serve
customer replies; nothing in 0011 reads or writes any of its tables.

Source ids (`source_order_id`, `source_shipment_id`, `sub_source_id`) are plain
columns with no foreign key, like the `management_user_id` link: they point into
a different, read-only database this schema must not couple itself to.

## Why `0005` exists

`0004` records *which* rules a draft cited — `draft_revision_sources` holds
opaque references and deliberately no rule text. `0005` is where that text lives,
so a citation resolves back to the instruction it came from and can be shown to
the reviewer.

It is knowledge only. There is no column for a customer message, order, SKU,
marketplace, conversation or draft, and no foreign key to any table holding one.
The dependency runs one way: drafts cite rules; rules know nothing about drafts.

`cst_knowledge_sources.active` is constrained to require `status = 'approved'`,
so an unreviewed spreadsheet row cannot become grounding for a customer-facing
reply. That status is a **document sign-off**, not a conversation workflow state
— the workflow still terminates at `reviewed`, and `0005` adds no state to it.
`tests/guards/draft-workflow.test.ts` carries a narrow exemption for this one
literal in this one file, plus a test pinning it away from the workflow.

The example pairs in `cst_rule_examples` come from the rule documents and are
illustrative wording. **Real customer traffic must never be copied into them** —
SQL cannot enforce the provenance of a string, so this is a rule for the importer.

## Why `0002` exists

`cst_app.conversation_messages.direction` is `NOT NULL` with
`CHECK (direction IN ('inbound','outbound'))`. Both permitted values are claims
about which way a message travelled. A source that does not record direction has
no truthful value to write, and picking either one would store a guess that every
downstream consumer reads as verified fact.

Widening that CHECK to admit `'unknown'` was considered and rejected: it would put
unverified rows in the table the conversation view reads, so every consumer would
have to remember to exclude them. A separate table without a `direction`,
`counterparty_ref` or `conversation_id` column makes the mistake impossible
rather than merely discouraged.

`0002` is purely additive. It alters nothing from `0001`, and applying or
reverting it leaves existing conversations untouched.

## Naming

`NNNN_<capability>.up.sql` — the sequence number orders migrations; the name
describes what the migration *is for*. Name by domain, capability, or technical
purpose, never by when the work happened: `0002_draft_workflow`, not
`0002_day2_openai`. `tests/guards/file-naming.test.ts` enforces this.

## Hard rules

- Migrations target the **application database only**, and create objects **only
  inside `cst_app`**. Nothing in `issue_tracking`, `poc_listing`, or `public` may
  be referenced, altered, or dropped — those belong to unrelated projects.
- The live source database is **strictly read-only** and must never appear in a
  migration in any form. Neither may the knowledge database.
- No migration may introduce a post-review workflow state or any structure
  capable of transmitting a customer reply. The workflow terminates at
  `reviewed`.
- No cross-schema foreign keys. The link to `issue_tracking.management_users` is
  a plain nullable column, kept logical on purpose so this project's schema does
  not couple to another project's lifecycle.
- Source timestamps are stored as naive `timestamp`, copied verbatim. Never cast
  them to `timestamptz` until the ingestion owner confirms the source zone — the
  source server is `Europe/Berlin`, so an implicit cast shifts every message.
- Application-generated timestamps use `timestamptz`.

`tests/migrations/cst-core-schema.test.ts` enforces most of the above statically
on every test run. It reads the SQL as text and never connects to a database.

## Running one (later, after review)

Both directions are wrapped in a single transaction, and the up migration is
re-runnable (`IF NOT EXISTS` throughout). Apply with any plain client against the
application database; there is no runner to install.

The down migration is **destructive** — it deletes all Phase 1 application state.
It exists for a rejected or failed migration, not for routine use. It drops the
schema with `RESTRICT`, never `CASCADE`, so it fails loudly rather than
destroying anything unexpected that ended up in `cst_app`.

## Deferred to Day 2

Drafts, draft revisions, AI run metadata, knowledge sources and citations. The
CST knowledge authority is not settled, so no rule content and no
OpenAI/vector-store identifiers appear in Day-1 structures.

## Prerequisites before executing `0001`

1. Sign-off on the `cst_app` boundary and this migration.
2. Confirmation of the threading rule and the order-status classification.
3. Confirmation of which database role owns `cst_app`.
