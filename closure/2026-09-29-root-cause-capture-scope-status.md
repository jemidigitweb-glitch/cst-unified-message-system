# Root cause capture — scope status

**2026-09-29.** Capture is finished. Reporting and export are not started.

## Built

| Layer | File |
| --- | --- |
| Migration | `migrations/0020_conversation_root_cause.up.sql` / `.down.sql` — **written, NOT APPLIED** |
| Migration test | `tests/migrations/conversation-root-cause-schema.test.ts` — static, reads the SQL as text |
| Domain | `lib/domain/root-cause-vocabulary.ts` — the three lists, the version, the display rule |
| Domain | `lib/domain/root-cause-selection.ts` — what a selection amounts to, or a refusal |
| Write | `lib/repositories/conversation-root-cause-repository.ts` — one INSERT, two reads |
| API | `app/api/conversations/[conversationId]/root-cause/route.ts` — GET extended, POST added |
| UI | `components/root-cause-selector.tsx` — the chip grid, its own component |
| Wiring | `components/context-panel.tsx` renders it directly beneath the read-only display |

Unchanged this round, and deliberately so: `lib/domain/message-app-root-cause.ts`
and `lib/repositories/root-cause-repository.ts`. The read path that shows the
message application's value gained nothing and must not — a module holding both
the lookup and the writer would be one edit away from writing what it read.

## Tests

| File | Tests |
| --- | --- |
| `tests/migrations/conversation-root-cause-schema.test.ts` | 35 |
| `tests/domain/root-cause-vocabulary.test.ts` | 21 |
| `tests/domain/root-cause-selection.test.ts` | 31 |
| `tests/repositories/conversation-root-cause-repository.test.ts` | 20 |
| `tests/guards/api-surface.test.ts` | +2 (the exemption and its writer) |
| `tests/guards/message-app-root-cause-panel.test.ts` | +6, and three rewritten |

Full suite: 4,784 passing. Three pre-existing failures in
`tests/knowledge/cst-rules-files.test.ts` are unrelated to this work — they
concern the spreadsheet corpus and a missing "Message Handling" area.

## Correction applied before 0020 was ever run

A parity review against the approved requirement found the **Level-3 issue-type
strings had been tidied**: all ten put into sentence case, and the two slashes
rewritten as the word "or". The approved values are

```
Lost parcel · transit damage · parcel damaged by courier ·
delivered to wrong address · false/incorrect delivery scan · delayed delivery ·
no tracking update · returned to sender · collection/drop-off issue · other
```

— item 1 capitalised, items 2-10 not. That irregularity is the specification,
not a mistake to normalise. Corrected in the TypeScript list and in the
migration's CHECK together; **no 0021 was created, because 0020 has never been
applied and the table holds no rows**. After it is applied this would cost a
data migration.

Two further changes came with it:

- **The issue type is now matched EXACTLY**, where it was case-folded. A
  variant is refused rather than repaired, so the approved list and the storable
  list cannot quietly stop being the same list. The root cause list stays folded
  — the source really does hold `Out of stock` beside `OUT OF STOCK` — and the
  courier matcher was left alone, which leaves the three deliberately different
  and documented.
- **The issue note's 1,000-character cap was an unapproved business rule.** It
  is now a stated technical ceiling of **2,000**, matching
  `INTERNAL_NOTE_MAX_LENGTH`, which this project already uses for an agent's own
  words about a case. There is no minimum and never was.

Level 1, the courier list, and every other behaviour were verified unchanged.

## Decisions worth recording

**The vocabulary was measured, not designed.** CST has no access to the message
application's option list — it lives in a UI backed by a database this
application holds no grant on. So the eighteen labels came from a read-only
`GROUP BY root_cause` across all five `customer_service` message tables: every
label offered is one its agents have really chosen. Case variants (`Out of
stock` beside `OUT OF STOCK`) were folded to one chip; the five rows holding
free prose are the OTHER flow working, not options.

**The four-level hierarchy hangs off existing labels.** `Delivery Issue`,
`FULFILMENT_CARRIER` and `FULFILMENT_WAREHOUSE` open the courier levels. No new
level-1 label was invented — one would have made every CST row unmatchable
against the thousands already filed under those three.

**Append-only, and that is the one behaviour of theirs not copied.** The message
application overwrites `root_cause` and discards the prior confirmation. Here,
changing a root cause inserts. The whole point of asking which courier causes
the most problems is that somebody will later ask how a number was arrived at.

**Courier is required; issue type is not.** This is the one place stricter than
the database. Which courier carried a parcel is a fact an agent has in front of
them, and an optional field on the one screen that feeds the report comes back
empty. What the courier did wrong is often still being established, and forcing
a choice buys a filled-in field at the price of a guessed one.

**One route, two systems, two components.** The message-app display keeps its
guard that it has nothing to operate; the CST selector is a separate file under
its own heading. Merging them would have to pick a winner between two values,
and neither system has the standing to be it.

**A dead check was removed rather than kept.** A guard against typing the word
"OTHER" into the explanation box was written, then deleted: the word is five
characters and the text is trimmed before measuring, so the 30-character
minimum already refuses it. An unreachable branch reads as a rule being
enforced while proving nothing.

## Not built, and not started

- Reporting by date range, courier, store and issue type, with counts **and
  percentages**.
- Excel/CSV export of that report.
- Any use of `getRootCauseHistory` on screen. The function exists so the
  question "when did this change, and from what" has an answer without a
  hand-written query; nothing renders it yet.
- Agent identity. `recorded_by_user_id` is written NULL by every insert.
