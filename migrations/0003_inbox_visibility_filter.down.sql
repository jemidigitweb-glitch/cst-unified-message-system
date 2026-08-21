-- =============================================================================
-- 0003_inbox_visibility_filter.down.sql
--
-- Rollback for 0003_inbox_visibility_filter.up.sql.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED.
--
-- NARROWING A CHECK CAN FAIL, AND SHOULD. Any conversation still marked
-- 'filtered' would violate the restored constraint, so this migration first
-- returns those rows to 'reply_inbox' — the value they would have had before
-- filtering existed. That reveals them again rather than hiding or deleting
-- them, which is the safe direction to fail in.
--
-- Rows whose inbound_count is 0 cannot be 'reply_inbox' (see
-- ck_conversations_reply_inbox_needs_inbound), so they go to 'outbound_only'.
-- =============================================================================

BEGIN;

UPDATE cst_app.conversations
   SET inbox_visibility = CASE WHEN inbound_count >= 1 THEN 'reply_inbox' ELSE 'outbound_only' END,
       inbox_filter_reason = NULL,
       updated_at = now()
 WHERE inbox_visibility = 'filtered';

ALTER TABLE cst_app.conversations
  DROP CONSTRAINT IF EXISTS ck_conversations_filter_reason_pair;

ALTER TABLE cst_app.conversations
  DROP CONSTRAINT IF EXISTS ck_conversations_inbox_visibility;

ALTER TABLE cst_app.conversations
  ADD CONSTRAINT ck_conversations_inbox_visibility
  CHECK (inbox_visibility IN ('reply_inbox', 'outbound_only'));

ALTER TABLE cst_app.conversations
  DROP COLUMN IF EXISTS inbox_filter_reason;

DROP INDEX IF EXISTS cst_app.ix_conversations_marketplace_inbox;

COMMIT;
