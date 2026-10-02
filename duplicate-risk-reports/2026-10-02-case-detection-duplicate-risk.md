# Case Detection Indicator — duplicate risk

**Date:** 2026-10-02

Where double counting could occur, and why it does not.

---

## 1. The real overlap, measured

**1,098 cases exist in both `cst_app.marketplace_cases` and
`cst_app.customer_case_history`.**

That is every row of 0021's table. Measured 2026-10-02 by joining on the shared
provenance key:

```sql
SELECT count(*)
FROM cst_app.marketplace_cases m
JOIN cst_app.customer_case_history h
  ON h.source_database = m.source_database
 AND h.source_table    = m.source_table
 AND h.source_case_id  = m.source_case_id;
-- 1098
```

An earlier working estimate of ~1,225 circulated during design and **was wrong**.
1,098 is the measured figure and supersedes it.

The overlap is the item-not-received and formal cases from the two inquiry logs
plus the payment disputes — the three stores 0021 imported. 0022 deliberately
used the **same key shape**, `(source_database, source_table, source_case_id)`,
precisely so a report can deduplicate across the two tables deterministically
instead of by matching names.

---

## 2. Why it cannot surface as a duplicate on screen

The two features render **disjoint kinds of thing**, and neither is derived from
the other:

| | Repeat-Customer Warning | Case Detection Indicator |
| --- | --- | --- |
| Renders | COUNTS of records | CASES |
| Names a case? | never — no identifier leaves the server | always — the case reference is the point |
| Scope | records that predate this conversation's first message | cases on this order, or this customer's other orders |
| Totals anything? | no | no |
| Table read | `customer_case_history` | `marketplace_cases` |

**No screen sums the two.** The warning carries no case reference and the panel
carries no count of records; there is no field on either that could be added to
the other.

Guarded, not merely intended — `tests/guards/case-detection-read-path.test.ts`:

- the panel imports no customer-history module, and the warning imports no case
  module
- the panel contains no `reduce` and no "total"
- the warning contains no `caseRef` and no `source_case_id`

---

## 3. Duplicates within the case table

**Zero.** `uq_marketplace_cases_source_identity` is unique on
`(source_database, source_table, source_case_id)`, all three NOT NULL, so the
upsert's plain conflict target is correct. Verified 2026-10-02: 0 duplicate
identities across 21,022 rows.

`source_table` is in the key because the identifier spaces genuinely overlap — 69
identifiers appear in BOTH inquiry logs for what measurement showed to be the
same case. The database would accept both rows of such a pair, so the importer
drops the superseded copy and **counts it**: `superseded_by_inquiries`, 69 cases
in run 3.

---

## 4. Duplicates between the two read lists

The "on this order" and "other orders by this customer" lists are **disjoint by
construction**: the customer statement carries
`c.order_ref IS DISTINCT FROM $4`, where `$4` is the conversation's resolved
order. A case matching both predicates appears only in the first.

`IS DISTINCT FROM` rather than `<>` is load-bearing: with `<>`, a NULL order
reference — what a conversation that resolved to no order supplies — would
exclude every row and silently empty the only list there is.

---

## 5. Events counted as cases

Six of the nine source stores are event logs. 7,240 inquiry event rows became 875
cases; 42,931 eBay return rows became 4,082. The collapse is the whole point, and
`source_row_count` preserves the original count so a report can still separate
"how many cases" from "how many recorded events".

**`sum(source_row_count)` is not a case count and must never be reported as one.**

---

## 6. Re-running the import

The upsert is keyed on the case identity, so a second run updates rows rather
than appending copies. The `xmax = 0` test in the `RETURNING` clause reports real
insert/update counts, so a second run that reported thousands of inserts would be
visible as a fault rather than silently doubling the table.

**Not yet proven live** — `cases_updated` is 0 in the only successful run. See
`evidence/2026-10-02-case-detection-evidence.md` §7.

---

## 7. Open decision

Nothing in this feature reconciles the two tables, and nothing should without a
decision. If a report is ever built that counts cases across both, it must
deduplicate on `(source_database, source_table, source_case_id)` and **say on the
report which table it preferred for the overlapping 1,098**. The queries are in
`query-packs/2026-10-02-case-detection-query-pack.md`.
