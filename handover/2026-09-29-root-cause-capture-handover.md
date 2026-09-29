# Root cause capture — handover

**2026-09-29.** Branch `sync-reconcile-late-arrivals`.

## Do this first

**Apply `migrations/0020_conversation_root_cause.up.sql` to the application
database.** It is written, reviewed and statically tested, and has **not been
run**. Until it is, the CST half of the panel reads as "nothing recorded" and
pressing Record answers 503.

Do not apply it blind. `validation/2026-09-29-root-cause-capture-validation.md`
holds the acceptance test: a transaction that applies the migration, proves each
CHECK rejects what it should, proves the foreign key rejects an unknown
conversation, runs the rollback, and is then **rolled back** so nothing
persists. Run that first, then apply for real.

Before running the rollback on a live database later: the table is append-only
and holds decisions agents made by hand, and CST cannot write back to the
message application, so **there is no upstream copy to re-import from**. Take a
dump first. The down migration says so too.

## What was built

See `closure/2026-09-29-root-cause-capture-scope-status.md` for the file list
and the decisions. In short: a chip-grid selector in the context panel that
records a root cause, plus — for delivery, fulfilment and carrier causes — a
courier, an issue type and a note. Append-only, in `cst_app` only, using the
message application's own eighteen labels.

## What is next, and it is the half the business actually asked for

**Reporting.** By date range, courier, store and issue type, with counts **and
percentages**, exportable to Excel/CSV. Not started. The two report indexes
exist for it, and `query-packs/2026-09-29-root-cause-query-pack.md` has the
queries written out.

Two things the report author must get right, both explained in that pack:

- **Append-only means the naive `count(*)` double counts.** A conversation whose
  root cause was corrected twice contributes three rows. Decide deliberately
  between counting current values per conversation and counting rows, and **say
  which on the report**.
- **"By store" is not in this table.** It is a fact about the conversation, not
  about the decision. Join `cst_app.conversations` rather than denormalising a
  marketplace column that can drift.

## Open questions for the user

1. **Should the issue type be required?** It is optional today, matching the
   schema's one-way CHECK, on the reasoning that what a courier did wrong is
   often still being established when the case is recorded. If the report needs
   it on every courier row, say so and it becomes one line in
   `readRootCauseSelection` plus a test.
2. **Is `FULFILMENT_WAREHOUSE` right to open the courier levels?** It is there
   because an agent cannot always tell a mis-pick from a mis-scan at the point
   of recording, and the courier is a fact they have either way. If a warehouse
   fault should never carry a courier, remove it from `COURIER_DETAIL_LABELS`.
3. **Should the history be on screen?** `getRootCauseHistory` exists and is
   tested; nothing renders it. A "changed from X" line under the current value
   is cheap to add.

## Things not to undo

- **Do not add a unique constraint on `conversation_id`.** Append-only depends
  on many rows per conversation; a unique index would make correcting a mistake
  impossible. It is the single most likely well-meant edit to the migration, and
  a test guards against it.
- **Do not add UPDATE or DELETE** to `conversation-root-cause-repository.ts`, or
  PATCH/DELETE to the route. An UPDATE would quietly turn this table into the
  overwriting one the message application uses, which is the one behaviour of
  theirs this deliberately does not copy.
- **Do not merge the two values into one field.** The message application's and
  CST's are recorded by different people in different systems and either can be
  out of date. A merged field has to pick a winner and neither has the standing.
- **Do not put a control in `MessageAppRootCauseSection`.** CST cannot write
  there. A guard slices that component out of the panel and asserts it has no
  button, input or save.
- **Do not add a CHECK to `root_cause`.** The vocabulary lives outside this
  schema and changes without telling us; a CHECK would turn a new label into a
  failed save rather than a row an operator can see.
- **Do not connect root cause to the CST message category.** Different systems,
  no shared vocabulary, storage or code path. The category baseline is frozen.

## Known unrelated failure

`tests/knowledge/cst-rules-files.test.ts` fails three tests — a missing "Message
Handling" area in the spreadsheet corpus, and a cache-timing assertion. It
predates this work and reproduces without it. Everything else passes: 4,784.
