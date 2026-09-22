-- =============================================================================
-- 0013_automation_restore_cancel_pair.down.sql
--
-- Restores 0011's original biconditional. DESTRUCTIVE TO UNDO-CANCEL: any
-- restored row (`scheduled` with `cancelled_at` set) will fail this CHECK, so
-- the rollback refuses until those rows are cancelled again or the timestamp
-- is cleared. That is the point of RESTRICT-style honesty: the old constraint
-- and Undo Cancel cannot coexist.
-- =============================================================================

BEGIN;

ALTER TABLE cst_app.automation_items
  DROP CONSTRAINT IF EXISTS ck_automation_items_cancel_pair;

ALTER TABLE cst_app.automation_items
  ADD CONSTRAINT ck_automation_items_cancel_pair
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));

COMMIT;
