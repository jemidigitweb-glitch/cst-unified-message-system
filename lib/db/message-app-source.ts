import type { MySqlQueryable } from "@/lib/db/order-source";
import { EBAY_SOURCE_ID, type SourceActivityRow } from "@/lib/domain/agent-activity";
import {
  RESPONSE_POLICY_TYPE,
  type SourceMailRow,
  type SourceSlaConfigRow,
} from "@/lib/domain/sla-policy";

/**
 * The minimum needed to READ eBay agent activity out of MariaDB.
 *
 * A reader and nothing else. The single statement below is a constant; there is
 * no INSERT, UPDATE, DELETE, CREATE, ALTER or DROP in this file and no code
 * path that could build one.
 *
 * ------------------------------------------------------------------------
 * THE QUERY BUDGET IS THE BINDING CONSTRAINT, NOT THE ROW COUNT
 * ------------------------------------------------------------------------
 * This account carries `MAX_QUERIES_PER_HOUR 100` alongside
 * `MAX_CONNECTIONS_PER_HOUR 50`. One hundred. Not per connection — per hour,
 * across everything.
 *
 * So the usual instinct is exactly backwards: small pages are the expensive
 * choice. 17,815 eBay rows at 200 per page is 90 queries and very nearly the
 * whole hour's budget for one import; at 2,000 per page it is 9. The default
 * page size is therefore large on purpose, and the caller counts what it
 * spends.
 *
 * Read-only comes from the GRANTS — `USAGE ON *.*` plus `SELECT` on 58
 * `message_app` tables and 2 in `listing_management`, and nothing else.
 * MariaDB 10.4 has no `transaction_read_only` to pin, so
 * `assertOrderSourceReadOnly` (shared with the staff reader) verifies the
 * privilege list instead of trusting it.
 *
 * ------------------------------------------------------------------------
 * THE PAYLOAD NEVER LEAVES MYSQL
 * ------------------------------------------------------------------------
 * `message_app_logs.data` is a JSON blob holding `replied_message_text` — the
 * full text of the reply sent to a customer — plus their email address, the
 * subject line and the message being answered. Selecting it and picking a field
 * in JavaScript would pull all of that across the wire and into process memory.
 *
 * `JSON_UNQUOTE(JSON_EXTRACT(...))` runs in the database and returns ONE
 * identifier. The body is never transferred, never logged and never stored.
 */

/**
 * One page of eBay activity, oldest id first.
 *
 * KEYSET PAGINATION on the primary key — the only index this table has besides
 * none: `message_app_logs` carries `PRIMARY(id)` and nothing else, so `id > ?`
 * is the one access path that is not a full scan. An OFFSET scan would also
 * re-read everything it skipped and shift every later page if a row arrived
 * mid-run, silently dropping an agent's work.
 *
 * `source = ?` is bound rather than inlined even though it is a constant here,
 * so the statement has no literal that a later edit could turn into a hole.
 *
 * SEVEN VALUES, and `data` is not among them — only one field extracted from
 * it. `JSON_EXTRACT` on a JSON null yields the string `null` rather than SQL
 * NULL; that is left for `usableExtMessageId` to reject rather than papered
 * over with `NULLIF` here, so the rule lives in one reviewable place.
 */
const SELECT_EBAY_ACTIVITY = `
  SELECT id                                                  AS source_pk,
         \`user\`                                             AS source_user_id,
         action                                              AS action,
         DATE_FORMAT(date, '%Y-%m-%d')                       AS action_date,
         source                                              AS source_id,
         sub_source                                          AS sub_source_id,
         JSON_UNQUOTE(JSON_EXTRACT(data, '$.ext_message_id')) AS ext_message_id
  FROM message_app_logs
  WHERE id > ? AND source = ?
  ORDER BY id ASC
  LIMIT ?`;

/** Exposed so a test can assert what it does and does not select. */
export const SELECT_EBAY_ACTIVITY_SQL = SELECT_EBAY_ACTIVITY;

type ActivityQueryRow = {
  source_pk: number | string;
  source_user_id: number | string | null;
  action: string;
  action_date: string;
  source_id: number | null;
  sub_source_id: number | null;
  ext_message_id: string | null;
};

/** A count a caller can compare against `MAX_QUERIES_PER_HOUR`. */
export type QueryBudget = { spent: number };

export async function fetchEbayActivityPage(
  connection: MySqlQueryable,
  options: { readonly afterId: number; readonly limit: number; readonly budget?: QueryBudget },
): Promise<readonly SourceActivityRow[]> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`limit must be a positive integer, received: ${String(options.limit)}`);
  }
  if (!Number.isInteger(options.afterId) || options.afterId < 0) {
    throw new Error(`afterId must be a non-negative integer, received: ${String(options.afterId)}`);
  }

  const [rows] = await connection.query(SELECT_EBAY_ACTIVITY, [
    options.afterId,
    EBAY_SOURCE_ID,
    options.limit,
  ]);
  if (options.budget) options.budget.spent += 1;

  return (rows as ActivityQueryRow[]).map((row) => ({
    // Text, because it is an opaque key for `agent_activity.source_pk` and the
    // column that stores it is text. Number() first would be a lossy round trip
    // through a float for no reason.
    sourcePk: String(row.source_pk),
    sourceUserId: row.source_user_id === null ? null : Number(row.source_user_id),
    action: row.action,
    // Formatted as a date in SQL so no JavaScript Date is constructed, and the
    // process timezone cannot shift a day boundary. The source column is a
    // DATE; it has no time to lose.
    actionDate: row.action_date,
    sourceId: row.source_id === null ? null : Number(row.source_id),
    subSourceId: row.sub_source_id === null ? null : Number(row.sub_source_id),
    extMessageId: row.ext_message_id,
  }));
}

/**
 * eBay message media: `files` rows of `type = 0`.
 *
 * FOUR COLUMNS, AND THE OMISSIONS ARE THE POINT.
 *
 *   `submitter`  NULL on every one of the 12,965 message-media rows. The
 *                BUYER/SELLER marker exists only on eBay's RETURN images
 *                (`type = 1`), which this importer does not touch. Authorship
 *                comes from the parent message's `direction`; reading a column
 *                that is always NULL and calling the result authorship is how a
 *                CST photograph gets labelled as a customer's.
 *   `path`       NULL on type 0 — it is the return-image storage location.
 *   `name`,      NULL on type 0.
 *   `format`,
 *   `date`,
 *   `file_id`
 *   `type`       not selected: it is the filter, so every returned row has it.
 *
 * `type` is bound rather than inlined so the statement carries no literal a
 * later edit could turn into a hole — and so type 1 cannot be pulled in by a
 * one-character mistake.
 *
 * Keyset pagination on the primary key, for the same reason as the activity
 * reader: `id > ?` cannot skip a row or repeat one when the table grows
 * mid-run, and it costs 7 queries for 12,965 rows at the default page size
 * against an account capped at 100 queries per hour.
 */
const SELECT_EBAY_MEDIA = `
  SELECT id         AS source_pk,
         ref_id     AS source_ref_id,
         real_url   AS media_url,
         view_order AS view_order
  FROM files
  WHERE id > ? AND type = ?
  ORDER BY id ASC
  LIMIT ?`;

/** Exposed so a test can assert what it does and does not select. */
export const SELECT_EBAY_MEDIA_SQL = SELECT_EBAY_MEDIA;

/** `files.type = 0` is message media. `1` is return evidence and is not imported. */
export const EBAY_MESSAGE_MEDIA_TYPE = 0;

/** One media row, exactly the four columns selected. */
export type SourceMediaRow = {
  readonly sourcePk: string;
  readonly sourceRefId: string | null;
  readonly mediaUrl: string | null;
  readonly viewOrder: number | null;
};

type MediaQueryRow = {
  source_pk: number | string;
  source_ref_id: number | string | null;
  media_url: string | null;
  view_order: number | null;
};

/**
 * Media for a NAMED set of messages, rather than a page of the table.
 *
 * WHY THIS EXISTS. An image can only be stored once CST holds the message it
 * arrived on, and 11,255 of 12,965 currently do not. Those are skipped, not
 * stored — the foreign key makes an orphan impossible — so there is no CST row
 * to retry from, and the naive fix is to re-scan the whole `files` table on
 * every run.
 *
 * That is 7 queries out of 100 per hour, for a table whose relevant rows are
 * already known. This asks the other way round: when CST ingests new eBay
 * messages, the reconciler maps them back to `ext_message_id` and asks only for
 * THOSE. One bounded query, no full re-read.
 *
 * `IN (?)` with an array is mysql2's list expansion — each element is escaped
 * individually, so the values are still bound rather than concatenated. The
 * caller must bound the list; `query` builds one statement per call and a list
 * of thousands would be a statement of thousands.
 */
const SELECT_EBAY_MEDIA_BY_REF = `
  SELECT id         AS source_pk,
         ref_id     AS source_ref_id,
         real_url   AS media_url,
         view_order AS view_order
  FROM files
  WHERE type = ? AND ref_id IN (?)
  ORDER BY id ASC`;

export const SELECT_EBAY_MEDIA_BY_REF_SQL = SELECT_EBAY_MEDIA_BY_REF;

/** How many ext_message_ids one reconciliation query may name. */
export const MAX_MEDIA_REF_LOOKUP = 500;

export async function fetchEbayMediaByRefIds(
  connection: MySqlQueryable,
  options: { readonly refIds: readonly string[]; readonly budget?: QueryBudget },
): Promise<readonly SourceMediaRow[]> {
  const refIds = [...new Set(options.refIds)];
  if (refIds.length === 0) return [];
  if (refIds.length > MAX_MEDIA_REF_LOOKUP) {
    throw new Error(
      `refIds must be at most ${MAX_MEDIA_REF_LOOKUP} per call, received ${refIds.length}`,
    );
  }

  const [rows] = await connection.query(SELECT_EBAY_MEDIA_BY_REF, [
    EBAY_MESSAGE_MEDIA_TYPE,
    refIds,
  ]);
  if (options.budget) options.budget.spent += 1;

  return (rows as MediaQueryRow[]).map(toMediaRow);
}

export async function fetchEbayMediaPage(
  connection: MySqlQueryable,
  options: { readonly afterId: number; readonly limit: number; readonly budget?: QueryBudget },
): Promise<readonly SourceMediaRow[]> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`limit must be a positive integer, received: ${String(options.limit)}`);
  }
  if (!Number.isInteger(options.afterId) || options.afterId < 0) {
    throw new Error(`afterId must be a non-negative integer, received: ${String(options.afterId)}`);
  }

  const [rows] = await connection.query(SELECT_EBAY_MEDIA, [
    options.afterId,
    EBAY_MESSAGE_MEDIA_TYPE,
    options.limit,
  ]);
  if (options.budget) options.budget.spent += 1;

  return (rows as MediaQueryRow[]).map(toMediaRow);
}

/** One shared projection, so the paged and by-ref readers cannot drift. */
function toMediaRow(row: MediaQueryRow): SourceMediaRow {
  return {
    sourcePk: String(row.source_pk),
    // Text, not Number: this is eBay's ext_message_id, it runs past 6.4e12, and
    // it is the key for a map whose other side is also a string.
    sourceRefId: row.source_ref_id === null ? null : String(row.source_ref_id),
    mediaUrl: row.media_url,
    viewOrder: row.view_order === null ? null : Number(row.view_order),
  };
}

/**
 * The approved response-time policy: `sla_configs` rows of `type = 'response'`.
 *
 * ------------------------------------------------------------------------
 * 42 ROWS OF 1,081, AND THE FILTER IS THE WHOLE POINT
 * ------------------------------------------------------------------------
 * `sla_configs` holds two populations under one table name. `type='response'`
 * is the policy — two rows per seller account, `key_value` NULL on every one,
 * all written 2026-04-15. `type='urgent'` is 1,039 rows of per-case escalation
 * log, written 2026-04-16 and stopped 2026-05-06, each carrying a customer's
 * marketplace message id.
 *
 * `type` is BOUND rather than inlined even though it is a constant here, so the
 * statement has no literal that a later edit could turn into a hole — the same
 * device as `source = ?` in the activity reader. A widened filter would pull
 * 1,039 stale rows and their customer-quoting `reason` column into an import
 * that has no column for either.
 *
 * ------------------------------------------------------------------------
 * EIGHT COLUMNS, AND THE TWO OMISSIONS ARE THE POINT
 * ------------------------------------------------------------------------
 *   `key_value`  a customer's marketplace message id. NULL on all 42 response
 *                rows, populated on all 1,039 urgent ones. Not selected, so a
 *                filter that ever slipped could still not carry one across.
 *   `reason`     quotes matched phrases from customer conversations. NULL on
 *                all 42. Not selected.
 *   `created_at` a one-shot 2026-04-15 stamp. Useless as a watermark, and
 *                `imported_at` records what CST did instead.
 *
 * Data that is never read cannot be stored by accident — the rule
 * `fetchStaffPage` applies to the credential columns.
 *
 * ------------------------------------------------------------------------
 * ONE QUERY, NOT A PAGED SCAN
 * ------------------------------------------------------------------------
 * 42 rows. The account is capped at 100 queries per hour, so paging this would
 * spend the budget to re-read a table smaller than one page — the instinct
 * `fetchEbayActivityPage` warns about, in its clearest form.
 *
 * `LIMIT ?` is still bound and still enforced: it is a RUNAWAY GUARD, not
 * pagination. If the response population ever grows past it the reader throws
 * rather than silently importing a truncated policy, which is the failure that
 * would otherwise look like a successful import with accounts missing.
 */
const SELECT_RESPONSE_SLA_CONFIGS = `
  SELECT id         AS source_pk,
         type       AS config_type,
         channel    AS channel,
         week_scope AS week_scope,
         situation  AS situation,
         hours      AS hours,
         sub_source AS sub_source,
         mail_id    AS mail_id
  FROM sla_configs
  WHERE type = ?
  ORDER BY id ASC
  LIMIT ?`;

/** Exposed so a test can assert what it does and does not select. */
export const SELECT_RESPONSE_SLA_CONFIGS_SQL = SELECT_RESPONSE_SLA_CONFIGS;

/**
 * The runaway guard. 42 rows today; this is roomy enough that ordinary growth
 * is invisible and tight enough that the urgent population (1,039) could never
 * fit through it even if the type filter were broken.
 */
export const MAX_RESPONSE_SLA_CONFIGS = 500;

type SlaConfigQueryRow = {
  source_pk: number | string;
  config_type: string | null;
  channel: string | null;
  week_scope: string | null;
  situation: string | null;
  hours: number | string | null;
  sub_source: number | null;
  mail_id: number | null;
};

export async function fetchResponseSlaConfigs(
  connection: MySqlQueryable,
  options: { readonly budget?: QueryBudget } = {},
): Promise<readonly SourceSlaConfigRow[]> {
  const [rows] = await connection.query(SELECT_RESPONSE_SLA_CONFIGS, [
    RESPONSE_POLICY_TYPE,
    MAX_RESPONSE_SLA_CONFIGS,
  ]);
  if (options.budget) options.budget.spent += 1;

  const result = rows as SlaConfigQueryRow[];
  if (result.length >= MAX_RESPONSE_SLA_CONFIGS) {
    throw new Error(
      `sla_configs returned ${result.length} response rows, at or past the ${MAX_RESPONSE_SLA_CONFIGS} guard — ` +
        "refusing to import a possibly truncated policy",
    );
  }

  return result.map((row) => ({
    // Text, because it is an opaque provenance key and the column that stores
    // it is text. Number() first would be a lossy round trip for no reason.
    sourcePk: String(row.source_pk),
    type: row.config_type ?? "",
    channel: row.channel,
    weekScope: row.week_scope,
    situation: row.situation,
    // `hours` is int(5) at source, but mysql2 can hand back a string when
    // supportBigNumbers is on. Number() here, and the domain layer rejects
    // anything that is not a positive integer.
    hours: row.hours === null ? null : Number(row.hours),
    subSource: row.sub_source === null ? null : Number(row.sub_source),
    mailId: row.mail_id === null ? null : Number(row.mail_id),
  }));
}

/**
 * The mailbox -> seller account map. 18 rows.
 *
 * READ WHOLE, NOT SAMPLED, and that is not pedantry: discovery first read this
 * table with `LIMIT 11` after `information_schema.TABLES.TABLE_ROWS` reported
 * 11, and TABLE_ROWS is an ESTIMATE for InnoDB. The real count is 18. The seven
 * unseen rows changed no mapping — every `mail_id` the policy references was in
 * the first eleven — but a truncated lookup map resolves a real mailbox to
 * "missing", and `resolveAccount` would then reject a policy row that is
 * perfectly good. Hence no LIMIT that can bite, and a guard that throws instead.
 *
 * WHY THIS IS NEEDED AT ALL: Shopify's and Amazon's policy rows are keyed by
 * `mail_id`, and CST stores `sub_source_id`. This is the only table that
 * connects them. eBay's rows state the account directly and need none of it.
 *
 * ------------------------------------------------------------------------
 * TWO COLUMNS, OUT OF TWELVE
 * ------------------------------------------------------------------------
 * `mails` also holds `email`, `env_pw`, `smtp_host`, `smtp_port`,
 * `smtp_encryption`, `port`, `type`, `assigned_to`, `is_fetch` and
 * `updated_at`. None is selected.
 *
 *   `env_pw`  holds the NAME of an environment variable rather than a
 *             password, which is a mercy and not a reason to read it.
 *   `email`   is a company mailbox address. CST has no use for it, and the
 *             column it would land in does not exist.
 *   the SMTP fields are transport configuration for a system that sends. This
 *             application has no transport and must not acquire one by
 *             accident; `tests/guards/automation-no-transport.test.ts` exists
 *             because that boundary is worth defending in the schema rather
 *             than in review.
 *
 * `sub_source` is selected INCLUDING its NULLs. Amazon's mailbox 1 has none,
 * and that NULL is load-bearing: it is what tells `resolveAccount` the target
 * is channel-wide rather than that the mailbox is missing. Filtering NULLs out
 * here would turn a verified reading into a dangling reference.
 */
const SELECT_MAIL_ACCOUNTS = `
  SELECT id         AS mail_id,
         sub_source AS sub_source
  FROM mails
  ORDER BY id ASC
  LIMIT ?`;

/** Exposed so a test can assert what it does and does not select. */
export const SELECT_MAIL_ACCOUNTS_SQL = SELECT_MAIL_ACCOUNTS;

/** Runaway guard, as above. 18 rows today. */
export const MAX_MAIL_ACCOUNTS = 500;

type MailQueryRow = { mail_id: number | string; sub_source: number | null };

export async function fetchMailAccounts(
  connection: MySqlQueryable,
  options: { readonly budget?: QueryBudget } = {},
): Promise<readonly SourceMailRow[]> {
  const [rows] = await connection.query(SELECT_MAIL_ACCOUNTS, [MAX_MAIL_ACCOUNTS]);
  if (options.budget) options.budget.spent += 1;

  const result = rows as MailQueryRow[];
  if (result.length >= MAX_MAIL_ACCOUNTS) {
    throw new Error(
      `mails returned ${result.length} rows, at or past the ${MAX_MAIL_ACCOUNTS} guard — ` +
        "refusing to resolve accounts from a possibly truncated map",
    );
  }

  return result.map((row) => ({
    mailId: Number(row.mail_id),
    subSource: row.sub_source === null ? null : Number(row.sub_source),
  }));
}
