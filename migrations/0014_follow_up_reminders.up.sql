-- =============================================================================
-- 0014_follow_up_reminders.up.sql
--
-- Shared follow-up reminders: "this customer conversation needs follow-up at
-- this time."
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  NOT EXECUTED. Awaiting review.
--
-- WHY A TABLE IS REQUIRED, stated plainly because the rule is not to add one
-- without a reason.
--
--   When CST tells a customer "we will update you within 48 hours", that
--   promise exists nowhere in this system. It is not derivable: no message
--   text may be scanned for it (the before-shipment rule exists because reading
--   wording to decide priority was wrong in three separate ways), and the
--   response SLA measures how fast we answer a message rather than a commitment
--   somebody made inside one. The promise is a decision a person took, so it
--   has to be stored as one.
--
--   It cannot live on an existing table. `conversations.workflow_state` is the
--   human review workflow and terminates at `reviewed`; a reminder is not a
--   workflow state and must not add one. `automation_items` is the post-
--   dispatch automation's own record, keyed by shipment and carrying a rendered
--   template — a reminder has no template, no shipment and nothing rendered.
--   `conversation_rule_analysis` is a machine finding about the rule base.
--
-- SHARED, NOT OWNED. Every CST staff member sees every reminder. There is
-- deliberately NO `assigned_user_id`, `created_by_user_id` or
-- `completed_by_user_id` column: this application has no authentication, no
-- session and no current user — `cst_app.app_users` holds zero rows and
-- `draft_revisions.created_by_user_id` is null on all 434 revisions because no
-- caller has ever had a user to supply. An ownership column added now could
-- only ever be filled with NULL, and a nullable owner that is always null is a
-- field that teaches readers to ignore it. Ownership is a later migration, once
-- identity exists.
--
-- IT REMINDS A PERSON. IT DOES NOT CONTACT A CUSTOMER.
-- There is no template, no body, no recipient, no channel, no marketplace, no
-- address, no scheduled send, no status meaning "sent" and nothing a transport
-- could read. `note` is CST's own words to CST, never a message to anybody. A
-- reminder coming due is a reason for a person to open the conversation and
-- decide; the acting happens in the systems that can act.
--
-- FOUR STATES, THREE STORED. `upcoming`, `due soon`, `overdue` and `completed`
-- are what the eventual list must show, but only the last is a fact about the
-- reminder — the other three are the same `scheduled` row read against a clock.
-- Persisting them would create rows that are wrong between the moment they come
-- due and the moment something remembers to update them, which is precisely the
-- bug a derived reading cannot have. Derive from `status` + `promised_due_at` +
-- `now()`.
--
-- NO CUSTOMER DATA. A conversation id, a promised time, an internal note, and
-- the state of the reminder. No customer identity, no order, no message text.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--   * Purely additive: alters and drops nothing from 0001-0013.
--   * Does NOT touch cst_app.internal_notes, which exists in the live database
--     without a migration in this repository and without any runtime reader.
--     It is left exactly as found; adopting or removing it is its own decision.
--   * Adds no send, outbound, transport or transmission structure.
--   * No functions or triggers.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. follow_up_reminders
--
-- One row per promise. MANY PER CONVERSATION is deliberate and unconstrained: a
-- thread can carry a promise made on Monday and a second made on Thursday, and
-- collapsing them would silently discard the first. Nothing here is unique but
-- the id.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.follow_up_reminders (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The conversation the promise was made in. ON DELETE CASCADE, matching every
  -- other conversation-linked table in this schema (0001, 0004, 0006, 0009): a
  -- reminder about a conversation that no longer exists is not a reminder.
  conversation_id bigint      NOT NULL,

  -- WHEN WE SAID WE WOULD COME BACK, as a real instant.
  --
  -- `timestamptz`, without hesitation, because this is an APPLICATION-GENERATED
  -- time and the migrations README is explicit that those use `timestamptz`.
  -- The naive `timestamp` rule applies to values copied verbatim from the
  -- source, whose zone is unconfirmed; nothing is copied here. A person chose
  -- this moment inside this application, so the moment is unambiguous.
  promised_due_at timestamptz NOT NULL,

  -- CST's own words to CST: "customer chasing the replacement shade". Never a
  -- message to a customer and never rendered to one. NULL means no note was
  -- written; the CHECK below stops an empty string becoming a second way to say
  -- the same thing.
  note            text,

  status          text        NOT NULL DEFAULT 'scheduled',

  -- When somebody marked it done. See the pair constraint for why this is a
  -- one-way implication rather than a biconditional.
  completed_at    timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_follow_up_reminders_conversation
    FOREIGN KEY (conversation_id) REFERENCES cst_app.conversations (id) ON DELETE CASCADE,

  -- THE WHOLE VOCABULARY, exhaustively. There is deliberately no 'sent', no
  -- 'sending', no 'queued', no 'delivered' and no 'notified': none of those are
  -- things a reminder can be, and a status word is the cheapest place for a
  -- capability nobody agreed to build to appear to exist.
  CONSTRAINT ck_follow_up_reminders_status
    CHECK (status IN ('scheduled', 'completed', 'cancelled')),

  -- A completed reminder must say WHEN it was completed.
  --
  -- ONE-WAY, AND 0013 IS WHY. `ck_automation_items_cancel_pair` shipped as a
  -- biconditional — timestamp set if and only if status matched — and that was
  -- right until somebody needed to put a cancelled record back, at which point
  -- PostgreSQL rejected the restore with 23514 and the screen returned a bare
  -- 500. Reopening a completed reminder is the same shape of action, and the
  -- row should keep the evidence that it was completed once. So: completed
  -- implies a timestamp; a timestamp does not imply completed.
  CONSTRAINT ck_follow_up_reminders_completed_pair
    CHECK (status <> 'completed' OR completed_at IS NOT NULL),

  -- An empty note is not a note. Mirrors ck_app_users_display_name_present.
  CONSTRAINT ck_follow_up_reminders_note_present
    CHECK (note IS NULL OR length(btrim(note)) > 0)
);

COMMENT ON TABLE cst_app.follow_up_reminders IS
  'Shared CST follow-up reminders, one per promise made in a conversation. Internal state only: no row here can contact a customer.';

COMMENT ON COLUMN cst_app.follow_up_reminders.promised_due_at IS
  'When CST said it would come back to the customer. Application-generated instant, so timestamptz.';

COMMENT ON COLUMN cst_app.follow_up_reminders.note IS
  'CST''s own words to CST. Never shown to a customer and never rendered into a message.';

COMMENT ON COLUMN cst_app.follow_up_reminders.status IS
  'scheduled, completed or cancelled. Upcoming/due-soon/overdue are NOT stored: derive them from status, promised_due_at and now().';

COMMENT ON COLUMN cst_app.follow_up_reminders.completed_at IS
  'When it was marked done. Only meaningful while status = completed; retained if a completed reminder is later reopened.';

-- -----------------------------------------------------------------------------
-- 2. The one question this table is asked
--
-- "Which reminders are still live, soonest first?" A partial index on exactly
-- the rows that can still come due — the same shape as `ix_automation_items_due`
-- (0011), which answers the same question for scheduled automation records.
--
-- PARTIAL, so completed and cancelled reminders cost the index nothing however
-- many accumulate; `id` as the tiebreaker so two reminders promised for the same
-- instant have a stable order rather than an arbitrary one.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_follow_up_reminders_due
  ON cst_app.follow_up_reminders (promised_due_at, id)
  WHERE status = 'scheduled';

-- Every reminder attached to one conversation, for the conversation view. Not
-- partial: opening a thread should show what was promised and what was done,
-- including the reminders that are finished.
CREATE INDEX IF NOT EXISTS ix_follow_up_reminders_conversation
  ON cst_app.follow_up_reminders (conversation_id, promised_due_at DESC);

COMMIT;
