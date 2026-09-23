-- =============================================================================
-- 0016_conversation_message_media.up.sql
--
-- eBay customer message images: the photographs a customer attached to a
-- marketplace message, recorded against the message they arrived on.
--
-- TARGET:  the APPLICATION database (varmen_db), schema cst_app ONLY.
-- STATUS:  APPLIED 2026-09-23 to varmen_db, schema cst_app. Reviewed and
--          approved. Created one table, three indexes and four COMMENTs; the
--          cst_app base-table count went 27 -> 28 and no existing table gained,
--          lost or changed a row. No data was imported: the table was deployed
--          empty.
--
-- WHY A TABLE IS REQUIRED, and why 0007's column is not enough.
--
--   0007 added `conversation_messages.attachments jsonb` and justified a column
--   rather than a table in one sentence: "an attachment has no identity of its
--   own in the source — it is an ordered array on the message row, with no id
--   and no metadata." That is exactly true of Shopify and B&Q, whose attachment
--   URLs are a JSONB array on the message row, and this migration leaves both
--   of them, and that column, completely untouched.
--
--   It is NOT true of eBay. eBay media lives in `message_app.files`, one row per
--   image, with its own primary key, its own `view_order`, and a UNIQUE index on
--   (ref_id, view_order, type). Verified live: 12,961 rows carrying a
--   `real_url`, across 9,157 distinct messages, `view_order` populated on every
--   single one. Flattening rows that HAVE an identity into an array would throw
--   away the only key that makes the sync idempotent, and there would then be no
--   way to tell a re-read from a new image.
--
--   So this table is 0007's reasoning applied to a source that is shaped
--   differently, not a reversal of it. Where the source gives identity, keep it.
--
-- WHAT IS AND IS NOT STORED
--
--   Stored: the media URL verbatim, its position in the message, the
--   `files.id` it came from, and the `files.ref_id` it was matched on.
--
--   NOT stored: the image itself. No bytea, no path, no local copy. These URLs
--   point at storage the business and eBay already run; this application copies
--   nothing and hosts nothing. If an image is removed at source the link stops
--   resolving, which is the correct behaviour — 0007 settled that and it is
--   unchanged here.
--
--   NOT stored: the host. It is a substring of `media_url` and deriving it costs
--   nothing, so storing it would create a second copy of one fact that can drift
--   from the first. Same reasoning as 0014 storing one reminder state and
--   deriving three.
--
--   NOT stored: who sent it. `files.submitter` is NULL on every one of the
--   12,961 message-media rows — the BUYER/SELLER marker exists only on eBay's
--   RETURN images, which are a different thing and are deliberately not in this
--   migration. Whether a customer or CST attached an image is already a fact on
--   the parent row, `conversation_messages.direction`, and must be read from
--   there. A second, weaker copy of that answer is how a CST photograph ends up
--   labelled as a customer's.
--
-- NO RETURN-EVIDENCE TABLE HERE, DELIBERATELY.
--   eBay return photographs (`files.type = 1`, keyed to `ebay_returns.return_id`)
--   are NOT message attachments and are not stored by this migration. They are
--   already readable through `lib/repositories/ebay-image-repository.ts`, which
--   requires a verified order number precisely because `ebay_returns` has no
--   buyer column and item_id alone matches other buyers' photographs. Copying
--   them into cst_app would duplicate a working read path and put a
--   cross-customer risk behind a weaker guard.
--
-- NO DUPLICATE MESSAGE STORAGE. There is no body, no subject, no sender, no
-- timestamp and no order id. Every one of those already exists on
-- `conversation_messages`; this table adds images to a message and nothing else.
--
-- THE MESSAGE MUST ALREADY EXIST. `conversation_message_id` is NOT NULL with a
-- real foreign key, so an image cannot be recorded against a message this
-- application has not ingested. Verified live: of 9,157 messages carrying media,
-- 1,095 are currently present in cst_app (11.9%) — the rest predate CST's
-- ingestion window. The importer must skip those and retry them as history
-- deepens; it must never invent a message to hang an image on.
--
-- SAFETY CONTRACT
--   * Creates objects in cst_app and nowhere else.
--   * Does NOT reference issue_tracking, poc_listing, or public.
--   * Never targets the live source databases, which are strictly read-only.
--     No MySQL object is created, altered or written by this or any migration.
--   * Purely additive: alters and drops nothing from 0001-0015. In particular
--     `conversation_messages.attachments` and its CHECK and index are untouched.
--   * Adds no send/outbound/transmission structure.
--   * Deletes no row and drops no column.
--   * Runs in one transaction; re-runnable.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cst_app.conversation_message_media (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The message this image arrived on. CASCADE because an image has no meaning
  -- once its message is gone, and no other table points at it.
  conversation_message_id bigint      NOT NULL,

  -- Source identity, in the same three-part shape `conversation_messages` uses
  -- (source_database, source_schema, source_table, source_pk). MySQL has no
  -- schema layer, so `source_database` carries the database name and there is
  -- deliberately no `source_schema` column rather than a column filled with a
  -- repeated placeholder.
  source_database         text        NOT NULL,
  source_table            text        NOT NULL,
  source_pk               text        NOT NULL,

  -- The source's OWN join key: `message_app.files.ref_id`, which for media rows
  -- is eBay's `ext_message_id`.
  --
  -- WHY IT IS STORED RATHER THAN DERIVED. Without it, re-checking that a row is
  -- still attached to the right message means walking back through MySQL:
  -- conversation_message_id -> conversation_messages.external_message_id ->
  -- ebay_message_headers.message_id -> .ext_message_id -> files.ref_id. That is
  -- a two-database round trip per row, against a source that enforces
  -- `max_connections_per_hour = 50` on this account. Keeping the key the match
  -- was made on turns reconciliation into a local join.
  --
  -- `bigint`, matching `ebay_message_headers.ext_message_id`, so the
  -- reconciliation join is numeric on both sides. node-postgres returns it as a
  -- string, which is the same treatment the eBay adapter already gives this
  -- value via its `::text` casts — no precision is lost in storage or in
  -- transit.
  --
  -- NOT NULL: it is the key the row was matched on. A media row that cannot say
  -- what it was attached to is an import failure, not a nullable field.
  source_ref_id           bigint      NOT NULL,

  -- The URL verbatim. Not parsed, not rewritten, not proxied.
  media_url               text        NOT NULL,

  -- The image's position within its message. Populated on every source row
  -- (0 NULLs across 12,961), so NOT NULL is a fact here rather than a hope.
  view_order              integer     NOT NULL,

  ingested_at             timestamptz NOT NULL DEFAULT now(),

  -- Advanced every time the sync still sees this row at source. Lets a later
  -- reconciliation pass tell "removed upstream" from "never imported" without
  -- deleting anything on a guess.
  last_seen_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_conversation_message_media_message
    FOREIGN KEY (conversation_message_id)
    REFERENCES cst_app.conversation_messages (id) ON DELETE CASCADE,

  -- A URL is the whole point of the row; an empty one is a failed import that
  -- must not be stored as a success.
  CONSTRAINT ck_conversation_message_media_url_present
    CHECK (length(btrim(media_url)) > 0),

  -- Every observed media URL is https (i.ebayimg.com, zstoreservice.vip.ebay.com
  -- and the business's own object storage). Anything else is a source change
  -- that a person should look at, not something to render in a reviewer's
  -- browser.
  CONSTRAINT ck_conversation_message_media_url_https
    CHECK (media_url LIKE 'https://%'),

  CONSTRAINT ck_conversation_message_media_view_order
    CHECK (view_order >= 0)
);

COMMENT ON TABLE cst_app.conversation_message_media IS
  'Images attached to a marketplace message, one row per image. URLs only: the files are not copied here. Return-case photographs are NOT stored here.';

COMMENT ON COLUMN cst_app.conversation_message_media.source_pk IS
  'Primary key of the source media row (message_app.files.id), as text. The idempotency key for the sync.';

COMMENT ON COLUMN cst_app.conversation_message_media.source_ref_id IS
  'The source join key (message_app.files.ref_id = eBay ext_message_id) this row was matched on. Stored so reconciliation is a local join instead of a MySQL round trip.';

COMMENT ON COLUMN cst_app.conversation_message_media.media_url IS
  'Attachment URL from the source, verbatim. A location, never a customer identity; nothing may derive a customer fact from one.';

COMMENT ON COLUMN cst_app.conversation_message_media.last_seen_at IS
  'Last time the sync observed this row at source. Reconciliation reads it; nothing deletes on it automatically.';

-- -----------------------------------------------------------------------------
-- Idempotency.
--
-- The same shape as `uq_conversation_messages_source_identity`, minus the schema
-- component MySQL does not have. This is what makes a re-run an upsert instead
-- of a duplicate, and it does not depend on the sync watermark being correct.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_message_media_source_identity
  ON cst_app.conversation_message_media (source_database, source_table, source_pk);

-- -----------------------------------------------------------------------------
-- The only read path the conversation view needs: every image for a message, in
-- the order the customer sent them.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_conversation_message_media_message
  ON cst_app.conversation_message_media (conversation_message_id, view_order);

-- -----------------------------------------------------------------------------
-- Reconciliation's read: every image imported for one source message.
--
-- This is what makes `source_ref_id` worth storing. "Has this message gained or
-- lost an image at source?" is answered by comparing one local lookup against
-- one MySQL page, rather than by resolving each row back through two databases.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_conversation_message_media_source_ref
  ON cst_app.conversation_message_media (source_ref_id);

COMMIT;
