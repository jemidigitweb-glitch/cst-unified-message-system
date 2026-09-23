-- =============================================================================
-- 0016_conversation_message_media.down.sql
--
-- Reverses 0016. DESTRUCTIVE: it deletes every recorded message image link.
-- It exists for a rejected migration, not for routine use.
--
-- WHAT IT COSTS, honestly. Nothing irreplaceable: every row is a copy of a
-- `message_app.files` row that stays exactly where it was, and the importer can
-- rebuild the table from source. No image is destroyed by this rollback,
-- because no image was ever stored here — only a URL pointing at storage
-- somebody else runs.
--
-- Drops the ONE table 0016 created and nothing else. All three indexes belong to
-- that table and go with it; naming them again here would be a second place to
-- keep in step.
--
-- RESTRICT, never CASCADE, so an unexpected dependant — a view or a foreign key
-- somebody added later — fails the rollback loudly instead of being destroyed by
-- it.
--
-- WHAT THIS DOES NOT TOUCH, deliberately and by name:
--   * cst_app.conversation_messages.attachments, its CHECK and its index. That
--     column is 0007's, it carries Shopify and B&Q attachments today, and 0016
--     never read, wrote or altered it. Rolling back eBay media must not disturb
--     the marketplaces that were already working.
--   * cst_app.conversation_messages and cst_app.conversations. This table
--     references messages and owns nothing they depend on, so removing it leaves
--     them exactly as they were.
--   * cst_app.sync_state. If a media feed row was written there it is a cursor,
--     not schema; deleting it is an operational decision for whoever rolls back,
--     not something a schema rollback should do silently.
--   * Everything 0001-0015 created.
--   * The live source databases — `ledsone`, `message_app` and
--     `order_management` — which are strictly read-only and appear in no
--     migration in any form.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.conversation_message_media RESTRICT;

COMMIT;
