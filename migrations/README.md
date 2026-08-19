# Migrations

Forward-only, numbered SQL pairs. **No migration framework** — a heavy dependency
is not justified for the number of migrations this project will have.

```
NNNN_<description>.up.sql     applies the change
NNNN_<description>.down.sql   reverses it
```

| Migration | Purpose | Status |
| --------- | ------- | ------ |
| `0001_cst_core_schema` | Core schema: users, conversations, messages, sync state, verified context, audit | **Written, NOT executed — awaiting GPT Project review** |

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
