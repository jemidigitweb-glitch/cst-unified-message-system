-- =============================================================================
-- 0018_agent_directory.down.sql
--
-- Reverses 0018. Deletes the local display directory of CST agent ids.
--
-- THE LEAST DESTRUCTIVE ROLLBACK IN THIS REPOSITORY, and that is by design.
-- Every row is a five-column copy of a row in the live directory, refreshed on
-- a schedule and rebuildable in full at any time. Nothing authored, decided or
-- observed by a person is stored here, so nothing of that kind can be lost.
--
-- WHAT BREAKS AFTERWARDS, stated so it is not a surprise: `agent_activity`
-- rows keep their `source_user_id` and lose their name. Activity reporting
-- continues, with agents identified by number until this is re-applied. It
-- degrades to less readable, never to wrong or absent.
--
-- Drops the ONE table 0018 created and nothing else. Its unique index belongs
-- to that table and goes with it.
--
-- RESTRICT, never CASCADE, so an unexpected dependant — a view or a foreign key
-- somebody added later — fails the rollback loudly instead of being destroyed
-- by it.
--
-- WHAT THIS DOES NOT TOUCH, deliberately and by name:
--   * cst_app.agent_activity. It holds NO foreign key to this table, precisely
--     so this rollback cannot take the activity record with it. Every row
--     survives with its `source_user_id` intact.
--   * cst_app.app_users. 0018 never created, altered, populated or re-commented
--     it, and a rollback is not the place to form an opinion about a table this
--     migration deliberately left alone.
--   * Everything 0001-0017 created.
--   * The live source databases — `ledsone`, `message_app` and
--     `order_management` — which are strictly read-only and appear in no
--     migration in any form. In particular this drops a COPY of directory rows
--     and never the directory.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.agent_directory RESTRICT;

COMMIT;
