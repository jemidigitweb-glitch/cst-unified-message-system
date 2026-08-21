-- =============================================================================
-- 0005_cst_knowledge_base.up.sql
--
-- The CST rule corpus that grounds AI reply drafts.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED. Awaiting review.
--
-- 0004 records WHICH rules a draft cited (draft_revision_sources holds opaque
-- references and no rule text). This migration is where that text finally lives,
-- so a citation can be resolved back to the instruction it came from and shown
-- to the reviewer.
--
-- STRUCTURE, in dependency order:
--   cst_knowledge_sources   governance: which document, which version, signed
--                           off by whom, and is it live
--   cst_rule_categories     the major CST areas (Delivery, Returns, Damage, ...)
--   cst_rules               the individual instructions the model is given
--   cst_rule_examples       illustrative message/reply pairs from the documents
--   cst_rule_triggers       the text that makes a rule relevant to a message
--
-- KNOWLEDGE ONLY. This is a rule corpus, not an operational store. There is no
-- column here for a customer message, an order, a SKU, a marketplace, a
-- conversation or a draft, and no foreign key to any table that holds one. The
-- dependency runs one way: drafts cite rules, rules know nothing about drafts.
--
-- ON cst_rule_examples: the example pairs come from the CST rule documents and
-- are illustrative wording written for training. They are NOT captured customer
-- traffic, and no real message may be copied into them. SQL cannot enforce the
-- provenance of a string, so this is a rule for the importer, stated here and
-- repeated as a COMMENT on the table.
--
-- A RULE IS ONLY USABLE ONCE ITS SOURCE IS SIGNED OFF. `active` on a source is
-- constrained to require an approved status, so an unreviewed spreadsheet row
-- cannot silently become grounding for a customer-facing reply. This matters
-- because the knowledge authority question is still open.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--   * Purely additive: alters and drops nothing from 0001-0004.
--   * No functions or triggers.
--   * Adds no workflow state and no outbound capability of any kind.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. cst_knowledge_sources
--
-- Governance for the rule corpus: where a rule came from and whether it has been
-- signed off. Rules are never loaded as anonymous text — every one points at the
-- document, sheet and row it was read from, so a wrong instruction in a draft can
-- be traced to the line that produced it and corrected at source.
--
-- `content_checksum` is over the source row's content. Re-importing an unchanged
-- row is then a no-op that can be recognised as one, and a row that changed
-- underneath an approval is visible rather than silently re-approved.
--
-- Versions are kept, not overwritten. A draft written last month cited the rule
-- as it read last month, and deleting that text would make the citation a lie.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.cst_knowledge_sources (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  source_file       text        NOT NULL,
  source_sheet      text,
  -- 1-based row in the sheet. NULL for a source that is not row-structured.
  source_row        integer,

  version           integer     NOT NULL DEFAULT 1,
  status            text        NOT NULL DEFAULT 'draft',
  approved_at       timestamptz,

  content_checksum  text,
  active            boolean     NOT NULL DEFAULT false,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_cst_knowledge_sources_status
    CHECK (status IN ('draft', 'reviewed', 'approved', 'retired')),

  CONSTRAINT ck_cst_knowledge_sources_file_present
    CHECK (length(btrim(source_file)) > 0),

  CONSTRAINT ck_cst_knowledge_sources_version_positive
    CHECK (version >= 1),

  CONSTRAINT ck_cst_knowledge_sources_row_positive
    CHECK (source_row IS NULL OR source_row >= 1),

  -- A sign-off has a date or it did not happen.
  CONSTRAINT ck_cst_knowledge_sources_approval_pair
    CHECK (status <> 'approved' OR approved_at IS NOT NULL),

  -- The load-bearing one: only signed-off knowledge may be live. An unreviewed
  -- row cannot become grounding for a reply to a customer.
  CONSTRAINT ck_cst_knowledge_sources_active_requires_approval
    CHECK (NOT active OR status = 'approved')
);

COMMENT ON TABLE cst_app.cst_knowledge_sources IS
  'Provenance and sign-off state for the CST rule corpus. One row per source document row and version.';
COMMENT ON COLUMN cst_app.cst_knowledge_sources.content_checksum IS
  'Checksum of the source row content, so an unchanged re-import is recognisable and a changed row cannot inherit an old approval.';
COMMENT ON COLUMN cst_app.cst_knowledge_sources.active IS
  'Whether this version is the live one. Constrained to require an approved status.';

-- One row of one sheet, at one version, exists once. Re-import is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cst_knowledge_sources_identity
  ON cst_app.cst_knowledge_sources
     (source_file, coalesce(source_sheet, ''), coalesce(source_row, 0), version);

-- At most one live version per source row. Enforced rather than trusted to the
-- importer: two active versions of a rule means two answers to one question.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cst_knowledge_sources_one_active
  ON cst_app.cst_knowledge_sources
     (source_file, coalesce(source_sheet, ''), coalesce(source_row, 0))
  WHERE active;

CREATE INDEX IF NOT EXISTS ix_cst_knowledge_sources_status
  ON cst_app.cst_knowledge_sources (status)
  WHERE active;


-- -----------------------------------------------------------------------------
-- 2. cst_rule_categories
--
-- The major CST areas: Delivery, Returns, Damage, Defective, Wrong item, Wrong
-- description, Wrong quantity, Missing parts, Pre-sales, Admin, B2B, and message
-- handling.
--
-- Deliberately data, not a CHECK constraint. The rule families are known today
-- but the list is the business's to extend, and adding one should be an INSERT
-- rather than a migration.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.cst_rule_categories (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  name         text        NOT NULL,
  description  text,
  active       boolean     NOT NULL DEFAULT true,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_cst_rule_categories_name_present
    CHECK (length(btrim(name)) > 0)
);

COMMENT ON TABLE cst_app.cst_rule_categories IS
  'Major CST rule areas. Held as data, not a CHECK vocabulary, so the business can add one without a migration.';

-- Case-insensitive: 'Delivery' and 'delivery' are the same area, and two of them
-- would split the rules that ground a delivery question.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cst_rule_categories_name
  ON cst_app.cst_rule_categories (lower(btrim(name)));


-- -----------------------------------------------------------------------------
-- 3. cst_rules
--
-- One CST instruction. The columns mirror the structure the rule documents are
-- actually written in — a requirement, the key rule, what the agent does, the
-- do and the don't, banned wording and its replacement — rather than flattening
-- all of it into one prose blob. Kept apart because the model is given them
-- differently: a banned phrase is a hard prohibition, an agent action is not.
--
-- Every rule points at the source row it was read from, so a draft citing this
-- rule can show the reviewer where the instruction came from.
--
-- No status column here. Whether a rule may be used is a property of its source's
-- sign-off, and duplicating it would let the two disagree.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.cst_rules (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  category_id             bigint      NOT NULL,
  source_id               bigint      NOT NULL,

  rule_name               text        NOT NULL,
  subcategory             text,

  -- Open vocabulary on purpose: the document families are analysed but the
  -- classification is not settled, and a wrong CHECK here would block the import
  -- rather than catch a mistake.
  rule_type               text        NOT NULL DEFAULT 'general',

  rule_requirement        text,
  key_rule                text,
  agent_action            text,
  do_instruction          text,
  dont_instruction        text,
  banned_phrase           text,
  replacement_instruction text,

  escalation_required     boolean     NOT NULL DEFAULT false,
  -- Tie-break when several rules match one message. Lower sorts first.
  priority                integer     NOT NULL DEFAULT 100,
  active                  boolean     NOT NULL DEFAULT true,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_cst_rules_category
    FOREIGN KEY (category_id) REFERENCES cst_app.cst_rule_categories (id) ON DELETE RESTRICT,

  -- RESTRICT, not CASCADE: deleting a source must not silently take its rules,
  -- and with them the meaning of every draft that cited one. Retire it instead.
  CONSTRAINT fk_cst_rules_source
    FOREIGN KEY (source_id) REFERENCES cst_app.cst_knowledge_sources (id) ON DELETE RESTRICT,

  CONSTRAINT ck_cst_rules_name_present
    CHECK (length(btrim(rule_name)) > 0),

  CONSTRAINT ck_cst_rules_type_present
    CHECK (length(btrim(rule_type)) > 0),

  CONSTRAINT ck_cst_rules_priority_positive
    CHECK (priority >= 0),

  -- A rule that instructs nothing is an import defect, not a rule.
  CONSTRAINT ck_cst_rules_has_instruction
    CHECK (
      coalesce(btrim(rule_requirement), '') <> ''
      OR coalesce(btrim(key_rule), '') <> ''
      OR coalesce(btrim(agent_action), '') <> ''
      OR coalesce(btrim(do_instruction), '') <> ''
      OR coalesce(btrim(dont_instruction), '') <> ''
      OR coalesce(btrim(banned_phrase), '') <> ''
    ),

  -- Replacement wording answers a banned phrase. On its own it says
  -- "say this instead" of nothing.
  CONSTRAINT ck_cst_rules_replacement_needs_banned_phrase
    CHECK (replacement_instruction IS NULL OR banned_phrase IS NOT NULL)
);

COMMENT ON TABLE cst_app.cst_rules IS
  'Individual CST instructions used to ground AI drafts. Contains rule text only — no customer, order, SKU or marketplace data.';
COMMENT ON COLUMN cst_app.cst_rules.banned_phrase IS
  'Wording the reply must not contain. Paired with replacement_instruction where the documents give an alternative.';
COMMENT ON COLUMN cst_app.cst_rules.priority IS
  'Tie-break when several rules match one message. Lower sorts first.';

-- One named rule per source row. A new version of the document creates a new
-- source, so re-import does not collide with the history it supersedes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cst_rules_source_name
  ON cst_app.cst_rules (source_id, lower(btrim(rule_name)));

-- The retrieval path: live rules for an area, best first.
CREATE INDEX IF NOT EXISTS ix_cst_rules_category_priority
  ON cst_app.cst_rules (category_id, priority)
  WHERE active;

CREATE INDEX IF NOT EXISTS ix_cst_rules_source
  ON cst_app.cst_rules (source_id);

CREATE INDEX IF NOT EXISTS ix_cst_rules_escalation
  ON cst_app.cst_rules (escalation_required)
  WHERE escalation_required;


-- -----------------------------------------------------------------------------
-- 4. cst_rule_examples
--
-- Illustrative message/reply pairs that show how a rule reads in practice.
--
-- PROVENANCE RULE, and it is not decorative: these come from the CST rule
-- documents. They are wording written to teach the rule. Real customer traffic
-- must never be copied in here — this schema is knowledge, it is not a message
-- store, and nothing else in the system reads customer text out of it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.cst_rule_examples (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id                   bigint      NOT NULL,

  customer_message_example  text,
  expected_response_example text,

  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_cst_rule_examples_rule
    FOREIGN KEY (rule_id) REFERENCES cst_app.cst_rules (id) ON DELETE CASCADE,

  -- An example with neither side is not an example.
  CONSTRAINT ck_cst_rule_examples_has_content
    CHECK (
      coalesce(btrim(customer_message_example), '') <> ''
      OR coalesce(btrim(expected_response_example), '') <> ''
    )
);

COMMENT ON TABLE cst_app.cst_rule_examples IS
  'Illustrative examples taken from the CST rule documents. NOT captured customer traffic — no real customer message may be stored here.';
COMMENT ON COLUMN cst_app.cst_rule_examples.customer_message_example IS
  'Representative wording from the rule documents showing what the rule responds to. Never a real customer message.';

CREATE INDEX IF NOT EXISTS ix_cst_rule_examples_rule
  ON cst_app.cst_rule_examples (rule_id);


-- -----------------------------------------------------------------------------
-- 5. cst_rule_triggers
--
-- What makes a rule relevant to an incoming message. Retrieval reads this table;
-- it does not hand the model the whole corpus and hope.
--
-- Triggers are rows rather than an array column so each one can carry its own
-- type — a keyword and a regular expression are matched differently — and so a
-- single bad trigger can be removed without rewriting the rule.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.cst_rule_triggers (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id       bigint      NOT NULL,

  trigger_text  text        NOT NULL,
  trigger_type  text        NOT NULL DEFAULT 'keyword',

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_cst_rule_triggers_rule
    FOREIGN KEY (rule_id) REFERENCES cst_app.cst_rules (id) ON DELETE CASCADE,

  CONSTRAINT ck_cst_rule_triggers_type
    CHECK (trigger_type IN ('keyword', 'phrase', 'regex', 'intent')),

  CONSTRAINT ck_cst_rule_triggers_text_present
    CHECK (length(btrim(trigger_text)) > 0)
);

COMMENT ON TABLE cst_app.cst_rule_triggers IS
  'Match terms that make a rule relevant to a message. Retrieval input only; stores no message content.';

-- The same trigger twice on one rule is a duplicate, not a stronger signal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cst_rule_triggers_identity
  ON cst_app.cst_rule_triggers (rule_id, trigger_type, lower(btrim(trigger_text)));

-- Lookup path: given a term from a message, find the rules that claim it.
CREATE INDEX IF NOT EXISTS ix_cst_rule_triggers_text
  ON cst_app.cst_rule_triggers (lower(btrim(trigger_text)));

CREATE INDEX IF NOT EXISTS ix_cst_rule_triggers_rule
  ON cst_app.cst_rule_triggers (rule_id);

COMMIT;
