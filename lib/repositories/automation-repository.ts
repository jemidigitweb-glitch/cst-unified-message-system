import "server-only";

import type { Pool, PoolClient } from "pg";

import type {
  AutomationItem,
  AutomationItemStatus,
  AutomationSettings,
  AutomationSettingsPatch,
  AutomationTemplate,
  DispatchEvent,
  ProcessedMode,
} from "@/lib/domain/automation/automation-types";
import { POST_DISPATCH_AUTOMATION_KEY } from "@/lib/domain/automation/automation-types";

/**
 * Post-dispatch automation state, in the application database only.
 *
 * WRITES ONLY TO cst_app.automation_settings and cst_app.automation_items.
 * Nothing here touches the read-only source database, another project's schema,
 * or anything 0001-0010 created — including the CST conversation draft tables,
 * which belong to a different feature and are not read or written from here.
 *
 * Every query is parameterised. No statement in this file can record a `sent`
 * row that is not a test-mode row, because the database refuses one.
 */

type Db = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/** Postgres `undefined_table` — migration 0011 has not been applied. */
const UNDEFINED_TABLE = "42P01";

export function isAutomationStoreMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === UNDEFINED_TABLE
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

type TemplateRow = {
  id: string;
  template_key: string;
  version: number;
  name: string;
  body_template: string;
  required_variables: string[];
  approved: boolean;
  active: boolean;
};

const TEMPLATE_COLUMNS = `id::text AS id, template_key, version, name, body_template,
  required_variables, approved, active`;

function templateOf(row: TemplateRow): AutomationTemplate {
  return {
    id: row.id,
    templateKey: row.template_key,
    version: Number(row.version),
    name: row.name,
    bodyTemplate: row.body_template,
    requiredVariables: row.required_variables ?? [],
    approved: row.approved,
    active: row.active,
  };
}

/** Every template an operator may choose. Unapproved ones are never offered. */
export async function listAutomationTemplates(db: Db): Promise<readonly AutomationTemplate[]> {
  const { rows } = await db.query({
    text: `SELECT ${TEMPLATE_COLUMNS} FROM cst_app.automation_templates
            WHERE approved AND active
            ORDER BY template_key, version DESC`,
  });
  return (rows as TemplateRow[]).map(templateOf);
}

export async function templateById(
  db: Db,
  templateId: string,
): Promise<AutomationTemplate | undefined> {
  const { rows } = await db.query({
    text: `SELECT ${TEMPLATE_COLUMNS} FROM cst_app.automation_templates WHERE id = $1::bigint`,
    values: [templateId],
  });
  const row = rows[0] as TemplateRow | undefined;
  return row === undefined ? undefined : templateOf(row);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type SettingsRow = {
  automation_key: string;
  enabled: boolean;
  delay_hours: number;
  enabled_sub_sources: number[];
  not_before: string | null;
  dispatch_time_zone: string;
  template_id: string | null;
  test_mode: boolean;
};

const SETTINGS_COLUMNS = `automation_key, enabled, delay_hours, enabled_sub_sources,
  not_before::text AS not_before, dispatch_time_zone, template_id::text AS template_id, test_mode`;

function settingsOf(row: SettingsRow): AutomationSettings {
  return {
    automationKey: row.automation_key,
    enabled: row.enabled,
    delayHours: Number(row.delay_hours),
    enabledSubSources: (row.enabled_sub_sources ?? []).map(Number),
    notBefore: row.not_before,
    dispatchTimeZone: row.dispatch_time_zone,
    templateId: row.template_id,
    testMode: row.test_mode,
  };
}

/**
 * The automation's configuration, or undefined when the row is absent.
 *
 * Undefined is NOT treated as "use the defaults" by any caller. A missing row
 * means the migration has not been seeded, and a scan that invented a
 * `not_before` would be exactly the backfill this design exists to prevent.
 */
export async function automationSettings(
  db: Db,
  automationKey: string = POST_DISPATCH_AUTOMATION_KEY,
): Promise<AutomationSettings | undefined> {
  const { rows } = await db.query({
    text: `SELECT ${SETTINGS_COLUMNS} FROM cst_app.automation_settings WHERE automation_key = $1`,
    values: [automationKey],
  });
  const row = rows[0] as SettingsRow | undefined;
  return row === undefined ? undefined : settingsOf(row);
}

/**
 * Applies an administrator's change.
 *
 * ONLY THE CONFIGURABLE COLUMNS, named one by one. There is deliberately no
 * generic column list and no pass-through of caller keys: this statement cannot
 * be steered into touching a record, a status or a result, whatever it is
 * handed.
 *
 * The caller is expected to have run `settingsPatchRefusal` first — that is
 * where "may this be switched on at all?" is decided, and it is a domain rule
 * rather than a SQL one.
 */
export async function updateAutomationSettings(
  db: Db,
  automationKey: string,
  patch: AutomationSettingsPatch,
): Promise<AutomationSettings | undefined> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown, cast = "") => {
    values.push(value);
    assignments.push(`${column} = $${values.length}${cast}`);
  };

  if (patch.enabled !== undefined) set("enabled", patch.enabled);
  if (patch.delayHours !== undefined) set("delay_hours", patch.delayHours, "::int");
  if (patch.enabledSubSources !== undefined) {
    set("enabled_sub_sources", [...patch.enabledSubSources], "::int[]");
  }
  // NAIVE on purpose: it is compared against the source's zone-less dispatch
  // time. `::timestamp`, never `::timestamptz`.
  if (patch.notBefore !== undefined) set("not_before", patch.notBefore, "::timestamp");
  if (patch.templateId !== undefined) set("template_id", patch.templateId, "::bigint");
  if (patch.testMode !== undefined) set("test_mode", patch.testMode);
  if (assignments.length === 0) return undefined;

  values.push(automationKey);
  const { rows } = await db.query({
    text: `UPDATE cst_app.automation_settings
              SET ${assignments.join(", ")}, updated_at = now()
            WHERE automation_key = $${values.length}
        RETURNING ${SETTINGS_COLUMNS}`,
    values,
  });
  const row = rows[0] as SettingsRow | undefined;
  return row === undefined ? undefined : settingsOf(row);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

type ItemRow = {
  id: string;
  automation_key: string;
  channel: AutomationItem["channel"];
  sub_source_id: number;
  source_order_id: string;
  source_order_number: string | null;
  source_shipment_id: string;
  recipient_name: string | null;
  dispatched_at: string;
  dispatch_source: "order_info_shipped_time";
  dispatch_time_zone: string;
  scheduled_at: string;
  template_id: string;
  template_version: number;
  template_name: string | null;
  status: AutomationItemStatus;
  test_mode: boolean;
  processed_mode: ProcessedMode | null;
  processed_at: string | null;
  rendered_body: string | null;
  skip_reason: string | null;
  last_error: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  updated_at: string;
};

const ITEM_COLUMNS = `
  i.id::text                    AS id,
  i.automation_key              AS automation_key,
  i.channel                     AS channel,
  i.sub_source_id               AS sub_source_id,
  i.source_order_id::text       AS source_order_id,
  i.source_order_number         AS source_order_number,
  i.source_shipment_id::text    AS source_shipment_id,
  i.recipient_name              AS recipient_name,
  i.dispatched_at::text         AS dispatched_at,
  i.dispatch_source             AS dispatch_source,
  i.dispatch_time_zone          AS dispatch_time_zone,
  i.scheduled_at::text          AS scheduled_at,
  i.template_id::text           AS template_id,
  i.template_version            AS template_version,
  t.name                        AS template_name,
  i.status                      AS status,
  i.test_mode                   AS test_mode,
  i.processed_mode              AS processed_mode,
  i.processed_at::text          AS processed_at,
  i.rendered_body               AS rendered_body,
  i.skip_reason                 AS skip_reason,
  i.last_error                  AS last_error,
  i.cancelled_at::text          AS cancelled_at,
  i.cancelled_reason            AS cancelled_reason,
  i.updated_at::text            AS updated_at`;

const ITEM_FROM = `
FROM cst_app.automation_items i
LEFT JOIN cst_app.automation_templates t ON t.id = i.template_id`;

function itemOf(row: ItemRow): AutomationItem {
  return {
    id: row.id,
    automationKey: row.automation_key,
    channel: row.channel,
    subSourceId: Number(row.sub_source_id),
    // Not stored: the storefront NAME is a source value and would go stale.
    subSourceName: null,
    orderId: row.source_order_id,
    orderNumber: row.source_order_number,
    shipmentId: row.source_shipment_id,
    recipientName: row.recipient_name,
    dispatchedAt: row.dispatched_at,
    dispatchSource: row.dispatch_source,
    dispatchTimeZone: row.dispatch_time_zone,
    scheduledAt: row.scheduled_at,
    templateId: row.template_id,
    templateVersion: Number(row.template_version),
    templateName: row.template_name,
    status: row.status,
    testMode: row.test_mode,
    processedMode: row.processed_mode,
    processedAt: row.processed_at,
    renderedBody: row.rendered_body,
    skipReason: row.skip_reason,
    lastError: row.last_error,
    cancelledAt: row.cancelled_at,
    cancelledReason: row.cancelled_reason,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates one scheduled record, or does nothing.
 *
 * DUPLICATE PROTECTION IS BOTH HALVES OF THIS STATEMENT. `ON CONFLICT DO
 * NOTHING` names the unique index on
 * (automation_key, sub_source_id, source_shipment_id), so a second scan over
 * the same shipment inserts nothing and reports it — and two scans running at
 * once cannot both win, which an application-side "does it exist?" check alone
 * could never guarantee. The caller checks too; the constraint is what makes
 * the check safe to rely on.
 *
 * IT ALSO MEANS AN ALREADY-PROCESSED SHIPMENT IS NEVER PROCESSED AGAIN. The key
 * is on the shipment and takes no account of status, so a `sent` record blocks
 * a second one as firmly as a `scheduled` one does. A deliberate resend would
 * have to be a new feature that says so.
 *
 * `scheduled_at` IS COMPUTED HERE, FROM THE DISPATCH TIME, in the database:
 *
 *   (dispatched_at AT TIME ZONE $zone) + delay_hours * interval '1 hour'
 *
 * `AT TIME ZONE` on a naive timestamp reads it AS being in that zone and
 * returns the instant — precisely the conversion the source's zone-less
 * `shipped_time` needs, done once, in one place. Never `now()`.
 */
const INSERT_ITEM = `
INSERT INTO cst_app.automation_items (
  automation_key, channel, sub_source_id, source_order_id, source_order_number,
  source_shipment_id, recipient_name, dispatched_at, dispatch_source,
  dispatch_time_zone, scheduled_at, template_id, template_version, status, test_mode
) VALUES (
  $1, $2, $3::int, $4::bigint, $5,
  $6::bigint, $10, $7::timestamp, 'order_info_shipped_time',
  $8, ($7::timestamp AT TIME ZONE $8) + ($9::int * interval '1 hour'),
  $11::bigint, $12::int, 'scheduled', $13
)
ON CONFLICT (automation_key, sub_source_id, source_shipment_id) DO NOTHING
RETURNING id::text AS id`;

export async function insertScheduledItem(
  db: Db,
  input: {
    readonly automationKey: string;
    readonly event: DispatchEvent;
    readonly dispatchTimeZone: string;
    readonly delayHours: number;
    readonly templateId: string;
    readonly templateVersion: number;
    readonly testMode: boolean;
  },
): Promise<{ created: boolean; id: string | null }> {
  const { event } = input;
  const { rows } = await db.query({
    text: INSERT_ITEM,
    values: [
      input.automationKey,
      event.channel,
      event.subSourceId,
      event.orderId,
      event.orderNumber,
      event.shipmentId,
      event.dispatchedAt,
      input.dispatchTimeZone,
      input.delayHours,
      event.customerName,
      input.templateId,
      input.templateVersion,
      input.testMode,
    ],
  });
  const row = rows[0] as { id: string } | undefined;
  return { created: row !== undefined, id: row?.id ?? null };
}

/**
 * Whether this shipment already has a record, in ANY state.
 *
 * The application-side half of the duplicate protection, and deliberately
 * status-blind: a shipment already processed must not be picked up again.
 */
export async function itemExistsForShipment(
  db: Db,
  input: {
    readonly automationKey: string;
    readonly subSourceId: number;
    readonly shipmentId: string;
  },
): Promise<boolean> {
  const { rows } = await db.query({
    text: `SELECT 1 FROM cst_app.automation_items
            WHERE automation_key = $1 AND sub_source_id = $2::int AND source_shipment_id = $3::bigint`,
    values: [input.automationKey, input.subSourceId, input.shipmentId],
  });
  return rows.length > 0;
}

/**
 * The due records, oldest first.
 *
 * `FOR UPDATE SKIP LOCKED` inside one transaction so two concurrent runs take
 * disjoint sets. Unlike a drafting queue there is no intermediate state to move
 * them into — a record is `scheduled` until it is `sent`, `skipped` or
 * `failed` — so the lock is what prevents a double process, and it is held for
 * the life of the transaction the caller runs the processing in.
 */
export async function selectDueItems(
  client: Pick<PoolClient, "query">,
  input: { readonly automationKey: string; readonly limit: number },
): Promise<readonly AutomationItem[]> {
  const { rows } = await client.query({
    text: `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
            WHERE i.automation_key = $1
              AND i.status = 'scheduled'
              AND i.scheduled_at <= now()
            ORDER BY i.scheduled_at ASC, i.id ASC
            FOR UPDATE OF i SKIP LOCKED
            LIMIT $2::int`,
    values: [input.automationKey, input.limit],
  });
  return (rows as ItemRow[]).map(itemOf);
}

/**
 * The soonest scheduled record, or nothing when none is waiting.
 *
 * ADDED FOR THE LONG-RUNNING WORKER, and it changes no behaviour on its own: it
 * is a SELECT, and every statement the automation issues is still reviewed in
 * this one file.
 *
 * IT TAKES NO LOCK, DELIBERATELY. The worker runs it plain, outside any
 * transaction, because it is asking a question — "when is the next moment?" —
 * and holding a row open for the hours until that moment would be a lock held
 * across every other caller's working day for no gain: the claim that actually
 * matters is `selectDueItems`, which takes `FOR UPDATE SKIP LOCKED` in the
 * transaction the processing runs in. This is the difference between the two
 * reads, and the reason this one is safe to run on the interval.
 *
 * It reads `status = 'scheduled'` and nothing else, so a cancelled record —
 * which is no longer scheduled — can never be the thing the worker waits for.
 * The partial index `ix_automation_items_due` covers exactly this shape, so the
 * interval recheck is one row, not a scan.
 */
export async function nextScheduledItem(
  db: Db,
  input: { readonly automationKey: string },
): Promise<AutomationItem | undefined> {
  const { rows } = await db.query({
    text: `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
            WHERE i.automation_key = $1 AND i.status = 'scheduled'
            ORDER BY i.scheduled_at ASC, i.id ASC
            LIMIT 1`,
    values: [input.automationKey],
  });
  const row = rows[0] as ItemRow | undefined;
  return row === undefined ? undefined : itemOf(row);
}

export async function itemById(db: Db, id: string): Promise<AutomationItem | undefined> {
  const { rows } = await db.query({
    text: `SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE i.id = $1::bigint`,
    values: [id],
  });
  const row = rows[0] as ItemRow | undefined;
  return row === undefined ? undefined : itemOf(row);
}

/**
 * The admin list, one page at a time, optionally filtered by status.
 *
 * ORDERED BY DISPATCH TIME, NEWEST FIRST, and not by `updated_at`. A list that
 * reorders itself every time a record is processed is one nobody can work
 * through; dispatch order is stable and is the order the work arrived in.
 */
export async function listItems(
  db: Db,
  input: {
    readonly automationKey: string;
    readonly limit: number;
    readonly offset?: number;
    readonly status?: AutomationItemStatus;
  },
): Promise<{ items: readonly AutomationItem[]; total: number }> {
  const { rows } = await db.query({
    text: `SELECT ${ITEM_COLUMNS}, count(*) OVER () AS total_count ${ITEM_FROM}
            WHERE i.automation_key = $1
              AND ($4::text IS NULL OR i.status = $4::text)
            ORDER BY i.dispatched_at DESC, i.id DESC
            LIMIT $2::int OFFSET $3::int`,
    values: [input.automationKey, input.limit, input.offset ?? 0, input.status ?? null],
  });
  const typed = rows as (ItemRow & { total_count: string })[];
  return {
    items: typed.map(itemOf),
    // An offset past the end is an ordinary state, so an empty page is not
    // evidence of an empty table and the count is re-read.
    total:
      typed.length === 0
        ? await countItems(db, input.automationKey, input.status)
        : Number(typed[0]!.total_count),
  };
}

async function countItems(
  db: Db,
  automationKey: string,
  status?: AutomationItemStatus,
): Promise<number> {
  const { rows } = await db.query({
    text: `SELECT count(*)::int AS total FROM cst_app.automation_items
            WHERE automation_key = $1 AND ($2::text IS NULL OR status = $2::text)`,
    values: [automationKey, status ?? null],
  });
  return Number((rows[0] as { total: number } | undefined)?.total ?? 0);
}

/** How many records sit in each state, for the admin summary and filters. */
export async function itemStatusCounts(
  db: Db,
  automationKey: string,
): Promise<Record<AutomationItemStatus, number>> {
  const { rows } = await db.query({
    text: `SELECT status, count(*)::int AS n FROM cst_app.automation_items
            WHERE automation_key = $1 GROUP BY status`,
    values: [automationKey],
  });
  const counts: Record<AutomationItemStatus, number> = {
    scheduled: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of rows as { status: AutomationItemStatus; n: number }[]) {
    counts[row.status] = Number(row.n);
  }
  return counts;
}

/**
 * Records a successful TEST-MODE processing run.
 *
 * `test_mode` IS RE-ASSERTED IN THE WHERE CLAUSE, not merely passed. The column
 * was set when the record was created; if it were somehow false, the database's
 * own `ck_automation_items_sent_requires_test_mode` would reject this UPDATE —
 * and this clause means it never reaches that point silently. Between the two,
 * there is no path in this application that writes a `sent` row claiming a
 * message left the system.
 */
export async function markItemProcessed(
  db: Db,
  input: { readonly id: string; readonly renderedBody: string },
): Promise<boolean> {
  const { rows } = await db.query({
    text: `UPDATE cst_app.automation_items
              SET status = 'sent',
                  processed_mode = 'test_mode',
                  processed_at = now(),
                  rendered_body = $2,
                  updated_at = now()
            WHERE id = $1::bigint AND status = 'scheduled' AND test_mode
        RETURNING id`,
    values: [input.id, input.renderedBody],
  });
  return rows.length === 1;
}

/** The recheck found the order no longer qualified. */
export async function markItemSkipped(
  db: Db,
  input: { readonly id: string; readonly reason: string },
): Promise<void> {
  await db.query({
    text: `UPDATE cst_app.automation_items
              SET status = 'skipped', skip_reason = $2, updated_at = now()
            WHERE id = $1::bigint AND status = 'scheduled'`,
    values: [input.id, input.reason],
  });
}

/** Processing could not complete. The reason is ours, never a vendor's text. */
export async function markItemFailed(
  db: Db,
  input: { readonly id: string; readonly reason: string },
): Promise<void> {
  await db.query({
    text: `UPDATE cst_app.automation_items
              SET status = 'failed', last_error = $2, updated_at = now()
            WHERE id = $1::bigint AND status = 'scheduled'`,
    values: [input.id, input.reason],
  });
}

/**
 * An operator stopped a scheduled record.
 *
 * Only `scheduled` is cancellable, which is the whole guarantee: a record that
 * has already been processed cannot be retrospectively cancelled, and the
 * cancellation of a scheduled one is what stops it ever being picked up, since
 * `selectDueItems` reads `status = 'scheduled'` and nothing else.
 */
export async function cancelItem(
  db: Db,
  input: { readonly id: string; readonly reason: string | null },
): Promise<boolean> {
  const { rows } = await db.query({
    text: `UPDATE cst_app.automation_items
              SET status = 'cancelled',
                  cancelled_at = now(),
                  cancelled_reason = $2,
                  updated_at = now()
            WHERE id = $1::bigint AND status = 'scheduled'
        RETURNING id`,
    values: [input.id, input.reason],
  });
  return rows.length === 1;
}

/**
 * An operator undoing an accidental cancellation.
 *
 * THE INVERSE OF `cancelItem`, AND GUARDED THE SAME WAY IT IS. `status =
 * 'cancelled'` in the WHERE clause is what makes requirement 7 true rather than
 * merely intended: a `sent`, `skipped`, `failed` or already-`scheduled` record
 * matches nothing, so this statement cannot resurrect a record that was
 * processed, cannot shorten a failure, and cannot be replayed to move a record
 * backwards a second time. `RETURNING id` turns "did it match?" into an answer
 * the caller has to handle, exactly as `cancelItem` does.
 *
 * NOTHING IS RECALCULATED AND NOTHING IS COPIED. This sets `status` and
 * `updated_at` and no other column, so `scheduled_at`, `dispatched_at`,
 * `source_order_id`, `source_shipment_id`, `sub_source_id`, `channel`,
 * `template_id` and `template_version` are all left exactly as the scan wrote
 * them. Requirement 4 and requirement 5 are the same fact here: there is no
 * INSERT and no arithmetic, so a restored record is the original record.
 *
 * THAT IS ALSO WHY AN OVERDUE RECORD NEEDS NO SPECIAL HANDLING. `scheduled_at`
 * is untouched, so if it has already passed then `selectDueItems` -- which reads
 * `status = 'scheduled' AND scheduled_at <= now()` and nothing else -- matches it
 * on the very next pass. If it is still in the future, that same query does not
 * match it until the original moment arrives. Requirement 6 falls out of not
 * changing anything, which is the strongest form it could take.
 *
 * `cancelled_at` AND `cancelled_reason` ARE KEPT, deliberately. They are not
 * cleared. A record that was cancelled and restored did have that happen to it,
 * and nulling the columns would make the row claim otherwise -- the cancellation
 * would become invisible, including the reason an operator typed. The page reads
 * them to show "Restored after cancel" instead of a bare cancellation, so the
 * history is visible rather than merely storable.
 *
 * `updated_at` moves because the row did change. Nothing else does.
 */
export async function restoreItem(
  db: Db,
  input: { readonly id: string },
): Promise<boolean> {
  const { rows } = await db.query({
    text: `UPDATE cst_app.automation_items
              SET status = 'scheduled',
                  updated_at = now()
            WHERE id = $1::bigint AND status = 'cancelled'
        RETURNING id`,
    values: [input.id],
  });
  return rows.length === 1;
}

/** Refreshes the recipient's display name from the source at recheck time. */
export async function refreshRecipientName(
  db: Db,
  input: { readonly id: string; readonly recipientName: string | null },
): Promise<void> {
  await db.query({
    text: `UPDATE cst_app.automation_items
              SET recipient_name = $2, updated_at = now()
            WHERE id = $1::bigint`,
    values: [input.id, input.recipientName],
  });
}
