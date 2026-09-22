-- =============================================================================
-- 0015_automation_worker_wake.down.sql
--
-- Reverses 0012. NON-DESTRUCTIVE: it drops four triggers and one function. No
-- table is dropped, no row is deleted, no data is touched, and the worker simply
-- falls back to its interval recheck — which is correct, only slower.
--
-- ORDER MATTERS. The triggers are dropped before the function they call, because
-- `DROP FUNCTION ... RESTRICT` (the default) refuses while a trigger still
-- depends on it. That refusal is wanted: if a fifth trigger were ever added and
-- this file not updated, the rollback fails loudly rather than leaving a trigger
-- pointing at a function that no longer exists — which would break every write to
-- the table it fired on.
--
-- The function is dropped with RESTRICT, never CASCADE, for the same reason the
-- 0011 rollback uses RESTRICT throughout: an unexpected dependant should stop the
-- rollback, not be silently destroyed by it.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_automation_items_wake_insert ON cst_app.automation_items RESTRICT;
DROP TRIGGER IF EXISTS trg_automation_items_wake_status ON cst_app.automation_items RESTRICT;
DROP TRIGGER IF EXISTS trg_automation_items_wake_schedule ON cst_app.automation_items RESTRICT;
DROP TRIGGER IF EXISTS trg_automation_settings_wake ON cst_app.automation_settings RESTRICT;

DROP FUNCTION IF EXISTS cst_app.automation_wake(text) RESTRICT;

COMMIT;
