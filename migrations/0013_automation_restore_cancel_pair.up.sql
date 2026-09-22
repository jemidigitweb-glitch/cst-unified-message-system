-- -----------------------------------------------------------------------------
-- 0013  Undo Cancel must be allowed to keep `cancelled_at`.
--
-- 0011's original `ck_automation_items_cancel_pair` was a biconditional:
-- `cancelled_at` was set if and only if `status = 'cancelled'`. That matches
-- Cancel, and it forbids Undo Cancel: restoring a row sets `status` back to
-- `scheduled` and deliberately leaves `cancelled_at` in place so the record
-- still shows that it was cancelled and put back. PostgreSQL then refuses the
-- UPDATE, and the admin page reports "Unable to restore this record".
--
-- THIS MIGRATION CHANGES ONLY THAT CHECK. No column, no table, no row. A
-- cancelled row must still have `cancelled_at`. A scheduled, sent, skipped or
-- failed row may keep the timestamp as history.
--
-- ALREADY-APPLIED 0011 IS WHY THIS FILE EXISTS. Fresh databases pick up the
-- relaxed CHECK from 0011 itself; this statement is the same change for a
-- database that already ran the original 0011.
-- -----------------------------------------------------------------------------

BEGIN;

ALTER TABLE cst_app.automation_items
  DROP CONSTRAINT IF EXISTS ck_automation_items_cancel_pair;

ALTER TABLE cst_app.automation_items
  ADD CONSTRAINT ck_automation_items_cancel_pair
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL);

COMMIT;
