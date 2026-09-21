-- =============================================================================
-- 0011_post_dispatch_automation.down.sql
--
-- Reverses 0011. DESTRUCTIVE: it deletes every post-dispatch automation record
-- and every saved template. It exists for a rejected migration, not for
-- routine use.
--
-- Drops only the three tables 0011 created, in dependency order, and leaves the
-- cst_app schema and everything 0001-0010 created untouched — including the CST
-- conversation draft workflow, which this automation neither reads nor writes.
-- RESTRICT throughout, never CASCADE, so an unexpected dependant fails the
-- rollback loudly instead of being destroyed by it.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.automation_items RESTRICT;
DROP TABLE IF EXISTS cst_app.automation_settings RESTRICT;
DROP TABLE IF EXISTS cst_app.automation_templates RESTRICT;

COMMIT;
