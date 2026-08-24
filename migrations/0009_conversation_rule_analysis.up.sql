-- -----------------------------------------------------------------------------
-- 0009  The result of asking "can the rule base answer this conversation?"
--
-- WHY A TABLE IS REQUIRED, stated plainly because the rule is not to add one
-- without a reason.
--
-- A no-rule outcome is currently derived: the interface infers it from the
-- absence of a draft plus the response to the last Generate click. That works
-- for exactly as long as the reviewer stays on the page. Reopen the
-- conversation and the finding is gone -- it looks identical to a conversation
-- nobody has tried yet, so the obvious next action is to click Generate and pay
-- for the same refusal again. The finding is a fact about the conversation and
-- has to outlive the page.
--
-- It cannot live on an existing table. `draft_replies` and `draft_revisions`
-- describe a draft, and the whole point of this state is that no draft was
-- written; a row there would be the contradiction the gate exists to prevent.
-- `conversations.workflow_state` is the human review workflow -- received,
-- drafting, pending_review, reviewed -- and a machine finding does not belong
-- in a state machine a person drives.
--
-- ONE ROW PER CONVERSATION, so re-analysing updates rather than accumulates.
-- Reopening a conversation ten times leaves one row, which is what "idempotent"
-- has to mean here.
--
-- NO CUSTOMER DATA. A conversation id, an outcome, the classifier's label for
-- the case, and when it was decided. No message text, no customer identity, no
-- rule text.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.conversation_rule_analysis (
  conversation_id bigint      PRIMARY KEY,

  -- Only one value today. An enum-by-check rather than a boolean so a later
  -- outcome ('corpus_unreadable', say) is an added value, not a new column.
  outcome         text        NOT NULL,

  -- The classifier's label for the customer's request, or NULL when it declined
  -- to name one. NULL means "unclassified", never "not looked at".
  case_type       text,

  -- How many rules were available to the marketplace when this was decided.
  -- Kept so a later reader can tell "the corpus was empty" from "the corpus was
  -- full and still had nothing for this case".
  rules_available integer     NOT NULL DEFAULT 0,

  analysed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_conversation_rule_analysis_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  CONSTRAINT ck_conversation_rule_analysis_outcome
    CHECK (outcome IN ('no_applicable_rule')),

  CONSTRAINT ck_conversation_rule_analysis_rules_available
    CHECK (rules_available >= 0)
);

COMMENT ON TABLE cst_app.conversation_rule_analysis IS
  'Conversations the CST knowledge base could not ground a reply for. One row each; re-analysis updates it. No draft exists for these.';

COMMENT ON COLUMN cst_app.conversation_rule_analysis.case_type IS
  'Classifier label for the customer request. NULL means unclassified, never unexamined.';
