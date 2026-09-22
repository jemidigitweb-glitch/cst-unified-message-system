# Internal notes — what the system can and cannot do

**2026-09-22.** Describes what exists now.

## Can

- A CST agent can record an internal note against any conversation, in any
  marketplace tab. Nothing about this feature is marketplace-specific: it hangs
  off `cst_app.conversations`, which is marketplace-neutral, so it works on an
  eBay thread and an Amazon one alike.
- An agent can read every internal note already recorded against the
  conversation they have open, newest first.
- An agent can **edit** a note's text, in place, and the card then says it was
  edited.
- An agent can **delete** a note, after confirming on the row.
- A note is just text. **Nobody is asked to categorise it** — the picker was
  removed, and the stored column is filled by the writer.
- **A new note is pinned automatically.** The newest note for a conversation
  shows between the conversation header and the first message, so an agent
  finds it before reading the thread. Creating the note is the only action;
  there is no pin step.
- A note can optionally carry a source order id, stored as a plain id.

## Cannot

- **Cannot be seen by a customer.** There is no customer-facing client in this
  application at all, and beyond that the note text is structurally unreachable
  from the three paths that do end up in front of someone outside CST: the AI
  draft input, the conversation export, and the post-dispatch automation body.
- **Cannot be reached from another conversation.** Edit and delete match on the
  note id *and* the conversation id in the SQL, so knowing a note id is not
  enough to touch it through a case it does not belong to — the answer is 404,
  the same as for a note that does not exist.
- **Cannot be moved between conversations, or made customer-visible, by an
  edit.** Neither is accepted from a request, and neither appears in the
  `UPDATE`'s `SET` clause.
- **Cannot be recovered once deleted.** A real delete, no soft-delete flag,
  no undo — which is why the interface asks before doing it.
- **Cannot record who wrote it.** See the limitation below.
- Cannot be searched, filtered, or listed across conversations. The only
  question the feature answers is "what has CST recorded about this case".
- Cannot be attached to an order on its own — a note always belongs to a
  conversation. An order-only note has nowhere to live, because the panel that
  shows notes is a conversation panel.
- Cannot carry an attachment. Text only.
- Cannot show a note's edit history. An edit replaces the text; only the fact
  that it was edited survives, via `updated_at`.
- **Cannot pin anything that is not an internal note.** There is no generic
  pinning: a customer message, a CST reply, a customer note or an arbitrary
  message id cannot be pinned, because the pinned area renders internal notes
  and there is no pin record to attach to anything else.
- **Cannot unpin a note while keeping it.** The note's existence is the pin,
  so the only way to clear the pinned area is to delete the note. If "keep it
  in the history but stop showing it at the top" is ever wanted, that needs a
  stored flag and a deliberate decision — it does not exist today.
- Cannot pin more than one note at a time. The newest is shown; older ones
  stay in the details column with a count.

## The limitation that matters: no author

**A note does not record who wrote it, because this application still has no
interactive sign-in.**

`cst_app.app_users` exists with roles `agent` / `reviewer` / `admin` and holds
zero rows; nothing in the application reads it. `internal_notes.author_user_id`
is present, references that table, and is written NULL by every insert — the
same state `draft_revisions.created_by_user_id` and
`context_snapshots.confirmed_by_user_id` have been in since 0001 and 0004.

The practical consequence is worth stating plainly to whoever uses this: a note
reading "Supervisor instructed us to offer a replacement" does not say which
supervisor, and the system cannot tell you. If that attribution matters
operationally before sign-in exists, the agent has to put the name in the note
text — the feature will not do it for them, and it will not invent one.

Closing this needs authentication against `issue_tracking.management_users`
(12 users, roles `staff` / `management` / `admin`), which
`cst_app.app_users.management_user_id` was designed to point at. That is a
separate piece of work and deliberately not part of this phase.
