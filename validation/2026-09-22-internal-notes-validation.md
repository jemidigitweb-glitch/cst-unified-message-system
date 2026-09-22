# Internal notes — validation

**2026-09-22.** How the feature was confirmed to work. Covers full CRUD and the
redesigned panel; supersedes the create-and-view-only record of earlier the
same day.

## Automated

| Suite | Covers |
| --- | --- |
| `tests/domain/internal-note.test.ts` | text rules for a new note and for an edit (blank, whitespace-only, non-text, the length ceiling, trimming, line breaks preserved); everything a caller sends beyond the text is ignored; an edit carries text and nothing else; note-id parsing; the stored category; the empty-state wording |
| `tests/repositories/internal-note-repository.test.ts` | the read is scoped by `conversation_id`; parameters bound, never interpolated; newest first; `hasMore` without a second query; limit clamping; no write statement of any kind |
| `tests/sync/internal-note-writer.test.ts` | create, update and delete: the application table and no source schema; parameterised values; the writer supplies the category; neither `visibility` nor `author_user_id` is written; **both ids bound on edit and delete**; an edit sets only text + `updated_at`; a real delete, not a flag; failures raised, not swallowed |
| `tests/migrations/internal-notes-schema.test.ts` | static review of `0012` — unchanged this round, since no schema change was needed |
| `tests/guards/internal-note-visibility.test.ts` | **the security guard** — see below |
| `tests/guards/api-surface.test.ts` | the two notes routes are the mutable exemptions; the DELETE exemption; both pinned to what they may do |
| `tests/repositories/internal-note-live.test.ts` | opt-in, against the real `varmen_db` — see below |

### What the visibility guard checks

Structural, not semantic. A module that cannot be imported cannot leak.

- the three internal-note modules are not imported by `lib/ai/`, `lib/export/`
  or `lib/domain/automation/`
- `internal_notes` is not named anywhere outside the feature's own files
- `conversationDetailSchema` has exactly the keys `conversation` and `messages`
- the export, `lib/ai/provider.ts` and `lib/ai/draft-assembly.ts` mention no
  internal note
- the customer-note files do not reference the internal-note feature
- the feature names `getAppPool` and never `getSourcePool`/`getKnowledgePool`
- the only statements in the feature are one `INSERT INTO`, one `UPDATE` and
  one `DELETE FROM`, all against `cst_app.internal_notes`
- **both the edit and the delete bind `id = $1 AND conversation_id = $2`** —
  asserted as exactly two occurrences, so neither can lose its scoping
- an edit's `SET` clause contains no `conversation_id`, `visibility`,
  `note_category` or `created_at`
- neither route names a visibility in code (comments stripped first, the way
  `draft-workflow.test.ts` strips them, so the prose denial is not read as the
  capability)
- the panel has no `<select>`, no category label, no staff-only caption, and
  reaches no URL outside `/api/conversations/${conversationId}/notes`
- the panel is a section, not a toggle: no `aria-expanded`, no toggle test id,
  a real `<h2>` carrying `INTERNAL_NOTES_TITLE`
- no empty-state sentence: neither `INTERNAL_NOTES_EMPTY` (the constant is
  gone from the domain too) nor the strings it held
- the amber tint is on both the section and the note card, so the boundary is
  visible before a note is read rather than only around each row

### What the pinned-layout guards check

The fix is structural, so the checks are structural:

- `<PinnedInternalNotes` is mounted **before** `ref={scroller}` in
  `conversation-view.tsx` — inside the scroller, its index would come after
- the scroller still carries `flex-1` and `overflow-y-auto`, so it remains
  the only element that scrolls
- the pinned section carries `shrink-0`, so the thread cannot squeeze it
- neither the pinned component nor the markup between the mount and the
  scroller uses `sticky` — a sticky card would still be inside the message
  list
- the early return comes before the frame, so a conversation with no notes
  renders no bordered strip at all
- the component asks `pinnedInternalNote()` rather than indexing `notes[0]`

### What the pinning guards check

"Pinned" is a rendering of the note, not a feature of its own, and these are
what stop it becoming a generic message-pinning system:

- the pinned component mentions no `ConversationMessageView`,
  `ConversationDetail`, `CustomerNote`, `SourceMessage`, `messages`,
  `bodyText` or `direction` — a conversation message cannot reach it
- no `pinNote` / `togglePin` / `unpin` / `isPinned` / `pinned_at` anywhere in
  the feature, and no Pin control in the panel
- no route path under `app/api` contains "pin", and neither
  `app/api/pinned-messages` nor `app/api/messages` exists
- no migration creates `pinned_messages`, `message_pins`, or a `pinned` /
  `is_pinned` column
- exactly one `POST` in the hook, and the pinned component issues no request
  of its own — so a note shown twice is still stored once
- the presentational components (`internal-notes-panel`,
  `internal-note-card`, `pinned-internal-note`) contain no `fetch(` at all;
  every request comes from the one hook

### The DELETE exemption

`tests/guards/api-surface.test.ts` forbade DELETE on every route. It now
permits it on exactly one — `notes/[noteId]` — by an exact path, and a new test
asserts that route is the *only* file in `app/api` exporting a DELETE. The
reasoning is recorded in the guard's own header: an internal note is the first
thing in this application a person writes in their own words, so the first that
a person can get wrong, and leaving removal to hand-written SQL makes
correcting a mistake harder than making it.

## Results, 2026-09-22

```
npx vitest run
  Test Files  2 failed | 132 passed | 13 skipped (147)
  Tests       2 failed | 3669 passed | 53 skipped (3724)
```

**Both failures are pre-existing and unrelated.**
`tests/knowledge/cst-category-corpus.test.ts` and
`tests/knowledge/cst-category-evidence.test.ts` read the gitignored
`Knowledge-source/` workbook directory, which is absent from this checkout
(`ENOENT ... scandir 'Knowledge-source'`). Neither touches internal notes.

```
npx tsc --noEmit      clean
npx eslint            2 errors, 2 warnings — all pre-existing
                      (conversation-view.tsx:203, workspace.tsx:279,
                       rule-coverage.ts:2, order-selection-tracking.test.ts:7)
                      nothing in the internal-notes files
npx next build        succeeded; both routes registered:
                        /api/conversations/[conversationId]/notes
                        /api/conversations/[conversationId]/notes/[noteId]
```

## Database

**No migration this round.** `0012` was applied earlier the same day and is
unchanged — nine columns, three CHECKs, two foreign keys, one index, verified
still in place. Removing `note_category` would have been a destructive
migration to serve a UI change, so the column stays and the writer fills it.

## Live CRUD

```
RUN_LIVE_NOTES=1 npx vitest run tests/repositories/internal-note-live.test.ts
  Test Files  1 passed (1)
  Tests       5 passed (5)
```

Through the real writer and repository, against `varmen_db`:

- **create** → stored, `author_user_id` NULL, category `general` without anyone
  being asked
- **read** → at the head of its conversation's feed
- **update** → text replaced, `created_at` unchanged, `updated_at` moved, the
  change visible on a re-read
- **delete** → gone from the feed, and a second delete finds nothing
- **cross-conversation** → against a *real* second conversation, an edit
  returns undefined and a delete returns false; the note is untouched on its
  own conversation and absent from the other's feed
- `visibility` read back as `internal`
- a whitespace-only insert refused by `ck_internal_notes_text_present`
- a note for a non-existent conversation refused with `23503`

Every row created was removed in `afterAll`; `cst_app.internal_notes` confirmed
back to 0 rows.

## `ledsone` — not modified, and proven so

- our source role holds **`SELECT` on 172 tables and no other privilege**
- a deliberate `INSERT` attempt was **refused**: `cannot execute INSERT in a
  read-only transaction`
- rows in `ledsone` containing this feature's test text: **0**
- tables named `internal_notes` in `ledsone`: **0**
- session `transaction_read_only`: **on**

`order_management.note` read `buyer=8148, team=113` at the start of the day and
`buyer=8149, team=113` afterwards. **That +1 is not ours.** It is note id
27133, `created_at 09:01:29Z`, `synced_at 09:20:38Z`, `created_by` null — one
of three rows the source system's own upstream pipeline wrote there today.
`ledsone` is a live production database shared with unrelated systems; its
counts move on their own, which is exactly why the proof above is about
privileges and a refused write rather than about a row count holding still.

## Manual checks still outstanding

Automated tests run in `environment: "node"` — this project has no DOM test
environment, so the panel's rendering is not exercised by the suite. Worth
confirming by hand on a running instance:

**The pinned area — the scroll behaviour is the point**

1. Open a conversation with an internal note.
2. **Scroll the messages down** → the pinned note stays visible.
3. **Scroll back up** → it is still there, unmoved.
4. Only the message list scrolls; the pinned row and the header do not.
5. A very long note scrolls inside its own box and does not take over the
   column.

**The pinned area — the rest**

1. Open a conversation → the header is unchanged.
2. Add an internal note → it appears immediately as an amber card between the
   header and the first message, labelled **PINNED INTERNAL NOTE** with a pin
   glyph.
3. It is not a left or right bubble, carries no Customer/CST reply label, and
   sits outside the message list.
4. There is **no Pin button** anywhere.
5. Edit it from the pinned card → the details-column card shows the same new
   text; edit it from the details column → the pinned card updates. One note.
6. Delete it → it disappears from both places at once.
7. Refresh → the note is still pinned.
8. With two or more notes, the newest is pinned and a line beneath reads
   "N earlier internal notes in the details panel".
9. With no notes, there is no pinned strip at all.
10. Customer and CST messages below are unchanged in appearance and order.

**The details column**

1. Open a conversation and the details column.
2. There is **no Internal Notes pill or button** anywhere.
3. The heading **Internal Notes** is visible, first in the column, with a rule
   beneath it.
4. The section is tinted amber and is visibly distinct from the plain sections
   below it — subtle, not a yellow panel.
5. With no notes there is **no "No notes yet."** and no other empty-state
   sentence: just the heading and the add box.
6. **Add a note** is available without opening anything. No category
   dropdown, no caption.
7. Type a note, **Add note** → it appears as an amber card at the top.
8. The card shows the text first, with the date/time at the **bottom right**,
   controls beneath it, and the stamp visibly fainter than the text.
9. **Edit** → the text becomes a textarea in place; **Update** saves and the
   card then shows `(edited)`; **Cancel** leaves it as it was.
10. **Delete** → "Delete this note?"; **Keep** cancels; **Yes, delete**
    removes the card.
11. Reopen the conversation → the surviving notes are still there.
12. Empty box → Add note is disabled; whitespace only → the validation
    sentence appears and no request is made.
13. Customer and CST messages in the centre thread are unchanged, and no note
    appears among them.
14. The details column is no wider than before, and no other section moved.
15. Generate a draft → the note text appears nowhere in the drafted reply.
16. Export the conversation → the note text appears nowhere in the file.
