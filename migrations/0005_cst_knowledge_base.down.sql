-- =============================================================================
-- 0005_cst_knowledge_base.down.sql
--
-- Rollback for 0005_cst_knowledge_base.up.sql.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED.
--
-- Drops only what 0005 created, in reverse dependency order. It does NOT drop the
-- cst_app schema and touches nothing from 0001-0004, so reversing this leaves
-- conversations, messages, context and drafts intact.
--
-- DESTRUCTIVE: deletes the CST rule corpus, its examples and its triggers.
-- Re-importable from the source documents, but every draft citation recorded in
-- cst_app.draft_revision_sources becomes unresolvable until it is — the citation
-- rows survive (they hold references, not rule text) and will point at rule ids
-- that no longer exist. Take a backup of cst_app before running this.
--
-- No DROP ... CASCADE. Each table names itself, in an order that satisfies its
-- own foreign keys, so an unexpected dependant fails the migration loudly
-- instead of being destroyed quietly.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.cst_rule_triggers;
DROP TABLE IF EXISTS cst_app.cst_rule_examples;
DROP TABLE IF EXISTS cst_app.cst_rules;
DROP TABLE IF EXISTS cst_app.cst_rule_categories;
DROP TABLE IF EXISTS cst_app.cst_knowledge_sources;

COMMIT;
