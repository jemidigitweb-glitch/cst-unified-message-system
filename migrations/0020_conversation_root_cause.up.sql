-- =============================================================================
-- 0020_conversation_root_cause.up.sql
--
-- The root causes a CST agent selects for a conversation, and — when any of
-- them is about delivery, fulfilment or a carrier — which courier, what kind of
-- problem, and a short note saying what actually happened.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT YET APPLIED. Written and reviewed; apply by hand like 0001-0019.
--
-- ---------------------------------------------------------------------------
-- WHY A CST TABLE AND NOT THE MESSAGE APPLICATION'S COLUMN
-- ---------------------------------------------------------------------------
-- The production message application stores its root cause on the message rows
-- themselves (`messages_headers.root_cause` and siblings) in MariaDB. CST
-- cannot write there, and this is measured rather than assumed: `SHOW GRANTS
-- FOR CURRENT_USER()` on the configured credential returns `USAGE ON *.*` plus
-- SELECT on 25 named tables in `order_management` and NO write privilege of any
-- kind. `message_app` is not granted at all.
--
-- So this is a CST record of a CST decision, in PostgreSQL, and the drift is
-- real and must be understood by anyone reading a report off it: the message
-- application's own classifier rewrites `root_cause` on its source rows every
-- five minutes, with no user and no log, and it will not see anything recorded
-- here. The panel therefore shows BOTH values, each labelled with whose it is,
-- rather than letting one silently stand in for the other.
--
-- ---------------------------------------------------------------------------
-- A CASE HAS ONE OR MORE ROOT CAUSES, ALL EQUAL
-- ---------------------------------------------------------------------------
-- An agent selects as many causes as apply — `PARTS MISSING`, or
-- `PARTS MISSING` and `Delivery Issue` and `OTHER` together. There is no
-- primary cause and no secondary one, and NO `is_primary` flag: nothing in the
-- business rule ranks them, so nothing here may imply a rank that a report
-- would then have to invent a meaning for.
--
-- Consequently the parent table holds NO `root_cause` column at all. Every
-- selected label is a row in `conversation_root_cause_labels`, and they are
-- peers. The parent is the REVISION — the act of recording — and carries only
-- what belongs to the act rather than to one label: the courier detail, the
-- note, the free-text OTHER explanation, the timestamp.
--
-- THE TWO COUNTS THIS SHAPE KEEPS APART, and a report must too:
--
--   case count             distinct current revisions (one per conversation)
--   root cause mentions    rows in the label table
--
-- A conversation carrying three labels is ONE case and THREE mentions. Storing
-- the labels as peers in a child table makes both countable; a comma-separated
-- column or a `primary` flag would make one of them guesswork.
--
-- ---------------------------------------------------------------------------
-- APPEND-ONLY, LIKE draft_revisions
-- ---------------------------------------------------------------------------
-- Changing a selection inserts a NEW parent revision and a fresh set of label
-- rows against it; it never updates one. The current value is the newest parent
-- for the conversation, together with ITS OWN labels.
--
-- This is deliberately NOT how the message application behaves. There, changing
-- a root cause overwrites the column and DELETES the prior confirmation log, so
-- nothing records what it was before, who changed it, or how often. That is the
-- one behaviour of theirs worth not copying: the whole point of asking which
-- courier causes the most problems is that somebody will later ask how a number
-- was arrived at, and a history that was overwritten cannot answer.
--
-- There is no UPDATE and no DELETE route, and no soft-delete column — this
-- project does not use soft deletes anywhere (see 0003).
--
-- ---------------------------------------------------------------------------
-- THE COURIER AND ISSUE-TYPE VOCABULARIES ARE CONSTRAINED, AND THE LABELS ARE
-- NOT
-- ---------------------------------------------------------------------------
-- `courier` and `courier_issue_type` are the REPORTING DIMENSIONS. The feature
-- exists to compare couriers fairly, and a free-text column would let one typo
-- split "EVRI" across two rows of the report and understate it. So both carry a
-- CHECK, in the same spirit as `ck_agent_activity_marketplace`: NULL is
-- permitted, a value outside the list is not.
--
-- `conversation_root_cause_labels.root_cause` is NOT constrained, and that is
-- equally deliberate. It holds a label from a vocabulary that lives outside
-- this schema and changes without telling us. A CHECK here would turn a new
-- label into a failed save rather than a row an operator can see, which is the
-- reasoning `agent_activity.action` already records for the same decision.
--
-- `vocabulary_version` is stamped at write time so a label can still be read
-- against the list that produced it, exactly as `automation_items` stamps
-- `template_version` rather than resolving it later.
--
-- ---------------------------------------------------------------------------
-- OTHER IS A LABEL LIKE ANY OTHER, AND IT CARRIES AN EXPLANATION
-- ---------------------------------------------------------------------------
-- `OTHER` is selectable alongside any other cause — `PARTS MISSING` and
-- `OTHER` together is an ordinary, meaningful selection. Choosing it obliges
-- the agent to type what the cause actually was, and that text is stored ONCE,
-- in `custom_root_cause` on the parent, because there is only ever one OTHER in
-- a selected set.
--
-- THE RELATIONSHIP IS ENFORCED IN THE DOMAIN, NOT HERE, and that is a choice
-- rather than an omission:
--
--   labels contain OTHER   <->   custom_root_cause is present
--
-- is a condition across two tables. PostgreSQL can only express it with a
-- trigger or a deferred constraint, and this migration adds neither — a trigger
-- firing on every label insert is a fragile thing to own for a rule the writer
-- already guarantees. `lib/domain/root-cause-selection.ts` refuses either half
-- before a write happens, and the repository writes both tables in ONE
-- transaction so no partial state can be observed. What this file DOES enforce
-- is that a stored explanation is never blank.
--
-- ---------------------------------------------------------------------------
-- AUTHORSHIP IS NULLABLE, AND IS A RECORDED LIMITATION
-- ---------------------------------------------------------------------------
-- CST has no interactive sign-in, and the agreed position for this phase is a
-- single CST staff user with no access restriction. So `recorded_by_user_id` is
-- written NULL by every insert today, exactly as `internal_notes.author_user_id`
-- and `draft_revisions.created_by_user_id` already are. The column exists so
-- that the day a sign-in arrives, nothing has to be backfilled with a guess —
-- and a fabricated author would be worse than an absent one, because a courier
-- report naming a person is read as fact about them.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, review, sku360 or public.
--   * Never targets the live source databases, which are strictly read-only.
--     Source rows are referenced by plain id columns, never by foreign key.
--   * Purely additive: alters and drops nothing from 0001-0019.
--   * Adds no send/outbound/transmission structure, and no workflow state.
--   * Stores no customer message text, address or identity.
--   * No functions or triggers.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. conversation_root_causes  —  the REVISION header
--
-- One row per recorded act of selection. Append-only; newest row is current.
-- Carries no label of its own: see `conversation_root_cause_labels`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.conversation_root_causes (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  conversation_id      bigint      NOT NULL,

  -- What the agent typed when `OTHER` is among the selected labels. Present if
  -- and only if it is — enforced in the domain, because that is a condition
  -- across two tables. See the header.
  --
  -- Stored exactly as written, trimmed at the ends and otherwise untouched:
  -- never re-cased, never reworded, and never promoted into the offered
  -- vocabulary. Unconstrained in length here on purpose — the application caps
  -- it, and a length CHECK would turn a raised ceiling into a migration.
  custom_root_cause    text,

  -- Courier detail, present only when one of the selected labels is about
  -- delivery, fulfilment or a carrier. Constrained, because these two ARE the
  -- report.
  courier              text,
  courier_issue_type   text,

  -- The agent's short account of what actually happened. A DIFFERENT field from
  -- `custom_root_cause`: that one says what the problem IS, this says what else
  -- a reader should know about it.
  issue_note           text,

  -- Which vocabulary produced the labels, the courier and the issue type.
  -- Stamped now rather than resolved later, so changing the list tomorrow does
  -- not silently rewrite today's provenance.
  vocabulary_version   integer     NOT NULL,

  -- NULL until this application has an interactive agent identity. See header.
  recorded_by_user_id  bigint,

  recorded_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_conversation_root_causes_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  -- SET NULL, matching internal_notes and draft_revisions: removing a person
  -- from the user table must not remove the decision they recorded about a case.
  CONSTRAINT fk_conversation_root_causes_user
    FOREIGN KEY (recorded_by_user_id) REFERENCES cst_app.app_users (id) ON DELETE SET NULL,

  -- An explanation of nothing is not an explanation. Whitespace is nothing.
  CONSTRAINT ck_conversation_root_causes_custom_present
    CHECK (custom_root_cause IS NULL OR length(btrim(custom_root_cause)) > 0),

  -- An issue type describes a courier's conduct, so it cannot be recorded
  -- without naming the courier. One-way on purpose: a courier may be known
  -- before the kind of problem has been established.
  CONSTRAINT ck_conversation_root_causes_issue_type_needs_courier
    CHECK (courier_issue_type IS NULL OR courier IS NOT NULL),

  -- A blank note is not a note; absent is the honest way to record "none given".
  CONSTRAINT ck_conversation_root_causes_note_present
    CHECK (issue_note IS NULL OR length(btrim(issue_note)) > 0),

  -- NULL permitted, a value outside the list is not. These two columns are the
  -- reporting dimensions and a typo in either would corrupt the comparison.
  CONSTRAINT ck_conversation_root_causes_courier
    CHECK (courier IS NULL OR courier IN (
      'Royal Mail',
      'EVRI',
      'DHL',
      'DPD',
      'GLS',
      'Amazon Shipping',
      'USPS',
      'Intelcom',
      'Smart Track',
      'Other'
    )),

  -- THE APPROVED SPELLINGS, CHARACTER FOR CHARACTER. The irregular casing is
  -- the business's — item 1 capitalised, items 2-10 not — and the two slashes
  -- are theirs too. An earlier draft tidied all ten into sentence case and
  -- wrote 'or' for '/'; it was corrected before this file was ever applied,
  -- which is the only reason it cost nothing.
  --
  -- These strings and `COURIER_ISSUE_TYPES` in lib/domain/root-cause-vocabulary.ts
  -- must stay identical AND in the same order. A test reads this file as text
  -- and compares the two, so editing one alone fails rather than ships a chip
  -- an agent can press into a save the database rejects.
  CONSTRAINT ck_conversation_root_causes_issue_type
    CHECK (courier_issue_type IS NULL OR courier_issue_type IN (
      'Lost parcel',
      'transit damage',
      'parcel damaged by courier',
      'delivered to wrong address',
      'false/incorrect delivery scan',
      'delayed delivery',
      'no tracking update',
      'returned to sender',
      'collection/drop-off issue',
      'other'
    ))
);

COMMENT ON TABLE cst_app.conversation_root_causes IS
  'One recorded act of root cause selection for a conversation — the revision header. The selected labels are rows in conversation_root_cause_labels. Append-only; newest row is current. Never shown to a customer and never part of a reply, a draft or an export.';

COMMENT ON COLUMN cst_app.conversation_root_causes.custom_root_cause IS
  'What the agent typed when OTHER is among the selected labels. Present if and only if it is, enforced in the domain because that is a cross-table condition. A separate field from issue_note: this says what the problem IS, the note says what else a reader should know.';

COMMENT ON COLUMN cst_app.conversation_root_causes.courier IS
  'Reporting dimension. Constrained so one typo cannot split a courier across two rows of a comparison.';

COMMENT ON COLUMN cst_app.conversation_root_causes.vocabulary_version IS
  'Which vocabulary produced these labels, stamped at write time so a stored label can be read against the list that offered it.';

COMMENT ON COLUMN cst_app.conversation_root_causes.recorded_by_user_id IS
  'NULL while the application has no interactive agent identity. An absent author, never a guessed one.';

-- -----------------------------------------------------------------------------
-- The panel's read: this conversation's current revision, newest first.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_conversation_root_causes_conversation
  ON cst_app.conversation_root_causes (conversation_id, recorded_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- The report's reads.
--
-- Two indexes, because the report asks two shapes of question: "how many cases
-- in this date range" scans by time alone, and "which courier is worst" groups
-- by courier within a range. The second is PARTIAL — a row with no courier can
-- never satisfy a courier comparison, and most rows will have none.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_conversation_root_causes_recorded_at
  ON cst_app.conversation_root_causes (recorded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ix_conversation_root_causes_courier
  ON cst_app.conversation_root_causes (courier, courier_issue_type, recorded_at DESC)
  WHERE courier IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. conversation_root_cause_labels  —  the selected causes
--
-- One row per selected capsule. At least one per revision, and all rows are
-- EQUAL PEERS: there is no primary label and no `is_primary` column.
--
-- ---------------------------------------------------------------------------
-- THEY BELONG TO A REVISION, NOT TO A CONVERSATION
-- ---------------------------------------------------------------------------
-- The foreign key points at `conversation_root_causes.id` — one append-only
-- revision — and NOT at `conversations.id`. This is the load-bearing decision
-- in this table.
--
-- Recording a changed selection inserts a NEW parent revision and a fresh set
-- of labels against it; nothing older is touched. So "what are this case's root
-- causes" is answered by reading the labels of the NEWEST parent, and the
-- answer is exactly the set the agent chose on that occasion.
--
-- Had these hung off the conversation, every revision's labels would pile up
-- together and a cause an agent had REMOVED would keep being reported.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.conversation_root_cause_labels (
  id                         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  conversation_root_cause_id bigint      NOT NULL,

  -- A label from the offered vocabulary, verbatim — `OTHER` included, which is
  -- an ordinary selectable cause here rather than a special case. Deliberately
  -- unconstrained: the vocabulary lives outside this schema and changes without
  -- notice, so an unrecognised label must be a visible row rather than a failed
  -- save.
  root_cause                 text        NOT NULL,

  recorded_at                timestamptz NOT NULL DEFAULT now(),

  -- CASCADE, matching how the parent hangs off `conversations`. These rows have
  -- no meaning without the revision that owns them, so a parent that went would
  -- leave labels describing nothing.
  CONSTRAINT fk_conversation_root_cause_labels_revision
    FOREIGN KEY (conversation_root_cause_id)
    REFERENCES cst_app.conversation_root_causes (id) ON DELETE CASCADE,

  CONSTRAINT ck_conversation_root_cause_labels_present
    CHECK (length(btrim(root_cause)) > 0),

  -- One mention of a label per revision. A case is not `PARTS MISSING` twice,
  -- and a duplicate would double that label's mention count.
  --
  -- PER REVISION, NOT PER CONVERSATION: a conversation whose selection is
  -- revised legitimately carries the same label on each revision, and the
  -- history would be unrecordable if it could not.
  CONSTRAINT uq_conversation_root_cause_labels
    UNIQUE (conversation_root_cause_id, root_cause)
);

COMMENT ON TABLE cst_app.conversation_root_cause_labels IS
  'The root causes selected in one revision, all equal peers — there is no primary label. One row per selected capsule; at least one per revision. Counting these rows gives root cause MENTIONS, which is a different metric from the case count.';

COMMENT ON COLUMN cst_app.conversation_root_cause_labels.conversation_root_cause_id IS
  'The parent REVISION these labels were recorded with — not the conversation. Reading the newest parent''s labels gives exactly the set the agent last chose.';

-- ---------------------------------------------------------------------------
-- THE ONE RULE THIS SCHEMA CANNOT ENFORCE, STATED SO NOBODY ASSUMES IT DOES
-- ---------------------------------------------------------------------------
-- `OTHER` among these labels requires `custom_root_cause` on the parent, and
-- its absence forbids it. That is a condition across two tables, expressible
-- only with a trigger or a deferred constraint, and this migration adds
-- neither — see the header.
--
-- It is enforced in `lib/domain/root-cause-selection.ts` before any write, and
-- the repository writes both tables in one transaction so no partial state is
-- observable. A row that breaks it is a bug in that module rather than
-- something the database will catch.
-- ---------------------------------------------------------------------------

-- The panel's read by parent is served by `uq_conversation_root_cause_labels`,
-- whose leading column is the parent id; no second index is created for it.
--
-- The report's read: how often was each label mentioned, over a date range.
-- Deliberately a DIFFERENT question from the case count, and answered from a
-- different table so the two cannot be confused for one another.
CREATE INDEX IF NOT EXISTS ix_conversation_root_cause_labels_label
  ON cst_app.conversation_root_cause_labels (root_cause, recorded_at DESC);

COMMIT;
