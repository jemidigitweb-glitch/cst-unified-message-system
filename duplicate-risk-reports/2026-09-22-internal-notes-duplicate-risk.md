# Internal notes — duplication and re-sync risk

**2026-09-22.**

## Is the feature idempotent?

**No, and deliberately not.** Every other writer in this project upserts:
`conversation_messages` is unique on its source coordinates,
`conversation_rule_analysis` is one row per conversation,
`automation_items` is unique on the shipment. Those all record a fact the
application derived, so re-deriving it must not accumulate rows.

An internal note is not derived from anything. Two notes reading "Chased the
courier", written an hour apart, are two real events, and collapsing them would
destroy the case history the feature exists to keep. There is therefore no
unique constraint on the note text and no upsert — `addInternalNote` inserts,
always.

## Where a duplicate could come from

**A double-click on Save.** The panel disables the button while `saving` is
true, so the second click does not fire. This is the only plausible source of
an accidental duplicate, and it is handled in the interface rather than the
database, because the database cannot tell an accidental second note from a
deliberate one.

**A failed save that actually succeeded.** If the insert commits and the
response is lost, the agent sees "This note could not be saved" and may write
it again — two rows. Still accepted, and now cheaper than it was: delete
exists, so an agent who sees the duplicate can remove it in two clicks. An
idempotency key on a free-text note would be machinery for a case that leaves a
visible duplicate a person can tidy up.

**A repeated edit or delete.** Neither duplicates anything. The edit is
idempotent by construction — it sets the text to a given value, so applying it
twice leaves the same row — and a second delete of the same note matches no row
and returns false rather than erring. The live test asserts that second delete
explicitly.

**Re-running the sync.** It cannot produce a note. `lib/sync/message-sync.ts`
never touches `internal_notes`, and
`tests/guards/internal-note-visibility.test.ts` fails the build if any file
outside the feature names that table.

**Re-running migration 0012.** Safe. `CREATE TABLE IF NOT EXISTS` and
`CREATE INDEX IF NOT EXISTS` throughout, in one transaction.

## Is this a duplicate of something that already exists?

No. Checked against each candidate:

| Candidate | Verdict |
| --- | --- |
| `order_management.note` type `team` (113 rows, `ledsone`) | **Genuinely internal notes, and genuinely not this.** Read-only, in the source database, attached to an order rather than a CST conversation, and written by the order system. This feature neither reads nor writes them. The overlap is conceptual only. |
| `cst_app.audit_log` | State transitions from a closed action vocabulary. Not free prose, and empty. |
| `cst_app.draft_revisions` | Describes a reply. Append-only history, but of a draft. |
| `cst_app.conversation_messages` | The customer thread. A row here *is* a message exchanged with a customer. |
| `lib/domain/customer-note.ts` | Buyer notes from the source, read-only. Same word, opposite direction: what a customer said, not what we said about their case. |
| `issue_tracking.issue_comments`, `discussion_comments`, `sku360.return_resolution_notes` | Other projects' tables in the same database. Not extended, not read. |

## Cascade behaviour

`fk_internal_notes_conversation ... ON DELETE CASCADE`. Deleting a conversation
removes its notes. Nothing in this application deletes a conversation today, so
this is a statement about ownership rather than a live path: a note has no
meaning without the case it is about.

`fk_internal_notes_author ... ON DELETE SET NULL`. Removing a person from
`app_users` must not remove the notes they wrote. Matches `audit_log` and
`draft_revisions`. Currently untestable in practice — the column is always
NULL.
