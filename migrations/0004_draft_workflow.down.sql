-- =============================================================================
-- 0004_draft_workflow.down.sql
--
-- Rollback for 0004_draft_workflow.up.sql.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED.
--
-- Drops only what 0004 created, in reverse dependency order. It does NOT drop
-- the cst_app schema and touches nothing from 0001-0003, so reversing this
-- leaves conversations, messages and their context intact.
--
-- DESTRUCTIVE: deletes every draft and its revision history. Drafts are human
-- work product and are not reconstructible from the source. Take a backup of
-- cst_app before running this.
--
-- Conversations left in 'drafting' or 'pending_review' keep that state. They
-- are not rewritten here: silently moving a conversation back to 'received'
-- would erase the fact that somebody had already started on it.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.draft_revision_sources;
DROP TABLE IF EXISTS cst_app.draft_revisions;
DROP TABLE IF EXISTS cst_app.draft_replies;

COMMIT;
