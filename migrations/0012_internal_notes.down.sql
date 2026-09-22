-- =============================================================================
-- 0012_internal_notes.down.sql
--
-- Reverses 0012. DESTRUCTIVE: it deletes every internal note CST staff have
-- written. Those notes are the only record of a case's progress this
-- application holds — nothing reconstructs them, because they were never in
-- the source database. This exists for a rejected migration, not for routine
-- use.
--
-- Drops the one table 0012 created and nothing else. The cst_app schema and
-- everything 0001-0011 created are left untouched, including the conversation
-- it referenced: a foreign key does not own the table it points at. RESTRICT,
-- never CASCADE, so an unexpected dependant fails the rollback loudly instead
-- of being destroyed by it.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.internal_notes RESTRICT;

COMMIT;
