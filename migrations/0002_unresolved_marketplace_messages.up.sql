-- =============================================================================
-- 0002_unresolved_marketplace_messages.up.sql
--
-- Storage for source messages whose DIRECTION, CUSTOMER IDENTITY and
-- CONVERSATION GROUPING are not verified.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED. Awaiting review.
--
-- WHY THE EXISTING TABLES CANNOT CARRY THIS DATA
--
--   cst_app.conversation_messages.direction
--     text NOT NULL, CHECK (direction IN ('inbound','outbound'))
--     Both permitted values are assertions about which way a message travelled.
--     A source that does not record direction has no truthful value to write.
--     Choosing 'inbound' as a fallback would print a guess as a stored fact on
--     every row, and every consumer downstream — the conversation view, the
--     inbound/outbound counts, any future draft grounding — would read it as
--     verified. Choosing 'outbound' would be the same error in the other
--     direction, and would additionally fabricate CST replies that were never
--     sent.
--
--   cst_app.conversations.counterparty_ref
--     text NOT NULL
--     Identifying the counterparty presupposes knowing which party is the
--     customer, which presupposes direction. There is nothing truthful to write.
--
--   cst_app.conversations.thread_key / threading_rule_version
--     text NOT NULL, unique together
--     Every row in that table asserts a grouping produced by a named rule. For
--     an unverified source there is no rule to name; a one-row-per-message
--     "thread" would still assert, structurally, that grouping was performed
--     and yielded singletons.
--
--   cst_app.conversation_messages.conversation_id
--     bigint NOT NULL, FK to cst_app.conversations
--     A message cannot be stored there at all without first asserting a
--     conversation for it.
--
-- Widening the direction CHECK to allow 'unknown' was considered and rejected.
-- It would place unverified rows in the same table the conversation view reads,
-- so every existing and future consumer would have to remember to exclude them;
-- one that forgets renders an unverified message as a customer message. A
-- separate table makes that failure impossible rather than merely discouraged.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HAVE
--   no direction column          — nothing to guess with
--   no counterparty column       — no fabricated customer identity
--   no conversation_id/thread    — no fabricated grouping
--   no workflow state            — an unverified message is not review work yet
--   no send/outbound structure   — this phase transmits nothing
--
-- SAFETY CONTRACT
--   * Creates and touches objects in cst_app and nowhere else.
--   * Does NOT reference, read, or ALTER issue_tracking, poc_listing, or public.
--   * Does NOT alter any object created by 0001. Existing eBay rows are
--     untouched: this migration is purely additive.
--   * Never targets the live source database, which is strictly read-only.
--   * No functions or triggers are created.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- unresolved_marketplace_messages
--
-- One row per source message, standing alone. Marketplace-neutral: any source
-- whose direction is unproven belongs here, not Shopify specifically.
--
-- IDEMPOTENT IMPORT: uniqueness is on the full source identity
-- (source_database, source_schema, source_table, source_pk), matching the rule
-- already used by conversation_messages. Re-running an import can therefore
-- never duplicate a source row, regardless of window overlap.
--
-- TIMEZONE RULE: identical to conversation_messages, and for the same reason.
--   source_ts       : the naive source value, copied EXACTLY. Never rewritten.
--   source_ts_utc   : nullable, populated only once the zone is confirmed.
--   source_ts_zone  : the IANA zone that justified that conversion.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.unresolved_marketplace_messages (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  marketplace         text        NOT NULL,

  source_database     text        NOT NULL,
  source_schema       text        NOT NULL,
  source_table        text        NOT NULL,
  source_pk           text        NOT NULL,
  external_message_id text,

  -- Nullable, unlike conversations.sub_source_id: nothing here depends on
  -- attributing the message to an account, so a missing value is recorded as
  -- missing rather than making the row unstorable.
  sub_source_id       integer,

  source_ts           timestamp   NOT NULL,
  source_ts_utc       timestamptz,
  source_ts_zone      text,

  body_text           text,
  body_decode_status  text        NOT NULL DEFAULT 'decoded',

  -- An opaque reference the source recorded alongside the message. Traceability
  -- only. In a source of unproven provenance its meaning is unproven too, so no
  -- business fact may be derived from it.
  source_reference    text,

  ingested_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_unresolved_messages_marketplace
    CHECK (marketplace IN ('ebay', 'amazon', 'shopify', 'bandq', 'temu')),

  CONSTRAINT ck_unresolved_messages_decode_status
    CHECK (body_decode_status IN ('decoded', 'empty', 'failed')),

  CONSTRAINT ck_unresolved_messages_normalised_ts_pair
    CHECK ((source_ts_utc IS NULL) = (source_ts_zone IS NULL))
);

COMMENT ON TABLE cst_app.unresolved_marketplace_messages IS
  'Source messages with unverified direction, identity and grouping. Has no direction, counterparty or thread column by design.';
COMMENT ON COLUMN cst_app.unresolved_marketplace_messages.source_ts IS
  'Naive source timestamp, copied verbatim. Authoritative for ordering. Never converted in place.';
COMMENT ON COLUMN cst_app.unresolved_marketplace_messages.source_reference IS
  'Opaque source reference. Traceability only; never a resolved order.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_unresolved_messages_source_identity
  ON cst_app.unresolved_marketplace_messages
     (source_database, source_schema, source_table, source_pk);

-- Feed order: newest first per marketplace, source PK as a stable tiebreaker.
CREATE INDEX IF NOT EXISTS ix_unresolved_messages_feed
  ON cst_app.unresolved_marketplace_messages (marketplace, source_ts DESC, id DESC);

COMMIT;
