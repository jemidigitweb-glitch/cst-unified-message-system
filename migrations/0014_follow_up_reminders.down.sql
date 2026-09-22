-- =============================================================================
-- 0014_follow_up_reminders.down.sql
--
-- Reverses 0014. DESTRUCTIVE: it deletes every stored follow-up reminder, which
-- means every promise CST recorded about when it would come back to a customer.
-- It exists for a rejected migration, not for routine use.
--
-- Drops the ONE table 0014 created and nothing else. Both indexes belong to
-- that table and go with it; no separate DROP INDEX is needed or wanted, since
-- naming them again here would be a second place to keep in step.
--
-- RESTRICT, never CASCADE, so an unexpected dependant — a view or a foreign key
-- somebody added later — fails the rollback loudly instead of being destroyed
-- by it.
--
-- WHAT THIS DOES NOT TOUCH, deliberately and by name:
--   * cst_app.conversations and everything 0001-0013 created. This table
--     references conversations and owns nothing they depend on, so removing it
--     leaves them exactly as they were.
--   * cst_app.internal_notes, which 0014 never created, never altered and never
--     read. It exists in the live database without a migration in this
--     repository; a rollback of an unrelated feature is not the place to form
--     an opinion about it.
--   * The live source database, which is strictly read-only and appears in no
--     migration in any form.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.follow_up_reminders RESTRICT;

COMMIT;
