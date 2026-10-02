-- =============================================================================
-- 0022_marketplace_cases.up.sql
--
-- Storage for the Case Detection Indicator: one row per marketplace customer
-- case, plus the run ledger that says when that snapshot was last published and
-- which source stores it covered.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  APPLIED 2026-10-02 to varmen_db, schema cst_app. Reviewed and
--          approved. Created two tables, six indexes (two unique and four
--          lookup, plus the two primary keys), 28 CHECK constraints, one foreign
--          key and twenty COMMENTs. The cst_app base-table count went 33 -> 35
--          and NO existing table gained, lost or changed a row — verified by an
--          exact row census of all 33 pre-existing tables taken before and
--          after. `customer_case_history` was 1,098 rows before and 1,098 after,
--          with its 24 constraints and 3 indexes intact and its `imported_at`
--          unchanged. No object was created outside cst_app.
--
--          BEFORE APPLYING, the whole file was rehearsed: its own BEGIN and
--          COMMIT were stripped and the remaining body executed inside a
--          transaction that was then ROLLED BACK, which proved every statement
--          parses and every constraint and index predicate is accepted by the
--          server, and left the database unchanged (33 tables, zero row drift).
--          Feeding the file to a client that has already issued BEGIN is NOT a
--          rehearsal: the file's own COMMIT would make it permanent.
--
--          Both tables were deployed EMPTY: this file imported nothing. Data
--          arrives separately and afterwards, by `npm run import:marketplace-
--          cases -- --apply`, which is manual and which nothing schedules.
--
-- WHY TWO TABLES ARE REQUIRED, stated plainly because the rule is not to add
-- one without a reason.
--
--   `marketplace_cases` exists because 0021's table cannot hold this data, and
--   the obstruction is physical rather than stylistic:
--   `customer_case_history.counterparty_ref` is NOT NULL, and FOUR of the nine
--   source stores carry no buyer column at all. Verified read-only on the
--   source: the eBay return store, the Amazon return store, the eBay
--   cancellation store and the Shopify refund store each record an order and a
--   storefront and no customer. That is roughly 19,700 of the ~21,000 cases.
--   Making 0021's column nullable would break the one read it exists to serve,
--   which matches on lower(counterparty_ref) in all three of its statements.
--
--   `case_import_runs` exists because nothing in cst_app can currently answer
--   "did the import run". 0021 records only a per-row `imported_at`, and
--   `countPreviousCases` already documents the gap it leaves: the value is NULL
--   both when a customer has no cases and when no import ever happened, and
--   those lead a reviewer to opposite conclusions. An indicator backed by a
--   snapshot cannot ship on an ambiguity like that.
--
-- ---------------------------------------------------------------------------
-- 0021 IS NOT TOUCHED, AND THE OVERLAP IS DECLARED RATHER THAN HIDDEN
-- ---------------------------------------------------------------------------
-- `cst_app.customer_case_history` is not altered, re-commented, re-indexed or
-- read by anything here. The Repeat-Customer Warning keeps its table, its three
-- statements and its numbers exactly as they are.
--
-- The honest consequence: once the importer runs, about 1,225 cases will exist
-- in BOTH tables — the item-not-received and formal cases from the two inquiry
-- logs, and the payment disputes. That is why the provenance key below is the
-- SAME SHAPE as 0021's, deliberately: (source_database, source_table,
-- source_case_id). An identical key is what lets a report deduplicate across
-- the two tables deterministically instead of by matching names, and it is
-- recorded in duplicate-risk-reports/ for exactly that reason.
--
-- No screen sums the two. The warning renders counts and no identifiers, the
-- indicator renders cases and no counts, and neither carries a total.
--
-- ---------------------------------------------------------------------------
-- ONE ROW PER CASE, NOT PER EVENT
-- ---------------------------------------------------------------------------
-- Six of the nine source stores are status-event logs, and each names its own
-- header row differently. Measured read-only on the replicated copy and on the
-- source schema:
--
--   eBay returns          42,931 event rows ->  4,082 cases. The header is the
--                         row carrying a status: 4,427 of 42,931 do, and the
--                         other 38,504 carry NULL in status, state, type and
--                         reason together.
--   eBay cancellations     4,623 event rows ->  1,263 cases. The source names
--                         the discriminator itself: `level` is commented
--                         "0-main / 1-sub", and exactly 1,263 rows are level 0.
--   inquiries              8,054 event rows ->  1,062 cases, sequenced by
--                         res_his_order.
--   formal cases           1,038 event rows ->    127 cases, same sequence.
--   payment disputes          37 event rows ->     36 cases, sequenced by
--                         revision.
--   Amazon returns        15,891 rows      -> 12,372 return authorisations.
--
-- Storing one row per event would report a customer who filed ONE
-- item-not-received claim as having filed four. `source_row_count` records how
-- many events folded in, so a report can still separate "how many cases" from
-- "how many recorded events" — the same split the root cause feature needed a
-- child table for.
--
-- ---------------------------------------------------------------------------
-- THE STATUS TRAP, RECORDED AGAIN BECAUSE IT RECURS IN A SECOND SOURCE
-- ---------------------------------------------------------------------------
-- 0021 documented that `status` is NULL on the NEWEST row of all 1,062 inquiry
-- cases while existing somewhere in 1,061 of them, so a plain "latest row wins"
-- collapse imports NULL for every case and looks like it worked.
--
-- The eBay return store has the same shape: status exists on 4,427 rows of
-- 42,931 and on none of the others. The importer's rule is therefore the same —
-- newest row by (event sequence, row id) decides IDENTITY, newest NON-NULL
-- value decides STATUS — and it lives in a pure function, not in this file.
--
-- ---------------------------------------------------------------------------
-- LIFECYCLE AND SOURCE STATUS ARE SEPARATE COLUMNS, AND THAT IS MEASURED
-- ---------------------------------------------------------------------------
-- They are not two names for one fact. On the eBay return store the two source
-- columns are orthogonal axes and demonstrably disagree:
--
--   * all 150 rows whose status is ESCALATED have current_state CLOSED. An
--     escalated return IS a closed return, so "active" cannot be read off the
--     status and escalation cannot be read off the lifecycle.
--   * 6 rows carry status READY_FOR_SHIPPING with current_state ITEM_DELIVERED.
--     The two columns simply disagree about where the case is.
--
-- So `lifecycle` is CST's own three-value reading, derived by the importer from
-- whichever column each store actually uses for closure, and `source_status`
-- and `source_state` keep the source's own words beside it. Collapsing them
-- would force a choice between two values the source never reconciled, which is
-- the guess this codebase rejects unmapped values to avoid.
--
-- `lifecycle` has THREE values, never a boolean. `unknown` is the honest answer
-- for a large, measured population: 13,315 Amazon return rows carry status
-- Approved, which means the request was approved and NOT that the case closed —
-- the store records no closure event and no closure date. A further 2,577 FBA
-- rows carry a warehouse disposition in `status` rather than a case status at
-- all, and 2,019 Shopify refund rows have no status column in the source.
--
-- ---------------------------------------------------------------------------
-- WAREHOUSE DISPOSITION IS NOT A CASE STATUS, SO IT GETS ITS OWN COLUMN
-- ---------------------------------------------------------------------------
-- The Amazon return store puts two different vocabularies in one column, split
-- cleanly by fulfilment channel. Measured: the 13,343 merchant-fulfilled rows
-- carry a CASE status (Approved 13,315, PendingApproval 25, Closed 3), while
-- the 2,577 Amazon-fulfilled rows carry a WAREHOUSE DISPOSITION (unit returned
-- to inventory 1,308, customer-damaged 634, sellable 310, reimbursed 97,
-- defective 91, repackaged 85, carrier-damaged 49, donated 2, damaged 1).
--
-- Reading the second group into `source_status` would show a CST reviewer a
-- stockroom outcome labelled as the customer's case status.
-- `source_disposition` is where it goes, and the CHECK below makes it
-- unrepresentable for any other store.
--
-- ---------------------------------------------------------------------------
-- DAMAGE IS A FLAG, NOT A CASE TYPE, AND THE SOURCE IS WHY
-- ---------------------------------------------------------------------------
-- A full column census of all fourteen case-related source tables found no
-- damage table, no damage status and no damage case identifier anywhere. Damage
-- is recorded as the REASON on a return: one value on eBay (arrived damaged,
-- 271 rows) and four on Amazon (1,133 rows between them). A DAMAGE case type
-- would need an identity the source does not issue, so `damage_reported` is a
-- boolean derived from a closed, reviewed value set and the reason it came from
-- stays visible in `source_reason`.
--
-- ---------------------------------------------------------------------------
-- REPLACEMENT IS CONFIRMABLE ON ONE STORE, AND THE NEAR-MISS IS THE POINT
-- ---------------------------------------------------------------------------
-- The source holds a 36-value return-action vocabulary including
-- "seller marked replacement shipped" and "seller offered replacement", and a
-- per-return table attaches the first to 51 returns and the second to 3. Read
-- as history that is 54 confirmed replacements, and it would be wrong.
--
-- That table is an AVAILABLE-ACTIONS snapshot, not an event log, and the proof
-- is a comparison against the returns' own activity feed: the action
-- "external claim opened" is attached to 4,076 of 4,082 returns there and
-- appears as an actual activity on ZERO of them, while "seller issued refund"
-- is attached to 78 and appears as an activity on 2,931. The replacement
-- actions likewise appear as an activity on zero returns.
--
-- So eBay has NO confirmed replacement on record, and the only authoritative
-- signal anywhere is the Amazon resolution field: 15 rows reading Replacement
-- and 1 reading ReturnlessReplacement, out of 15,891.
-- ck_marketplace_cases_replacement_source makes anything else unrepresentable,
-- so the 54 near-misses cannot be stored as confirmations by a later edit.
--
-- ---------------------------------------------------------------------------
-- THE ORDER REFERENCE, AND WHY 0021 LEFT IT OUT
-- ---------------------------------------------------------------------------
-- 0021 refused an order reference for the two inquiry logs, because neither
-- carries an order id and deriving one from ITEM plus BUYER is what
-- lib/context/resolve-order-context.ts does with an ambiguous outcome on 7% of
-- real cases. That reasoning was correct for the key it considered.
--
-- It did not consider ITEM plus TRANSACTION, which is the marketplace's own
-- order-line identifier and is unique by construction. Both logs carry both
-- parts on 100% of their rows (8,054 of 8,054 and 1,038 of 1,038, none zero),
-- and the order source carries the same pair: 364,467 eBay order lines hold
-- both, forming 364,465 distinct pairs. Joining them was measured read-only:
--
--   1,189 cases -> 1,182 resolve to EXACTLY ONE order (99.4%)
--                      7 resolve to none
--                      0 resolve to several
--
-- and every one of the 1,182 lands on the same storefront the case itself
-- records, so the storefront corroborates the match rather than being assumed.
--
-- `order_match_method` is therefore four distinct measured states rather than a
-- nullable column a reader has to interpret. A source-recorded order id that
-- resolves to a real order is a different claim from one that does not (the
-- Amazon return store has 16% of the latter), and both are different claims
-- from a reference this application derived. `unmatched` is the honest value for
-- the 7, and it is stored rather than left as a NULL that reads as "not
-- checked".
--
-- ---------------------------------------------------------------------------
-- NO FOREIGN KEY TO `conversations`, FOR 0021'S REASON
-- ---------------------------------------------------------------------------
-- A case is matched to a conversation logically, at read time, by comparing the
-- stored order reference with the order that conversation already resolved to,
-- or by the buyer handle. There is no FK and no write back. A buyer's case is
-- most valuable before their next conversation exists, so an FK would make the
-- rows worth having unstorable.
--
-- ---------------------------------------------------------------------------
-- THE ONE FOREIGN KEY, AND WHY IT IS SAFE
-- ---------------------------------------------------------------------------
-- `import_run_id` references the run ledger in the SAME schema, NOT NULL, with
-- ON DELETE RESTRICT. It is the first FK on this feature and it is within
-- cst_app, so it couples nothing to another project's lifecycle — the rule the
-- repository states for cross-schema references.
--
-- It is also the publication gate. See the ATOMIC PUBLICATION block below.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets a source database. No MySQL and no marketplace PostgreSQL
--     object is created, altered, read or written by this file, and applying it
--     opens no connection to either.
--   * Purely additive: alters and drops nothing from 0001-0021. In particular
--     customer_case_history, conversations, context_snapshots and agent_activity
--     are untouched.
--   * Adds no send, outbound, transport, recipient or transmission structure,
--     and no workflow state. The workflow still terminates at reviewed.
--   * Creates no trigger, function, rule, schedule, cron entry or worker, and
--     registers no sync_state feed. Nothing here causes a read of anything.
--   * Stores no customer message text, case correspondence, postal location,
--     email address or contact detail.
--   * Removes no row and drops no column.
--   * Runs in one transaction, re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. THE RUN LEDGER
--
-- Created FIRST, because the case table's foreign key points at it.
--
-- ---------------------------------------------------------------------------
-- A DRY RUN WRITES NOTHING, AND THE SCHEMA IS WHERE THAT IS ENFORCED
-- ---------------------------------------------------------------------------
-- There is deliberately NO `mode` column and no dry-run state. An earlier draft
-- of this design had the importer record `mode = 'dry_run'` so a rehearsal was
-- visible, and that was wrong twice over: it made a read-only rehearsal perform
-- a write, and it put a row in the one table whose purpose is to say when real
-- data was last published.
--
-- This table records PUBLISHED AND ATTEMPTED APPLY RUNS ONLY. A dry run has no
-- row to write, so "a rehearsal changes no database" is a property of the
-- schema rather than a promise in a script.
--
-- ---------------------------------------------------------------------------
-- ATOMIC PUBLICATION: A PARTIAL IMPORT IS NEVER VISIBLE
-- ---------------------------------------------------------------------------
-- An earlier draft wrote the cases in bounded batches, each its own
-- transaction, so a failure part-way left committed rows behind. Those rows
-- would have been read by the indicator while the run itself was recorded as
-- failed — a partial case set presented as the answer. That is corrected here,
-- and the correction is what the three states below exist for.
--
-- THE PROTOCOL the importer must follow, and the only one these constraints
-- admit:
--
--   TRANSACTION 1  INSERT a run row with status 'in_progress', naming the
--                  source stores this run intends to cover. Commits at once, so
--                  an attempt that later dies is still on record.
--
--   TRANSACTION 2  EVERY case upsert, AND the single statement that moves this
--                  run to 'published' with its published_at and its counts, in
--                  ONE transaction. Either all the cases land and the run is
--                  published together with them, or neither happens. There is
--                  no interleaving in which published data is incomplete.
--
--   TRANSACTION 3  only on failure: move the run to 'failed' with the error.
--                  Transaction 2 has already rolled back, so no case row from
--                  this run exists to be read.
--
-- RESUMABILITY IS TRADED FOR ATOMICITY, DELIBERATELY. A failed run must be
-- repeated from the beginning rather than continued, and that is affordable
-- precisely because the whole extraction costs one source connection and twelve
-- queries against an hourly allowance of a hundred.
--
-- ---------------------------------------------------------------------------
-- A FAILED IMPORT CANNOT EXPOSE A PARTIAL RECORD SET. THREE REASONS, NOT ONE
-- ---------------------------------------------------------------------------
-- The property matters enough to state as a chain rather than as an assurance,
-- because each link is checkable on its own:
--
--   1. NOTHING IS COMMITTED UNTIL EVERYTHING IS. Every case upsert lives in
--      transaction 2 together with the publish statement. A failure anywhere in
--      it rolls back the whole set — including the `import_run_id` and
--      `imported_at` updates made to rows that ALREADY existed, so a refresh
--      that dies leaves the previous snapshot byte-identical rather than
--      half-rewritten.
--
--   2. A RUN CANNOT BE COMMITTED AND FAILED AT THE SAME TIME. Because the
--      publish statement is inside that transaction, "committed" and
--      "published" are the same event. There is no window in which rows exist
--      under a run that later reports failure, which is precisely the window an
--      earlier batched design left open.
--
--   3. AN UNPUBLISHED RUN IS UNREADABLE BY CONSTRUCTION, NOT BY CONVENTION.
--      ck_case_import_runs_in_progress_unpublished forbids an in-progress run
--      from carrying a published_at, and every freshness query filters on
--      status = 'published'. A run abandoned between transactions 1 and 2
--      therefore contributes no coverage and no timestamp, and the read-path
--      gate below hides any row that somehow named it.
--
-- The one thing a schema cannot do is stop a reader ignoring the gate, which is
-- why the gate is written out immediately below and why a guard test, not this
-- file, is what will hold the repository to it.
--
-- THE READ-PATH GATE, which no schema can enforce and which the repository
-- therefore owns: a case row is visible to CST only when its `import_run_id`
-- names a run whose status is 'published'. With the protocol above that is
-- redundant, and it is required anyway — it is what makes an abandoned
-- 'in_progress' row harmless rather than a hole. `ix_marketplace_cases_run`
-- exists to make that join cheap.
--
-- ---------------------------------------------------------------------------
-- FRESHNESS IS PER SOURCE STORE, NOT ONE GLOBAL TIMESTAMP
-- ---------------------------------------------------------------------------
-- `source_tables` records what a run ACTUALLY covered, because a run may be
-- asked for a subset and must not then be readable as a whole-snapshot refresh.
-- A published run covering only the inquiry log says nothing about how current
-- the return stores are.
--
-- So the freshness question is answered per store, from published runs only:
--
--   SELECT t, max(r.published_at)
--     FROM cst_app.case_import_runs r, unnest(r.source_tables) AS t
--    WHERE r.status = 'published'
--    GROUP BY 1
--
-- A store with no row in that result has never been published, and CST must
-- report that as "never imported" rather than as "no cases found" — the two
-- lead a reviewer to opposite conclusions, which is the distinction this whole
-- table exists to make possible.
--
-- No GIN index on `source_tables`. This table gains one row per approved
-- refresh, so it will hold tens of rows and the unnest above is a trivial scan
-- whichever way it is written.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cst_app.case_import_runs (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Three states, and the middle one is the whole point. 'published' is the
  -- ONLY state CST may read data behind.
  status              text        NOT NULL,

  -- Application-generated, so timestamptz — the convention for anything this
  -- application produces, as against the naive source values on the case table.
  started_at          timestamptz NOT NULL DEFAULT now(),

  -- When the run stopped, whichever way it ended. NULL only while in progress.
  finished_at         timestamptz,

  -- When this run's data became readable. Set in the SAME transaction as the
  -- rows it publishes, and it is the authoritative freshness value — never
  -- max(imported_at), which is a per-row "last confirmed" and exists on rows a
  -- failed run never published.
  published_at        timestamptz,

  -- What this run actually covered. Constrained to the nine known stores so a
  -- run cannot claim coverage of something that does not exist.
  source_tables       text[]      NOT NULL,

  -- The source allowance is a hundred queries and fifty connections per HOUR,
  -- shared across every consumer. Recorded here so the spend is auditable from
  -- the database rather than from a terminal somebody has closed.
  mysql_connections   integer     NOT NULL,
  mysql_queries       integer     NOT NULL,

  -- Counts, NULL while in progress and required once published. `cases_read` is
  -- what the source returned, `cases_rejected` what could not be mapped, and
  -- the two upsert counts split new cases from refreshed ones.
  cases_read          integer,
  cases_inserted      integer,
  cases_updated       integer,
  cases_rejected      integer,

  -- Tallied by reason, so a report names what was dropped. Nothing unmappable
  -- is ever repaired with a default, which is why this is kept at all.
  rejection_summary   jsonb,

  error               text,

  CONSTRAINT ck_case_import_runs_status
    CHECK (status IN ('in_progress', 'published', 'failed')),

  -- Publication implies a publication time. ONE-WAY, and 0013 is why: the
  -- converse would make retracting a bad run impossible, because moving it to
  -- 'failed' while keeping the timestamp as history would violate a
  -- biconditional. A retracted run keeps published_at and stops being read,
  -- because every freshness query filters on status.
  CONSTRAINT ck_case_import_runs_published_has_time
    CHECK (status <> 'published' OR published_at IS NOT NULL),

  -- A run still in progress has published nothing. This direction IS tight: it
  -- is what stops a half-finished run being readable as current.
  CONSTRAINT ck_case_import_runs_in_progress_unpublished
    CHECK (status <> 'in_progress' OR published_at IS NULL),

  CONSTRAINT ck_case_import_runs_finished
    CHECK (status = 'in_progress' OR finished_at IS NOT NULL),

  -- A failure must say what failed. Same device as ck_sync_state_error_detail.
  CONSTRAINT ck_case_import_runs_failed_has_error
    CHECK (status <> 'failed' OR error IS NOT NULL),

  -- A published run must report its own numbers. Without this a run could be
  -- published with no counts at all, and "published" would stop meaning
  -- "finished and accounted for".
  CONSTRAINT ck_case_import_runs_published_has_counts
    CHECK (status <> 'published'
           OR (cases_read IS NOT NULL AND cases_inserted IS NOT NULL
               AND cases_updated IS NOT NULL AND cases_rejected IS NOT NULL)),

  CONSTRAINT ck_case_import_runs_counts_not_negative
    CHECK ((cases_read     IS NULL OR cases_read     >= 0)
       AND (cases_inserted IS NULL OR cases_inserted >= 0)
       AND (cases_updated  IS NULL OR cases_updated  >= 0)
       AND (cases_rejected IS NULL OR cases_rejected >= 0)),

  -- A run that opened no connection and ran no query read nothing, so it cannot
  -- be a publication.
  CONSTRAINT ck_case_import_runs_usage_recorded
    CHECK (mysql_connections >= 0 AND mysql_queries >= 0),

  -- Coverage must name at least one store, must contain no NULL element, and
  -- every element must be a store this application has reviewed.
  CONSTRAINT ck_case_import_runs_source_tables_present
    CHECK (cardinality(source_tables) >= 1
           AND array_position(source_tables, NULL) IS NULL),

  CONSTRAINT ck_case_import_runs_source_tables_known
    CHECK (source_tables <@ ARRAY[
             'ebay_returns', 'amazon_returns', 'cancellation', 'amz_cancellations',
             'shopify_returns', 'shopify_cancellations', 'inquiries', 'cases',
             'payment_disputes'
           ]::text[])
);

COMMENT ON TABLE cst_app.case_import_runs IS
  'One row per attempted or published case-import run. A rehearsal writes no row here at all, so a dry run changes no database. Only a published row may be read as current.';

COMMENT ON COLUMN cst_app.case_import_runs.status IS
  'in_progress: started and not yet published. published: its cases landed in the same transaction that published it, and may be read. failed: rolled back, so no case row from it exists.';

COMMENT ON COLUMN cst_app.case_import_runs.published_at IS
  'When this run became readable, set in the same transaction as the rows it published. The authoritative freshness value, as against the per-row imported_at.';

COMMENT ON COLUMN cst_app.case_import_runs.source_tables IS
  'The source stores this run actually covered. Freshness is answered per store from this array, because a subset run must not read as a whole-snapshot refresh.';

COMMENT ON COLUMN cst_app.case_import_runs.mysql_queries IS
  'Queries this run spent against an account allowing one hundred per hour in total, shared with every other consumer. Recorded so the budget is auditable later.';

COMMENT ON COLUMN cst_app.case_import_runs.rejection_summary IS
  'Unmappable cases tallied by reason. Nothing unmappable is repaired with a default, so this is the record of what was dropped and why.';

-- -----------------------------------------------------------------------------
-- The freshness read, and the only one this table exists to serve. PARTIAL,
-- because a freshness query never asks about an unpublished run.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_case_import_runs_published
  ON cst_app.case_import_runs (published_at DESC)
  WHERE status = 'published';

-- -----------------------------------------------------------------------------
-- AT MOST ONE RUN MAY BE IN PROGRESS AT A TIME.
--
-- A PARTIAL UNIQUE INDEX on a column whose every matching row holds the same
-- value, which is how PostgreSQL expresses "at most one row satisfying this
-- predicate". A second concurrent import cannot record its attempt, so it fails
-- at the first statement instead of part-way through the data.
--
-- WHY IT IS HERE, STATED PRECISELY, BECAUSE THE OBVIOUS REASON IS WRONG.
-- The reviewed hazard was that two concurrent runs would upsert the same cases,
-- one would publish and the other fail, and the rows would end up naming a
-- failed run and so be hidden from CST. That hazard does NOT exist: the publish
-- statement sits inside the same transaction as the upserts, so a run cannot be
-- committed-and-failed, and a rollback reverts the `import_run_id` updates along
-- with everything else. All four interleavings leave every surviving row naming
-- a published run.
--
-- What remains is operational, and this index is for that: two runs upserting
-- about 21,000 rows in different orders can DEADLOCK, and each wasted attempt
-- costs twelve queries out of an hourly source allowance of one hundred shared
-- with every other consumer. Making the overlap impossible is cheaper than
-- discovering it, and it follows 0002's rule — make the mistake unrepresentable
-- rather than merely discouraged.
--
-- It constrains nothing else. Any number of 'published' and 'failed' rows may
-- coexist, because the predicate matches neither.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_import_runs_single_in_progress
  ON cst_app.case_import_runs (status)
  WHERE status = 'in_progress';

-- =============================================================================
-- 2. THE CASES
-- =============================================================================
CREATE TABLE IF NOT EXISTS cst_app.marketplace_cases (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- -------------------------------------------------------------------------
  -- PROVENANCE. The same key shape as 0021's, deliberately — see the header on
  -- the declared overlap. MySQL has no schema layer, so there is no
  -- source_schema column, matching agent_activity and conversation_message_media.
  --
  -- `source_case_id` is the CASE identifier exactly as the source issues it,
  -- never a per-event row id: the return identifier, the cancellation
  -- identifier, the return-authorisation identifier, the inquiry identifier,
  -- the case identifier, the dispute identifier.
  --
  -- TEXT, NOT bigint. These are 20-digit integers at source, past what a
  -- JavaScript number holds exactly, and a rounded identifier is a case nobody
  -- can find again. Here the value is also opaque: nothing computes with it.
  -- -------------------------------------------------------------------------
  source_database       text        NOT NULL,
  source_table          text        NOT NULL,
  source_case_id        text        NOT NULL,

  marketplace           text        NOT NULL,
  sub_source_id         integer     NOT NULL,

  -- What kind of case. A CLOSED vocabulary of five, each measured.
  case_type             text        NOT NULL,

  -- -------------------------------------------------------------------------
  -- THE ORDER, AND HOW IT WAS ESTABLISHED. Four states, never a nullable column
  -- a reader must interpret — see the header.
  -- -------------------------------------------------------------------------
  order_ref             text,
  order_match_method    text        NOT NULL,

  -- The marketplace line identifiers the match was made on, kept so it can be
  -- re-derived and re-checked without going back to the source. Text for the
  -- same reason as source_case_id.
  order_line_item_ref   text,
  order_txn_ref         text,

  -- -------------------------------------------------------------------------
  -- THE CUSTOMER. NULLABLE, unlike 0021's, and that is the reason this table
  -- exists: four of the nine stores record no customer at all. NULL here means
  -- THE SOURCE HOLDS NONE, not that the import failed to read one.
  --
  -- Named for conversations.counterparty_ref because it IS that identity and
  -- this column exists to be compared with it. An opaque marketplace handle,
  -- not a name and not a way to reach anyone.
  -- -------------------------------------------------------------------------
  counterparty_ref      text,

  -- CST's own three-value reading of where the case stands. See the header on
  -- why this is separate from source_status and why `unknown` is a real answer.
  lifecycle             text        NOT NULL,

  -- -------------------------------------------------------------------------
  -- THE SOURCE'S OWN WORDS, PRESERVED AND DELIBERATELY UNCONSTRAINED.
  --
  -- These vocabularies belong to eBay, Amazon and Shopify and change without
  -- telling us. A CHECK here would turn a new marketplace status into a failed
  -- import, which is the trade 0021 made for the same reason on event_status.
  -- Nullable, because most stores populate only some of them, and never blank:
  -- an empty string would read as a status that was recorded and happens to be
  -- empty, which is a different claim from none being recorded.
  -- -------------------------------------------------------------------------
  source_status         text,
  source_state          text,
  source_disposition    text,
  source_resolution     text,
  source_reason         text,
  source_reason_family  text,

  -- Two flags, each from a closed reviewed value set. See the header for the
  -- exact values and the counts behind them.
  damage_reported       boolean     NOT NULL,
  replacement_confirmed boolean     NOT NULL,

  -- Three states, not a boolean, exactly as in 0021: 'not_recorded' means the
  -- source store has NO escalation signal at all, which is a different fact
  -- from a signal meaning no. Six of the nine stores have no such column.
  escalation            text        NOT NULL,

  -- What the seller owes on an open case, where the store records it. On the
  -- eBay return store this is populated on 100% of header rows and is the most
  -- directly actionable field the source has: issue a refund, provide a return
  -- authorisation, provide a label, approve the request.
  seller_action_owed    text,
  seller_action_due_at  timestamp,

  quantity              integer,
  refund_amount         numeric(12,2),
  refund_currency       text,

  -- -------------------------------------------------------------------------
  -- NAIVE TIMESTAMPS, SOURCE VALUES PRESERVED BYTE-FOR-BYTE.
  --
  -- The convention is timestamptz for anything this application generates and
  -- naive timestamp only where a source value is kept exactly; these four are
  -- the latter. No timezone is known for them and none may be implied. The
  -- first dry run of 0021's importer proved the cost of getting this wrong:
  -- the driver parsed a naive datetime into a local Date and silently gave it
  -- an offset it never had.
  --
  -- `opened_at` is NOT NULL and is the EARLIEST recorded date across a case's
  -- events, not the latest. A case accumulates events over weeks, so the newest
  -- one is when it was last touched — which would make an old case look recent
  -- and defeat the point of knowing a case already exists. A case with no date
  -- on any event row is rejected by the importer and counted, not given one.
  --
  -- `closed_at` is nullable and genuinely absent for several stores: the eBay
  -- return store has no closure-date column at all, so a closed return there
  -- records closure without a date. There is deliberately no CHECK tying the
  -- two together — one that exempted four of the nine stores would assert
  -- nothing while looking as though it did.
  -- -------------------------------------------------------------------------
  opened_at             timestamp   NOT NULL,
  closed_at             timestamp,
  source_updated_at     timestamp,

  -- How many source event rows collapsed into this case. Load-bearing for the
  -- duplicate-risk record: it lets a report distinguish "how many cases" from
  -- "how many recorded events", and summing it must never be read as a case
  -- count.
  source_row_count      integer     NOT NULL,

  -- When this row was last confirmed against the source. A per-row fact, and
  -- NOT the freshness answer: a row carries one even if the run that wrote it
  -- was never published. Freshness comes from case_import_runs.published_at.
  imported_at           timestamptz NOT NULL DEFAULT now(),

  -- The publication gate and the provenance link. NOT NULL, so every case row
  -- can always be joined to the run that last confirmed it, and RESTRICT, so a
  -- run that produced rows cannot be removed while they exist.
  import_run_id         bigint      NOT NULL
                          REFERENCES cst_app.case_import_runs (id) ON DELETE RESTRICT,

  -- Same device as ck_customer_case_history_source_database: one source, named,
  -- so a row from somewhere else is a constraint violation and not a surprise.
  CONSTRAINT ck_marketplace_cases_source_database
    CHECK (source_database = 'message_app'),

  -- The nine reviewed stores. A tenth arriving should fail the import and be
  -- looked at, not be stored as a provenance nobody has checked.
  CONSTRAINT ck_marketplace_cases_source_table
    CHECK (source_table IN (
             'ebay_returns', 'amazon_returns', 'cancellation', 'amz_cancellations',
             'shopify_returns', 'shopify_cancellations', 'inquiries', 'cases',
             'payment_disputes'
           )),

  CONSTRAINT ck_marketplace_cases_source_case_id_present
    CHECK (length(btrim(source_case_id)) > 0),

  -- The same vocabulary as ck_sync_state_marketplace, ck_agent_activity_marketplace
  -- and ck_customer_case_history_marketplace. NOT NULL: the platform is
  -- verifiable for every row from the storefront, so an unverifiable row must be
  -- rejected by the importer rather than stored with a NULL that later reads as
  -- "some marketplace".
  CONSTRAINT ck_marketplace_cases_marketplace
    CHECK (marketplace IN ('ebay', 'amazon', 'shopify', 'bandq', 'temu')),

  -- FIVE case types, each measured, and the fifth is the interesting one.
  -- The Shopify store records a REFUND and not a return case: seven columns,
  -- holding a date, an order, an amount and a currency, with no status, no
  -- reason and no lifecycle. Calling those 2,019 rows RETURN would assert a
  -- case the source does not record, so they get the type they actually are.
  CONSTRAINT ck_marketplace_cases_case_type
    CHECK (case_type IN (
             'RETURN', 'CANCELLATION', 'ITEM_NOT_RECEIVED', 'PAYMENT_DISPUTE', 'REFUND'
           )),

  CONSTRAINT ck_marketplace_cases_lifecycle
    CHECK (lifecycle IN ('active', 'closed', 'unknown')),

  CONSTRAINT ck_marketplace_cases_order_match_method
    CHECK (order_match_method IN (
             'source_order_id_verified',
             'source_order_id_unverified',
             'item_transaction',
             'unmatched'
           )),

  -- A BICONDITIONAL, and this is the one place it is right. 0011 shipped one
  -- that broke Undo Cancel, and 0013 had to undo it, because there a state
  -- transition legitimately moved one side without the other.
  --
  -- There is no such transition here. 'unmatched' IS DEFINED as "no reference",
  -- and a case row is only ever written whole — the upsert sets both columns
  -- from the same incoming record, so they can never move apart. A hand-written
  -- statement that cleared one and not the other would be rejected, which is
  -- the outcome wanted rather than a hazard.
  CONSTRAINT ck_marketplace_cases_order_ref_method
    CHECK ((order_match_method = 'unmatched') = (order_ref IS NULL)),

  CONSTRAINT ck_marketplace_cases_order_ref_present
    CHECK (order_ref IS NULL OR length(btrim(order_ref)) > 0),

  CONSTRAINT ck_marketplace_cases_counterparty_present
    CHECK (counterparty_ref IS NULL OR length(btrim(counterparty_ref)) > 0),

  -- Nullable, but never blank, for every preserved source vocabulary.
  CONSTRAINT ck_marketplace_cases_source_values_present
    CHECK ((source_status        IS NULL OR length(btrim(source_status))        > 0)
       AND (source_state         IS NULL OR length(btrim(source_state))         > 0)
       AND (source_disposition   IS NULL OR length(btrim(source_disposition))   > 0)
       AND (source_resolution    IS NULL OR length(btrim(source_resolution))    > 0)
       AND (source_reason        IS NULL OR length(btrim(source_reason))        > 0)
       AND (source_reason_family IS NULL OR length(btrim(source_reason_family)) > 0)),

  CONSTRAINT ck_marketplace_cases_escalation
    CHECK (escalation IN ('escalated', 'not_escalated', 'not_recorded')),

  -- Only three stores record an escalation signal at all. ONE-WAY, exactly as
  -- ck_customer_case_history_escalation_source is: a row from one of the three
  -- may still be 'not_recorded', because the source can record no signal on an
  -- individual case.
  CONSTRAINT ck_marketplace_cases_escalation_source
    CHECK (escalation = 'not_recorded'
           OR source_table IN ('inquiries', 'ebay_returns', 'amazon_returns')),

  -- One-way. A confirmed replacement implies the Amazon return store, which is
  -- the only store carrying the field that confirms one. See the header for why
  -- the eBay action table is not that field.
  CONSTRAINT ck_marketplace_cases_replacement_source
    CHECK (replacement_confirmed = false OR source_table = 'amazon_returns'),

  -- One-way. A warehouse disposition implies the Amazon return store, the only
  -- one that records one. This is what keeps a stockroom outcome out of every
  -- field a screen could render as a case status.
  CONSTRAINT ck_marketplace_cases_disposition_source
    CHECK (source_disposition IS NULL OR source_table = 'amazon_returns'),

  -- A collapsed case folded in at least one source row. Zero would mean a case
  -- assembled from nothing.
  CONSTRAINT ck_marketplace_cases_source_row_count_positive
    CHECK (source_row_count >= 1),

  CONSTRAINT ck_marketplace_cases_quantity_positive
    CHECK (quantity IS NULL OR quantity >= 0),

  -- An amount without a currency is a number nobody can act on.
  CONSTRAINT ck_marketplace_cases_refund_pair
    CHECK (refund_amount IS NULL OR length(btrim(coalesce(refund_currency, ''))) > 0)
);

COMMENT ON TABLE cst_app.marketplace_cases IS
  'One marketplace customer case per row, collapsed from the message application per-event case stores. Holds no case correspondence, no postal location and no contact detail. Readable only when the run that wrote it is published.';

COMMENT ON COLUMN cst_app.marketplace_cases.source_case_id IS
  'The source CASE identifier, as text, exactly as the source issues it. Never a per-event row id: six of the nine stores hold many rows per case.';

COMMENT ON COLUMN cst_app.marketplace_cases.case_type IS
  'RETURN, CANCELLATION, ITEM_NOT_RECEIVED, PAYMENT_DISPUTE or REFUND. Damage is not a type: the source issues no damage case identifier, so damage is recorded on damage_reported with its reason kept in source_reason.';

COMMENT ON COLUMN cst_app.marketplace_cases.lifecycle IS
  'CST own reading: active, closed or unknown. Separate from source_status because the two source columns are orthogonal and measurably disagree. unknown is a real answer for the Amazon approved population, the Amazon-fulfilled rows and the Shopify refund rows.';

COMMENT ON COLUMN cst_app.marketplace_cases.source_status IS
  'The source status, in its own words, unconstrained because the vocabulary belongs to the marketplace. NULL where the store records none. Never a warehouse disposition, which has its own column.';

COMMENT ON COLUMN cst_app.marketplace_cases.source_disposition IS
  'The Amazon warehouse disposition for an Amazon-fulfilled return. A stockroom outcome, NOT a case status, and kept apart so no screen can present it as one.';

COMMENT ON COLUMN cst_app.marketplace_cases.order_match_method IS
  'How the order reference was established: recorded by the source and verified against a real order, recorded but unverified, derived from the marketplace item and transaction identifiers, or unmatched. unmatched is stored rather than left as a NULL reading as not checked.';

COMMENT ON COLUMN cst_app.marketplace_cases.counterparty_ref IS
  'The marketplace buyer handle, the same identity as conversations.counterparty_ref. NULLABLE because four of the nine source stores record no customer at all, and NULL here means the source holds none.';

COMMENT ON COLUMN cst_app.marketplace_cases.escalation IS
  'escalated or not_escalated where a store records the signal. not_recorded where the store has no escalation concept at all, which is six of the nine and is not evidence of absence.';

COMMENT ON COLUMN cst_app.marketplace_cases.replacement_confirmed IS
  'True only from the Amazon resolution field, which is the single authoritative confirmation anywhere in the source. The eBay return-action table is an available-actions snapshot and must never be read as confirmation.';

COMMENT ON COLUMN cst_app.marketplace_cases.opened_at IS
  'The earliest recorded date across the case events, a naive source datetime preserved exactly. No timezone is known for it and none may be implied. Earliest, not latest, so an old case cannot read as recent.';

COMMENT ON COLUMN cst_app.marketplace_cases.source_row_count IS
  'How many source event rows collapsed into this case. Lets a report separate how many cases from how many recorded events. Summing it must never be read as a case count.';

COMMENT ON COLUMN cst_app.marketplace_cases.imported_at IS
  'When this row was last confirmed against the source. A per-row fact and NOT the freshness answer, because a row carries one even when the run that wrote it was never published.';

COMMENT ON COLUMN cst_app.marketplace_cases.import_run_id IS
  'The run that last confirmed this row, and the publication gate: CST reads a case only when this run is published. Also what makes a row the source stopped returning detectable rather than guessed at.';

-- -----------------------------------------------------------------------------
-- IDEMPOTENCY, AND IT IS THE WHOLE OF THE DUPLICATE PREVENTION.
--
-- Keyed on the CASE, so an approved refresh upserts rather than appending a
-- second copy, and so a case that gained three more event rows between runs
-- updates one row instead of becoming four.
--
-- `source_table` is in the key because the identifier spaces genuinely overlap:
-- the formal-case store and the dispute store use separate marketplace
-- identifier spaces, and 69 identifiers appear in BOTH inquiry logs for what
-- measurement showed to be the same case. The database would accept both rows
-- of that pair without complaint, so the key admits them and the importer drops
-- the superseded copy and counts it. Same reasoning as
-- uq_customer_case_history_source_identity and uq_agent_directory_source_identity.
--
-- A plain column list is the conflict target, and that is correct only because
-- all three columns are NOT NULL. sla-policy-writer.ts needs a coalesce in its
-- target because one of its key columns is nullable and PostgreSQL treats NULLs
-- as distinct, which lets the same row insert twice forever. No column of this
-- key can be NULL. If one ever became nullable, the writer must change with it.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_cases_source_identity
  ON cst_app.marketplace_cases (source_database, source_table, source_case_id);

-- -----------------------------------------------------------------------------
-- The primary read: the cases on the order a conversation has already resolved
-- to. PARTIAL, because a row with no order reference can never satisfy it.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_marketplace_cases_order
  ON cst_app.marketplace_cases (marketplace, sub_source_id, order_ref)
  WHERE order_ref IS NOT NULL;

-- -----------------------------------------------------------------------------
-- The secondary read: other cases for the same customer. FUNCTIONAL on
-- lower(counterparty_ref), and 0021's omission of one is exactly why.
--
-- The handles differ in case between the two systems — every imported source
-- value is lowercase while 358 conversation values are not — so lower() has to
-- be applied to both sides, and a plain index cannot serve that predicate.
-- 0021 accepted the resulting sequential scan because its table holds 1,098
-- rows and the scan is sub-millisecond, and recorded that a functional index
-- would need a migration if the table ever grew by orders of magnitude. This
-- table is expected to hold about twenty times as many rows, so that migration
-- is this one, and the index is here from the start rather than retro-fitted.
--
-- PARTIAL, because four of the nine stores record no customer.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_marketplace_cases_counterparty
  ON cst_app.marketplace_cases (marketplace, sub_source_id, lower(counterparty_ref))
  WHERE counterparty_ref IS NOT NULL;

-- -----------------------------------------------------------------------------
-- The publication gate join, and the sweep that finds rows the source stopped
-- returning. Not partial: every row has a run.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_marketplace_cases_run
  ON cst_app.marketplace_cases (import_run_id);

COMMIT;
