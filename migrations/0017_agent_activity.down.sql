-- =============================================================================
-- 0017_agent_activity.down.sql
--
-- Reverses 0017. DESTRUCTIVE: it deletes every imported record of which agent
-- did what. It exists for a rejected migration, not for routine use.
--
-- WHAT IT COSTS, honestly. Nothing irreplaceable: every row is a projection of a
-- `message_app.message_app_logs` row that stays exactly where it was, and the
-- importer can rebuild the table from source. No original record of anybody's
-- work is destroyed by this rollback.
--
-- WHAT IT DOES COST is the resolved link. The conversation each action was
-- matched to was computed through a three-hop join across two databases; that
-- work is thrown away here and has to be redone. That is a rebuild cost, not a
-- data loss.
--
-- Drops the ONE table 0017 created and nothing else. All three indexes belong to
-- that table and go with it; naming them again here would be a second place to
-- keep in step.
--
-- RESTRICT, never CASCADE, so an unexpected dependant — a view or a foreign key
-- somebody added later — fails the rollback loudly instead of being destroyed by
-- it.
--
-- WHAT THIS DOES NOT TOUCH, deliberately and by name:
--   * cst_app.conversations. This table references conversations and owns
--     nothing they depend on, so removing it leaves them exactly as they were.
--   * cst_app.app_users, and the four always-NULL attribution columns
--     (`draft_revisions.created_by_user_id`, `context_snapshots
--     .confirmed_by_user_id`, `internal_notes.author_user_id`,
--     `audit_log.actor_user_id`). 0017 never wrote to any of them; they are as
--     empty after this rollback as they were before it.
--   * cst_app.agent_directory, if 0018 has been applied. It is a separate
--     migration with a separate decision behind it, and this table holds no
--     foreign key to it.
--   * cst_app.sync_state. If an activity feed row was written there it is a
--     cursor, not schema.
--   * Everything 0001-0016 created.
--   * The live source databases — `ledsone`, `message_app` and
--     `order_management` — which are strictly read-only and appear in no
--     migration in any form.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.agent_activity RESTRICT;

COMMIT;
