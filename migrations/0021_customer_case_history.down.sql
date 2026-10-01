-- =============================================================================
-- 0021_customer_case_history.down.sql
--
-- Rollback for 0021. Drops the one table it created and nothing else.
--
-- RESTRICT, NEVER CASCADE. Nothing references this table — it holds no foreign
-- key and is the target of none, deliberately (see the up migration on why
-- there is no link to `conversations`) — so RESTRICT should succeed outright.
-- If it ever does not, something has taken a dependency on this table since,
-- and the right outcome is a failed rollback a person looks at rather than a
-- CASCADE quietly removing whatever that was.
--
-- The two indexes go with the table; dropping them separately is unnecessary
-- and would leave a half-rolled-back state if the table drop then failed.
--
-- WHAT THIS DOES NOT TOUCH. No other cst_app table loses a row, a column or a
-- comment. In particular `conversations`, `context_snapshots` and
-- `agent_activity` are untouched: this table was additive and its removal is
-- too. The imported case history is lost, which is acceptable — it is a
-- re-derivable snapshot of a read-only MySQL source, not a system of record,
-- and re-running the approved one-time import reproduces it.
--
-- NO MYSQL OBJECT IS TOUCHED. The source is read-only and a rollback is not a
-- writer. Applying this file opens no MySQL connection.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.customer_case_history RESTRICT;

COMMIT;
