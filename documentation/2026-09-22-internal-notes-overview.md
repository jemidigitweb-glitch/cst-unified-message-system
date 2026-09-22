# Internal notes — how the feature works

**2026-09-22.** Full CRUD: add, read, edit, delete.

An internal note is a CST agent's own short record of where a case stands — the
main point, the issue, the progress, a courier or supervisor update, something
worth knowing next time. It is not a message, it is never part of a reply, and
no customer ever sees one.

## No category

The first version asked an agent to choose one of five categories before they
could write a sentence. The reader of that note did not need the answer, and the
question was asked every time, so it is gone: the panel asks for the note and
nothing else.

`note_category` still exists on the table and is still CHECK-constrained. The
writer fills it with `STORED_INTERNAL_NOTE_CATEGORY` (`general`), a request
cannot set it, and nothing renders it. Dropping a working column for a UI change
would have been a destructive migration for no gain, and anything already
stored under one of the other four values still reads back.

## Endpoints

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/conversations/[conversationId]/notes` | that conversation's notes, newest first |
| `POST` | `/api/conversations/[conversationId]/notes` | add one |
| `PATCH` | `/api/conversations/[conversationId]/notes/[noteId]` | replace its text |
| `DELETE` | `/api/conversations/[conversationId]/notes/[noteId]` | remove it |

**Every operation is conversation-scoped, in the SQL rather than in a check a
route performs.** `updateInternalNote` and `deleteInternalNote` both match on
`id = $1 AND conversation_id = $2`, so a note id borrowed from another case
matches no row and the answer is 404 — the same answer as for a note that does
not exist, so the difference cannot be used to discover that an id is real
somewhere else. A note id alone is never a capability.

The alternative shape, `/api/internal-notes/[noteId]`, was not built: it would
have made the conversation an argument a route could forget rather than a
segment it cannot be called without.

## The path a note takes

```
components/internal-notes-panel.tsx      agent types, Add note
        ↓ POST /api/conversations/:id/notes
app/api/conversations/[conversationId]/notes/route.ts
        ↓ parseInternalNoteRequest        non-blank text, nothing else accepted
lib/sync/internal-note-writer.ts          addInternalNote, app pool
        ↓
varmen_db  cst_app.internal_notes
```

Reading is the same path in reverse through
`lib/repositories/internal-note-repository.ts` (`findInternalNotes`), newest
note first. Editing and deleting go to the `[noteId]` route and the
conversation-scoped writer functions.

## What an edit cannot change

The `UPDATE` sets `note_text` and `updated_at`. It does not set
`conversation_id` (a note cannot be moved to another case), `visibility` (the
whole guarantee), `note_category` (never asked about), or `created_at` (when a
note was written is not when it was corrected). None of those is accepted from a
request body either.

## Why it is a separate endpoint

`GET /api/conversations/[conversationId]` returns the customer thread, and that
same `ConversationDetail` object is what feeds the AI draft input and the
conversation export. A note folded into it would reach a drafted reply and a
downloadable file in one move, without anybody choosing that. Internal notes
therefore have their own route, their own payload and their own panel, and
`tests/guards/internal-note-visibility.test.ts` fails the build if the two ever
meet.

## Pinned, and what that does and does not mean

**Creating an internal note pins it. There is nothing else to do.** No pin
flag, no pin column, no pin table, no pin endpoint, no Pin button — the note's
existence is the pin. The newest note for a conversation renders as a labelled
amber card between the conversation header and the first message; the details
column keeps the full list.

**It stays put while the thread scrolls.** The pinned card is a `shrink-0`
sibling of the message scroller in `conversation-view.tsx`, not a child of it.
The scroller keeps `flex-1 min-h-0 overflow-y-auto` and owns all the
scrolling; the pinned row sits above it in the same flex column and cannot
move.

This was wrong in the first attempt: the card was rendered inside the
scroller, so it read correctly on open and then scrolled away the moment an
agent moved down the thread — exactly when a note saying "courier follow-up
already requested" earns its place. `position: sticky` was considered and
rejected: a sticky card is still a child of the scroller, still part of the
message list, and still competing for its height. The card is bounded at
`max-h-44` with its own overflow, so a very long note scrolls inside its own
box rather than taking the conversation's height.

**Which note is pinned is a domain rule**, not an index in the component:
`pinnedInternalNote()` returns the newest of the list every time it is asked.
Everything else follows without any stored state — adding promotes the new
note, editing changes its text in place, deleting the pinned one promotes the
next newest, and deleting the last removes the row entirely.

**Only internal notes are pinnable.** A customer message, a CST reply, a
customer note or an arbitrary message id cannot appear there: the pinned area
takes `InternalNote` values from the notes endpoint, and nothing in the
application converts a conversation message into one.
`tests/guards/internal-note-visibility.test.ts` fails the build if the pinned
component so much as mentions a message type, if a pin action appears anywhere
in the feature, if a route path contains "pin", or if a migration creates pin
storage.

**One note, one row, two renderings.** The pinned card and the sidebar card
are the same object from the same list — `useInternalNotes` in
`components/use-internal-notes.ts`, held by the workspace because the two
columns are siblings. Adding a note issues one `POST`; editing updates both
cards; deleting removes both. Nothing is duplicated to support the display.

The newest note is shown in full and older ones stay in the details column,
with a one-line count beneath the pinned card. A case with a long note history
would otherwise open on its history rather than on the conversation.

## Where it appears

`components/context-panel.tsx` — **the first section of the details column**,
above the case summary and everything below it.

It is a section, not a control. It was a pill an agent had to click, which
meant the notes on a case were invisible until somebody asked for them — the
opposite of what an operational summary is for. There is now a heading reading
*Internal Notes*, a rule beneath it, and the notes themselves. Nothing to open.

**The section carries a subtle amber tint, and so does each note card.** Every
other section in that column states something read *from* the customer or
their purchase; these are the only rows on the screen CST wrote, and the tint
is what says so before a word is read. It is the same amber the customer-note
card in the centre column uses — the application already has one "this is a
note, not a message" colour, and a second near-identical yellow would be a
distinction without a difference. The two are never adjacent: one is a
labelled card above the thread, the other a headed section in the sidebar.

Each note is a bordered card: the text first, then bottom-right and aligned
away from it, the timestamp — plus `(edited)` once `updated_at` differs from
`created_at` — with `Edit` / `Delete` beneath. The text leads and the metadata
trails, so the column reads as a stack of what was recorded rather than a
stack of timestamps. Never a conversation bubble, which is the one rendering
that would make a note look like something said to a customer.

**There is no empty state.** A section headed Internal Notes with nothing under
it but the add box has already reported the absence; a sentence there was one
more line to read on a column that is mostly scanned.

The notes load with the conversation rather than on a click, which costs one
request per conversation opened — what an always-visible section costs. That
single read serves both renderings.

### The files

| File | Role |
| --- | --- |
| `components/use-internal-notes.ts` | the one list and the four operations; the only place that fetches |
| `components/internal-note-card.tsx` | one note, wherever shown — text, bottom-right stamp, Edit/Delete |
| `components/pinned-internal-note.tsx` | the pinned area under the conversation header |
| `components/internal-notes-panel.tsx` | the Internal Notes section in the details column |

The card is shared rather than written twice: two implementations would be two
chances for the edit control, the delete confirmation or the timestamp to
drift apart, and a reader would have no way to tell which was current.

**Edit is in place**: the text becomes a textarea where it sat, with `Update` /
`Cancel`. **Delete asks first, inline**: the row becomes "Delete this note?
Yes, delete / Keep". A note is the only record of what somebody observed and
there is no undo, so a stray click must not be enough — and the confirmation is
a second click rather than a browser dialog, because this application has no
modal anywhere and `confirm()` would be a new convention as well as an
untestable one.

Nothing on the panel explains what an internal note is. An earlier version
carried a sentence saying the notes were internal and never shown to a
customer, and a sentence for the empty state; both told an agent, under a
heading reading Internal Notes, what Internal Notes are. The guarantee is
enforced by the schema and the guards, not by a caption.

## Validation

`parseInternalNoteRequest` (a new note) and `parseInternalNoteUpdate` (an edit)
each run in two places: in the panel so an agent is told what is wrong before a
request is made, and again in the route because the first call is a convenience
and the second is the rule. They share `parseNoteText`, so a new note and an
edit cannot diverge on what counts as blank or over-long. The database checks
it a third time — `ck_internal_notes_text_present`.

They are two functions rather than one because they accept different things and
always will: a new note may name the order it is about, an edit may not
re-point an existing one. One permissive schema covering both is how an edit
quietly acquires the ability to change something it was never meant to.

`visibility` is not accepted from any request and never will be. Letting a
caller name it would make the one guarantee this feature offers a
client-supplied value.

## Known limitation: no author

Notes are stored with `author_user_id` NULL. This application has no interactive
sign-in, so there is no agent identity to record — the same reason
`draft_revisions.created_by_user_id` and `context_snapshots.confirmed_by_user_id`
are null today. The column exists and references `cst_app.app_users`, so nothing
needs backfilling with a guess when sign-in arrives. A fabricated author would
be worse than an absent one: it would make an unattributed note look attributed.
