-- =============================================================================
-- 0004_draft_workflow.up.sql
--
-- AI reply drafts, their revision history, and the sources each revision used.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED. Awaiting review.
--
-- This is the "Day-2" migration deferred by 0001: drafts, draft revisions, AI
-- run metadata, and knowledge citations.
--
-- THE WORKFLOW ENDS AT REVIEWED. `cst_app.conversations.workflow_state` already
-- constrains itself to received -> drafting -> pending_review -> reviewed, and
-- nothing here adds a state, column, table or trigger that could follow it.
-- There is no sent_at, no delivery status, no transmission attempt, no queue and
-- no retry counter, because there is no capability to send. Adding one would
-- mean adding a transport.
--
-- GROUNDING IS RECORDED, NOT ASSUMED. Every revision stores what it was allowed
-- to rely on (`draft_revision_sources`) and what it could not establish
-- (`missing_information`). A draft that cites nothing is visibly a draft that
-- cites nothing, rather than one that quietly invented its facts.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--   * Purely additive: alters and drops nothing from 0001-0003.
--   * No functions or triggers.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. draft_replies
--
-- One draft per conversation. A conversation either has a draft in progress or
-- it does not; regenerating produces a new REVISION, never a competing draft,
-- so there is never a question of which one is current.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.draft_replies (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id     bigint      NOT NULL,

  -- Denormalised pointer to the newest revision, so reading the current draft
  -- is one lookup rather than a scan-and-sort of its history.
  current_revision    integer     NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_draft_replies_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  CONSTRAINT ck_draft_replies_current_revision
    CHECK (current_revision >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_replies_conversation
  ON cst_app.draft_replies (conversation_id);


-- -----------------------------------------------------------------------------
-- 2. draft_revisions
--
-- Append-only history. Regeneration and human edits both add a row; nothing is
-- ever updated in place, so the trail of what was proposed, by whom or by what,
-- and what a human changed, stays intact.
--
-- `requires_review` is stored rather than derived. Whether a draft was safe to
-- accept is a property of the moment it was produced — the knowledge corpus and
-- the resolved context both move — so recomputing it later would answer a
-- different question.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.draft_revisions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_reply_id      bigint      NOT NULL,

  revision            integer     NOT NULL,
  origin              text        NOT NULL,

  body_text           text        NOT NULL,

  -- What the generator could not establish. Empty only when nothing was missing.
  missing_information text[]      NOT NULL DEFAULT '{}',
  requires_review     boolean     NOT NULL DEFAULT true,

  -- AI run metadata. NULL for a human edit, which has no model behind it.
  model               text,
  provider_response_id text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  bigint,

  CONSTRAINT fk_draft_revisions_draft
    FOREIGN KEY (draft_reply_id) REFERENCES cst_app.draft_replies (id) ON DELETE CASCADE,

  CONSTRAINT fk_draft_revisions_author
    FOREIGN KEY (created_by_user_id) REFERENCES cst_app.app_users (id) ON DELETE SET NULL,

  -- Two origins, exhaustively. There is deliberately no 'sent' or 'approved'.
  CONSTRAINT ck_draft_revisions_origin
    CHECK (origin IN ('generated', 'edited')),

  -- A generated revision names its model; a human edit must not pretend to one.
  CONSTRAINT ck_draft_revisions_model_pair
    CHECK ((origin = 'generated') = (model IS NOT NULL)),

  CONSTRAINT ck_draft_revisions_revision_positive
    CHECK (revision >= 1),

  -- A draft with nothing in it is not a draft.
  CONSTRAINT ck_draft_revisions_body_present
    CHECK (length(btrim(body_text)) > 0)
);

COMMENT ON COLUMN cst_app.draft_revisions.missing_information IS
  'Facts the generator could not establish. Recorded so a gap is visible rather than filled in.';
COMMENT ON COLUMN cst_app.draft_revisions.requires_review IS
  'Stored, not derived: whether this draft was safe to accept was true at generation time.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_revisions_number
  ON cst_app.draft_revisions (draft_reply_id, revision);

CREATE INDEX IF NOT EXISTS ix_draft_revisions_draft
  ON cst_app.draft_revisions (draft_reply_id, revision DESC);


-- -----------------------------------------------------------------------------
-- 3. draft_revision_sources
--
-- What a revision was grounded on: approved CST documents, and verified backend
-- facts. Citations are per revision, not per draft, because regenerating against
-- an updated corpus legitimately changes them.
--
-- A generated revision with no rows here used no knowledge at all. That is a
-- meaningful and visible state, not a missing record.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.draft_revision_sources (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_revision_id   bigint      NOT NULL,

  source_kind         text        NOT NULL,
  -- Opaque identifier from the source system: a document id, or the name of the
  -- backend fact. Never document CONTENT — no CST rule text is stored here.
  source_ref          text        NOT NULL,
  source_label        text,

  captured_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_draft_revision_sources_revision
    FOREIGN KEY (draft_revision_id) REFERENCES cst_app.draft_revisions (id) ON DELETE CASCADE,

  CONSTRAINT ck_draft_revision_sources_kind
    CHECK (source_kind IN ('cst_document', 'verified_fact')),

  CONSTRAINT ck_draft_revision_sources_ref_present
    CHECK (length(btrim(source_ref)) > 0)
);

COMMENT ON TABLE cst_app.draft_revision_sources IS
  'Citations for one draft revision. Stores references only; no CST document content is copied here.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_revision_sources_identity
  ON cst_app.draft_revision_sources (draft_revision_id, source_kind, source_ref);

CREATE INDEX IF NOT EXISTS ix_draft_revision_sources_revision
  ON cst_app.draft_revision_sources (draft_revision_id);

COMMIT;
