-- =============================================================================
-- 0021_customer_case_history.up.sql
--
-- One row per historical customer CASE, collapsed from the message
-- application's per-event case logs. Storage only: this migration creates the
-- structure a future approved one-time import will write into, and imports
-- nothing.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  APPLIED 2026-10-01 to varmen_db, schema cst_app. Reviewed and
--          approved. Created one table, two indexes (plus the primary key) and
--          seven COMMENTs; the cst_app base-table count went 32 -> 33 and no
--          existing table gained, lost or changed a row — verified by an exact
--          row census of all 32 pre-existing tables taken before and after.
--          The table was deployed EMPTY: this file imported nothing.
--
--          Data arrived separately and afterwards, by
--          `npm run import:case-history -- --apply`: 1,098 cases from 9,127
--          source event rows. That importer is one-time and nothing schedules
--          it. See the WHAT IS AND IS NOT STORED block below for what it was
--          permitted to carry.
--
-- WHY A TABLE IS REQUIRED, stated plainly because the rule is not to add one
-- without a reason.
--
--   Nothing in cst_app records that a customer has had a case before. A
--   conversation carries `counterparty_ref` and a context snapshot carries the
--   verified order, but neither says "this buyer already filed an
--   item-not-received claim in March". The only record of that is in MySQL
--   `message_app`, which this application reads over an account capped at 100
--   queries per hour — so it cannot be consulted at request time, and a
--   repeat-contact signal has to be stored locally or not exist.
--
--   It cannot be derived from what cst_app already holds. CST's own eBay
--   conversation history begins 2026-06-20 (measured); the case history goes
--   back to 2025-01-21. The whole value of the signal is the part that predates
--   CST's ingestion window, which is by definition not derivable from it.
--
-- WHAT THE SOURCE ACTUALLY IS, measured 2026-10-01 over a read-only connection.
--
--   message_app.inquiries         8,052 rows ->  1,062 cases, 1,000 buyers
--                                 req_date 2025-03-09 .. 2026-10-01 (live)
--   message_app.cases             1,038 rows ->    127 cases,   121 buyers
--                                 req_date 2025-01-21 .. 2025-05-31 (stopped)
--   message_app.payment_disputes     37 rows ->     36 cases,    34 buyers
--                                 req_date 2025-02-17 .. 2026-09-24
--
--   `cases` stopped being written on 2025-05-31, the same day `inquiries` was
--   created. Supersession is the obvious reading and is NOT verified; it is
--   recorded here as an observation so nobody reads an empty recent window as
--   a broken import. All of its 127 cases are historical by definition.
--
--   ALL THREE TABLES ARE EBAY-ONLY, AND THAT IS VERIFIED RATHER THAN ASSUMED.
--   The 14 distinct `sub_source` values across them (1, 2, 3, 4, 21, 22, 23,
--   24, 27, 28, 41, 211, 222, 238) every one resolve to
--   `order_management.sub_source.source_id = 2`, which `order-context-
--   repository.ts` documents as the eBay platform check. That same ID space is
--   `cst_app.conversations.sub_source_id`, so the storefront carries across
--   without a mapping table. `marketplace` is still a column and still
--   constrained to the five, because a one-platform fact written as a
--   no-platform fact is how the next marketplace becomes a silent mis-join.
--
-- ONE ROW PER CASE, NOT PER EVENT — AND THE COLLAPSE IS NOT OPTIONAL.
--
--   `inquiries` and `cases` are per-event logs: 8,052 rows for 1,062 cases,
--   1,038 rows for 127. `res_his_order` is the event sequence within a case,
--   verified: (inquiry_id, res_his_order) yields 8,052 distinct pairs for 8,052
--   rows and (case_id, res_his_order) 1,038 for 1,038, with sequences running
--   0..18. Storing one row per event would report four disputes where a
--   customer filed one, which is the double count `duplicate-risk-reports/`
--   exists to prevent.
--
--   So the unique key below is the SOURCE CASE ID, not the source row id, and
--   `source_row_count` records how many events were folded in — the same
--   "distinguish how many cases from how many mentions" split the root cause
--   feature made with its child table.
--
-- THE STATUS TRAP, recorded because the obvious collapse rule gets it wrong.
--
--   `status` is NULL on the NEWEST row of all 1,062 inquiry cases, and `state`
--   likewise — yet a status exists somewhere in 1,061 of them. A plain "latest
--   row wins" collapse therefore imports `event_status = NULL` for every single
--   case and looks like it worked.
--
--   The importer's rule must be: latest row by (res_his_order, id) for
--   identity, latest NON-NULL value for `event_status`. One case has no status
--   on any row and is honestly unknown; `event_status` is nullable for exactly
--   that case and for no other reason.
--
--   `buyer` and `type` never disagree across the rows of a case (0 of 1,062),
--   so those may be taken from any row. That was measured, not assumed.
--
-- WHAT IS AND IS NOT STORED
--
--   Stored: which source table and case, which buyer, which storefront, what
--   kind of case, its last known status, whether it escalated, when it was
--   raised, and how many source events were folded in.
--
--   NOT stored, and these are the columns that exist at source and are
--   deliberately left behind: `comments` (1,000 chars of case correspondence),
--   `buyer_req`, `esc_reason`, `buyer_note`, `evi_seller_note`,
--   `return_address` (a customer's postal location, in a longtext),
--   `tracking_no`, `tracking_url`, `carrier`, `claim_amount`, `claim_cur`,
--   `item_id`, `transaction_id`, `revision`, `due_date`. A column that is not
--   here cannot leak, which is the same reasoning 0017 and 0018 applied to the
--   credential columns in `order_management.user`.
--
--   NO ORDER REFERENCE FOR `inquiries` OR `cases`, because neither table has
--   one. They carry `item_id` + `transaction_id` and no order id at all; only
--   `payment_disputes` has `order_id`. Deriving an order from an item and a
--   buyer is precisely what `lib/context/resolve-order-context.ts` does, with
--   an ambiguous outcome in 7% of cases — so an order reference invented here
--   would be a guess wearing a verified column's name. The CHECK below makes a
--   non-dispute row carrying one unrepresentable.
--
-- NO FOREIGN KEY TO `conversations`, DELIBERATELY, AND IT IS THE POINT.
--
--   The natural instinct is to link each case to the conversation it belongs
--   to. It would defeat the feature. A buyer's case history is valuable exactly
--   when they come back and message again — so at import time the matching
--   conversation usually does not exist yet, and an FK would make the only rows
--   worth having unstorable. Measured: of 1,000 inquiry buyers, 80 match a CST
--   eBay conversation today (8.0%); over the last 3 months, 72 of 91 (79.1%).
--   The other 92% are not junk, they are the forward-looking part.
--
--   Matching is therefore a read-time join on `counterparty_ref`, the same
--   opaque per-marketplace identity string `conversations.counterparty_ref`
--   already holds, and the index below is sized for that read.
--
-- NO DATE FILTER IS ENCODED HERE. The approved range is all available history,
-- and a range is an importer argument rather than a schema constraint — a CHECK
-- on `event_at` would turn a later approval to go further back into a migration
-- instead of a re-run.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source databases, which are strictly read-only.
--     No MySQL object is created, altered or written by this or any migration,
--     and applying this file opens no MySQL connection.
--   * Purely additive: alters and drops nothing from 0001-0020.
--   * Adds no send/outbound/transmission structure, and no workflow state.
--   * Stores no customer message text, postal location, email or contact
--     detail — only the marketplace identity string CST already stores.
--   * Creates no schedule, worker, trigger or function. Nothing here causes a
--     read of anything; the table is written only by an explicitly approved
--     one-time import.
--   * Deletes no row and drops no column.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cst_app.customer_case_history (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Source identity. Same shape as agent_activity and
  -- conversation_message_media; MySQL has no schema layer, so there is no
  -- source_schema column. `source_case_id` is the CASE id (inquiry_id /
  -- case_id), never the per-event row id — see the header on the collapse.
  source_database   text        NOT NULL,
  source_table      text        NOT NULL,
  source_case_id    text        NOT NULL,

  -- Text, not bigint. These are bigint(20) at source and run past what a
  -- JavaScript number holds exactly; the repository convention is to select a
  -- bigint as text rather than round it into a row nobody can find again.
  -- Here the value is also opaque — nothing computes with it.

  marketplace       text        NOT NULL,
  sub_source_id     integer     NOT NULL,

  -- The matching key, and the only customer-identifying value stored. Named
  -- for `conversations.counterparty_ref` because it IS that identity and this
  -- column exists to be joined to it: at source it is `inquiries.buyer`,
  -- `cases.buyer`, `payment_disputes.buyer`. An opaque marketplace handle, not
  -- a name and not a way to reach anyone.
  counterparty_ref  text        NOT NULL,

  -- Present only for a payment dispute, which is the one source table that
  -- records an order. NULL everywhere else, and the CHECK below keeps it that
  -- way rather than leaving it to the importer.
  order_ref         text,

  -- What kind of case. A CLOSED vocabulary, unlike agent_activity.action:
  -- these three values are the whole observed population ('ITEM_NOT_RECEIVED'
  -- and 'RETURN' are the only two values of inquiries.type / cases.case_type;
  -- 'PAYMENT_DISPUTE' is a constant the importer writes from the table's own
  -- identity, since payment_disputes has no type column). A fourth value
  -- arriving should fail the import and be looked at, not be stored as a case
  -- type nobody has reviewed.
  event_type        text        NOT NULL,

  -- Last known status, as the source spells it. Nullable for one measured
  -- reason only: one inquiry case of 1,062 carries no status on any of its
  -- event rows. NOT constrained to a list — the source's status vocabulary
  -- (CLOSED, CS_CLOSED, OPEN, WAITING_BUYER_RESPONSE, WAITING_SELLER_RESPONSE,
  -- FULLY_PROTECTED...) is eBay's and changes without telling us, and a CHECK
  -- here would turn a new eBay status into a failed import.
  event_status      text,

  -- Three states, not a boolean. Only `inquiries` records escalation at all
  -- (`is_case`, `esc_date`); `cases.esc_reason` is NULL on every one of its
  -- 1,038 rows and `payment_disputes` has no escalation concept. A boolean
  -- would have to answer `false` for "the source never recorded one", which is
  -- the guess this codebase rejects unmapped values to avoid.
  escalation        text        NOT NULL,

  -- `req_date`, a naive MySQL datetime, preserved as the source wrote it. The
  -- SQL convention here is timestamptz for anything this application generates
  -- and naive timestamp only where a source value is kept byte-for-byte; this
  -- is the latter. No timezone is known for it and none may be implied.
  event_at          timestamp   NOT NULL,

  -- How many source event rows collapsed into this case. Load-bearing for the
  -- duplicate-risk record: it is what lets a report distinguish "how many
  -- cases" (count rows) from "how many recorded events" (sum this). 1 for
  -- every payment dispute, up to 19 for an inquiry.
  source_row_count  integer     NOT NULL,

  imported_at       timestamptz NOT NULL DEFAULT now(),

  -- Same device as ck_agent_directory_source_system: one source, named, so a
  -- row from somewhere else is a constraint violation rather than a surprise.
  CONSTRAINT ck_customer_case_history_source_database
    CHECK (source_database = 'message_app'),

  CONSTRAINT ck_customer_case_history_source_table
    CHECK (source_table IN ('inquiries', 'cases', 'payment_disputes')),

  CONSTRAINT ck_customer_case_history_source_case_id_present
    CHECK (length(btrim(source_case_id)) > 0),

  -- Same vocabulary as ck_sync_state_marketplace and
  -- ck_agent_activity_marketplace. NOT NULL here, unlike agent_activity: the
  -- platform is verifiable for every row from sub_source.source_id, so an
  -- unverifiable row must be rejected by the importer rather than stored with
  -- a NULL that later reads as "some marketplace".
  CONSTRAINT ck_customer_case_history_marketplace
    CHECK (marketplace IN ('ebay', 'amazon', 'shopify', 'bandq', 'temu')),

  CONSTRAINT ck_customer_case_history_counterparty_present
    CHECK (length(btrim(counterparty_ref)) > 0),

  CONSTRAINT ck_customer_case_history_event_type
    CHECK (event_type IN ('ITEM_NOT_RECEIVED', 'RETURN', 'PAYMENT_DISPUTE')),

  -- Nullable, but never blank: an empty string would read as a status that was
  -- recorded and happens to be empty, which is a different claim from "the
  -- source recorded none".
  CONSTRAINT ck_customer_case_history_event_status_present
    CHECK (event_status IS NULL OR length(btrim(event_status)) > 0),

  CONSTRAINT ck_customer_case_history_escalation
    CHECK (escalation IN ('escalated', 'not_escalated', 'not_recorded')),

  -- A collapsed case folded in at least one source row. Zero would mean a case
  -- assembled from nothing.
  CONSTRAINT ck_customer_case_history_source_row_count_positive
    CHECK (source_row_count >= 1),

  -- ONE-WAY IMPLICATIONS, AND 0013 IS WHY BOTH ARE WRITTEN THIS WAY.
  --
  -- The tempting form is a biconditional — order_ref IS NOT NULL exactly when
  -- source_table = 'payment_disputes'. It would be wrong on measured data: 1 of
  -- the 37 dispute rows has order_id NULL (along with case_id and buyer, so the
  -- importer rejects that one outright), and a biconditional would also reject
  -- every legitimate dispute whose order the source never recorded.
  --
  -- The same shape as ck_agent_activity_conversation_implies_matched, for the
  -- same reason: a constraint that is exactly tight in one direction and loose
  -- in the other survives the real data, where a biconditional breaks on it.
  -- 0011's ck_automation_items_cancel_pair is the precedent for getting this
  -- wrong, and 0013 is the migration that had to undo it.
  --
  -- So: carrying an order reference implies this row is a payment dispute. A
  -- payment dispute without one is permitted and is the truth.
  CONSTRAINT ck_customer_case_history_order_ref_dispute_only
    CHECK (order_ref IS NULL OR source_table = 'payment_disputes'),

  -- And likewise for escalation: claiming an escalation state other than
  -- 'not_recorded' implies the row came from `inquiries`, the only source table
  -- that records one. An `inquiries` row may still be 'not_recorded' — only 144
  -- of its 8,052 event rows carry an esc_date at all — so the implication runs
  -- one way only.
  CONSTRAINT ck_customer_case_history_escalation_source
    CHECK (escalation = 'not_recorded' OR source_table = 'inquiries')
);

COMMENT ON TABLE cst_app.customer_case_history IS
  'One historical customer case per row, collapsed from the message application per-event case logs. Holds no case correspondence, no postal location and no contact detail.';

COMMENT ON COLUMN cst_app.customer_case_history.source_case_id IS
  'The source CASE id (inquiries.inquiry_id, cases.case_id, payment_disputes.case_id), as text. Never the per-event row id: the source logs many rows per case.';

COMMENT ON COLUMN cst_app.customer_case_history.counterparty_ref IS
  'The marketplace buyer handle, same identity as conversations.counterparty_ref and the key the repeat-contact read joins on. Opaque per marketplace; not a name and not a route to a person.';

COMMENT ON COLUMN cst_app.customer_case_history.event_status IS
  'Latest NON-NULL status across the case''s event rows. The newest row carries no status on any of the 1,062 inquiry cases measured, so a latest-row rule would store NULL for all of them. NULL here means no event row recorded one.';

COMMENT ON COLUMN cst_app.customer_case_history.escalation IS
  'escalated / not_escalated: recorded by inquiries (is_case, esc_date). not_recorded: the source table has no escalation signal at all, which is every cases and payment_disputes row.';

COMMENT ON COLUMN cst_app.customer_case_history.source_row_count IS
  'How many source event rows collapsed into this case. Lets a report separate how many cases from how many recorded events; summing it must never be read as a case count.';

COMMENT ON COLUMN cst_app.customer_case_history.event_at IS
  'The source req_date, a naive datetime preserved exactly. No timezone is known for it and none may be implied.';

-- -----------------------------------------------------------------------------
-- Idempotency, and it is the whole of the duplicate prevention.
--
-- Keyed on the CASE, so re-running the import upserts rather than appending a
-- second copy, and so a case that gained three more event rows between runs
-- updates one row instead of becoming four. `source_table` is in the key
-- because `cases.case_id` and `payment_disputes.case_id` are separate eBay
-- id spaces and a collision between them must be impossible rather than
-- unlikely — the same reasoning as uq_agent_directory_source_identity.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_case_history_source_identity
  ON cst_app.customer_case_history (source_database, source_table, source_case_id);

-- -----------------------------------------------------------------------------
-- The only read this table exists to serve: has this buyer, on this
-- marketplace, had a case before? `marketplace` leads because
-- `counterparty_ref` is only unique within one — an eBay handle and a Shopify
-- handle may be the same string and are not the same person.
--
-- NO INDEX ON `order_ref`, deliberately. It is populated on at most 36 rows in
-- the entire approved range, and a per-order lookup over a table that small is
-- a sequential scan whichever way it is written. Adding one would be storage
-- and write cost for a plan the planner would decline.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_customer_case_history_counterparty
  ON cst_app.customer_case_history (marketplace, counterparty_ref);

COMMIT;
