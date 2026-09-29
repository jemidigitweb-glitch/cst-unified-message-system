# Root cause capture — data map

**2026-09-29.**

**This feature reads one database and writes another, and the split is the
whole safety story.** The message application's recorded root cause is read from
the read-only marketplace source. CST's own recorded root cause is written to
the application database. Nothing crosses.

## What is read, and from where

`ledsone` → schema `customer_service` → the `root_cause` column on five tables.

| Marketplace | Table | Key |
| --- | --- | --- |
| eBay | `ebay_message_headers` | `id` — the **header** table; the body table has no root cause and is never the recorded source table |
| Amazon | `amazon_messages` | `id` |
| Shopify | `shopify_messages` | `id` |
| B&Q | `bandq_messages` | `id` |
| Temu | `temu_messages` | `id` |

Read-only in the strongest sense available: the source pool pins
`default_transaction_read_only=on` on its session, so the server refuses a write
from that path regardless of what is written. The table names are compile-time
literals from the marketplace adapters, never taken from the `source_table`
column — a table identifier cannot be a bound parameter, so interpolating a
stored value would be injection through a data column.

Which source rows belong to a conversation is answered by
`cst_app.conversation_messages`, not by re-threading. CST already threaded these
rows and recorded each one's full source identity.

## What is written, and where

`varmen_db` → schema `cst_app` → table `conversation_root_causes` (migration
`0020`, **not yet applied**).

| Column | Type | Origin |
| --- | --- | --- |
| `id` | `bigint` identity | database |
| `conversation_id` | `bigint` NOT NULL | `cst_app.conversations.id`, FK, `ON DELETE CASCADE` |
| `root_cause` | `text` NOT NULL | the label the agent chose, verbatim — or their own prose from the OTHER flow. **Deliberately unconstrained**: the vocabulary lives outside this schema and free text is a supported path |
| `courier` | `text` NULL | one of ten, CHECK-constrained. A reporting dimension |
| `courier_issue_type` | `text` NULL | one of ten, CHECK-constrained. A reporting dimension. CHECK requires a courier first |
| `issue_note` | `text` NULL | the agent's own account; CHECK rejects blank |
| `vocabulary_version` | `integer` NOT NULL | stamped at write from `ROOT_CAUSE_VOCABULARY_VERSION` |
| `recorded_by_user_id` | `bigint` NULL | `cst_app.app_users.id`, FK `ON DELETE SET NULL` — **not in the INSERT at all**, so it takes its default |
| `recorded_at` | `timestamptz` NOT NULL | `now()`, the database's own clock |

Indexes:

- `ix_conversation_root_causes_conversation (conversation_id, recorded_at DESC, id DESC)`
  — the panel's read, and how "current" is derived.
- `ix_conversation_root_causes_recorded_at (recorded_at DESC, id DESC)`
  — the report's date-range scan.
- `ix_conversation_root_causes_courier (courier, courier_issue_type, recorded_at DESC) WHERE courier IS NOT NULL`
  — the courier comparison. **Partial**, because a row with no courier can never
  satisfy one and most rows will have none.

## The vocabulary's own origin

The eighteen labels in `lib/domain/root-cause-vocabulary.ts` are not a CST
invention and not a copy of a file. They are the distinct non-blank values of
`root_cause` across the five source tables, measured on 2026-09-29, ordered by
frequency, with OTHER moved to the end. The query is kept at
`sql/2026-09-29-root-cause-vocabulary-measurement.sql`.

This makes the list **derived data with no live link**. Re-run the query to
refresh it; when the list changes, bump `ROOT_CAUSE_VOCABULARY_VERSION`. Nothing
resolves a label against the source at read time, deliberately — a stored label
must still mean what it meant when somebody chose it.

## The cross-database rule, applied

No foreign key points at `ledsone`. No statement joins the two. The source rows
referenced by a conversation are referenced by plain id columns on
`conversation_messages`, which is how every other feature in this application
does it. Migration `0020` names no source-database object in executable SQL —
only in the prose explaining why the table exists.

## What is not stored

No customer message text, no customer name, no address, no postcode, no
tracking number, no marketplace, no order id. The note is an agent's account of
what happened, not a copy of what a customer wrote. No column a transport could
read: no recipient, no channel, no template, no rendered body.
