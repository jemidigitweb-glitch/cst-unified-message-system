# Root cause capture — query pack

**2026-09-29.** The reads this feature performs, and the reads the report will
perform once it is built.

Two databases, and nothing joins them.

## What the application runs today

All three live in `lib/repositories/conversation-root-cause-repository.ts` and
are exported as `ROOT_CAUSE_STATEMENTS` so a guard test can assert what they do.

**The current value.** The panel's read. Append-only means "current" is the
newest row, not a column.

```sql
SELECT id::text AS id, root_cause, courier, courier_issue_type,
       vocabulary_version, issue_note, recorded_at
  FROM cst_app.conversation_root_causes
 WHERE conversation_id = $1::bigint
 ORDER BY recorded_at DESC, id DESC
 LIMIT 1;
```

Answered by `ix_conversation_root_causes_conversation` without a sort. The
`id DESC` tiebreak matters: two rows can share an instant when a selection is
corrected immediately, and `recorded_at` alone is not a total order.

**The history.** Not rendered yet; exists so "when did this change, and from
what" has an answer without a hand-written query. Same statement without the
`LIMIT 1`, bounded at 50.

**The write.** The only writing statement in the module.

```sql
INSERT INTO cst_app.conversation_root_causes
       (conversation_id, root_cause, courier, courier_issue_type, issue_note, vocabulary_version)
VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::integer)
RETURNING …;
```

`recorded_by_user_id` is **not in the statement**, so it takes its default
rather than holding a parameter slot waiting for a caller to guess an author.

## The source read, unchanged

`lib/repositories/root-cause-repository.ts`, one statement per marketplace
table, built at module load from the adapters' compile-time literals:

```sql
SELECT <pk>::text AS source_pk, root_cause
  FROM customer_service.<table>
 WHERE <pk> = ANY($1::bigint[]);
```

A stored `source_table` is only ever used to **look up** a prepared statement,
never to build one.

## What the report will run — not built yet

Both indexes exist for these already. Written here so the next piece of work
starts from the shape the schema was designed for, not from a fresh guess.

**Counts and percentages by courier, over a date range.** The question the
feature exists to answer.

```sql
SELECT courier,
       count(*) AS cases,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
  FROM cst_app.conversation_root_causes r
 WHERE r.courier IS NOT NULL
   AND r.recorded_at >= $1::timestamptz
   AND r.recorded_at <  $2::timestamptz
 GROUP BY courier
 ORDER BY cases DESC;
```

Served by the **partial** index `ix_conversation_root_causes_courier`.

**By courier and issue type.** Add `courier_issue_type` to both the SELECT and
the GROUP BY; the same index covers it, in that column order.

**By root cause alone, over a date range.** Served by
`ix_conversation_root_causes_recorded_at`.

```sql
SELECT root_cause, count(*) AS cases
  FROM cst_app.conversation_root_causes
 WHERE recorded_at >= $1::timestamptz AND recorded_at < $2::timestamptz
 GROUP BY root_cause
 ORDER BY cases DESC;
```

### Two things the report author must handle, and neither is optional

**Append-only means the naive count is wrong.** Every one of the queries above
counts ROWS, and a conversation whose root cause was corrected twice
contributes three. For "how many cases", count the CURRENT value per
conversation:

```sql
WITH current AS (
  SELECT DISTINCT ON (conversation_id)
         conversation_id, root_cause, courier, courier_issue_type, recorded_at
    FROM cst_app.conversation_root_causes
   ORDER BY conversation_id, recorded_at DESC, id DESC
)
SELECT courier, count(*) AS cases
  FROM current
 WHERE courier IS NOT NULL
   AND recorded_at >= $1::timestamptz AND recorded_at < $2::timestamptz
 GROUP BY courier
 ORDER BY cases DESC;
```

Which of the two is right depends on the question — "how many cases involved
EVRI" wants the second; "how often did somebody record an EVRI problem" wants
the first. **Say which, on the report.** A percentage whose denominator is
undocumented is a number nobody can act on.

**"By store" is not in this table.** The user asked for the report to break down
by store, and `conversation_root_causes` holds no marketplace column — on
purpose, because it is a fact about the conversation, not about the decision.
Join to `cst_app.conversations` for it rather than denormalising a copy that can
drift.

## Not in this pack

Nothing here reads the message application's `root_cause` for reporting, and
nothing should. Those values belong to a system that rewrites them every five
minutes with no user and no log; a report built on them cannot say how a number
was arrived at. The panel shows both so a human can compare. The report counts
CST's own.
