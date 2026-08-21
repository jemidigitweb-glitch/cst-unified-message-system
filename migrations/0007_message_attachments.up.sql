-- =============================================================================
-- 0007_message_attachments.up.sql
--
-- Records the attachment URLs a customer message arrived with, so the
-- conversation view can show the photograph instead of the word "Photo 1".
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED. Awaiting review.
--
-- WHY THIS IS REQUIRED
--
--   CST staff routinely ask customers for photographs — the damage rules
--   require them before anything is offered — and the thread currently shows
--   only a body line saying a photo exists. The reviewer has to leave the
--   application to see the evidence the rules told them to collect.
--
--   The URLs are in the source (`shopify_messages.attachments`, 3,836 rows;
--   `bandq_messages.attachments`, 206) as a JSONB array, and they were never
--   copied into cst_app. Nothing in this schema can currently drive that view.
--
-- WHAT IS AND IS NOT STORED
--
--   Stored: the attachment URLs, verbatim, as a JSONB array of strings.
--
--   NOT stored: the file itself. These point at storage the business already
--   runs; this application copies nothing and hosts nothing. If an attachment
--   is removed at source the link stops resolving, which is the correct
--   behaviour — the record of what a customer sent should not outlive it here.
--
--   NOT a customer identity field. A URL is a location, not a person, and
--   nothing may derive a customer fact from one.
--
-- WHY A COLUMN AND NOT A TABLE
--
--   An attachment has no identity of its own in the source — it is an ordered
--   array on the message row, with no id and no metadata. Modelling that as a
--   child table would invent a primary key the source does not have and imply a
--   stability it does not promise.
--
-- SAFETY CONTRACT
--   * Touches cst_app.conversation_messages and nothing else.
--   * Purely additive: one nullable column and one partial index.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--   * Adds no send/outbound/transmission structure.
--   * Deletes no row and drops no column.
--   * Runs in one transaction; re-runnable.
-- =============================================================================

BEGIN;

ALTER TABLE cst_app.conversation_messages
  ADD COLUMN IF NOT EXISTS attachments jsonb;

COMMENT ON COLUMN cst_app.conversation_messages.attachments IS
  'Attachment URLs from the source message, as a JSON array of strings. NULL where the source records none. The files are not copied here.';

-- -----------------------------------------------------------------------------
-- Keep the shape honest.
--
-- A JSONB column will accept an object, a number or a bare string just as
-- happily as the array the reader expects. Without this, one malformed write
-- becomes a runtime error in the conversation view for a row nobody can find.
-- -----------------------------------------------------------------------------
ALTER TABLE cst_app.conversation_messages
  DROP CONSTRAINT IF EXISTS ck_conversation_messages_attachments_array;

ALTER TABLE cst_app.conversation_messages
  ADD CONSTRAINT ck_conversation_messages_attachments_array
  CHECK (attachments IS NULL OR jsonb_typeof(attachments) = 'array');

-- -----------------------------------------------------------------------------
-- Only the rows that have one are ever looked up by this, so the index covers
-- only those. The overwhelming majority of messages carry no attachment.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_conversation_messages_attachments
  ON cst_app.conversation_messages (conversation_id)
  WHERE attachments IS NOT NULL;

COMMIT;
