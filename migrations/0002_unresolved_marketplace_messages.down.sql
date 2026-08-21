-- =============================================================================
-- 0002_unresolved_marketplace_messages.down.sql
--
-- Rollback for 0002_unresolved_marketplace_messages.up.sql.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED.
--
-- Drops only the object 0002 created. It does NOT drop the cst_app schema and
-- does not touch anything from 0001 — reversing this migration must not take
-- the eBay conversations with it.
--
-- DESTRUCTIVE: deletes every stored unresolved source message. The rows are
-- reconstructible from the read-only source, but the ingestion cursor in
-- cst_app.sync_state is not reset here; clear the relevant feed row separately
-- if a full re-import is intended.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.unresolved_marketplace_messages;

COMMIT;
