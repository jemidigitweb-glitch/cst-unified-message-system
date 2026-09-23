-- =============================================================================
-- 0017_agent_activity.up.sql
--
-- What a CST agent did, and to which conversation: one row per recorded action
-- in the message application's own activity log.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  APPLIED 2026-09-23 to varmen_db, schema cst_app. Reviewed and
--          approved. Created one table, four indexes and four COMMENTs; the
--          cst_app base-table count went 28 -> 29 and no existing table gained,
--          lost or changed a row. No data was imported: the table was deployed
--          empty.
--
-- WHY A TABLE IS REQUIRED, stated plainly because the rule is not to add one
-- without a reason.
--
--   Nothing in cst_app records who did anything. `draft_revisions
--   .created_by_user_id` is NULL on all 434 rows, `context_snapshots
--   .confirmed_by_user_id` on all 405, `internal_notes.author_user_id` on both,
--   and `audit_log` has no rows at all — because this application has never had
--   a signed-in user to supply one. A performance dashboard cannot be built on
--   four columns that are empty by construction.
--
--   The work IS recorded, just not here: `message_app.message_app_logs` holds
--   40,290 rows covering 2026-03-06 to 2026-09-23, each stamping a `user`, an
--   `action` and a date — reply_to_message, move_to_resolved,
--   mark_as_no_need_reply, root_cause_confirmed and a dozen more. That is the
--   only verified record of CST agent activity that exists anywhere.
--
--   It cannot be derived from what we already store. Message sign-offs were
--   measured as an alternative and rejected: 84.1% of outbound replies carry a
--   first name, but the highest-volume signer matches no employee record at all,
--   and `lib/domain/message-signature.ts` states in its own header that the name
--   "may be a customer or one of our own agents" and must never be treated as an
--   identity. A guessed attribution is worse than none, because a dashboard is
--   read as fact about a named person.
--
-- THE JOIN TO A CONVERSATION IS PROVEN, NOT ASSUMED.
--   message_app_logs.data->>'ext_message_id'
--     -> ledsone.customer_service.ebay_message_headers.ext_message_id   [2,885/2,885, 100.0%]
--     -> .message_id
--     -> cst_app.conversation_messages.external_message_id              [2,817/2,885, 97.6%]
--   Measured over the eBay reply log since CST's ingestion window opened:
--   3,115 replies resolved to 1,417 distinct conversations, 76.0% of all CST
--   eBay conversations. `external_message_id` is `ebay_message_headers
--   .message_id` — see `lib/marketplaces/ebay/adapter.ts` — and must never be
--   confused with `ext_message_id`, which is the body-join key.
--
-- WHAT IS AND IS NOT STORED
--
--   Stored: the source row id, which agent, which action, which day, which
--   marketplace and sub-source, and the conversation it resolved to.
--
--   NOT stored: the log's `data` payload. It is a JSON blob containing the full
--   text of the reply that was sent, the customer's email address, the subject
--   line and the message being answered. Every one of those already lives on
--   `conversation_messages`, or is customer PII with no job to do here. Only the
--   one identifier needed to make the join — `ext_message_id` — is lifted out,
--   and it is kept so a match can be re-checked without re-reading MySQL.
--
--   NOT stored: any name, email, password, token or contact detail. This table
--   holds a numeric agent id and nothing else about the person. See 0018 for the
--   directory that turns that id into a name, and why it is separate.
--
-- NO FOREIGN KEY ON `source_user_id`, DELIBERATELY.
--   It points into `order_management.user`, a MySQL database owned by another
--   project. A real FK is impossible across engines, and the logical-reference
--   pattern is already this schema's answer to exactly that problem — see
--   `app_users.management_user_id`, kept as a plain nullable column on purpose
--   so cst_app does not couple to another project's lifecycle.
--
-- AN UNMATCHED ROW IS KEPT, AND SAYS SO.
--   `match_status` distinguishes three real outcomes: the log row resolved to a
--   conversation, it carried a reference that did not resolve, or it never had
--   one (5.1% of eBay reply rows carry no ext_message_id, and the
--   mark_as_no_need_reply / settings actions reference nothing). Dropping the
--   unmatched would silently understate an agent's work; storing them as matched
--   would invent conversations. The CHECK below makes the third state
--   unrepresentable rather than merely discouraged.
--
-- SHARED ACCOUNTS ARE NOT PEOPLE. `source_user_id` 86 is a login named `admin`,
-- and three log rows carry no user at all. Those must report as unattributed.
-- The schema keeps the raw id rather than blanking it — an operator needs to see
-- that the work happened — and the reader, not the writer, refuses to name it.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source databases, which are strictly read-only.
--     No MySQL object is created, altered or written by this or any migration.
--   * Purely additive: alters and drops nothing from 0001-0016.
--   * Adds no send/outbound/transmission structure, and no workflow state.
--   * Stores no customer message text, address or identity.
--   * Deletes no row and drops no column.
--   * Runs in one transaction; re-runnable.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cst_app.agent_activity (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Source identity. Same shape as conversation_message_media; MySQL has no
  -- schema layer, so there is no source_schema column.
  source_database     text        NOT NULL,
  source_table        text        NOT NULL,
  source_pk           text        NOT NULL,

  -- The acting login, as the source numbers it. Nullable because the source
  -- permits it: three rows have no user. A logical reference, never an FK.
  source_user_id      bigint,

  -- What was done, in the source's own vocabulary. Deliberately NOT constrained
  -- to a fixed list: the source adds actions without telling us, and a CHECK
  -- here would turn a new action type into a failed import rather than a row an
  -- operator can see. 20 distinct values observed; longest is 30 characters.
  action              text        NOT NULL,

  -- The source records a DATE, not a timestamp. Stored as a date so nothing
  -- downstream can imply a precision the source does not have.
  action_date         date        NOT NULL,

  -- Which marketplace the action belongs to, mapped by the importer from the
  -- source's numeric `source` column (2 -> ebay, 3 -> shopify; no other value
  -- has been observed). NULL when the importer cannot map it honestly.
  marketplace         text,
  sub_source_id       integer,

  -- The conversation this action resolved to, when it resolved to one.
  conversation_id     bigint,

  -- The identifier the join was made on, kept so a match can be re-checked
  -- without re-reading MySQL. Text, because it is an opaque external id.
  external_message_id text,

  match_status        text        NOT NULL,

  ingested_at         timestamptz NOT NULL DEFAULT now(),

  -- SET NULL, not CASCADE: if a conversation is ever removed, the fact that an
  -- agent did work must survive it. Losing the link is acceptable; losing the
  -- work record would quietly rewrite somebody's numbers.
  CONSTRAINT fk_agent_activity_conversation
    FOREIGN KEY (conversation_id)
    REFERENCES cst_app.conversations (id) ON DELETE SET NULL,

  CONSTRAINT ck_agent_activity_action_present
    CHECK (length(btrim(action)) > 0),

  CONSTRAINT ck_agent_activity_match_status
    CHECK (match_status IN ('matched', 'unmatched', 'no_reference')),

  -- A ONE-WAY IMPLICATION, AND 0013 IS WHY.
  --
  -- The obvious form is the biconditional `(match_status = 'matched') =
  -- (conversation_id IS NOT NULL)`, and it is a latent bug. The foreign key
  -- above is ON DELETE SET NULL, so deleting a conversation sets this column to
  -- NULL on rows whose status still reads 'matched' — and the biconditional
  -- would reject that delete with 23514. That is exactly how 0011's
  -- `ck_automation_items_cancel_pair` broke Undo Cancel, and 0013 exists to
  -- undo it. The same mistake is not being made twice.
  --
  -- So: a row that HAS a conversation must be marked matched. A row marked
  -- matched whose conversation has since been removed is permitted, and is the
  -- truth — it was matched, and the conversation is gone.
  --
  -- WHAT THIS DELIBERATELY DOES NOT CATCH, stated because it is a real gap and
  -- not an oversight. The same looseness that lets SET NULL through also lets an
  -- importer INSERT ('matched', conversation_id NULL) — a bug that would read as
  -- "matched but detached" rather than being rejected. SQL cannot tell the two
  -- apart: a CHECK sees a row, not whether it arrived by INSERT or by a cascade.
  --
  -- The alternatives were considered and are worse. A biconditional breaks the
  -- delete (above). ON DELETE RESTRICT makes removing a conversation fail
  -- because somebody once worked on it. A trigger buys the distinction at the
  -- cost of the only non-declarative constraint in this schema outside 0015.
  --
  -- So the importer owns this one, and a test pins it:
  -- `tests/migrations/mysql-source-schema.test.ts` records the accepted
  -- behaviour, and the importer must never write 'matched' without a
  -- conversation id.
  CONSTRAINT ck_agent_activity_conversation_implies_matched
    CHECK (conversation_id IS NULL OR match_status = 'matched'),

  -- A row that identified no message cannot be carrying the identifier of one.
  -- One-way on purpose: this deliberately does NOT require a matched row to
  -- have an `external_message_id`, because the Shopify path joins on a
  -- different key and would otherwise be unrepresentable here.
  CONSTRAINT ck_agent_activity_reference_pair
    CHECK (match_status <> 'no_reference' OR external_message_id IS NULL),

  -- Same vocabulary as ck_sync_state_marketplace. NULL is permitted; a value
  -- outside the five is not.
  CONSTRAINT ck_agent_activity_marketplace
    CHECK (marketplace IS NULL
           OR marketplace IN ('ebay', 'amazon', 'shopify', 'bandq', 'temu'))
);

COMMENT ON TABLE cst_app.agent_activity IS
  'One recorded CST agent action, imported from the message application activity log. Holds no customer message text and no staff personal data.';

COMMENT ON COLUMN cst_app.agent_activity.source_user_id IS
  'Acting login id in order_management.user. Logical reference, intentionally not a foreign key: it points into another project''s MySQL database.';

COMMENT ON COLUMN cst_app.agent_activity.match_status IS
  'matched: resolved to a conversation. unmatched: carried a reference that did not resolve. no_reference: the source row identified no message.';

COMMENT ON COLUMN cst_app.agent_activity.action_date IS
  'The source stores a DATE. Intra-day ordering is not available and must not be implied; use source_pk for ordering within a day.';

-- -----------------------------------------------------------------------------
-- Idempotency. A re-run upserts rather than duplicating, and does not depend on
-- the sync watermark being correct.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_activity_source_identity
  ON cst_app.agent_activity (source_database, source_table, source_pk);

-- -----------------------------------------------------------------------------
-- The dashboard's primary read: one agent's actions over a date range.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_agent_activity_user_date
  ON cst_app.agent_activity (source_user_id, action_date);

-- -----------------------------------------------------------------------------
-- The conversation view's read: who has touched this conversation. Partial,
-- because an unmatched row can never satisfy this lookup.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_agent_activity_conversation
  ON cst_app.agent_activity (conversation_id)
  WHERE conversation_id IS NOT NULL;

COMMIT;
