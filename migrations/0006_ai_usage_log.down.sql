-- =============================================================================
-- 0006_ai_usage_log.down.sql
--
-- Reverses 0006. Drops the AI usage accounting table.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
--
-- WHAT IS LOST
--
--   The record of what each draft generation consumed. That history cannot be
--   rebuilt — the providers are not re-queried and no other table holds token
--   counts — so take a copy first if the spend record matters.
--
--   Nothing else is affected. No conversation, message, draft, revision or
--   workflow state references this table; the foreign keys point outward from
--   it, not into it.
--
-- SAFETY CONTRACT
--   * Drops only what 0006 created.
--   * Touches no other table in cst_app.
--   * Never targets the live source database.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.ai_usage_log;

COMMIT;
