-- =============================================================================
-- 0022_marketplace_cases.down.sql
--
-- Rollback for 0022. Drops the two tables it created and nothing else.
--
-- ---------------------------------------------------------------------------
-- THE ORDER IS LOAD-BEARING, AND THIS IS THE FIRST ROLLBACK HERE WHERE IT IS
-- ---------------------------------------------------------------------------
-- `marketplace_cases.import_run_id` references `case_import_runs (id)`, so the
-- child must go first. Dropping the ledger first would fail under RESTRICT
-- while any case row survived — which is the constraint working, but it would
-- leave a half-rolled-back state for no reason. Child, then parent.
--
-- ---------------------------------------------------------------------------
-- RESTRICT, NEVER CASCADE
-- ---------------------------------------------------------------------------
-- Nothing outside these two tables references either of them: the case table
-- holds exactly one foreign key and it points at its sibling here, and neither
-- is the target of a reference from anywhere else — there is deliberately no
-- link to `conversations`, for the reason 0021 records at length.
--
-- So with the order above, both drops should succeed outright. If either ever
-- does not, something has taken a dependency on these tables since, and the
-- right outcome is a failed rollback a person looks at rather than a CASCADE
-- quietly removing whatever that was.
--
-- The indexes go with their tables. Dropping them separately is unnecessary and
-- would leave a half-rolled-back state if a table drop then failed.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT TOUCH
-- ---------------------------------------------------------------------------
-- No other cst_app table loses a row, a column, an index or a comment. In
-- particular `customer_case_history` is untouched, so the Repeat-Customer
-- Warning is unaffected by this rollback exactly as it was unaffected by the
-- migration: it keeps its 1,098 rows, its two indexes and its three statements.
-- `conversations`, `context_snapshots`, `agent_activity` and `sync_state` are
-- likewise untouched — 0022 was additive and its removal is too.
--
-- The imported case snapshot is lost, which is acceptable and is the same
-- judgement 0021's rollback records: it is a re-derivable snapshot of a
-- read-only source, not a system of record. Re-applying 0022 and re-running the
-- approved import reproduces it, at a cost of one source connection and twelve
-- queries.
--
-- The run ledger is lost with it, which means the record of WHEN the snapshot
-- was published is lost too. That is stated rather than glossed: after a
-- rollback and a re-import, the freshness a reviewer sees is the new run's, and
-- the history of earlier runs is gone. Nothing downstream reads it.
--
-- ---------------------------------------------------------------------------
-- NO SOURCE OBJECT IS TOUCHED
-- ---------------------------------------------------------------------------
-- Both sources are strictly read-only and a rollback is not a writer. Applying
-- this file opens no MySQL connection and no marketplace source connection, and
-- names no object in either.
-- =============================================================================

BEGIN;

-- Child first: it holds the foreign key.
DROP TABLE IF EXISTS cst_app.marketplace_cases RESTRICT;

-- Then the ledger it pointed at.
DROP TABLE IF EXISTS cst_app.case_import_runs RESTRICT;

COMMIT;
