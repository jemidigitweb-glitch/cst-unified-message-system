# Internal notes — handover

**2026-09-22.** Full CRUD shipped: add, read, edit, delete.

## What you are picking up

An agent can add, read, edit and delete internal notes on a conversation, from
a compact **Internal Notes** control in the top-right corner of the details
column. Notes live in `varmen_db` → `cst_app.internal_notes` (migration `0012`,
applied 2026-09-22 and unchanged since). Nothing about the feature touches the
read-only source database.

There is no category. The picker was removed; `note_category` remains on the
table, filled by the writer with `general`, invisible to everyone.

Start with `documentation/2026-09-22-internal-notes-overview.md` for how it
works, and `closure/2026-09-22-internal-notes-scope-status.md` for why the
non-obvious decisions were made.

## Operational notes

- **The migration is applied.** If you are bringing up a fresh environment, run
  `migrations/0012_internal_notes.up.sql` against the application database with
  any plain client — there is no runner. It is re-runnable.
- **If the table is missing**, both handlers answer `503` with "Internal notes
  storage is not available yet" rather than a 500. That is `42P01` being
  recognised, and it means the migration has not been applied to whatever
  database `APP_DB_*` points at — not that the feature is broken.
- **The live test writes.** `RUN_LIVE_NOTES=1 npx vitest run
  tests/repositories/internal-note-live.test.ts` stores one note in
  `cst_app.internal_notes` and removes it in `afterAll`. It is skipped without
  the flag.
- **Nothing here reaches `ledsone`.** The source role holds `SELECT` only
  across all 172 tables and the pool pins `default_transaction_read_only=on`,
  so this is belt and braces — but a `getSourcePool` appearing in this feature
  would fail `tests/guards/internal-note-visibility.test.ts`, and should.

## The one thing to watch

**Notes are unattributed.** `author_user_id` is always NULL because this
application has no interactive sign-in. If someone asks "who wrote this note",
the honest answer is that the system cannot say, and it was built that way
rather than guess.

Expect this to come up the first time a supervisor instruction is disputed. The
fix is authentication against `issue_tracking.management_users` (12 users, in
the same database, roles `staff` / `management` / `admin`), which
`cst_app.app_users.management_user_id` was designed to reference — see the
comment at the top of migration `0001`. The column and the foreign key are
already in place; what is missing is sign-in and a populated `app_users`.

## Do not

- Do not fold notes into `ConversationDetail` to save a request. That payload
  feeds the thread view, the AI draft input and the conversation export, and a
  note in it reaches all three. The separate endpoint is the security control.
- Do not extend the customer-notes feature into this one. It reads buyer notes
  from the source and writes nothing; they share a word and nothing else.
- Do not remove or weaken `ck_internal_notes_visibility` without deciding, on
  purpose, that a customer may see a note.
- **Do not drop `conversation_id` from the edit or delete `WHERE` clause.**
  That clause is the entire access control — without it a note id alone
  reaches any note in the table. A guard asserts both statements carry it.
- Do not add a second DELETE route by copying the first. The guard exemption
  is an exact path, on purpose; a new one has to be added deliberately, with a
  reason.

## Next

Nothing is outstanding on the feature itself. If more is wanted, the obvious
candidates and their open questions:

- **Edit history.** An edit currently replaces the text and `updated_at`
  records that it happened. Keeping revisions would follow the
  `draft_revisions` pattern and roughly double the storage model.
- **Attribution**, once sign-in exists — see above.
- **A note count on the conversation row**, so an agent can see which cases
  carry notes without opening each. That needs a feed-level query, which this
  feature deliberately does not have today.
