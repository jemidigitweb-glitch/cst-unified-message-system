-- =============================================================================
-- 0010_context_snapshot_delivery_facts.down.sql
--
-- Rollback for 0010_context_snapshot_delivery_facts.up.sql.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
--
-- NARROWING BACK IS SAFE HERE, UNLIKE 0003's ROLLBACK. The restored CHECK is
-- narrower than 0010's, but only on three columns being dropped in the same
-- statement -- there is no row left afterward for the narrower check to be
-- wrong about. No UPDATE is needed first.
-- =============================================================================

BEGIN;

ALTER TABLE cst_app.context_snapshots
  DROP CONSTRAINT IF EXISTS ck_context_snapshots_unresolved_has_no_order;

ALTER TABLE cst_app.context_snapshots
  ADD CONSTRAINT ck_context_snapshots_unresolved_has_no_order
  CHECK (
    resolution NOT IN ('no_order', 'ambiguous', 'needs_context')
    OR (sub_source_id IS NULL AND order_number IS NULL AND order_date IS NULL)
  );

ALTER TABLE cst_app.context_snapshots
  DROP COLUMN IF EXISTS tracking_number,
  DROP COLUMN IF EXISTS delivery_courier,
  DROP COLUMN IF EXISTS delivery_address;

COMMIT;
