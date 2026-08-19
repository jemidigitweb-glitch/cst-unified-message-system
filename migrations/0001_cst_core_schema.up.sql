-- =============================================================================
-- 0001_cst_core_schema.up.sql
--
-- CST Unified Message System — core application schema.
-- Covers: Live Message -> Thread -> Verify Context.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED. Awaiting GPT Project review.
--
-- SAFETY CONTRACT
--   * Creates and touches objects in cst_app and nowhere else.
--   * Does NOT reference, read, or ALTER issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--   * Contains no send/outbound/transmission structure. The workflow terminates
--     at 'reviewed'; there is no state, table, column, or trigger after it.
--   * No functions or triggers are created at all.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
--
-- Deferred to the Day-2 migration: drafts, draft revisions, AI run metadata,
-- knowledge sources and citations. The CST knowledge authority is not settled,
-- so nothing here encodes rule content or OpenAI/vector-store identifiers.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS cst_app;

COMMENT ON SCHEMA cst_app IS
  'CST Unified Marketplace Message System application state and workflow data. Owns nothing outside itself.';


-- -----------------------------------------------------------------------------
-- 1. app_users
--
-- CST-specific user metadata. `management_user_id` is a LOGICAL reference to
-- issue_tracking.management_users — deliberately NOT a foreign key. A real FK
-- would couple this project's uptime and migrations to an unrelated project's
-- schema, and would require adding CST roles to that table's role CHECK, which
-- we must not do. Authentication reads that table; ownership stays separate.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.app_users (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  management_user_id bigint,
  display_name       text        NOT NULL,
  cst_role           text        NOT NULL DEFAULT 'agent',
  active             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_app_users_cst_role
    CHECK (cst_role IN ('agent', 'reviewer', 'admin')),
  CONSTRAINT ck_app_users_display_name_present
    CHECK (length(btrim(display_name)) > 0)
);

COMMENT ON COLUMN cst_app.app_users.management_user_id IS
  'Logical reference to issue_tracking.management_users.user_id. Intentionally not an FK.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_management_user_id
  ON cst_app.app_users (management_user_id)
  WHERE management_user_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 2. conversations
--
-- One row per DERIVED conversation. No marketplace source exposes a thread id,
-- so `thread_key` is computed and stamped with the rule version that produced
-- it. Uniqueness on (threading_rule_version, thread_key) lets a future rule
-- version regenerate threads alongside the current ones instead of colliding
-- with them, which keeps regeneration deterministic and idempotent.
--
-- Marketplace-neutral by construction: no eBay column, table, or encoding
-- appears here. `listing_item_ref` and `counterparty_ref` are opaque strings
-- whose meaning is owned by the marketplace adapter.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.conversations (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  marketplace             text        NOT NULL,
  sub_source_id           integer     NOT NULL,

  thread_key              text        NOT NULL,
  threading_rule_version  text        NOT NULL,
  threading_strategy      text        NOT NULL,

  -- Optional: no-item conversations are first-class and must not be forced to
  -- carry a listing reference.
  listing_item_ref        text,
  counterparty_ref        text        NOT NULL,

  -- Naive source timestamps, preserved exactly. See conversation_messages for
  -- the full timezone rationale.
  first_source_ts         timestamp   NOT NULL,
  last_source_ts          timestamp   NOT NULL,

  workflow_state          text        NOT NULL DEFAULT 'received',
  needs_context           boolean     NOT NULL DEFAULT false,
  inbox_visibility        text        NOT NULL DEFAULT 'reply_inbox',

  message_count           integer     NOT NULL DEFAULT 0,
  inbound_count           integer     NOT NULL DEFAULT 0,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- Phase 1 workflow. These four states are exhaustive: 'reviewed' is terminal
  -- and there is deliberately no 'approved', 'sending', 'sent', or
  -- 'manual_handoff'. Adding one would require adding a transport.
  CONSTRAINT ck_conversations_workflow_state
    CHECK (workflow_state IN ('received', 'drafting', 'pending_review', 'reviewed')),

  CONSTRAINT ck_conversations_marketplace
    CHECK (marketplace IN ('ebay', 'amazon', 'shopify', 'bandq', 'temu')),

  CONSTRAINT ck_conversations_threading_strategy
    CHECK (threading_strategy IN ('item_linked', 'no_item')),

  -- Outbound-only groups have no customer message to answer, so they are kept
  -- out of the reply inbox but remain visible in a read-only view.
  CONSTRAINT ck_conversations_inbox_visibility
    CHECK (inbox_visibility IN ('reply_inbox', 'outbound_only')),

  CONSTRAINT ck_conversations_item_linked_has_listing
    CHECK (threading_strategy <> 'item_linked' OR listing_item_ref IS NOT NULL),

  CONSTRAINT ck_conversations_reply_inbox_needs_inbound
    CHECK (inbox_visibility <> 'reply_inbox' OR inbound_count >= 1),

  CONSTRAINT ck_conversations_timespan
    CHECK (last_source_ts >= first_source_ts),

  CONSTRAINT ck_conversations_counts_non_negative
    CHECK (message_count >= 0 AND inbound_count >= 0 AND inbound_count <= message_count)
);

COMMENT ON TABLE cst_app.conversations IS
  'Derived conversations. thread_key is computed, never sourced; see threading_rule_version.';
COMMENT ON COLUMN cst_app.conversations.first_source_ts IS
  'Naive source timestamp preserved verbatim. NOT converted; timezone unconfirmed.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_rule_thread_key
  ON cst_app.conversations (threading_rule_version, thread_key);

CREATE INDEX IF NOT EXISTS ix_conversations_inbox
  ON cst_app.conversations (inbox_visibility, workflow_state, last_source_ts DESC);

CREATE INDEX IF NOT EXISTS ix_conversations_marketplace_sub_source
  ON cst_app.conversations (marketplace, sub_source_id, last_source_ts DESC);

CREATE INDEX IF NOT EXISTS ix_conversations_needs_context
  ON cst_app.conversations (needs_context)
  WHERE needs_context;


-- -----------------------------------------------------------------------------
-- 3. conversation_messages
--
-- Projection of live source rows. The source stays authoritative; this is a
-- local reference so the UI does not re-query the read-only source per render.
--
-- IDEMPOTENT SYNC: uniqueness is on the full source identity
-- (source_database, source_schema, source_table, source_pk). Re-running a sync
-- can therefore never duplicate a source row, regardless of watermark overlap.
-- external_message_id is recorded for traceability but is NOT the identity —
-- it is nullable and not guaranteed unique across marketplaces.
--
-- TIMEZONE RULE (deliberate, do not "simplify"):
--   Every source timestamp column is `timestamp without time zone`. Day 1
--   evidence points strongly to UTC, but the ingestion owner has not confirmed
--   it, and the source server runs Europe/Berlin — so an implicit cast to
--   timestamptz would silently shift every message by +2h.
--
--   source_ts        : the naive value, copied EXACTLY. Never rewritten.
--   source_ts_utc    : nullable, populated only once the zone is confirmed.
--   source_ts_zone   : the IANA zone that justified that conversion.
--   A CHECK keeps the normalised pair honest: you cannot record a converted
--   timestamp without recording what you assumed to produce it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.conversation_messages (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id     bigint      NOT NULL,

  source_database     text        NOT NULL,
  source_schema       text        NOT NULL,
  source_table        text        NOT NULL,
  source_pk           text        NOT NULL,
  external_message_id text,

  direction           text        NOT NULL,

  source_ts           timestamp   NOT NULL,
  source_ts_utc       timestamptz,
  source_ts_zone      text,

  body_text           text,
  body_decode_status  text        NOT NULL DEFAULT 'decoded',

  ingested_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_conversation_messages_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  CONSTRAINT ck_conversation_messages_direction
    CHECK (direction IN ('inbound', 'outbound')),

  CONSTRAINT ck_conversation_messages_decode_status
    CHECK (body_decode_status IN ('decoded', 'empty', 'failed')),

  CONSTRAINT ck_conversation_messages_normalised_ts_pair
    CHECK ((source_ts_utc IS NULL) = (source_ts_zone IS NULL))
);

COMMENT ON COLUMN cst_app.conversation_messages.source_ts IS
  'Naive source timestamp, copied verbatim. Authoritative for ordering. Never converted in place.';
COMMENT ON COLUMN cst_app.conversation_messages.source_ts_utc IS
  'Normalised timestamp. NULL until the ingestion owner confirms the source timezone.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_messages_source_identity
  ON cst_app.conversation_messages (source_database, source_schema, source_table, source_pk);

-- Thread render order: source timestamp first, source PK only as tiebreaker.
CREATE INDEX IF NOT EXISTS ix_conversation_messages_thread_order
  ON cst_app.conversation_messages (conversation_id, source_ts, source_pk);


-- -----------------------------------------------------------------------------
-- 4. sync_state
--
-- Per-feed cursor for incremental reads. The watermark is a (timestamp, pk)
-- pair because the source timestamp is not unique — the PK breaks ties so a
-- resumed sync cannot skip rows sharing a second.
--
-- No background worker is created here; this is state only.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.sync_state (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  marketplace           text        NOT NULL,
  feed_key              text        NOT NULL,

  watermark_source_ts   timestamp,
  watermark_source_pk   text,

  last_run_at           timestamptz,
  last_success_at       timestamptz,
  last_status           text        NOT NULL DEFAULT 'never_run',
  last_error            text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_sync_state_marketplace
    CHECK (marketplace IN ('ebay', 'amazon', 'shopify', 'bandq', 'temu')),

  CONSTRAINT ck_sync_state_last_status
    CHECK (last_status IN ('never_run', 'ok', 'error')),

  CONSTRAINT ck_sync_state_error_detail
    CHECK (last_status <> 'error' OR last_error IS NOT NULL)
);

COMMENT ON COLUMN cst_app.sync_state.watermark_source_ts IS
  'Naive source timestamp watermark. Same preservation rule as conversation_messages.source_ts.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_state_feed
  ON cst_app.sync_state (marketplace, feed_key);


-- -----------------------------------------------------------------------------
-- 5. context_snapshots
--
-- The verified business context behind a conversation, one current row each.
--
-- LOGICAL ORDER IDENTITY: (sub_source_id, order_number). Day 1 proved a single
-- marketplace order can span several physical order rows — status/lifecycle
-- versions, warehouse splits, re-imports — and that picking one physical row
-- discards 42.6% of the order items in the affected groups. So the physical
-- row ids are carried in `source_order_row_ids` for traceability ONLY; they are
-- never the business identity, and no row-picking rule is encoded here.
--
-- 'no_order' is a legitimate, common outcome (pre-sales enquiries). Nothing in
-- this table forces an order onto a conversation.
--
-- 'ambiguous' means several genuine purchases matched. The order columns stay
-- NULL and the candidates live in context_order_candidates until a human picks.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.context_snapshots (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id       bigint      NOT NULL,

  resolution            text        NOT NULL,

  -- Logical marketplace-order identity. NULL unless resolution = 'single_order'.
  sub_source_id         integer,
  order_number          text,
  order_date            timestamp,
  order_status_summary  text,

  -- Physical member rows behind the logical order. Traceability/audit only.
  source_order_row_ids  bigint[]    NOT NULL DEFAULT '{}',

  listing_item_ref      text,
  listing_url           text,

  -- Provenance: how this context was established, and by whom when a human
  -- chose among genuine candidates.
  verification_method   text        NOT NULL DEFAULT 'none',
  confirmed_by_user_id  bigint,
  confirmed_at          timestamptz,

  resolved_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_context_snapshots_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  CONSTRAINT fk_context_snapshots_confirmed_by
    FOREIGN KEY (confirmed_by_user_id) REFERENCES cst_app.app_users (id) ON DELETE SET NULL,

  CONSTRAINT ck_context_snapshots_resolution
    CHECK (resolution IN ('single_order', 'no_order', 'ambiguous', 'needs_context', 'terminated_order')),

  CONSTRAINT ck_context_snapshots_verification_method
    CHECK (verification_method IN ('none', 'deterministic_single', 'user_confirmed')),

  -- A resolved order requires a full logical identity.
  CONSTRAINT ck_context_snapshots_order_identity_complete
    CHECK (
      resolution NOT IN ('single_order', 'terminated_order')
      OR (sub_source_id IS NOT NULL AND order_number IS NOT NULL)
    ),

  -- An unresolved context must NOT carry an order. This is what stops an
  -- ambiguous conversation from quietly acquiring one.
  CONSTRAINT ck_context_snapshots_unresolved_has_no_order
    CHECK (
      resolution NOT IN ('no_order', 'ambiguous', 'needs_context')
      OR (sub_source_id IS NULL AND order_number IS NULL AND order_date IS NULL)
    ),

  -- A user-confirmed context must name the user; an unconfirmed one must not.
  CONSTRAINT ck_context_snapshots_confirmation_pair
    CHECK (
      (verification_method = 'user_confirmed')
      = (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)
    ),

  -- Unresolved contexts cannot claim a verification method.
  CONSTRAINT ck_context_snapshots_unresolved_not_verified
    CHECK (
      resolution NOT IN ('no_order', 'ambiguous', 'needs_context')
      OR verification_method = 'none'
    )
);

COMMENT ON COLUMN cst_app.context_snapshots.source_order_row_ids IS
  'Physical order row ids forming the logical order. Traceability only, never the business identity.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_context_snapshots_conversation
  ON cst_app.context_snapshots (conversation_id);

CREATE INDEX IF NOT EXISTS ix_context_snapshots_logical_order
  ON cst_app.context_snapshots (sub_source_id, order_number)
  WHERE order_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_context_snapshots_resolution
  ON cst_app.context_snapshots (resolution);


-- -----------------------------------------------------------------------------
-- 6. context_order_candidates
--
-- Candidate logical orders for genuinely ambiguous conversations — the ~12% of
-- threads where the same buyer bought the same listing more than once (93% of
-- them on different order dates: real repeat purchasing, not duplicate rows).
--
-- There is deliberately NO `selected` column. Selection is recorded on
-- context_snapshots together with the confirming user, so no process can mark a
-- candidate chosen by being newest, oldest, or closest — there is nowhere to
-- write that. Candidates are presented; a human decides.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.context_order_candidates (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id       bigint      NOT NULL,

  sub_source_id         integer     NOT NULL,
  order_number          text        NOT NULL,
  order_date            timestamp,
  order_status_summary  text,

  source_order_row_ids  bigint[]    NOT NULL DEFAULT '{}',
  item_count            integer     NOT NULL DEFAULT 0,

  listing_item_ref      text,
  listing_url           text,

  discovered_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_context_order_candidates_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  CONSTRAINT ck_context_order_candidates_item_count
    CHECK (item_count >= 0)
);

COMMENT ON TABLE cst_app.context_order_candidates IS
  'Candidate logical orders awaiting CST selection. No selected flag exists by design.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_context_order_candidates_identity
  ON cst_app.context_order_candidates (conversation_id, sub_source_id, order_number);

CREATE INDEX IF NOT EXISTS ix_context_order_candidates_conversation
  ON cst_app.context_order_candidates (conversation_id, order_date DESC);


-- -----------------------------------------------------------------------------
-- 7. context_items
--
-- Every item belonging to the resolved logical order — the UNION across all
-- active member rows, never one physical row's subset.
--
-- EXACT SKU: `exact_sku` stores the source value BYTE-FOR-BYTE. There is no
-- splitting on '+', no trimming, no normalising, no case-folding, no separator
-- parsing, and no combo reconstruction anywhere in this schema. A combo such as
-- 'PSHYOS4BRBM+SPUPBM+LSDO210BM' is one identifier with its own product master
-- row; components are already decomposed upstream in the source.
--
-- Note the CHECK deliberately tests length only, NOT btrim equality: 16 source
-- rows carry legitimately untrimmed SKUs, and rejecting or repairing them would
-- corrupt the source value the database says is correct.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.context_items (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  context_snapshot_id    bigint      NOT NULL,

  exact_sku              text        NOT NULL,
  product_title          text,
  quantity               text,
  image_url              text,

  -- Source identifiers for audit: which order item, on which physical order row.
  source_order_item_id   bigint,
  source_order_row_id    bigint,

  captured_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_context_items_snapshot
    FOREIGN KEY (context_snapshot_id) REFERENCES cst_app.context_snapshots (id) ON DELETE CASCADE,

  CONSTRAINT ck_context_items_exact_sku_present
    CHECK (length(exact_sku) > 0)
);

COMMENT ON COLUMN cst_app.context_items.exact_sku IS
  'Source SKU verbatim. Never split on +, trimmed, normalised, case-folded, or reconstructed.';
COMMENT ON COLUMN cst_app.context_items.quantity IS
  'Text because the source column is character varying. Preserved as-is; not coerced.';

CREATE INDEX IF NOT EXISTS ix_context_items_snapshot
  ON cst_app.context_items (context_snapshot_id);

CREATE INDEX IF NOT EXISTS ix_context_items_exact_sku
  ON cst_app.context_items (exact_sku);


-- -----------------------------------------------------------------------------
-- 8. audit_log
--
-- Append-only history of Day-1 application actions and state changes. Mirrors
-- the *_status_history convention already used in this database.
--
-- Records review workflow only. There are no sending events, because there is
-- no sending.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_user_id  bigint,

  entity_type    text        NOT NULL,
  entity_id      bigint      NOT NULL,
  action         text        NOT NULL,

  from_state     text,
  to_state       text,
  detail         jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_audit_log_actor
    FOREIGN KEY (actor_user_id) REFERENCES cst_app.app_users (id) ON DELETE SET NULL,

  CONSTRAINT ck_audit_log_entity_type
    CHECK (entity_type IN ('conversation', 'context_snapshot', 'app_user', 'sync_state')),

  CONSTRAINT ck_audit_log_action
    CHECK (action IN (
      'conversation_created',
      'conversation_updated',
      'workflow_state_changed',
      'context_resolved',
      'context_confirmed',
      'context_cleared',
      'sync_completed',
      'sync_failed'
    )),

  -- Any workflow state named here must be one of the four Phase 1 states.
  CONSTRAINT ck_audit_log_workflow_states
    CHECK (
      (from_state IS NULL OR from_state IN ('received', 'drafting', 'pending_review', 'reviewed'))
      AND (to_state IS NULL OR to_state IN ('received', 'drafting', 'pending_review', 'reviewed'))
    )
);

CREATE INDEX IF NOT EXISTS ix_audit_log_entity
  ON cst_app.audit_log (entity_type, entity_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ix_audit_log_occurred_at
  ON cst_app.audit_log (occurred_at DESC);

COMMIT;
