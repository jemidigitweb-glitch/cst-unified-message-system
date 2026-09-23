-- =============================================================================
-- 0018_agent_directory.up.sql
--
-- The minimum needed to turn an agent id into a name a dashboard can print.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  APPLIED 2026-09-23 to varmen_db, schema cst_app. The decision below
--          was reviewed and the separate directory was approved: `app_users` is
--          NOT the home for these ids and was left untouched. Created one
--          table, two indexes and four COMMENTs; the cst_app base-table count
--          went 29 -> 30 and no existing table gained, lost or changed a row.
--          No data was imported: the table was deployed empty.
--
--          0016 and 0017 never depended on this migration —
--          `agent_activity.source_user_id` is a plain nullable column with no
--          foreign key to this table — so this remains independently
--          reversible.
--
-- ---------------------------------------------------------------------------
-- THE DECISION THIS MIGRATION IS ASKING FOR
-- ---------------------------------------------------------------------------
-- `cst_app.app_users` already exists and looks like the right home. It is not,
-- and the reason is specific rather than stylistic.
--
--   `app_users.management_user_id` is documented at 0001 as a logical reference
--   to `issue_tracking.management_users.user_id`, and there is a partial UNIQUE
--   index enforcing one row per value. `issue_tracking` is NOT a system this
--   project is connected to. Its 12 rows are not CST agents.
--
--   The two id spaces OVERLAP, and every overlapping id names a DIFFERENT
--   PERSON. Verified live against both:
--
--     id   issue_tracking.management_users   order_management.user
--     ---  -------------------------------   ---------------------
--       1  TestAdmin (admin)                 ramesh
--      41  Suman                             arivarasan
--      42  Varman                            Dilaksi
--      43  Bietrick                          mathusha   <- 17,788 CS actions
--      44  Janani                            Rakesh
--      45  Luxsika                           Rakesh
--      46  Manoranjani                       thushyanthini
--      47  Mayurika                          Thuventhini
--      48  Muguntha                          sathees
--      49  Rajiv                             Paulroshan
--      50  Arun                              satheesvaran
--      57  Nandhi                            Anith
--
--   Writing order_management ids into that column would produce rows that are
--   indistinguishable from the authority it documents, and the unique index
--   would silently conflate two different people behind one number. `app_users`
--   is therefore left completely untouched by this migration — not altered, not
--   populated, not re-commented.
--
-- ---------------------------------------------------------------------------
-- WHY NOT JUST READ `ledsone.staff.users`, WHICH ALREADY EXISTS
-- ---------------------------------------------------------------------------
-- A fair question, and the preferred answer if it held: CST already has a
-- read-only pool on `ledsone`, `staff.users` is a projection of the same
-- directory, and its `id` DOES correspond exactly (43 = mathusha, 210 =
-- thurshikan, 86 = admin, all confirmed). Reading it live would need no table
-- at all.
--
-- It was measured, and it is not sufficient:
--
--   * STALE BY ~2.5 MONTHS. max(updated_at) = 2026-07-09; max(id) = 240 against
--     256 live.
--   * MISSING 3 OF THE 13 AGENTS who appear in the activity log — including
--     user 241, Kartheepan, the second most active eBay agent (774 replies
--     across 386 conversations), plus 22 Torin and 248 sajeesan2.
--   * CONTENT DIVERGES. 174 gnanatheepan reads Active there and Remove in the
--     live directory; 7 Muguntha reads Admin there and User live.
--
-- A dashboard that cannot name its second-busiest agent is not shippable, and
-- one that prints a stale employment status about a named person is worse than
-- one that prints nothing. So this is a small local directory, refreshed from
-- the live authority, rather than a live read of a lagging copy.
--
-- IF REVIEW DECIDES the ledsone projection is good enough, or that it will be
-- refreshed, this migration should be rejected and the reader should join
-- `ledsone.staff.users` through the existing source pool instead. That is a
-- genuine option and it costs one fewer table.
--
-- ---------------------------------------------------------------------------
-- WHAT IS AND IS NOT STORED
-- ---------------------------------------------------------------------------
--   Stored: the source system, the source id, a display name, whether the
--   account is active, and when it was refreshed. Five columns.
--
--   NOT stored, and none of it is optional to omit: `user_password`, `token`,
--   `verification_code`, `fcm_token`, `user_email`, `user_contact`,
--   `user_gender`, `user_branch`, `user_image`, `attempts`, `last_attempt`.
--   Credentials must never leave the system that owns them, and this
--   application has no use for an agent's phone number, gender or address. A
--   column that is not here cannot leak.
--
--   NOT an authentication table. There is no credential, no session, no login
--   and nothing a sign-in could read. Authentication, if it is ever built,
--   verifies against the owning system directly; this is a lookup for display.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Does NOT alter, populate or re-comment cst_app.app_users.
--   * Never targets the live source databases, which are strictly read-only.
--   * Purely additive: alters and drops nothing from 0001-0017.
--   * Adds no send/outbound/transmission structure.
--   * Stores no credential and no contact detail.
--   * Runs in one transaction; re-runnable.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cst_app.agent_directory (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Which directory the id belongs to. Present so a second source can never be
  -- silently merged into the first — the mistake this whole migration exists to
  -- avoid. NOT NULL with no default: the importer must say.
  source_system  text        NOT NULL,
  source_user_id bigint      NOT NULL,

  -- What to print. Built by the importer from the source's name fields; an
  -- empty one is a failed import, not a nameless agent.
  display_name   text        NOT NULL,

  -- What the application reads.
  active         boolean     NOT NULL,

  -- The raw status the boolean was derived from, kept because the source
  -- vocabulary is inconsistent — 'Active' (201), 'Remove' (30), 'Removed' (2)
  -- and one NULL — so a reviewer can see what 'active = false' was based on
  -- instead of trusting the importer's reading of two spellings of one word.
  source_status  text,

  synced_at      timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_agent_directory_display_name_present
    CHECK (length(btrim(display_name)) > 0),

  CONSTRAINT ck_agent_directory_source_system
    CHECK (source_system IN ('order_management'))
);

COMMENT ON TABLE cst_app.agent_directory IS
  'Minimal display directory for CST agent ids. Holds no credential, no contact detail and no authentication state. Not related to cst_app.app_users.';

COMMENT ON COLUMN cst_app.agent_directory.source_user_id IS
  'Agent id as numbered by source_system. Matches cst_app.agent_activity.source_user_id. Logical reference; the owning database is MySQL and read-only.';

COMMENT ON COLUMN cst_app.agent_directory.source_status IS
  'Source status verbatim. Evidence for `active`, never read by the application.';

COMMENT ON COLUMN cst_app.agent_directory.synced_at IS
  'When this row was last refreshed from the source directory. A stale row is a reportable state, not a silent one.';

-- -----------------------------------------------------------------------------
-- One row per person per directory. The compound key is the point: it makes a
-- collision between two source systems a constraint violation rather than a
-- misattributed dashboard row.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_directory_source_identity
  ON cst_app.agent_directory (source_system, source_user_id);

COMMIT;
