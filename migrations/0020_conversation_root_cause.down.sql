-- =============================================================================
-- 0020_conversation_root_cause.down.sql
--
-- Reverses 0020. Drops the table this migration created and nothing else.
--
-- THIS DESTROYS RECORDED WORK, and unlike most of the down migrations in this
-- project that is not a formality. `conversation_root_causes` is append-only and
-- holds decisions a CST agent made by hand — which courier, which kind of
-- problem, and their own account of what happened. None of it exists anywhere
-- else: CST cannot write back to the message application (its credential holds
-- no write privilege), so there is no upstream copy to re-import from.
--
-- Take a dump of the table before running this if any row has been recorded.
--
-- The indexes go with their tables; they are not dropped separately.
--
-- RESTRICT, never CASCADE, exactly as 0011-0019 drop theirs. If something has
-- come to depend on either table since, the rollback must FAIL and be read by a
-- person rather than quietly take the dependant with it.
--
-- ---------------------------------------------------------------------------
-- CHILD FIRST, AND THE ORDER IS NOT COSMETIC
-- ---------------------------------------------------------------------------
-- `conversation_root_cause_labels` holds a foreign key into
-- `conversation_root_causes`. Under RESTRICT, dropping the parent while the
-- child still exists FAILS — which is the correct behaviour and exactly why
-- CASCADE is not used, but it would also make this file unrunnable if the
-- statements were the other way round. The child goes first so the rollback
-- completes; the RESTRICT still protects against any OTHER dependant that has
-- appeared since.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.conversation_root_cause_labels RESTRICT;

DROP TABLE IF EXISTS cst_app.conversation_root_causes RESTRICT;

COMMIT;
