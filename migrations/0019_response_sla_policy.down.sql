-- =============================================================================
-- 0019_response_sla_policy.down.sql
--
-- Reverses 0019. Drops the local copy of the response-time policy.
--
-- NON-DESTRUCTIVE, and for once that claim needs no qualification. Every row is
-- an eight-column copy of a row in `message_app.sla_configs`, rebuildable in
-- full by re-running `scripts/import-sla-policy.mjs` at a cost of three queries
-- against the source. Nothing authored, decided or observed by a person is
-- stored here — the policy was decided in another system on 2026-04-15, and
-- this table has never been the authority for it.
--
-- WHAT BREAKS AFTERWARDS: nothing that is running today. At the time this
-- migration was written, no code path reads `response_sla_policy` — the SLA
-- performance tile is still `unavailable`, and no compliance percentage is
-- computed from these rows by anything. A reader added later degrades to
-- "no approved target" for every conversation, which is the same honest state
-- B&Q, Temu and five Shopify accounts are in with the table present.
--
-- Drops the ONE table 0019 created and nothing else. Both its indexes belong to
-- that table and go with it.
--
-- RESTRICT, never CASCADE, so an unexpected dependant — a view, or a foreign
-- key somebody added later — fails the rollback loudly instead of being
-- destroyed by it.
--
-- WHAT THIS DOES NOT TOUCH, deliberately and by name:
--   * cst_app.conversations and cst_app.conversation_messages. No row of either
--     was read, written or referenced by 0019, and `sub_source_id` is matched
--     logically with no foreign key precisely so this rollback cannot reach a
--     conversation.
--   * lib/domain/response-sla.ts and RESPONSE_SLA_MINUTES. CST's own 24-hour
--     rule is application code, was never moved into this table, and is
--     unaffected in both directions.
--   * Everything 0001-0018 created.
--   * The live source databases — `ledsone`, `message_app` and
--     `order_management` — which are strictly read-only and appear in no
--     migration in any form. In particular this drops a COPY of the policy and
--     never the policy.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS cst_app.response_sla_policy RESTRICT;

COMMIT;
