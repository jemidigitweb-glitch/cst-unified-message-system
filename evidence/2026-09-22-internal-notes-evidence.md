# Internal notes — evidence

**2026-09-22.** Captured after the CRUD and UI revision. No customer data
appears here; the notes used in the live run were written for the test.

## Test run

```
$ npx vitest run

 Test Files  2 failed | 132 passed | 13 skipped (147)
      Tests  2 failed | 3669 passed | 53 skipped (3724)
```

The two failures are pre-existing and unrelated — both read the gitignored
`Knowledge-source/` workbook directory, absent from this checkout:

```
FAIL tests/knowledge/cst-category-corpus.test.ts
  Error: ENOENT: no such file or directory, scandir '...\Knowledge-source'
FAIL tests/knowledge/cst-category-evidence.test.ts
  Delivery_Master_Rules final.xlsx: expected false to be true
```

Focused suites, all green:

```
tests/domain/internal-note.test.ts              36 passed  (10 added for the pinning rule)
tests/sync/internal-note-writer.test.ts         25 passed
tests/guards/internal-note-visibility.test.ts   28 passed   (11 added for pinning + layout)
tests/guards/api-surface.test.ts                17 passed
```

Three guards failed mid-change and were fixed rather than relaxed:
`api-surface` (the pinned component named `cst_app` in a comment — components
may not), and `marketplace-ui` / `notification-bell` (both count `<aside` in
`workspace.tsx`; new comments had used the literal tag names). All three were
my prose, not the guards.

## Typecheck, lint, build

```
$ npx tsc --noEmit
(no output)

$ npx eslint
✖ 4 problems (2 errors, 2 warnings)
  components/conversation-view.tsx:203   react-hooks/set-state-in-effect   (pre-existing)
  components/workspace.tsx:279           react-hooks/set-state-in-effect   (pre-existing)
  lib/knowledge/rule-coverage.ts:2       no-unused-vars                    (pre-existing)
  tests/guards/order-selection-tracking.test.ts:7  no-unused-vars          (pre-existing)

$ npx next build
✓ Compiled successfully in 2.8s
├ ƒ /api/conversations/[conversationId]/notes
├ ƒ /api/conversations/[conversationId]/notes/[noteId]
```

## Live CRUD against varmen_db

```
$ RUN_LIVE_NOTES=1 npx vitest run tests/repositories/internal-note-live.test.ts

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Covering create → read → update → delete on a real conversation; the
cross-conversation refusals against a real *second* conversation; `visibility`
read back as `internal`; a whitespace-only insert refused by
`ck_internal_notes_text_present`; and a note for a non-existent conversation
refused with `23503`.

## Schema — unchanged this round

No migration was written. `cst_app.internal_notes` still carries the nine
columns, three CHECK constraints, two foreign keys and one index that `0012`
created. `note_category` was deliberately kept rather than dropped: removing a
working column to serve a UI change would be destructive for no gain.

```
varmen_db cst_app.internal_notes rows: 1
columns (unchanged, no migration this round): 9
pin-related tables in cst_app: 0
```

**The one row is real, not test data.** Note id 23 on conversation 37088,
about E27/B22 fitting compatibility, `created_at 11:01:57`,
`updated_at 11:02:30` — written and then edited through the interface while
this work was being checked. Every synthetic row the live suite created was
removed in `afterAll`; this one was left alone. Its `updated_at` differing
from `created_at` is also live confirmation that the edit path and the
`(edited)` marker behave as intended.

## The source database was not modified — and here is the proof

```
grants held by our source role:
   SELECT: 172 tables            ← and no other privilege, anywhere
rows in ledsone containing our test text: 0
tables named internal_notes in ledsone: 0
session read_only: on
attempted write to ledsone was REFUSED:
   cannot execute INSERT in a read-only transaction
```

The last line is a deliberate probe: an `INSERT` was attempted against
`order_management.note` to confirm the refusal is real rather than assumed. It
was refused at the transaction level and the role lacks the grant in any case,
so nothing was written.

### About the buyer-note count

`order_management.note` read `buyer=8148, team=113` at the start of the day and
`buyer=8149, team=113` afterwards. **The extra row is not ours.**

```
id     note_type  created_by  created_at            synced_at
27133  buyer      null        2026-09-22T09:01:29Z  2026-09-22T09:20:38Z
```

`synced_at` is the source system's own pipeline column; three rows were written
there by that pipeline today. `ledsone` is a live production database shared
with unrelated systems, so its counts move on their own — which is why the
proof above rests on privileges and a refused write rather than on a count
holding still.

## Not captured here

Screenshots of the pinned card or the panel. This project runs no DOM in
tests (`environment: "node"`), so the rendering checks in
`validation/2026-09-22-internal-notes-validation.md` are listed as manual and
have not been performed in this session.

The source-database probe described above was run in the previous round. This
round issued no write of any kind against `ledsone`; the grants and the
read-only session were re-confirmed by reading only.
