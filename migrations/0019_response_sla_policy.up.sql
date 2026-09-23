-- =============================================================================
-- 0019_response_sla_policy.up.sql
--
-- The approved response-time target, per marketplace and seller account.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  WRITTEN, NOT EXECUTED — awaiting review.
--          No database has run this. The table does not exist anywhere, and no
--          row has been imported. The importer
--          (`scripts/import-sla-policy.mjs`) defaults to a dry run and has been
--          run in that mode only.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS STORES, AND WHAT IT DELIBERATELY DOES NOT DECIDE
-- ---------------------------------------------------------------------------
-- It stores what `message_app.sla_configs` SAYS: 16 hours on a weekday, 24 at
-- the weekend, per seller account, on eBay, Amazon and Shopify.
--
-- It does NOT decide that this is the target CST measures against. CST applies
-- its own 24-hour rule (`lib/domain/response-sla.ts`), the two disagree, and
-- reconciling them is a business decision recorded in
-- `handover/2026-09-23-response-time-sla-handover.md` (A1). Measured on
-- identical data the gap is worth up to 30 percentage points, so it is not a
-- choice a migration may make by arriving.
--
-- Importing what a policy SAYS commits to nothing about which policy GOVERNS.
-- That is the whole reason this is safe to apply while A1-A3 are open: no
-- compliance percentage is computed from these rows, no dashboard tile changes
-- value, and `RESPONSE_SLA_MINUTES` is untouched.
--
-- ---------------------------------------------------------------------------
-- 42 ROWS OUT OF 1,081, AND THE OTHER 1,039 ARE NOT POLICY
-- ---------------------------------------------------------------------------
-- `sla_configs` holds two populations under one table name:
--
--   type='response'    42 rows. Two per account (week/weekend), `key_value`
--                      NULL on every one, all written 2026-04-15. THE POLICY.
--   type='urgent'   1,039 rows. `key_value` populated on every one with a
--                      marketplace MESSAGE ID (874 distinct), written
--                      continuously 2026-04-16 and stopped 2026-05-06. A
--                      per-case escalation log, not a policy.
--
-- Only the 42 are imported, and three independent reasons say so: they are a
-- different kind of thing; the log has been dead for four months; and its
-- `reason` column quotes phrases from customer messages, which must never be
-- copied into cst_app. `tests/migrations/sla-policy-schema.test.ts` pins that
-- no column here could hold either.
--
-- ---------------------------------------------------------------------------
-- WHY `sub_source_id` IS NULLABLE, AND WHY THE INDEX COALESCES IT
-- ---------------------------------------------------------------------------
-- Amazon's policy row carries `mail_id = 1`, and `message_app.mails.id = 1` has
-- `sub_source` NULL. The source therefore does NOT say which seller account the
-- Amazon target belongs to. CST holds exactly one Amazon account
-- (`sub_source_id` 8), so writing 8 would very probably be right — and would be
-- a fabricated join, indistinguishable in the table from the 14 eBay rows where
-- the source states the account outright.
--
-- So NULL means "the whole channel", it is a verified reading rather than a
-- missing value, and a lookup for any Amazon conversation falls back to it.
--
-- PostgreSQL treats NULLs as distinct in a unique index, so a plain
-- UNIQUE (marketplace, sub_source_id, week_scope) would happily admit two
-- ('amazon', NULL, 'week') rows and the upsert would insert a duplicate on
-- every run. `coalesce(sub_source_id, -1)` is what actually makes the key
-- unique. -1 is safe as a sentinel because seller account ids are positive.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO UNIQUE INDEX ON SOURCE IDENTITY — A DEPARTURE, ON PURPOSE
-- ---------------------------------------------------------------------------
-- 0016, 0017 and 0018 each carry a unique index on the source's identity, and
-- that is what makes their imports idempotent. This one does not, and the
-- reason is in the data rather than in taste.
--
-- Three Shopify mailboxes resolve to ONE seller account:
--
--   mail_id 2, 3 and 8  ->  sub_source 104
--
-- so three source rows collapse to one policy row per week_scope — six rows
-- becoming two. Verified: all three carry the same 16/24, so the collapse loses
-- nothing. But it means the mapping from source row to policy row is MANY-TO-
-- ONE, and a unique index on `source_pk` would assert a one-to-one relationship
-- the data does not have.
--
-- `source_pk` here is therefore PROVENANCE, not identity: it names the source
-- row the stored target was taken from. The identity — and the idempotency — is
-- the scope key above. `ix_response_sla_policy_source` is a plain lookup index
-- so a disputed target still resolves back to its source row by local join.
--
-- The importer owns the collapse. It deduplicates by scope, it picks the lowest
-- source id so a re-run is deterministic, and it REFUSES THE WHOLE IMPORT if
-- two rows collapsing to one scope disagree on `hours` — see
-- `lib/domain/sla-policy.ts`. A future edit giving sales@ 16h and german@ 12h
-- fails loudly rather than storing whichever sorted first.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT STORED
-- ---------------------------------------------------------------------------
--   `key_value`   a customer's marketplace message id. Never selected.
--   `reason`      quoted phrases from customer messages. Never selected.
--   `situation`   'default' on all 42. A column holding one value teaches
--                 readers to ignore it; instead the mapper REJECTS a response
--                 row whose situation is not 'default', because a new
--                 applicability dimension is a thing to notice, not to store.
--   `created_at`  the source's own stamp is a one-shot 2026-04-15 and is not a
--                 usable watermark. `imported_at` records what CST did instead.
--
-- ---------------------------------------------------------------------------
-- COVERAGE IS INCOMPLETE, AND THAT IS DATA, NOT A BUG
-- ---------------------------------------------------------------------------
-- After a full import, CST accounts WITHOUT a target are:
--
--   shopify  109, 198, 233, 245, 248   (5 of 8 — their mailboxes were created
--                                       2026-04-21, six days after the policy)
--   bandq    104                       (no sla_configs row of either type)
--   temu     248                       (no sla_configs row of either type)
--
-- The absence is the point. A conversation on those accounts resolves to NO
-- policy row, and the reader must return "no approved target" rather than a
-- default — `missing`, never `met` and never `missed`. Seeding a fallback here
-- would invent a promise nobody made.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source databases, which are strictly read-only.
--   * Purely additive: alters and drops nothing from 0001-0018.
--   * Writes no row. The table is created EMPTY; the importer is separate and
--     dry-run by default.
--   * Adds no send/outbound/transmission structure.
--   * Stores no credential, no contact detail and no customer message content.
--   * Changes no existing SLA rule and computes no compliance percentage.
--   * Runs in one transaction; re-runnable.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cst_app.response_sla_policy (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Which marketplace the target applies to. The five-value vocabulary is
  -- shared with `sync_state` and `agent_activity` deliberately, so one word
  -- means one thing across cst_app. Only 'ebay', 'amazon' and 'shopify' can be
  -- populated today: the source holds no B&Q or Temu policy of either type, and
  -- neither marketplace carries an outbound message to measure against anyway.
  marketplace     text        NOT NULL,

  -- The seller account, as numbered by the source. NULL = the whole channel;
  -- see the header. Not a foreign key: `conversations.sub_source_id` is a plain
  -- column too, and account ids are NOT unique across marketplaces — 104 is a
  -- Shopify account and a B&Q one, 248 is Shopify and Temu. Every lookup must
  -- therefore key on (marketplace, sub_source_id), never on the id alone.
  sub_source_id   integer,

  -- The source's own vocabulary, kept verbatim. 'weekday' would read better and
  -- would put a translation step in every query, screen and report that ever
  -- compares this against `sla_configs`.
  week_scope      text        NOT NULL,

  -- The approved target. Hours because that is the unit the business agreed in;
  -- converting to minutes here would hide the approved figure behind
  -- arithmetic, the same reasoning as `RESPONSE_SLA_MINUTES = 24 * 60`.
  target_hours    integer     NOT NULL,

  -- Provenance, so a disputed target resolves to the row that set it by a LOCAL
  -- join rather than a trip back through an account capped at 100 queries an
  -- hour. Same reasoning as `conversation_message_media.source_ref_id` in 0016.
  source_database text        NOT NULL DEFAULT 'message_app',
  source_table    text        NOT NULL DEFAULT 'sla_configs',
  source_pk       text        NOT NULL,

  -- The mailbox `sub_source_id` was resolved through, for Shopify and Amazon.
  -- NULL for eBay, whose rows state the account directly. Without it, checking
  -- why a Shopify account has the target it has means re-reading `mails`.
  source_mail_id  integer,

  -- How many agreeing source rows collapsed into this one. 1 everywhere except
  -- Shopify account 104, which is 3. Stored rather than logged because a log
  -- line scrolls away and a reader of this table would otherwise have no way to
  -- tell a single-source target from a three-way agreement.
  source_rows     integer     NOT NULL DEFAULT 1,

  imported_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_response_sla_policy_marketplace
    CHECK (marketplace IN ('ebay', 'amazon', 'shopify', 'bandq', 'temu')),

  CONSTRAINT ck_response_sla_policy_week_scope
    CHECK (week_scope IN ('week', 'weekend')),

  -- A target of zero or less is not a promise, it is a broken import.
  CONSTRAINT ck_response_sla_policy_target_positive
    CHECK (target_hours > 0),

  -- Account ids are positive at source, and -1 is the sentinel the unique index
  -- below coalesces to. Admitting a negative id would let a real row collide
  -- with the channel-wide one.
  CONSTRAINT ck_response_sla_policy_sub_source_positive
    CHECK (sub_source_id IS NULL OR sub_source_id > 0),

  CONSTRAINT ck_response_sla_policy_source_rows_positive
    CHECK (source_rows > 0)
);

COMMENT ON TABLE cst_app.response_sla_policy IS
  'The response-time target stated by the message application, per marketplace and seller account. A copy of what the policy says; not a statement about which policy CST measures against. Holds no customer message content.';

COMMENT ON COLUMN cst_app.response_sla_policy.sub_source_id IS
  'Seller account as numbered by the source. NULL means the target applies to the whole channel — the verified reading for Amazon, whose mails row carries no account. Not unique across marketplaces: always key on (marketplace, sub_source_id).';

COMMENT ON COLUMN cst_app.response_sla_policy.week_scope IS
  'Source vocabulary, verbatim: week | weekend. Which calendar day an arrival falls on needs a business timezone that is not yet approved — see handover A3.';

COMMENT ON COLUMN cst_app.response_sla_policy.source_pk IS
  'sla_configs.id the target was taken from. PROVENANCE, not identity: three Shopify mailboxes collapse to one account, so the mapping is many-to-one and this column is deliberately not unique.';

COMMENT ON COLUMN cst_app.response_sla_policy.source_rows IS
  'How many agreeing source rows collapsed into this one. 3 for Shopify account 104, 1 everywhere else. The importer refuses the run if collapsing rows disagree on the target.';

-- -----------------------------------------------------------------------------
-- The real identity of a policy row, and what makes the import idempotent.
--
-- coalesce(), not a plain column list: PostgreSQL treats NULLs as distinct in a
-- unique index, so Amazon's channel-wide row would be insertable twice and
-- every re-run would append another pair.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_response_sla_policy_scope
  ON cst_app.response_sla_policy (marketplace, coalesce(sub_source_id, -1), week_scope);

-- Provenance lookup. Plain, not unique — see the header.
CREATE INDEX IF NOT EXISTS ix_response_sla_policy_source
  ON cst_app.response_sla_policy (source_database, source_table, source_pk);

COMMIT;
