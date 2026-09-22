-- =============================================================================
-- 0012_internal_notes.up.sql
--
-- Internal notes: a CST agent's own short record of where a case stands —
-- a courier update, an instruction from a supervisor, a fault in a listing, or
-- what happened the last time this customer got in touch.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
--
-- THESE NOTES ARE STAFF-ONLY, AND THE SCHEMA IS WHERE THAT IS STATED.
-- `visibility` is NOT NULL and constrained to the single value 'internal'. It
-- is deliberately a one-value CHECK rather than a comment or a convention: the
-- day somebody wants a note a customer can see, they have to alter this
-- constraint on purpose. It cannot be forgotten, and it cannot be widened by an
-- INSERT that simply omits the column. This is the same device
-- `automation_items.test_mode` uses in 0011, for the same reason.
--
-- WHY A TABLE IS REQUIRED. There is nowhere for this to live today.
-- `conversation_messages` is the customer thread — a row there IS a message
-- somebody exchanged with a customer, which is exactly what a note is not, and
-- it would put internal text into the message feed that grounds an AI draft.
-- `audit_log` records state transitions from a closed action vocabulary, not
-- free prose. `draft_revisions` describes a reply. A note about the case is
-- none of those three.
--
-- WHY THE CONVERSATION IS THE PARENT. An agent writes a note while reading a
-- conversation, and every one of the four purposes above arises from that
-- reading. `source_order_id` is available for a note that is really about one
-- order, and it is a PLAIN COLUMN: the order lives in the read-only source
-- database and this schema may not couple itself to it — the same rule 0011
-- states for `automation_items.source_order_id`.
--
-- AUTHORSHIP IS NULLABLE, AND THAT IS A RECORDED LIMITATION, NOT AN OVERSIGHT.
-- This application still has no interactive sign-in, so there is no agent
-- identity to stamp on a note. `author_user_id` references `app_users` and is
-- written NULL by every insert today, exactly as `draft_revisions
-- .created_by_user_id` and `context_snapshots.confirmed_by_user_id` already
-- are. A fabricated author would be worse than an absent one: it would make an
-- unattributed note look attributed. When sign-in exists, the column is already
-- here and nothing needs to be backfilled with a guess.
--
-- NO EDIT OR DELETE IN THIS PHASE. `updated_at` exists so the later CRUD phase
-- does not need a migration to add it; nothing writes it apart from the insert
-- default. There is no soft-delete column, because this project does not use
-- soft deletes anywhere (see 0003's note on the same question).
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, review, sku360 or public.
--   * Never targets the live source database, which is strictly read-only.
--     Source rows are referenced by plain id columns, never by foreign key.
--   * Purely additive: alters and drops nothing from 0001-0011.
--   * No functions or triggers.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. internal_notes
--
-- One row per note. Append-only in this phase.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.internal_notes (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  conversation_id   bigint      NOT NULL,

  -- The order this note is about, when it is about one. A PLAIN COLUMN with no
  -- foreign key: `order_management.orders` lives in the read-only source
  -- database, which this schema must not couple itself to.
  source_order_id   bigint,

  -- The four purposes this feature was asked for, plus a general note for the
  -- ones that are none of them. An enum-by-check rather than a lookup table:
  -- five fixed values that the interface must know the labels for anyway.
  note_category     text        NOT NULL,

  -- The agent's own words. Never a customer's, and never a reply.
  note_text         text        NOT NULL,

  -- NULL until this application has an interactive agent identity. See the
  -- header: an invented author is worse than an absent one.
  author_user_id    bigint,

  -- STAFF-ONLY, AS A STORED FACT. One permitted value. See the header.
  visibility        text        NOT NULL DEFAULT 'internal',

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_internal_notes_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  -- SET NULL, matching `draft_revisions` and `audit_log`: removing a person
  -- from the user table must not remove the note they wrote about a case.
  CONSTRAINT fk_internal_notes_author
    FOREIGN KEY (author_user_id) REFERENCES cst_app.app_users (id) ON DELETE SET NULL,

  CONSTRAINT ck_internal_notes_category
    CHECK (note_category IN (
      'courier_update',
      'supervisor_instruction',
      'listing_issue',
      'case_history',
      'general'
    )),

  -- A note with nothing in it is not a note. Whitespace is nothing.
  CONSTRAINT ck_internal_notes_text_present
    CHECK (length(btrim(note_text)) > 0),

  -- The one value. Widening this is the deliberate act that would let a note
  -- reach a customer, and it is meant to be hard to do by accident.
  CONSTRAINT ck_internal_notes_visibility
    CHECK (visibility IN ('internal'))
);

COMMENT ON TABLE cst_app.internal_notes IS
  'CST staff notes about a conversation. Never shown to a customer, never part of a reply, a draft or an export. visibility is constrained to internal.';

COMMENT ON COLUMN cst_app.internal_notes.visibility IS
  'Stored, not assumed: the only permitted value is internal. Widening this CHECK is what a customer-visible note would require.';

COMMENT ON COLUMN cst_app.internal_notes.source_order_id IS
  'order_management.orders.id in the read-only source database. A plain id, never a foreign key.';

COMMENT ON COLUMN cst_app.internal_notes.author_user_id IS
  'NULL while the application has no interactive agent identity. An absent author, never a guessed one.';

-- The only read this feature performs: one conversation's notes, newest first.
CREATE INDEX IF NOT EXISTS ix_internal_notes_conversation
  ON cst_app.internal_notes (conversation_id, created_at DESC, id DESC);

COMMIT;
