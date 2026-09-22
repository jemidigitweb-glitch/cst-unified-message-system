-- =============================================================================
-- 0011_post_dispatch_automation.up.sql
--
-- Post-dispatch automation: a dispatched shipment is scheduled, rechecked when
-- due, and processed against a saved message template.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
--
-- THERE IS NO TRANSPORT IN THIS PHASE, AND THE SCHEMA SAYS SO IN THE ONE PLACE
-- IT MATTERS. `automation_items.test_mode` is NOT NULL, has no default, and is
-- constrained so that a row can only reach `sent` while it is true. So every
-- processed row in this database states, as a stored fact rather than as a
-- convention, that it was processed locally and that no message left the
-- system. The day a reviewed marketplace transport exists, that constraint is
-- what has to be deliberately changed — it cannot be forgotten.
--
-- WHY THE STATUS IS `sent` AT ALL, given the above. It is the lifecycle
-- vocabulary this automation was specified with, and the alternative — a
-- private synonym — would have every screen, query and report translate it.
-- The honesty is carried by `test_mode` and `processed_mode`, which travel with
-- the row everywhere it goes, rather than by the status word alone.
--
-- NO AI, NO DRAFTS, NO REVIEW. This automation renders a saved template and
-- records the result. It holds no revisions, no citations and no review state.
-- The CST conversation draft workflow (0004, 0005) is untouched and continues
-- to serve customer replies; nothing here reads or writes any of its tables.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source database, which is strictly read-only.
--     Source rows are referenced by plain id columns, never by foreign key.
--   * Purely additive: alters and drops nothing from 0001-0010.
--   * No functions or triggers.
--   * Runs in one transaction; re-runnable via IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. automation_templates
--
-- The saved, approved message. Versioned, because an item records the version
-- it was processed against: editing a template tomorrow must not silently
-- rewrite what was prepared today.
--
-- `body_template` carries {{placeholders}} which are substituted from VERIFIED
-- SOURCE VALUES only — see `renderTemplate`. A placeholder with no verified
-- value fails the item rather than rendering a blank or a guess.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.automation_templates (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  template_key        text        NOT NULL,
  version             integer     NOT NULL,
  name                text        NOT NULL,

  body_template       text        NOT NULL,
  -- Placeholders that MUST resolve. An item missing one of these fails.
  required_variables  text[]      NOT NULL DEFAULT '{}',

  approved            boolean     NOT NULL DEFAULT false,
  active              boolean     NOT NULL DEFAULT true,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_automation_templates_key_present
    CHECK (length(btrim(template_key)) > 0),
  CONSTRAINT ck_automation_templates_name_present
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT ck_automation_templates_body_present
    CHECK (length(btrim(body_template)) > 0),
  CONSTRAINT ck_automation_templates_version_positive
    CHECK (version >= 1),
  CONSTRAINT ck_automation_templates_variables_nonblank
    CHECK (array_position(required_variables, '') IS NULL),

  -- An inactive template may stay approved (it governed past items), but an
  -- UNAPPROVED one must never be live.
  CONSTRAINT ck_automation_templates_active_needs_approval
    CHECK (NOT active OR approved)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_templates_key_version
  ON cst_app.automation_templates (template_key, version);

INSERT INTO cst_app.automation_templates (
  template_key, version, name, body_template, required_variables, approved, active
) VALUES (
  'post_dispatch_update',
  1,
  'Post-dispatch update',
  'Hello {{customer_name}},' || chr(10) || chr(10) ||
  'Your order {{order_number}} has been dispatched.' || chr(10) || chr(10) ||
  'If anything is not right with your order, reply to this message and we will help.' || chr(10) || chr(10) ||
  'Kind regards,' || chr(10) ||
  'Customer Service',
  ARRAY['customer_name', 'order_number'],
  true,
  true
)
ON CONFLICT (template_key, version) DO NOTHING;

INSERT INTO cst_app.automation_templates (
  template_key, version, name, body_template, required_variables, approved, active
) VALUES (
  'post_dispatch_update_with_tracking',
  1,
  'Post-dispatch update with tracking',
  'Hello {{customer_name}},' || chr(10) || chr(10) ||
  'Your order {{order_number}} was dispatched on {{dispatch_date}} with {{courier}}.' || chr(10) ||
  'Your tracking reference is {{tracking_number}}.' || chr(10) || chr(10) ||
  'If anything is not right with your order, reply to this message and we will help.' || chr(10) || chr(10) ||
  'Kind regards,' || chr(10) ||
  'Customer Service',
  ARRAY['customer_name', 'order_number', 'dispatch_date', 'courier', 'tracking_number'],
  true,
  true
)
ON CONFLICT (template_key, version) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 2. automation_settings
--
-- One row per automation. Seeded so that a fresh install processes nothing:
-- switched off, no storefront in scope, and no `not_before`.
--
-- `not_before` IS THE BACKFILL GUARD. The source holds 600,914 dispatched
-- shipments with a recorded dispatch time, every one of them older than
-- `dispatched_at + 24h` and therefore immediately due. A scan without a floor
-- would schedule all of them, so the scan refuses until an operator sets one.
--
-- `test_mode` DEFAULTS TRUE and is the safe value: there is no transport, so
-- the only thing this automation can honestly do is process locally.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.automation_settings (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  automation_key      text        NOT NULL,

  enabled             boolean     NOT NULL DEFAULT false,
  delay_hours         integer     NOT NULL DEFAULT 24,

  -- Source storefront ids. A plain integer array, never a cross-database FK.
  enabled_sub_sources integer[]   NOT NULL DEFAULT '{}',

  -- NAIVE, like every other source timestamp in this schema: it is compared
  -- against `order_management.order_info.shipped_time`, which the source stores
  -- without a zone. Casting either to timestamptz would shift the comparison.
  not_before          timestamp,

  -- The zone those naive source timestamps are written in. Needed to turn a
  -- dispatch time into a real instant for scheduling. Europe/Berlin is the
  -- source server's zone, recorded in migrations/README.md.
  dispatch_time_zone  text        NOT NULL DEFAULT 'Europe/Berlin',

  -- Which saved template this automation renders. Unset refuses the scan, the
  -- same discipline as `not_before`: a missing choice is a refusal, never a
  -- silent default.
  template_id         bigint,

  test_mode           boolean     NOT NULL DEFAULT true,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_automation_settings_template
    FOREIGN KEY (template_id) REFERENCES cst_app.automation_templates (id) ON DELETE RESTRICT,

  CONSTRAINT ck_automation_settings_key_present
    CHECK (length(btrim(automation_key)) > 0),

  -- A year is already far beyond any post-dispatch follow-up, and the bound
  -- stops a mistyped value scheduling an item past the heat death of the queue.
  CONSTRAINT ck_automation_settings_delay_hours
    CHECK (delay_hours >= 0 AND delay_hours <= 8760),

  CONSTRAINT ck_automation_settings_time_zone_present
    CHECK (length(btrim(dispatch_time_zone)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_settings_key
  ON cst_app.automation_settings (automation_key);

COMMENT ON COLUMN cst_app.automation_settings.not_before IS
  'Backfill guard. NULL refuses the scan outright rather than scheduling every historical dispatch.';
COMMENT ON COLUMN cst_app.automation_settings.test_mode IS
  'True means process locally and transmit nothing. There is no transport in this phase, so true is the only honest value.';

INSERT INTO cst_app.automation_settings (
  automation_key, enabled, delay_hours, enabled_sub_sources, not_before, template_id, test_mode
)
SELECT 'post_dispatch_message', false, 24, '{}', NULL, t.id, true
  FROM cst_app.automation_templates t
 WHERE t.template_key = 'post_dispatch_update' AND t.version = 1
ON CONFLICT (automation_key) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 3. automation_items
--
-- One record per dispatched shipment per automation. The natural key is the
-- SHIPMENT, not the order: an order can be dispatched in several parcels (3,506
-- orders in the source have two completed shipments, and one has ten), and each
-- parcel is its own dispatch event.
--
-- `uq_automation_items_shipment` is what makes a repeated scan idempotent at the
-- database rather than in the application. The application checks too — see
-- `insertScheduledItem` — but a check plus a constraint is the only combination
-- where two concurrent scans cannot both win.
--
-- SOURCE IDS ARE PLAIN COLUMNS. There is no foreign key to order_management or
-- customers, and there must never be: those live in a different, read-only
-- database that this schema may not couple itself to.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cst_app.automation_items (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  automation_key      text        NOT NULL,

  -- Channel and storefront, both copied from the source at scan time.
  channel             text        NOT NULL,
  sub_source_id       integer     NOT NULL,

  source_order_id     bigint      NOT NULL,
  source_order_number text,
  source_shipment_id  bigint      NOT NULL,

  -- A DISPLAY NAME AND NOTHING ELSE. No email address, no postal address, no
  -- phone number, no marketplace handle: a greeting needs a name, and a
  -- dispatch update needs nothing further.
  recipient_name      text,

  -- Copied verbatim from `order_management.order_info.shipped_time`. NAIVE.
  dispatched_at       timestamp   NOT NULL,
  -- Which field the dispatch time came from, so a later change of source is a
  -- visible change of record rather than a silent reinterpretation.
  dispatch_source     text        NOT NULL DEFAULT 'order_info_shipped_time',
  -- The zone used to turn `dispatched_at` into `scheduled_at`, recorded so the
  -- arithmetic can be checked long after the setting has been changed.
  dispatch_time_zone  text        NOT NULL,

  -- dispatched_at + delay_hours, resolved to a real instant. NEVER scan time.
  scheduled_at        timestamptz NOT NULL,

  -- Stamped when the item is scheduled, so changing the selected template
  -- tomorrow does not rewrite the provenance of an item queued today.
  template_id         bigint      NOT NULL,
  template_version    integer     NOT NULL,

  status              text        NOT NULL DEFAULT 'scheduled',

  -- WHETHER THIS ROW WAS PROCESSED WITHOUT A TRANSPORT. No default: every
  -- insert must state it, because a row that forgot to would be the one row
  -- nobody could account for.
  test_mode           boolean     NOT NULL,
  -- The same fact in words, for anything that reads a row without reading this
  -- schema. Only one value is reachable in this phase.
  processed_mode      text,
  processed_at        timestamptz,
  -- The rendered template, stored so an operator can see exactly what was
  -- produced. It was produced, not delivered.
  rendered_body       text,

  -- Why the recheck stopped it. Set only when status = 'skipped'.
  skip_reason         text,
  -- Why processing failed. Set only when status = 'failed'.
  last_error          text,
  -- An operator stopped it before it was processed. Distinct from `skipped`:
  -- one is a decision, the other is the system reporting a fact.
  cancelled_at        timestamptz,
  cancelled_reason    text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_automation_items_template
    FOREIGN KEY (template_id) REFERENCES cst_app.automation_templates (id) ON DELETE RESTRICT,

  CONSTRAINT ck_automation_items_key_present
    CHECK (length(btrim(automation_key)) > 0),

  CONSTRAINT ck_automation_items_channel
    CHECK (channel IN ('ebay', 'amazon', 'shopify', 'bandq', 'temu')),

  CONSTRAINT ck_automation_items_dispatch_source
    CHECK (dispatch_source = 'order_info_shipped_time'),

  -- THE WHOLE VOCABULARY, exhaustively. There is deliberately no 'sending',
  -- no 'drafting', no 'pending_review' and no 'reviewed'.
  CONSTRAINT ck_automation_items_status
    CHECK (status IN ('scheduled', 'sent', 'skipped', 'failed', 'cancelled')),

  -- THE SAFETY CONSTRAINT OF THIS MIGRATION. A row may only reach `sent` while
  -- it is a test-mode row, so the database itself refuses to record a real
  -- transmission while no transport exists. Removing this is what building one
  -- would have to start with.
  CONSTRAINT ck_automation_items_sent_requires_test_mode
    CHECK (status <> 'sent' OR test_mode),

  -- A processed row states how it was processed, when, and what it produced.
  CONSTRAINT ck_automation_items_processed_pair
    CHECK (
      (status = 'sent')
        = (processed_mode IS NOT NULL AND processed_at IS NOT NULL AND rendered_body IS NOT NULL)
    ),

  -- The only processing mode this phase has.
  CONSTRAINT ck_automation_items_processed_mode
    CHECK (processed_mode IS NULL OR processed_mode = 'test_mode'),

  CONSTRAINT ck_automation_items_skip_reason_pair
    CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),

  CONSTRAINT ck_automation_items_failure_pair
    CHECK ((status = 'failed') = (last_error IS NOT NULL)),

  -- A cancelled row must record when that happened. Other statuses MAY still
  -- carry `cancelled_at`: Undo Cancel returns the row to `scheduled` without
  -- erasing the cancellation, so the page can say it was restored.
  CONSTRAINT ck_automation_items_cancel_pair
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);

COMMENT ON TABLE cst_app.automation_items IS
  'Post-dispatch automation records. Test-mode processing only: no row here represents a message delivered to a customer.';
COMMENT ON COLUMN cst_app.automation_items.rendered_body IS
  'The template as rendered from verified source values. Produced, never delivered.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_items_shipment
  ON cst_app.automation_items (automation_key, sub_source_id, source_shipment_id);

CREATE INDEX IF NOT EXISTS ix_automation_items_due
  ON cst_app.automation_items (scheduled_at, id)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS ix_automation_items_status
  ON cst_app.automation_items (automation_key, status, dispatched_at DESC);

COMMIT;
