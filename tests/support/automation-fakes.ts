import type { Pool } from "pg";

import type {
  AutomationSettings,
  AutomationTemplate,
  DispatchEvent,
} from "@/lib/domain/automation/automation-types";

/**
 * In-memory stand-ins for the two databases, for automation tests.
 *
 * NOT A SQL ENGINE. Each fake recognises the handful of statements the
 * repositories actually issue and answers them from ordinary JavaScript state.
 * That is enough to test the behaviour that matters — what gets scheduled, what
 * gets processed, what gets skipped — without a database, and it keeps every
 * statement this code issues visible to an assertion.
 *
 * `sourceStatements` records everything run against the SOURCE, so a test can
 * assert that it saw nothing but SELECTs.
 */

export type ItemRecord = {
  id: string;
  automation_key: string;
  channel: string;
  sub_source_id: number;
  source_order_id: string;
  source_order_number: string | null;
  source_shipment_id: string;
  recipient_name: string | null;
  dispatched_at: string;
  dispatch_source: string;
  dispatch_time_zone: string;
  scheduled_at: string;
  template_id: string;
  template_version: number;
  status: string;
  test_mode: boolean;
  processed_mode: string | null;
  processed_at: string | null;
  rendered_body: string | null;
  skip_reason: string | null;
  last_error: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  updated_at: string;
};

export function defaultTemplate(overrides: Partial<AutomationTemplate> = {}): AutomationTemplate {
  return {
    id: "500",
    templateKey: "post_dispatch_update",
    version: 1,
    name: "Post-dispatch update",
    bodyTemplate: "Hello {{customer_name}},\n\nYour order {{order_number}} has been dispatched.",
    requiredVariables: ["customer_name", "order_number"],
    approved: true,
    active: true,
    ...overrides,
  };
}

export function defaultSettings(overrides: Partial<AutomationSettings> = {}): AutomationSettings {
  return {
    automationKey: "post_dispatch_message",
    enabled: true,
    delayHours: 24,
    enabledSubSources: [22],
    notBefore: "2026-09-01 00:00:00",
    dispatchTimeZone: "Europe/Berlin",
    templateId: "500",
    testMode: true,
    ...overrides,
  };
}

export function dispatchEvent(overrides: Partial<DispatchEvent> = {}): DispatchEvent {
  return {
    shipmentId: "7000001",
    orderId: "900001",
    orderNumber: "TEST-ORDER-0001",
    channel: "ebay",
    subSourceId: 22,
    subSourceName: "storefront-a",
    dispatchedAt: "2026-09-10 08:00:00",
    orderStatus: "Completed",
    shipmentStatus: "Completed",
    shipmentCancelled: false,
    cancellationRaised: false,
    returned: false,
    trackingNumber: "TRK000111222",
    carrier: "Test Carrier",
    customerName: "Sam Tester",
    productTitle: "Test Lamp",
    sku: "SKU-TEST-1",
    ...overrides,
  };
}

/** Rows the source fake returns, in the shape the real query selects. */
export function sourceRow(event: DispatchEvent, sourceId = 2): Record<string, unknown> {
  return {
    shipment_id: event.shipmentId,
    order_id: event.orderId,
    order_number: event.orderNumber,
    source_id: sourceId,
    sub_source_id: event.subSourceId,
    sub_source_name: event.subSourceName,
    dispatched_at: event.dispatchedAt,
    order_status: event.orderStatus,
    shipment_status: event.shipmentStatus,
    shipment_cancelled: event.shipmentCancelled,
    cancellation_raised: event.cancellationRaised,
    returned: event.returned,
    tracking_number: event.trackingNumber,
    carrier: event.carrier,
    first_name: event.customerName?.split(" ")[0] ?? null,
    last_name: event.customerName?.split(" ").slice(1).join(" ") || null,
    address_name: null,
    item_sku: event.sku,
    real_sku: null,
    item_title: event.productTitle,
  };
}

export type FakeSource = {
  query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows: unknown[] }>;
  statements: string[];
};

/** The read-only source. Every statement it is handed is recorded. */
export function fakeSource(options: {
  readonly discovered?: readonly DispatchEvent[];
  readonly byShipment?: Readonly<Record<string, DispatchEvent | null>>;
  readonly sourceId?: number;
}): FakeSource {
  const statements: string[] = [];
  return {
    statements,
    async query(config) {
      statements.push(config.text);
      if (/WHERE sh\.id = \$1::bigint/.test(config.text)) {
        const id = String(config.values?.[0]);
        const event = options.byShipment?.[id];
        if (event === null || event === undefined) return { rows: [] };
        return { rows: [sourceRow(event, options.sourceId ?? 2)] };
      }
      return {
        rows: (options.discovered ?? []).map((event) => sourceRow(event, options.sourceId ?? 2)),
      };
    },
  };
}

export type FakeApp = {
  pool: Pool;
  items: ItemRecord[];
  templates: AutomationTemplate[];
  settings: AutomationSettings | undefined;
  statements: string[];
  /** Insert attempts the unique key rejected. */
  conflicts: number;
};

/**
 * The application database.
 *
 * The unique key on (automation_key, sub_source_id, source_shipment_id) is
 * enforced here the way the real index enforces it: an insert that collides
 * returns no row, exactly as `ON CONFLICT DO NOTHING` does. The
 * `sent`-requires-`test_mode` CHECK is enforced too, because a test that could
 * write a non-test `sent` row would be testing the wrong database.
 */
export function fakeApp(initial: {
  readonly settings?: AutomationSettings;
  readonly items?: ItemRecord[];
  readonly templates?: AutomationTemplate[];
  readonly now?: () => Date;
}): FakeApp {
  const state: FakeApp = {
    pool: undefined as unknown as Pool,
    items: initial.items ? [...initial.items] : [],
    templates: initial.templates ? [...initial.templates] : [defaultTemplate()],
    settings: initial.settings,
    statements: [],
    conflicts: 0,
  };
  const now = initial.now ?? (() => new Date());
  let nextItemId = 1000;

  const templateRow = (template: AutomationTemplate) => ({
    id: template.id,
    template_key: template.templateKey,
    version: template.version,
    name: template.name,
    body_template: template.bodyTemplate,
    required_variables: [...template.requiredVariables],
    approved: template.approved,
    active: template.active,
  });

  // `pg` accepts both a string and a config object; the real code uses both, so
  // the fake has to as well or transaction control arrives as `undefined`.
  const query = async (config: string | { text: string; values?: unknown[] }) => {
    const text = typeof config === "string" ? config : config.text;
    const values = typeof config === "string" ? [] : (config.values ?? []);
    state.statements.push(text);

    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };

    if (/FROM cst_app\.automation_templates/.test(text)) {
      if (/WHERE id = \$1::bigint/.test(text)) {
        const found = state.templates.find((t) => t.id === String(values[0]));
        return { rows: found === undefined ? [] : [templateRow(found)] };
      }
      return {
        rows: state.templates.filter((t) => t.approved && t.active).map(templateRow),
      };
    }

    if (/FROM cst_app\.automation_settings/.test(text) && /^\s*SELECT/.test(text)) {
      return {
        rows:
          state.settings === undefined
            ? []
            : [
                {
                  automation_key: state.settings.automationKey,
                  enabled: state.settings.enabled,
                  delay_hours: state.settings.delayHours,
                  enabled_sub_sources: [...state.settings.enabledSubSources],
                  not_before: state.settings.notBefore,
                  dispatch_time_zone: state.settings.dispatchTimeZone,
                  template_id: state.settings.templateId,
                  test_mode: state.settings.testMode,
                },
              ],
      };
    }

    if (/SELECT 1 FROM cst_app\.automation_items/.test(text)) {
      const [key, subSourceId, shipmentId] = values as [string, number, string];
      const found = state.items.some(
        (item) =>
          item.automation_key === key &&
          item.sub_source_id === Number(subSourceId) &&
          item.source_shipment_id === String(shipmentId),
      );
      return { rows: found ? [{ "?column?": 1 }] : [] };
    }

    if (/INSERT INTO cst_app\.automation_items/.test(text)) {
      // Positional, matching INSERT_ITEM exactly.
      const key = String(values[0]);
      const subSourceId = Number(values[2]);
      const shipmentId = String(values[5]);
      const dispatchedAt = String(values[6]);
      const zone = String(values[7]);
      const delayHours = Number(values[8]);
      const clash = state.items.some(
        (item) =>
          item.automation_key === key &&
          item.sub_source_id === subSourceId &&
          item.source_shipment_id === shipmentId,
      );
      if (clash) {
        state.conflicts += 1;
        return { rows: [] };
      }
      // The real statement computes this in SQL; the fake does the same
      // arithmetic on the same inputs so a test can check the result.
      const scheduledAt = new Date(
        Date.parse(`${dispatchedAt.replace(" ", "T")}Z`) + delayHours * 3_600_000,
      ).toISOString();
      const record: ItemRecord = {
        id: String(nextItemId++),
        automation_key: key,
        channel: String(values[1]),
        sub_source_id: subSourceId,
        source_order_id: String(values[3]),
        source_order_number: values[4] as string | null,
        source_shipment_id: shipmentId,
        recipient_name: values[9] as string | null,
        dispatched_at: dispatchedAt,
        dispatch_source: "order_info_shipped_time",
        dispatch_time_zone: zone,
        scheduled_at: scheduledAt,
        template_id: String(values[10]),
        template_version: Number(values[11]),
        status: "scheduled",
        test_mode: Boolean(values[12]),
        processed_mode: null,
        processed_at: null,
        rendered_body: null,
        skip_reason: null,
        last_error: null,
        cancelled_at: null,
        cancelled_reason: null,
        updated_at: now().toISOString(),
      };
      state.items.push(record);
      return { rows: [{ id: record.id }] };
    }

    if (/FOR UPDATE OF i SKIP LOCKED/.test(text)) {
      const [, limit] = values as [string, number];
      const due = state.items
        .filter(
          (item) =>
            item.status === "scheduled" && Date.parse(item.scheduled_at) <= now().getTime(),
        )
        .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
        .slice(0, Number(limit));
      return { rows: due.map(toItemRow) };
    }

    if (/SET status = 'sent'/.test(text)) {
      const [id, body] = values as [string, string];
      const item = state.items.find((candidate) => candidate.id === String(id));
      // The real WHERE clause, and the table's own CHECK constraint.
      if (!item || item.status !== "scheduled" || !item.test_mode) return { rows: [] };
      item.status = "sent";
      item.processed_mode = "test_mode";
      item.processed_at = now().toISOString();
      item.rendered_body = body;
      item.updated_at = now().toISOString();
      return { rows: [{ id: item.id }] };
    }

    if (/SET status = 'skipped'/.test(text)) {
      const [id, reason] = values as [string, string];
      const item = state.items.find((candidate) => candidate.id === String(id));
      if (item && item.status === "scheduled") {
        item.status = "skipped";
        item.skip_reason = reason;
        item.updated_at = now().toISOString();
      }
      return { rows: [] };
    }

    if (/SET status = 'failed'/.test(text)) {
      const [id, reason] = values as [string, string];
      const item = state.items.find((candidate) => candidate.id === String(id));
      if (item && item.status === "scheduled") {
        item.status = "failed";
        item.last_error = reason;
        item.updated_at = now().toISOString();
      }
      return { rows: [] };
    }

    if (/SET status = 'cancelled'/.test(text)) {
      const [id, reason] = values as [string, string | null];
      const item = state.items.find((candidate) => candidate.id === String(id));
      if (!item || item.status !== "scheduled") return { rows: [] };
      item.status = "cancelled";
      item.cancelled_at = now().toISOString();
      item.cancelled_reason = reason;
      item.updated_at = now().toISOString();
      return { rows: [{ id: item.id }] };
    }

    if (/SET recipient_name = \$2/.test(text)) {
      const [id, name] = values as [string, string | null];
      const item = state.items.find((candidate) => candidate.id === String(id));
      if (item) item.recipient_name = name;
      return { rows: [] };
    }

    if (/count\(\*\)::int AS total FROM cst_app\.automation_items/.test(text)) {
      const [key, status] = values as [string, string | null];
      const n = state.items.filter(
        (item) => item.automation_key === key && (status === null || item.status === status),
      ).length;
      return { rows: [{ total: n }] };
    }

    if (/GROUP BY status/.test(text)) {
      const key = String(values[0]);
      const counts = new Map<string, number>();
      for (const item of state.items.filter((i) => i.automation_key === key)) {
        counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
      }
      return { rows: [...counts].map(([status, n]) => ({ status, n })) };
    }

    if (/FROM cst_app\.automation_items i/.test(text)) {
      if (/WHERE i\.id = \$1::bigint/.test(text)) {
        const item = state.items.find((candidate) => candidate.id === String(values[0]));
        return { rows: item === undefined ? [] : [toItemRow(item)] };
      }
      const [key, limit, offset, status] = values as [string, number, number, string | null];
      const matching = state.items
        .filter((item) => item.automation_key === key && (status === null || item.status === status))
        .sort((a, b) => b.dispatched_at.localeCompare(a.dispatched_at));
      return {
        rows: matching
          .slice(Number(offset), Number(offset) + Number(limit))
          .map((item) => ({ ...toItemRow(item), total_count: String(matching.length) })),
      };
    }

    if (/UPDATE cst_app\.automation_settings/.test(text)) {
      return { rows: [] };
    }

    throw new Error(`fakeApp: unrecognised statement\n${text}`);
  };

  const client = { query, release: () => {} };
  state.pool = {
    query,
    connect: async () => client,
  } as unknown as Pool;

  return state;
}

function toItemRow(item: ItemRecord): Record<string, unknown> {
  return {
    id: item.id,
    automation_key: item.automation_key,
    channel: item.channel,
    sub_source_id: item.sub_source_id,
    source_order_id: item.source_order_id,
    source_order_number: item.source_order_number,
    source_shipment_id: item.source_shipment_id,
    recipient_name: item.recipient_name,
    dispatched_at: item.dispatched_at,
    dispatch_source: item.dispatch_source,
    dispatch_time_zone: item.dispatch_time_zone,
    scheduled_at: item.scheduled_at,
    template_id: item.template_id,
    template_version: item.template_version,
    template_name: "Post-dispatch update",
    status: item.status,
    test_mode: item.test_mode,
    processed_mode: item.processed_mode,
    processed_at: item.processed_at,
    rendered_body: item.rendered_body,
    skip_reason: item.skip_reason,
    last_error: item.last_error,
    cancelled_at: item.cancelled_at,
    cancelled_reason: item.cancelled_reason,
    updated_at: item.updated_at,
  };
}
