# Internal notes — scope status

**2026-09-22.** Full CRUD and the revised panel are finished. Supersedes the
create-and-view-only record of earlier the same day.

## Built

| Layer | File |
| --- | --- |
| Migration | `migrations/0012_internal_notes.up.sql` / `.down.sql` — **unchanged this round** |
| Domain | `lib/domain/internal-note.ts` |
| Read | `lib/repositories/internal-note-repository.ts` |
| Write | `lib/sync/internal-note-writer.ts` — add, update, delete |
| API | `app/api/conversations/[conversationId]/notes/route.ts` (GET, POST) |
| API | `app/api/conversations/[conversationId]/notes/[noteId]/route.ts` (PATCH, DELETE) |
| UI state | `components/use-internal-notes.ts` — one list, four operations, the only fetcher |
| UI | `components/internal-note-card.tsx` — one note, shared by both renderings |
| UI | `components/pinned-internal-note.tsx` — pinned under the conversation header |
| UI | `components/internal-notes-panel.tsx` — the section in `components/context-panel.tsx` |
| Wiring | `components/workspace.tsx` holds the state; `components/conversation-view.tsx` renders the pinned card |

## Decisions worth recording

**The pin is derived, not stored.** A pinned internal note is the newest row
of the list that already exists — no pin flag, no pin table, no pin endpoint,
no Pin button, and therefore no state that can disagree with the note. The
alternative, a generic message-pinning feature, was explicitly not built: it
would let a customer message or a CST reply into a surface designed for
private staff notes, which is a different feature with a much larger blast
radius. Five guards keep that shut.

**State lives in the workspace, not in either panel.** The same notes render
in two sibling columns. Two copies would be two lists that disagree on the
first edit, so `useInternalNotes` is held once and passed to both — the same
arrangement `selectedOrderNumber` already has, for the same reason. React
Context was not introduced: nothing in this codebase uses it, and one shared
hook did the job.

**One card component, two mount points.** Writing the card twice would be two
chances for the edit control, the delete confirmation or the timestamp to
drift apart, with no way for a reader to tell which was current.

**Only the newest note is pinned.** Pinning all of them would open a case on
its note history rather than on the conversation; older notes stay one column
away behind a one-line count.

**No migration was written, and that was the decision.** The obvious reading of
"category is not part of the experience" is to drop `note_category`. It is a
`NOT NULL` column under a CHECK, holding data the read path still understands;
dropping it would be a destructive migration serving a UI change. The column
stays, the writer fills it with `STORED_INTERNAL_NOTE_CATEGORY`, a request
cannot set it, and nothing renders it. Anything stored under one of the other
four values still reads back.

**The DELETE guard was widened, deliberately and narrowly.**
`tests/guards/api-surface.test.ts` forbade DELETE on every route in the
application. It now permits exactly one — `notes/[noteId]`, by exact path — and
a new test asserts that is the only file in `app/api` exporting one. The reason
is in the guard's header: an internal note is the first thing here a person
writes in their own words, so the first a person can get wrong, and leaving
removal to hand-written SQL makes correcting a mistake harder than making it.

**Conversation scoping lives in the SQL, not in the route.** Both the edit and
the delete bind `id = $1 AND conversation_id = $2`. There is no ownership check
a handler could forget to call, because there is nothing to call. A note id
borrowed from another case matches no row, and the answer is 404 — the same
answer as for a note that does not exist, so the difference cannot be used to
discover that an id is real somewhere else. The guard asserts both statements
carry the clause.

**`/api/conversations/[id]/notes/[noteId]`, not `/api/internal-notes/[id]`.**
The flat shape would have made the conversation an argument a route could
forget rather than a segment it cannot be called without.

**Two parsers, not one.** `parseInternalNoteRequest` and
`parseInternalNoteUpdate` share the text rules but accept different things: a
new note may name the order it is about, an edit may not re-point an existing
one. One permissive schema covering both is how an edit quietly acquires the
ability to change something it was never meant to.

**Inline confirmation, not `confirm()`.** Delete is irreversible and a note is
the only record of what somebody observed, so a stray click must not be enough.
The confirmation is a second click on the same row: this application has no
modal anywhere, and a native dialog would be a new convention as well as an
untestable one.

**The panel stopped explaining itself.** The staff-only caption and the
full-sentence empty state both told an agent, inside a panel they had just
opened called Internal Notes, what Internal Notes are. The guarantee is
enforced by the schema and the guards; the empty state is now three words.

## Explicitly out of scope, and why

- **Authentication and agent identity.** Unchanged from before: notes are
  stored unattributed rather than attributed to an invented user.
- **Edit history.** An edit replaces the text; `updated_at` records that it
  happened. Keeping revisions (the `draft_revisions` pattern) was not asked for
  and would double the feature's storage model.
- **Any change to the customer-notes feature.** It reads buyer notes from the
  read-only source and writes nothing.
- **Notes in the AI draft, the export, or the automation body.** Still a
  guarded prohibition, not an omission.
- **Search, cross-conversation listing, attachments.** None asked for.

## Verified before calling this closed

Full suite (2 pre-existing failures, both from the absent gitignored
`Knowledge-source/` directory), typecheck clean, lint clean for every touched
file, build succeeds with both routes registered, live CRUD passing against
`varmen_db` including the cross-conversation refusals, and `ledsone` proven
unwritable by this project. Details in
`validation/2026-09-22-internal-notes-validation.md`.

## Not committed

The working tree carries these changes uncommitted, at the requester's
instruction. Git is being handled manually.
