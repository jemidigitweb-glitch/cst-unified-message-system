# Internal notes — data map

**2026-09-22.**

**There is no source-to-application mapping here, and that is the finding worth
recording.** Every other data map in this folder traces a field out of the
read-only marketplace database into `cst_app`. An internal note has no such
origin: it is typed by a CST agent in this application, stored in this
application, and read back by this application. Nothing about it is derived
from `ledsone`, and nothing in `ledsone` is read to produce one.

## Where it is stored

`varmen_db` → schema `cst_app` → table `internal_notes` (migration `0012`).

| Column | Type | Origin |
| --- | --- | --- |
| `id` | `bigint` identity | database |
| `conversation_id` | `bigint` NOT NULL | `cst_app.conversations.id`, FK, `ON DELETE CASCADE` |
| `source_order_id` | `bigint` NULL | `order_management.orders.id` — **plain column, no FK** |
| `note_category` | `text` NOT NULL | **not asked for and not client-settable** — the writer stores `general`; CHECK still constrains the column to five values so older rows read back |
| `note_text` | `text` NOT NULL | the agent's own words, trimmed; CHECK rejects blank |
| `author_user_id` | `bigint` NULL | `cst_app.app_users.id`, FK `ON DELETE SET NULL` — always NULL today |
| `visibility` | `text` NOT NULL | defaults `'internal'`, CHECK permits nothing else |
| `created_at` / `updated_at` | `timestamptz` NOT NULL | `now()` |

Index: `ix_internal_notes_conversation (conversation_id, created_at DESC, id DESC)`
— the one read this feature performs.

## The cross-database rule, applied

`source_order_id` names a row in `order_management.orders`, which lives in
`ledsone`. It is a **plain `bigint` with no foreign key**, the same rule
`0011` states for `automation_items.source_order_id`: the order lives in a
different, read-only database this schema must not couple itself to. Postgres
could not enforce such a constraint across databases in any case, and pretending
otherwise in the schema would be a relationship nobody can rely on.

Nothing in this feature resolves that id into order data. If a note needs order
context on screen, the existing order-context pipeline already supplies it to
the same panel.

## Relationship to `order_management.note`

The source database holds 8,148 `buyer` notes and 113 `team` notes (counts
unchanged on 2026-09-22). The `team` rows are genuinely internal notes, written
by colleagues in the order system.

**They are not this feature, and this feature does not read them.** They are
read-only, they belong to the order rather than to a CST conversation, and
`lib/domain/customer-note.ts` already excludes them from the customer-notes feed
by `note_type`. New notes written here go to `cst_app.internal_notes` and
nowhere else; no row in `ledsone` is created, updated or deleted by this
feature, and the source role holds `SELECT` only across all 172 of its tables.
