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
| `0012_automation_worker_wake` | Wake signal for the always-running automation worker: one function, four triggers | **Written, NOT executed — awaiting review** |

## Why `0012` exists
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
unwakeable case — 0012 not applied, a direct SQL edit, a dropped listener
connection — degrades the delay, never the outcome. Correctness comes from
`FOR UPDATE SKIP LOCKED` in `selectDueItems`, untouched by this migration.

It adds **no column, no table and no row**, and alters no existing constraint.
The honest caveat: five triggers and one function are new objects against tables
that already exist, which is a real change to the database even though the schema
of the data is unchanged. `0012.down.sql` drops them with `RESTRICT` and is
non-destructive — the worker falls back to its interval.

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
