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
