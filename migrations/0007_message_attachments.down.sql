-- =============================================================================
-- 0007_message_attachments.down.sql
--
-- Reverses 0007. Restores cst_app.conversation_messages to its 0006 shape.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
--
-- WHAT IS LOST
--
--   The recorded attachment URLs. That is derived data, not authored data: it
--   is read from the source message rows and can be rebuilt in full by
--   re-running `npm run backfill:attachments -- --apply`. No message, thread,
--   draft or workflow state is touched, and no file is deleted anywhere — this
--   application never held the files, only links to them.
--
-- SAFETY CONTRACT
--   * Touches cst_app.conversation_messages and nothing else.
--   * Drops only what 0007 added.
--   * Never targets the live source database.
--   * Deletes no row.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS cst_app.ix_conversation_messages_attachments;

ALTER TABLE cst_app.conversation_messages
  DROP CONSTRAINT IF EXISTS ck_conversation_messages_attachments_array;

ALTER TABLE cst_app.conversation_messages
  DROP COLUMN IF EXISTS attachments;

COMMIT;
