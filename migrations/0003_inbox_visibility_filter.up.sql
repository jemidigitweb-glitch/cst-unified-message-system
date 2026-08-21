-- =============================================================================
-- 0003_inbox_visibility_filter.up.sql
--
-- Lets a conversation be stored and threaded but kept OUT of the reply inbox.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED. Awaiting review.
--
-- WHY THIS IS REQUIRED
--
--   The Shopify mailbox is shared. Of the inbound messages in the loaded month,
--   42% are not customer contact: 240 bounces of our own outbound mail, 602
--   notices from other sales channels, 239 platform and app alerts, 191 courier
--   notifications, and roughly 918 unsolicited supplier and sales approaches.
--   Left unfiltered they bury the ~3,000 real customer messages.
--
--   Filtering has to be decided at INGEST, because the fields it rests on —
--   sender domain, recipient domain, subject line — live in the source and are
--   deliberately never copied into cst_app. Nothing currently in this schema
--   could drive a read-side filter, so the decision has to be stored.
--
--   `conversations.inbox_visibility` already exists and already gates the inbox
--   query, but its CHECK admits only 'reply_inbox' and 'outbound_only'. Neither
--   fits: a courier notification HAS a customer-side message, so calling it
--   'outbound_only' would be false, and 'reply_inbox' is what we are avoiding.
--
-- WHAT THIS IS NOT
--
--   Not a delete, and not a soft delete. A filtered conversation keeps every
--   message, its verified direction and its threading. Only its inbox
--   membership changes, and `inbox_filter_reason` records why, so what was
--   hidden can always be listed, audited, and un-hidden by re-running ingest
--   with a different rule.
--
-- SAFETY CONTRACT
--   * Touches cst_app.conversations and nothing else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--   * Adds no send/outbound/transmission structure.
--   * Deletes no row and drops no column.
--   * Runs in one transaction; re-runnable.
--
-- NOTE: unlike 0002 this is NOT purely additive — it replaces one CHECK
-- constraint on a table created by 0001. The replacement only widens what is
-- permitted, so every existing row remains valid; no row is read or rewritten.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Widen inbox_visibility to admit a filtered conversation.
--
-- Widening only. 'reply_inbox' and 'outbound_only' keep their exact meaning, so
-- existing rows satisfy the new constraint unchanged.
-- -----------------------------------------------------------------------------
ALTER TABLE cst_app.conversations
  DROP CONSTRAINT IF EXISTS ck_conversations_inbox_visibility;

ALTER TABLE cst_app.conversations
  ADD CONSTRAINT ck_conversations_inbox_visibility
  CHECK (inbox_visibility IN ('reply_inbox', 'outbound_only', 'filtered'));


-- -----------------------------------------------------------------------------
-- 2. Record why.
--
-- A hidden conversation that cannot say why it is hidden is indistinguishable
-- from one lost to a bug. The paired CHECK keeps the two columns honest in both
-- directions: a filtered conversation must carry a reason, and a visible one
-- must not carry a stale reason from an earlier rule version.
-- -----------------------------------------------------------------------------
ALTER TABLE cst_app.conversations
  ADD COLUMN IF NOT EXISTS inbox_filter_reason text;

COMMENT ON COLUMN cst_app.conversations.inbox_filter_reason IS
  'Why this conversation is kept out of the reply inbox. NULL unless inbox_visibility = filtered. Never a reason to delete it.';

ALTER TABLE cst_app.conversations
  DROP CONSTRAINT IF EXISTS ck_conversations_filter_reason_pair;

ALTER TABLE cst_app.conversations
  ADD CONSTRAINT ck_conversations_filter_reason_pair
  CHECK ((inbox_visibility = 'filtered') = (inbox_filter_reason IS NOT NULL));


-- -----------------------------------------------------------------------------
-- 3. Keep the inbox query fast now that it excludes a large filtered set.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_conversations_marketplace_inbox
  ON cst_app.conversations (marketplace, inbox_visibility, last_source_ts DESC);

COMMIT;
