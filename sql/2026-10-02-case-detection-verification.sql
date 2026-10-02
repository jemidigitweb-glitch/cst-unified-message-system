-- =============================================================================
-- 2026-10-02-case-detection-verification.sql
--
-- Re-derives every number in evidence/2026-10-02-case-detection-evidence.md.
--
-- READ-ONLY. Run against the APPLICATION database (varmen_db) with
--
--     SET default_transaction_read_only = on;
--
-- on the session first, so the server refuses a write from this path even if a
-- statement below were wrong. Nothing here touches the marketplace source and
-- nothing here touches MySQL.
-- =============================================================================

SET default_transaction_read_only = on;

-- -----------------------------------------------------------------------------
-- 1. The migration landed, and landed only where it should have.
-- -----------------------------------------------------------------------------
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'cst_app' AND table_type = 'BASE TABLE'
  AND table_name IN ('marketplace_cases', 'case_import_runs', 'customer_case_history')
ORDER BY 1;

-- -----------------------------------------------------------------------------
-- 2. The run ledger. Expect exactly one 'published' row, and failed rows owning
--    no cases at all.
-- -----------------------------------------------------------------------------
SELECT id, status, started_at, published_at,
       cardinality(source_tables) AS stores,
       cases_read, cases_inserted, cases_updated, cases_rejected,
       mysql_connections, mysql_queries
FROM cst_app.case_import_runs
ORDER BY id;

-- Rows owned by each run. A failed run must own ZERO.
SELECT r.id, r.status, count(c.id)::int AS rows_owned
FROM cst_app.case_import_runs r
LEFT JOIN cst_app.marketplace_cases c ON c.import_run_id = r.id
GROUP BY 1, 2 ORDER BY 1;

-- What was dropped, and why. Nothing unmappable is repaired with a default.
SELECT jsonb_pretty(rejection_summary)
FROM cst_app.case_import_runs WHERE status = 'published';

-- -----------------------------------------------------------------------------
-- 3. FRESHNESS, PER SOURCE STORE. This is the statement the read path runs.
--    A store ABSENT here has never been imported — which is not the same fact
--    as holding no cases, and must never be reported as one.
-- -----------------------------------------------------------------------------
SELECT t AS source_table, max(r.published_at)::text AS published_at
FROM cst_app.case_import_runs r, unnest(r.source_tables) AS t
WHERE r.status = 'published'
GROUP BY 1
ORDER BY 1;

-- -----------------------------------------------------------------------------
-- 4. What is visible to CST — i.e. behind the publication gate. This number and
--    the raw row count agree only while no run has been retracted.
-- -----------------------------------------------------------------------------
SELECT count(*)::int AS visible_cases
FROM cst_app.marketplace_cases c
JOIN cst_app.case_import_runs r ON r.id = c.import_run_id
WHERE r.status = 'published';

SELECT count(*)::int AS all_rows FROM cst_app.marketplace_cases;

-- -----------------------------------------------------------------------------
-- 5. The distribution. `source_rows` is how many EVENT rows collapsed in;
--    summing it is never a case count.
-- -----------------------------------------------------------------------------
SELECT source_table, marketplace, case_type,
       count(*)::int AS cases,
       sum(source_row_count)::int AS source_rows
FROM cst_app.marketplace_cases
GROUP BY 1, 2, 3
ORDER BY 1, 3;

SELECT lifecycle, count(*)::int FROM cst_app.marketplace_cases GROUP BY 1 ORDER BY 1;
SELECT order_match_method, count(*)::int FROM cst_app.marketplace_cases GROUP BY 1 ORDER BY 1;

SELECT count(*) FILTER (WHERE damage_reported)::int           AS damage,
       count(*) FILTER (WHERE replacement_confirmed)::int     AS replacement,
       count(*) FILTER (WHERE escalation = 'escalated')::int  AS escalated,
       count(*) FILTER (WHERE escalation = 'not_escalated')::int AS not_escalated,
       count(*) FILTER (WHERE escalation = 'not_recorded')::int  AS not_recorded,
       count(*) FILTER (WHERE source_disposition IS NOT NULL)::int AS dispositions,
       count(*) FILTER (WHERE counterparty_ref IS NOT NULL)::int   AS with_customer
FROM cst_app.marketplace_cases;

SELECT min(opened_at)::text AS earliest, max(opened_at)::text AS latest
FROM cst_app.marketplace_cases;

-- -----------------------------------------------------------------------------
-- 6. THE THREE TRAPS, each as a query that would show the mistake if it had
--    been made.
-- -----------------------------------------------------------------------------

-- 6a. NO WAREHOUSE DISPOSITION MAY APPEAR AS A CASE STATUS. The only values here
--     should be the merchant-fulfilled case statuses — never 'sellable',
--     'reimbursed', 'customer damaged' or 'unit returned to inventory'.
SELECT source_status, lifecycle, count(*)::int
FROM cst_app.marketplace_cases
WHERE source_table = 'amazon_returns'
GROUP BY 1, 2 ORDER BY 3 DESC;

-- ...and where the disposition legitimately lives.
SELECT source_disposition, count(*)::int
FROM cst_app.marketplace_cases
WHERE source_disposition IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;

-- 6b. AN ESCALATED CASE MAY BE CLOSED. Both facts must survive; neither is
--     derivable from the other.
SELECT count(*)::int AS escalated_and_closed
FROM cst_app.marketplace_cases
WHERE escalation = 'escalated' AND lifecycle = 'closed';

-- 6c. A CONFIRMED REPLACEMENT COMES FROM ONE STORE ONLY. Any other store here
--     means ck_marketplace_cases_replacement_source has been weakened.
SELECT source_table, count(*)::int
FROM cst_app.marketplace_cases
WHERE replacement_confirmed
GROUP BY 1;

-- -----------------------------------------------------------------------------
-- 7. Duplicates. Expect zero.
-- -----------------------------------------------------------------------------
SELECT count(*)::int AS duplicate_identities FROM (
  SELECT source_database, source_table, source_case_id
  FROM cst_app.marketplace_cases
  GROUP BY 1, 2, 3 HAVING count(*) > 1
) d;

-- -----------------------------------------------------------------------------
-- 8. The Repeat-Customer Warning's table is untouched, and the overlap is
--    declared rather than hidden. See duplicate-risk-reports/.
-- -----------------------------------------------------------------------------
SELECT count(*)::int AS rows, max(imported_at)::text AS imported_at
FROM cst_app.customer_case_history;

SELECT count(*)::int AS shared_identities
FROM cst_app.marketplace_cases m
JOIN cst_app.customer_case_history h
  ON h.source_database = m.source_database
 AND h.source_table    = m.source_table
 AND h.source_case_id  = m.source_case_id;

-- -----------------------------------------------------------------------------
-- 9. REACH. How many conversations the indicator can render anything on. These
--    are the two matches the read path makes, written out exactly as the
--    repository makes them — including the publication gate.
-- -----------------------------------------------------------------------------
SELECT count(DISTINCT s.conversation_id)::int AS conversations_with_a_case_on_their_order
FROM cst_app.context_snapshots s
JOIN cst_app.conversations cv ON cv.id = s.conversation_id
JOIN cst_app.marketplace_cases c
  ON c.marketplace   = cv.marketplace
 AND c.sub_source_id = cv.sub_source_id
 AND c.order_ref     = s.order_number
JOIN cst_app.case_import_runs r ON r.id = c.import_run_id AND r.status = 'published'
WHERE s.order_number IS NOT NULL;

SELECT count(DISTINCT cv.id)::int AS conversations_with_a_customer_case
FROM cst_app.conversations cv
JOIN cst_app.marketplace_cases c
  ON c.marketplace   = cv.marketplace
 AND c.sub_source_id = cv.sub_source_id
 AND c.counterparty_ref IS NOT NULL
 AND lower(c.counterparty_ref) = lower(cv.counterparty_ref)
JOIN cst_app.case_import_runs r ON r.id = c.import_run_id AND r.status = 'published';
