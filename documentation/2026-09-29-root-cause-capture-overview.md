# Root cause capture — overview

**2026-09-29.**

## The problem

The business wants to know which courier causes the most problems, and how
often — by date range, by courier, by store, by issue type, with counts and
percentages, exportable.

The message application already asks its agents for a root cause, and has
40,000-odd rows of answers. It cannot answer the courier question, because it
records only a single flat label: `FULFILMENT_CARRIER` says a carrier was
involved and nothing about which one, what they did, or what happened.

CST cannot fix that at source. It holds **no write privilege** on that
application's database — `SHOW GRANTS FOR CURRENT_USER()` on the configured
credential returns `USAGE ON *.*` plus SELECT on 25 named tables in
`order_management`, and `message_app` is not granted at all. That is measured,
not assumed.

## The shape of the answer

CST records its own root cause, in its own database, using the message
application's own vocabulary, plus three further levels the courier question
needs.

```
  Level 1   Root cause          18 labels, the message app's own
  Level 2   Courier             10 options   ┐ only for Delivery Issue,
  Level 3   Courier issue type  10 options   │ FULFILMENT_CARRIER and
  Level 4   Issue note          free text    ┘ FULFILMENT_WAREHOUSE
```

Both values show in the context panel, one above the other, each labelled with
whose it is. Neither overwrites the other and neither can.

## Why the vocabulary is the message application's

A parallel CST vocabulary was the obvious wrong turn. It would have made every
CST row unmatchable against the rows already recorded, and turned a comparison
between couriers into a comparison between two systems' opinions about what a
category means.

So the eighteen labels were measured out of the source — a read-only `GROUP BY
root_cause` across all five marketplace tables. Every label offered is one their
agents have really chosen. The query and the result are kept at
`sql/2026-09-29-root-cause-vocabulary-measurement.sql`.

The three labels that open the courier levels are existing labels for the same
reason. No new level-1 label was invented.

## Why it is append-only

Changing a root cause inserts a row; the newest is current. There is no UPDATE,
no DELETE, no soft-delete column, no PATCH route.

This deliberately does **not** copy the message application, which overwrites
the column and discards the prior confirmation — so nothing there records what a
root cause was before, who changed it, or how often. That is reasonable for a
screen that owns the write and is about to be overwritten by the next save. It
is not reasonable here: the whole point of asking which courier causes the most
problems is that somebody will later ask how a number was arrived at, and a
history that was overwritten cannot answer.

The cost is that the rollback destroys hand-recorded work with no upstream copy
to re-import from. `0020_conversation_root_cause.down.sql` says so, where
somebody about to run it will read it.

## Where the rules live

One statement of each rule, read by both ends.

- `lib/domain/root-cause-vocabulary.ts` — the three lists, the version stamp,
  which labels open which levels, what a chip says as opposed to what it stores.
- `lib/domain/root-cause-selection.ts` — whether what is on screen amounts to a
  record, or a sentence explaining why not.

The browser imports `readRootCauseSelection` to decide whether the button is
enabled and what to say beneath it; the route imports the same function to
decide whether to write. The reason the button is dead is therefore always on
screen, and the enabling rule and the saving rule cannot drift.

The database enforces the same rules again in SQL. That duplication is
deliberate and both halves earn their place: the CHECK is the last line and
catches a writer that skips the domain module; the domain module is the first
and turns what the CHECK would have made an opaque 500 into a sentence an agent
can act on.

## Where the strictness differs from the schema

One place, on purpose. `courier` is nullable in the table and **required** by
the selection rule for the three labels that open it. The feature exists to
answer a question about couriers, and an optional field on the one screen that
feeds that answer is a field that comes back empty. `Other` is on the list of
ten for the case where the courier genuinely is not one of the nine.

`courier_issue_type` stays optional at both ends, matching the schema's own
one-way CHECK: which courier carried a parcel is a fact an agent has in front of
them, whereas what the courier did wrong is often still being established.

## What is not here

Reporting. This pass is capture. Counts, percentages, grouping by date range,
courier, store and issue type, and the Excel/CSV export are the next piece of
work — the two report indexes exist for it already.

Agent identity. `recorded_by_user_id` is written NULL by every insert, because
CST has no interactive sign-in and the agreed position for this phase is a
single staff user. The column exists so that nothing has to be backfilled with a
guess the day a sign-in arrives. A courier report naming a person is read as
fact about them, so an absent author is better than a fabricated one.
