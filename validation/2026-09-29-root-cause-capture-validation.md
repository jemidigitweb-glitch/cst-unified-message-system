# Root cause capture — validation

**2026-09-29.**

## What is proven, and how

| Claim | Proven by | Kind |
| --- | --- | --- |
| The migration creates one table in `cst_app` and nothing anywhere else | `tests/migrations/conversation-root-cause-schema.test.ts` | static, reads SQL as text |
| The courier and issue-type CHECKs hold exactly the ten approved labels each | same, label by label and in order | static |
| The issue-type strings carry the approved casing and both slashes | same, plus `tests/domain/root-cause-vocabulary.test.ts` asserting the ten as literals | static |
| The chip lists and those CHECKs are the same lists | `tests/domain/root-cause-vocabulary.test.ts` — reads the migration and compares | static |
| A case or punctuation variant of an issue type is refused, not repaired | `root-cause-vocabulary.test.ts` and `root-cause-selection.test.ts` | unit |
| The screen renders the shared lists, never a fourth copy | `tests/guards/message-app-root-cause-panel.test.ts` | static |
| The issue note has no minimum and one shared technical ceiling | `root-cause-vocabulary.test.ts`, `root-cause-selection.test.ts` | unit + static |
| The 18 labels are the message application's own | `sql/2026-09-29-root-cause-vocabulary-measurement.sql`, run live | measured |
| OTHER stores the explanation, never the word | `tests/domain/root-cause-selection.test.ts` | unit |
| Courier is required for the three labels that open it; issue type is not | same | unit |
| A courier on a non-courier cause is refused, not dropped | same | unit |
| Nothing throws on a malformed body | same, hostile-input block | unit |
| The writer issues one INSERT and names one table | `tests/repositories/…` and `tests/guards/api-surface.test.ts` | static + unit |
| The route exports GET and POST and nothing that overwrites | `tests/guards/message-app-root-cause-panel.test.ts` | static |
| The message-app display still has no control of any kind | same, on the sliced component | static |
| The read lookup never acquires the writer | same | static |
| The panel keys the selector by conversation | same | static |

## What is NOT proven, and the acceptance test for it

**Migration `0020` has not been applied.** Everything above is static or against
a fake. Run the following against the application database inside a transaction
that is **rolled back**, exactly as `0014` was validated. Nothing below should
be committed.

```sql
BEGIN;

-- 1. It applies.
\i migrations/0020_conversation_root_cause.up.sql

-- 2. A well-formed row is accepted. Substitute a real conversation id.
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, courier, courier_issue_type, issue_note, vocabulary_version)
VALUES (<a real cst_app.conversations.id>, 'Delivery Issue', 'EVRI', 'Lost parcel', 'test', 1);

-- 3. Each CHECK rejects. Every one of these must ERROR.
--    a. a courier outside the ten
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, courier, vocabulary_version)
VALUES (<id>, 'Delivery Issue', 'Yodel', 1);
--    b. an issue type with no courier
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, courier_issue_type, vocabulary_version)
VALUES (<id>, 'Delivery Issue', 'Lost parcel', 1);
--    b2. an issue type with the WRONG CASING. The approved value is
--        'transit damage'; the CHECK admits nothing else, so this must ERROR.
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, courier, courier_issue_type, vocabulary_version)
VALUES (<id>, 'Delivery Issue', 'DPD', 'Transit damage', 1);
--    b3. an issue type with the slash written as a word. Also must ERROR.
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, courier, courier_issue_type, vocabulary_version)
VALUES (<id>, 'Delivery Issue', 'DPD', 'false or incorrect delivery scan', 1);
--    c. the literal OTHER, in any casing
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, vocabulary_version)
VALUES (<id>, 'other', 1);
--    d. a blank root cause
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, vocabulary_version)
VALUES (<id>, '   ', 1);
--    e. a blank note
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, issue_note, vocabulary_version)
VALUES (<id>, 'RETURN', '  ', 1);

-- 4. The foreign key rejects an unknown conversation. Must ERROR.
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, vocabulary_version)
VALUES (999999999, 'RETURN', 1);

-- 5. Append-only really is: a second row for the same conversation is accepted
--    and the newest is current.
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, vocabulary_version)
VALUES (<id>, 'RETURN', 1);
SELECT root_cause FROM cst_app.conversation_root_causes
 WHERE conversation_id = <id>
 ORDER BY recorded_at DESC, id DESC LIMIT 1;   -- expect 'RETURN'

-- 6. The rollback removes only this table, and refuses if something depends.
\i migrations/0020_conversation_root_cause.down.sql

ROLLBACK;
```

Each rejecting statement aborts the transaction in psql, so run them one at a
time with savepoints, or as separate rolled-back transactions.

## Then, end to end

With `0020` applied for real:

1. Open any conversation. The CST section shows "Record".
2. Choose `OUT OF STOCK`, press Record. It appears beneath the heading.
3. Press Change, choose `Delivery Issue`. The courier chips appear; the button
   is disabled and reads "Choose the courier."
4. Choose `EVRI`. The issue-type chips appear. The button enables **without** an
   issue type — that is correct.
5. Record. Confirm the panel now shows `Delivery Issue` with `EVRI`.
6. `SELECT count(*) FROM cst_app.conversation_root_causes WHERE conversation_id = …`
   — expect **2**, not 1. The first selection is still there.
7. Choose `OTHER`. Type 29 characters: refused, with a count. Type a 30th: the
   button enables. Record, and confirm the **prose** is stored, not "OTHER".
8. Switch to another conversation mid-selection and back. The form must be
   empty, not carrying the other case's half-filled answer.

## Degradation, verified by reading rather than running

With `0020` absent the application must not break. The route catches Postgres
`42P01` on the read and returns the message-app half with `cst: null`, logging a
warning; a POST answers **503** with "Recording a root cause is not available".
Confirm both once, before applying, by opening a conversation on a deployment
that has not run the migration.
