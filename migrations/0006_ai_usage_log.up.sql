-- =============================================================================
-- 0006_ai_usage_log.up.sql
--
-- Records what each AI draft generation consumed.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED. Awaiting review.
--
-- WHY THIS IS REQUIRED
--
--   Nothing in this system currently records what a draft cost. The only
--   evidence a generation happened at all is a draft revision, which says
--   nothing about tokens, and the free-tier limit has already been hit
--   repeatedly without anyone being able to answer "how many, and how big".
--   A per-call record turns that from a guess into a query.
--
--   It also makes accidental repeat generation VISIBLE. A loop that quietly
--   burns the quota looks identical to normal use until the bill or the 429
--   arrives; two rows a second against one conversation does not.
--
-- WHAT IS AND IS NOT STORED
--
--   Stored: provider, model, token counts, an estimated cost, the conversation
--   and draft revision it belongs to, and when it happened.
--
--   NOT stored: the prompt, the reply, the retrieved rules, or any customer
--   text. This table is an accounting record. Nothing in it should ever need
--   redacting, and a leak of it would disclose usage volumes and nothing else.
--
--   Token columns are NULLABLE on purpose. A provider that does not report
--   usage records the call with unknown counts rather than a fabricated zero —
--   a zero would silently understate consumption in exactly the situation where
--   the number matters.
--
-- COST IS AN ESTIMATE AND SAYS SO
--
--   `estimated_cost_usd` is computed by the application from a rate table it
--   holds, not billed by the provider. Prices change and the column name is
--   deliberately blunt about that. It is for spotting a runaway, not for
--   reconciling an invoice.
--
-- SAFETY CONTRACT
--   * Creates one table in cst_app and nothing else.
--   * Purely additive: no existing table, column or constraint is touched.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--   * Adds no send/outbound/transmission structure.
--   * Deletes no row and drops no column.
--   * Runs in one transaction; re-runnable.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cst_app.ai_usage_log (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Which model answered. Both recorded: the provider alone cannot price a
  -- call, and the model alone does not say who billed for it.
  provider           text        NOT NULL,
  model              text        NOT NULL,

  -- What it belongs to. The conversation is required — a generation always has
  -- one. The revision is nullable because a call that FAILED produced no
  -- revision, and those are the ones most worth counting.
  conversation_id    bigint      NOT NULL,
  draft_revision_id  bigint,

  -- NULL means the provider did not report it, never "none were used".
  input_tokens       integer,
  output_tokens      integer,
  total_tokens       integer,

  -- Application's own estimate from a local rate table. Not an invoice.
  estimated_cost_usd numeric(12, 6),

  -- 'ok' or a short failure reason, so failed calls can be counted separately.
  outcome            text        NOT NULL DEFAULT 'ok',

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_ai_usage_log_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  -- SET NULL, not CASCADE: deleting a draft must not erase the record that it
  -- cost something. The spend happened whether or not the output was kept.
  CONSTRAINT fk_ai_usage_log_revision
    FOREIGN KEY (draft_revision_id) REFERENCES cst_app.draft_revisions (id) ON DELETE SET NULL,

  CONSTRAINT ck_ai_usage_log_provider
    CHECK (provider IN ('openai', 'gemini')),

  CONSTRAINT ck_ai_usage_log_model_present
    CHECK (length(btrim(model)) > 0),

  CONSTRAINT ck_ai_usage_log_tokens_non_negative
    CHECK (
      (input_tokens  IS NULL OR input_tokens  >= 0) AND
      (output_tokens IS NULL OR output_tokens >= 0) AND
      (total_tokens  IS NULL OR total_tokens  >= 0)
    ),

  CONSTRAINT ck_ai_usage_log_cost_non_negative
    CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0)
);

COMMENT ON TABLE cst_app.ai_usage_log IS
  'One row per AI draft generation attempt. Accounting only: no prompt, reply, rule text or customer data.';

COMMENT ON COLUMN cst_app.ai_usage_log.estimated_cost_usd IS
  'Application estimate from a local rate table, NOT a provider invoice. For spotting runaway usage.';

COMMENT ON COLUMN cst_app.ai_usage_log.draft_revision_id IS
  'NULL when the call failed and produced no revision. Those calls still cost money and are still recorded.';

-- -----------------------------------------------------------------------------
-- Serves the two questions this table exists to answer: what has this
-- conversation cost, and what has been spent recently.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_ai_usage_log_conversation
  ON cst_app.ai_usage_log (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_ai_usage_log_recent
  ON cst_app.ai_usage_log (created_at DESC);

COMMIT;
