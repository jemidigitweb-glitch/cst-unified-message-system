# Case Detection Indicator — query pack

**Date:** 2026-10-02

The queries this feature runs, and the ones a report will need. All read-only,
all against the APPLICATION database.

---

## 1. What the feature runs per conversation

Four statements, at most, on the application pool. No MySQL, no marketplace
source.

### 1a. Freshness, per source store

```sql
SELECT t AS source_table, max(r.published_at)::text AS published_at
FROM cst_app.case_import_runs r, unnest(r.source_tables) AS t
WHERE r.status = 'published'
GROUP BY 1
ORDER BY 1;
```

Runs first. If it returns nothing for this marketplace's stores, the other three
statements are never sent.

### 1b. The order this conversation resolved to

```sql
SELECT id::text, conversation_id::text, resolution, sub_source_id, order_number
FROM cst_app.context_snapshots
WHERE conversation_id = $1::bigint;
```

`order_number` is non-null only on a single-order snapshot.

### 1c. Cases on that order

```sql
SELECT <case columns>
FROM cst_app.marketplace_cases c
JOIN cst_app.case_import_runs r
  ON r.id = c.import_run_id AND r.status = 'published'
WHERE c.marketplace = $1 AND c.sub_source_id = $2::int AND c.order_ref = $3
ORDER BY CASE c.lifecycle WHEN 'active' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END,
         c.opened_at DESC, c.id DESC
LIMIT $4::int;
```

### 1d. The same customer's cases on their other orders

```sql
... WHERE c.marketplace = $1 AND c.sub_source_id = $2::int
      AND c.counterparty_ref IS NOT NULL
      AND lower(c.counterparty_ref) = lower($3)
      AND c.order_ref IS DISTINCT FROM $4
```

`IS DISTINCT FROM`, not `<>`: `$4` is NULL when the conversation resolved to no
order, and `<>` against NULL excludes every row.

**Both ask for `LIMIT n+1` and report the overflow**, so a capped list says it was
capped.

---

## 2. Verification

See `sql/2026-10-02-case-detection-verification.sql` — the run ledger, the
distribution, the three traps, duplicates, the untouched warning table, and
reach.

---

## 3. Queries a report will need, and the decision each forces

### 3a. Cases by marketplace and type, over a date range

```sql
SELECT c.marketplace, c.case_type, c.lifecycle, count(*)::int AS cases
FROM cst_app.marketplace_cases c
JOIN cst_app.case_import_runs r ON r.id = c.import_run_id AND r.status = 'published'
WHERE c.opened_at >= $1::timestamp AND c.opened_at < $2::timestamp
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```

**Decision:** `opened_at` is naive and of unknown zone — the same open question
as every other source timestamp in this application. A range boundary is
therefore approximate at the edges and a report must say so.

### 3b. Cases by storefront

```sql
SELECT c.marketplace, c.sub_source_id, count(*)::int AS cases
FROM cst_app.marketplace_cases c
JOIN cst_app.case_import_runs r ON r.id = c.import_run_id AND r.status = 'published'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

**Decision:** `sub_source_id` is an identifier, not a name. Joining it to a
storefront name means reading the order source, which is a different pool.

### 3c. Damage and escalation rates

```sql
SELECT c.marketplace,
       count(*)::int                                            AS cases,
       count(*) FILTER (WHERE c.damage_reported)::int           AS damage,
       count(*) FILTER (WHERE c.escalation = 'escalated')::int  AS escalated,
       count(*) FILTER (WHERE c.escalation = 'not_recorded')::int AS no_signal
FROM cst_app.marketplace_cases c
JOIN cst_app.case_import_runs r ON r.id = c.import_run_id AND r.status = 'published'
GROUP BY 1;
```

**Decision:** `not_recorded` must be reported, not folded into the denominator as
"not escalated". Six of the nine stores have no escalation concept at all, so a
rate computed over all cases understates it by an unknown amount. `no_signal` is
in the SELECT so the denominator question cannot be skipped.

### 3d. Cases per conversation — the double-counting one

```sql
SELECT cv.id::text, count(DISTINCT c.source_case_id)::int AS cases
FROM cst_app.conversations cv
JOIN cst_app.context_snapshots s ON s.conversation_id = cv.id
JOIN cst_app.marketplace_cases c
  ON c.marketplace = cv.marketplace AND c.sub_source_id = cv.sub_source_id
 AND c.order_ref = s.order_number
JOIN cst_app.case_import_runs r ON r.id = c.import_run_id AND r.status = 'published'
GROUP BY 1;
```

**Decision:** `count(DISTINCT source_case_id)`, never `count(*)`, and never
`sum(source_row_count)` — the first is cases, the last is source EVENTS and is
five to ten times larger on the event-log stores.

### 3e. Across both case tables — read §3e's warning first

```sql
-- Cases in the new table, with a flag for those the 0021 table also holds.
SELECT m.source_table, m.case_type,
       count(*)::int                                   AS cases,
       count(h.id)::int                                AS also_in_case_history
FROM cst_app.marketplace_cases m
JOIN cst_app.case_import_runs r ON r.id = m.import_run_id AND r.status = 'published'
LEFT JOIN cst_app.customer_case_history h
       ON h.source_database = m.source_database
      AND h.source_table    = m.source_table
      AND h.source_case_id  = m.source_case_id
GROUP BY 1, 2 ORDER BY 1, 2;
```

**Decision, and it must be stated on the report:** 1,098 cases exist in both
tables. Deduplicate on `(source_database, source_table, source_case_id)` and say
which table was preferred. A naive `UNION ALL` double-counts every one of them.
See `duplicate-risk-reports/2026-10-02-case-detection-duplicate-risk.md`.

### 3f. Import history

```sql
SELECT id, status, started_at, published_at, finished_at,
       cases_read, cases_inserted, cases_updated, cases_rejected,
       mysql_connections, mysql_queries, rejection_summary
FROM cst_app.case_import_runs
ORDER BY id DESC;
```

**Decision:** a report on data quality should read `rejection_summary` rather
than only the counts — it names what was dropped and why, and nothing unmappable
was ever repaired with a default.
