-- =============================================================================
-- 0001_cst_core_schema.down.sql
--
-- Rollback for 0001_cst_core_schema.up.sql.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED.
--
-- Drops in reverse dependency order. Every statement is qualified to cst_app;
-- nothing here can reach issue_tracking, poc_listing, or public.
--
-- DESTRUCTIVE: this deletes all Phase 1 application state — conversations,
-- resolved context, and audit history. It is intended for a failed or rejected
-- migration, not for routine use. Take a backup of cst_app first.
--
-- The schema drop uses RESTRICT rather than CASCADE on purpose: if anything
-- unexpected lives in cst_app, this fails loudly instead of destroying it.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.audit_log;
DROP TABLE IF EXISTS cst_app.context_items;
DROP TABLE IF EXISTS cst_app.context_order_candidates;
DROP TABLE IF EXISTS cst_app.context_snapshots;
DROP TABLE IF EXISTS cst_app.sync_state;
DROP TABLE IF EXISTS cst_app.conversation_messages;
DROP TABLE IF EXISTS cst_app.conversations;
DROP TABLE IF EXISTS cst_app.app_users;

DROP SCHEMA IF EXISTS cst_app RESTRICT;

COMMIT;
