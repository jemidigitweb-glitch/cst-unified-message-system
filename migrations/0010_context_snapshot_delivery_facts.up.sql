-- =============================================================================
-- 0010_context_snapshot_delivery_facts.up.sql
--
-- Lets a resolved order's shipment facts survive a cached read.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
--
-- WHY THIS IS REQUIRED
--
--   The eBay order-context resolver (`lib/context/resolve-order-context.ts`)
--   returns 8 verified facts the first time it resolves a conversation:
--   order_number, order_status, order_date, tracking_number, delivery_courier,
--   delivery_address, sku, product_title. Every subsequent request for the
--   same conversation is answered from the cached `context_snapshots` row
--   instead of the source database, and that row had nowhere to hold the
--   three shipment facts -- so a cached read silently dropped them, and any
--   draft generated after the first one for that conversation lost the
--   ability to cite a tracking number, courier, or delivery address it had
--   already verified.
--
-- WHAT THIS IS NOT
--
--   Not a new resolution path and not a new verification method. These three
--   columns are populated exactly when order_number/order_date/
--   order_status_summary already are -- a single deterministic match -- and
--   are governed by the same CHECK that keeps an unresolved snapshot free of
--   order data.
--
-- SAFETY CONTRACT
--   * Touches cst_app.context_snapshots and nothing else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--   * Adds no send/outbound/transmission structure.
--   * Deletes no row and drops no column.
--   * Purely additive: every existing row already has NULL in these columns
--     (source and resolution never carried them before this migration) and
--     satisfies the widened CHECK unchanged.
--   * Runs in one transaction; re-runnable.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The three shipment facts, alongside the order facts they were always
--    resolved with.
-- -----------------------------------------------------------------------------
ALTER TABLE cst_app.context_snapshots
  ADD COLUMN IF NOT EXISTS tracking_number text,
  ADD COLUMN IF NOT EXISTS delivery_courier text,
  ADD COLUMN IF NOT EXISTS delivery_address text;

COMMENT ON COLUMN cst_app.context_snapshots.tracking_number IS
  'Verified courier tracking number for the resolved order. NULL unless resolution = single_order (or terminated_order).';
COMMENT ON COLUMN cst_app.context_snapshots.delivery_courier IS
  'Verified courier/carrier name for the resolved order. NULL unless resolution = single_order (or terminated_order).';
COMMENT ON COLUMN cst_app.context_snapshots.delivery_address IS
  'Verified delivery address for the resolved order, as one formatted line. NULL unless resolution = single_order (or terminated_order).';

-- -----------------------------------------------------------------------------
-- 2. Widen ck_context_snapshots_unresolved_has_no_order so an unresolved
--    snapshot (no_order / ambiguous / needs_context) stays free of these three
--    columns too -- the same invariant it already holds for order_number,
--    order_date and sub_source_id.
-- -----------------------------------------------------------------------------
ALTER TABLE cst_app.context_snapshots
  DROP CONSTRAINT IF EXISTS ck_context_snapshots_unresolved_has_no_order;

ALTER TABLE cst_app.context_snapshots
  ADD CONSTRAINT ck_context_snapshots_unresolved_has_no_order
  CHECK (
    resolution NOT IN ('no_order', 'ambiguous', 'needs_context')
    OR (
      sub_source_id IS NULL
      AND order_number IS NULL
      AND order_date IS NULL
      AND tracking_number IS NULL
      AND delivery_courier IS NULL
      AND delivery_address IS NULL
    )
  );

COMMIT;
