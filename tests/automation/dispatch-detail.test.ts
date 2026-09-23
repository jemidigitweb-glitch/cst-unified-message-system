import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { getAutomationDispatchDetails } from "@/lib/domain/automation/automation-dispatch-detail-service";
import {
  NOT_AVAILABLE,
  datePart,
  dispatchDetailFields,
  timePart,
} from "@/lib/domain/automation/dispatch-detail-view";
import { shipmentDispatchDetail } from "@/lib/repositories/dispatch-detail-repository";

/**
 * The dispatch detail behind one post-dispatch record.
 *
 * No database and no network: both clients are stubs, so these test the
 * RESOLUTION and the DISPLAY RULES — which shipment is fetched, which timestamp
 * is shown, what an absent value prints, and that nothing on this path writes.
 *
 * NO CUSTOMER DATA. Order numbers, shipment ids, tracking references and names
 * here are synthetic. The shapes mirror real ones because the shapes are what
 * several of these assertions are about — notably `shipping_method` stored as an
 * empty string, which is the real state of the order the brief cites and the
 * reason blank is normalised to absent.
 */

const DISPATCHED_AT = "2026-09-22 08:09:39";

/** The record, as `automation_items` holds it. */
function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "9001",
    automation_key: "post_dispatch_followup",
    channel: "ebay",
    sub_source_id: 12,
    source_order_id: "4400001",
    source_order_number: "99-99999-99999",
    source_shipment_id: "8800002",
    recipient_name: "A Buyer",
    dispatched_at: DISPATCHED_AT,
    dispatch_source: "order_info_shipped_time",
    dispatch_time_zone: "Europe/London",
    scheduled_at: "2026-09-23 08:09:39",
    template_id: "3",
    template_version: 2,
    template_name: "Post-dispatch follow-up",
    status: "scheduled",
    test_mode: true,
    processed_mode: null,
    processed_at: null,
    rendered_body: null,
    skip_reason: null,
    last_error: null,
    cancelled_at: null,
    cancelled_reason: null,
    updated_at: "2026-09-22 09:00:00",
    ...overrides,
  };
}

/** A row of `dispatch-event-repository`'s `FIND_ONE` projection. */
function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: "8800002",
    order_id: "4400001",
    order_number: "99-99999-99999",
    source_id: 2,
    sub_source_id: 12,
    sub_source_name: "a-storefront",
    dispatched_at: DISPATCHED_AT,
    order_status: "Completed",
    shipment_status: "Completed",
    shipment_cancelled: false,
    cancellation_raised: false,
    returned: false,
    tracking_number: "AA000000000GB",
    carrier: "Royal Mail",
    first_name: "A",
    last_name: "Buyer",
    address_name: null,
    item_sku: "SKU-1",
    real_sku: null,
    item_title: "A lamp",
    ...overrides,
  };
}

/** A row of the new detail projection. */
function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: "8800002",
    shipping_method: "",
    shipped: 1,
    shipped_error: null,
    source_shipped_time: DISPATCHED_AT,
    shipment_created_at: "2026-09-22 06:35:29",
    cancelled_at: null,
    created_at: "2026-09-22 00:40:23",
    updated_at: "2026-09-22 06:46:32",
    carrier_service_id: "379",
    carrier_service_name: "A TRACKED SERVICE (2kg)",
    carrier_service_code: "STNINRM48",
    shipments_on_order: 1,
    ...overrides,
  };
}

/**
 * Stub clients that record every statement.
 *
 * The two source queries are told apart by a column only the new one selects —
 * both end in `WHERE sh.id = $1::bigint`, which is the point: each is keyed on
 * one named shipment. `byShipment` maps a shipment id to its rows, so a request
 * for a shipment that is not in the map returns nothing, exactly as the source
 * would for an id it does not hold.
 */
function stubs(options: {
  items?: Record<string, ReturnType<typeof item>>;
  events?: Record<string, Record<string, unknown>>;
  details?: Record<string, Record<string, unknown>>;
}) {
  const statements: { text: string; values?: readonly unknown[] }[] = [];

  // `as unknown as Pool`, the convention `tests/support/automation-fakes.ts`
  // already uses: the repository needs only `query`, but its parameter is pg's
  // own `Pool`, whose result carries four fields no stub has any use for.
  const app = {
    query: async (config: { text: string; values?: unknown[] }) => {
      statements.push(config);
      const id = String(config.values?.[0]);
      const row = options.items?.[id];
      return { rows: row === undefined ? [] : [row] };
    },
  } as unknown as Pool;

  const source = {
    query: async (config: { text: string; values?: readonly unknown[] }) => {
      statements.push(config);
      const id = String(config.values?.[0]);
      if (config.text.includes("shipments_on_order")) {
        const row = options.details?.[id];
        return { rows: row === undefined ? [] : [row] };
      }
      const row = options.events?.[id];
      return { rows: row === undefined ? [] : [row] };
    },
  };

  return { app, source, statements };
}

const REPOSITORY_SOURCE = readFileSync(
  join(__dirname, "..", "..", "lib", "repositories", "dispatch-detail-repository.ts"),
  "utf8",
);

const SERVICE_SOURCE = readFileSync(
  join(__dirname, "..", "..", "lib", "domain", "automation", "automation-dispatch-detail-service.ts"),
  "utf8",
);

describe("opening a record loads that record's order and shipment", () => {
  it("resolves the clicked record and returns its own order", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow() },
      details: { "8800002": detailRow() },
    });

    const result = await getAutomationDispatchDetails(app, source, "9001");
    expect(result.found).toBe(true);
    if (!result.found) return;

    const fields = dispatchDetailFields(result.details);
    expect(fields.orderNumber).toBe("99-99999-99999");
    expect(fields.channel).toBe("ebay");
    expect(fields.customer).toBe("A Buyer");
  });

  it("reports an unknown record id as not found rather than as an empty panel", async () => {
    const { app, source } = stubs({ items: {} });
    const result = await getAutomationDispatchDetails(app, source, "404404");
    expect(result.found).toBe(false);
  });

  it("displays the shipment id the record carries", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow() },
      details: { "8800002": detailRow() },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");
    expect(dispatchDetailFields(result.details).shipmentId).toBe("8800002");
  });
});

describe("the dispatch timestamp is the one the scheduler used", () => {
  /**
   * THE RULE THIS FEATURE TURNS ON. The Records table prints
   * `automation_items.dispatched_at`; so does the panel. A fresh read of
   * `order_info.shipped_time` must never become the displayed value, or the two
   * screens would disagree about when a parcel was dispatched.
   */
  it("shows the record's own dispatched_at, split into date and time", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow() },
      details: { "8800002": detailRow() },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");

    const fields = dispatchDetailFields(result.details);
    expect(fields.dispatchDate).toBe("2026-09-22");
    expect(fields.dispatchTime).toBe("08:09:39");
    expect(fields.dispatchSource).toBe("order_info_shipped_time");
    expect(result.details.item.dispatchedAt).toBe(DISPATCHED_AT);
  });

  it("keeps showing the recorded timestamp when the source has moved, and reports the drift", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow({ dispatched_at: "2026-09-25 17:00:00" }) },
      details: { "8800002": detailRow({ source_shipped_time: "2026-09-25 17:00:00" }) },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");

    // Displayed: still the scheduled-from value.
    const fields = dispatchDetailFields(result.details);
    expect(fields.dispatchDate).toBe("2026-09-22");
    expect(fields.dispatchTime).toBe("08:09:39");
    // Reported: both sides, as a discrepancy rather than a correction.
    expect(result.details.dispatchDrift).toEqual({
      recorded: DISPATCHED_AT,
      sourceNow: "2026-09-25 17:00:00",
    });
  });

  it("reports no drift when the source still agrees", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow() },
      details: { "8800002": detailRow() },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");
    expect(result.details.dispatchDrift).toBeNull();
  });

  /** A naive timestamp is split, never parsed — parsing would shift the date. */
  it("splits a naive timestamp without going through a Date", () => {
    expect(datePart("2026-09-22 23:45:01")).toBe("2026-09-22");
    expect(timePart("2026-09-22 23:45:01")).toBe("23:45:01");
    expect(timePart("2026-09-22 23:45:01.123")).toBe("23:45:01");
    expect(datePart(null)).toBeNull();
    expect(timePart("2026-09-22")).toBeNull();
  });
});

describe("tracking, courier and shipping method come from the source", () => {
  it("displays the tracking number, the resolved courier and the carrier service", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow() },
      details: { "8800002": detailRow() },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");

    const fields = dispatchDetailFields(result.details);
    expect(fields.trackingNumber).toBe("AA000000000GB");
    expect(fields.courier).toBe("Royal Mail");
    expect(fields.carrierService).toBe("A TRACKED SERVICE (2kg)");
    expect(fields.shipmentStatus).toBe("Completed");
  });

  it("displays a recorded shipping method", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow() },
      details: { "8800002": detailRow({ shipping_method: "Tracked 48" }) },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");
    expect(dispatchDetailFields(result.details).shippingMethod).toBe("Tracked 48");
  });

  /**
   * `order_info.shipping_method` is declared NOT NULL and is EMPTY on real rows.
   * A caller trusting the constraint would print a blank label.
   */
  it("treats a blank shipping method as absent", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow() },
      details: { "8800002": detailRow({ shipping_method: "" }) },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");
    expect(dispatchDetailFields(result.details).shippingMethod).toBe(NOT_AVAILABLE);
  });

  it("says Not available when there is no tracking number", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow({ tracking_number: null }) },
      details: { "8800002": detailRow() },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");
    expect(dispatchDetailFields(result.details).trackingNumber).toBe(NOT_AVAILABLE);
  });

  /**
   * NO CARRIER MEANS NO CARRIER. The numeric `carrier_service_id` is still
   * returned on the payload so the panel can report it as an unresolved id, but
   * it must never be offered as the courier's name.
   */
  it("says Not available when no carrier name resolves, and never substitutes the id", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow({ carrier: null }) },
      details: { "8800002": detailRow({ carrier_service_name: null, carrier_service_id: "379" }) },
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");

    const fields = dispatchDetailFields(result.details);
    expect(fields.courier).toBe(NOT_AVAILABLE);
    expect(fields.carrierService).toBe(NOT_AVAILABLE);
    expect(fields.courier).not.toContain("379");
    // Still available to be labelled as an id, which is a different claim.
    expect(result.details.shipment?.carrierServiceId).toBe("379");
  });

  it("reports the source half as unavailable when the shipment is gone, and keeps the record", async () => {
    const { app, source } = stubs({
      items: { "9001": item() },
      events: {},
      details: {},
    });
    const result = await getAutomationDispatchDetails(app, source, "9001");
    if (!result.found) throw new Error("expected the record");

    expect(result.details.event).toBeNull();
    expect(result.details.shipment).toBeNull();
    const fields = dispatchDetailFields(result.details);
    expect(fields.trackingNumber).toBe(NOT_AVAILABLE);
    expect(fields.courier).toBe(NOT_AVAILABLE);
    // The automation half is unaffected, and the dispatch time still reads.
    expect(fields.shipmentId).toBe("8800002");
    expect(fields.dispatchDate).toBe("2026-09-22");
  });
});

describe("one order, several shipments", () => {
  /**
   * The brief's case. Two shipments on one order; the record names one of them,
   * and the panel must fetch THAT one rather than the order's first.
   */
  it("resolves the record's shipment, not the order's first", async () => {
    const { app, source, statements } = stubs({
      items: { "9002": item({ id: "9002", source_shipment_id: "8800002" }) },
      events: {
        // The earlier shipment on the same order. Must not be chosen.
        "8800001": eventRow({ shipment_id: "8800001", tracking_number: "FIRSTPARCEL", carrier: "Evri" }),
        "8800002": eventRow({ shipment_id: "8800002", tracking_number: "SECONDPARCEL" }),
      },
      details: {
        "8800001": detailRow({ shipment_id: "8800001", shipments_on_order: 2 }),
        "8800002": detailRow({ shipment_id: "8800002", shipments_on_order: 2 }),
      },
    });

    const result = await getAutomationDispatchDetails(app, source, "9002");
    if (!result.found) throw new Error("expected the record");

    const fields = dispatchDetailFields(result.details);
    expect(fields.shipmentId).toBe("8800002");
    expect(fields.trackingNumber).toBe("SECONDPARCEL");
    expect(fields.courier).toBe("Royal Mail");
    // And it says this is one of several, rather than implying it is the only one.
    expect(fields.shipmentsOnOrder).toBe(2);

    // Every source read was keyed on the record's shipment id and no other.
    const sourceValues = statements
      .filter((s) => s.text.includes("order_management.shipment"))
      .map((s) => String(s.values?.[0]));
    expect(sourceValues.length).toBeGreaterThan(0);
    expect(new Set(sourceValues)).toEqual(new Set(["8800002"]));
  });

  it("keys the supplementary read on the shipment, never on the order", () => {
    expect(REPOSITORY_SOURCE).toContain("WHERE sh.id = $1::bigint");
    expect(REPOSITORY_SOURCE).not.toMatch(/WHERE\s+o\.id\s*=/);
    expect(REPOSITORY_SOURCE).not.toMatch(/WHERE\s+sh\.order_id\s*=/);
  });

  it("refuses a non-numeric shipment id before it reaches the cast", async () => {
    const calls: unknown[] = [];
    const source = {
      query: async (config: { text: string }) => {
        calls.push(config.text);
        return { rows: [] };
      },
    };
    expect(await shipmentDispatchDetail(source, "8800002; DROP")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("the source database stays read-only", () => {
  /**
   * Matched as SQL WRITE FORMS, not as bare words. `AS created_at` and
   * `sh.updated_at` are column names this projection legitimately selects, and a
   * substring check on "CREATE"/"UPDATE" flags them — which is a test that fails
   * for the wrong reason and teaches the next reader to loosen it.
   */
  const WRITE_STATEMENT =
    /\b(insert\s+into|update\s+[\w.]+\s+set|delete\s+from|truncate\b|alter\s+table|drop\s+table|create\s+(table|index|view))/i;

  it("issues nothing but SELECTs on the source path", () => {
    expect(REPOSITORY_SOURCE).not.toMatch(WRITE_STATEMENT);
    expect(REPOSITORY_SOURCE).toContain("SELECT");
  });

  it("does not write from the service either", () => {
    expect(SERVICE_SOURCE).not.toMatch(WRITE_STATEMENT);
  });

  it("parameterises every value it sends", () => {
    // The only interpolation in the statement is `$1`; no template placeholder
    // may reach the SQL text.
    const statements = REPOSITORY_SOURCE.match(/`\nSELECT[\s\S]*?`/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).not.toMatch(/\$\{/);
    }
  });

  it("records no write on either client when a panel is opened", async () => {
    const { app, source, statements } = stubs({
      items: { "9001": item() },
      events: { "8800002": eventRow() },
      details: { "8800002": detailRow() },
    });
    await getAutomationDispatchDetails(app, source, "9001");

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.text.toUpperCase()).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    }
  });
});

describe("no automation behaviour changes", () => {
  /**
   * The detail path must not be able to reschedule, re-evaluate eligibility or
   * render a template. Asserted on the service's imports rather than by trying to
   * observe an absence at runtime.
   */
  it("neither schedules, evaluates eligibility nor renders a template", () => {
    expect(SERVICE_SOURCE).not.toContain("automation-eligibility-service");
    expect(SERVICE_SOURCE).not.toContain("automation-template-service");
    expect(SERVICE_SOURCE).not.toContain("automation-work-item-service");
    expect(SERVICE_SOURCE).not.toContain("automation-runner");
    expect(SERVICE_SOURCE).not.toContain("insertScheduledItem");
    expect(SERVICE_SOURCE).not.toContain("scheduledAtFrom");
  });

  /**
   * The scheduler's own query is untouched. This feature adds a second read
   * rather than widening the one the runner depends on, so the recheck before a
   * record is processed is byte-for-byte what it was.
   */
  it("leaves the scheduler's dispatch-event query as the only thing it reuses from it", () => {
    expect(SERVICE_SOURCE).toContain("dispatchEventForShipment");
    const eventRepository = readFileSync(
      join(__dirname, "..", "..", "lib", "repositories", "dispatch-event-repository.ts"),
      "utf8",
    );
    // The eligibility filter and the delay are still where they were.
    expect(eventRepository).toContain("WHERE sh.status = 'Completed'");
    expect(eventRepository).toContain("AND oi.shipped_time IS NOT NULL");
  });

  it("reads the dispatch timestamp from the record and never from the live shipment", () => {
    // The displayed value is built from `item.dispatchedAt`. A change that
    // pointed it at the source read would fail here and in the drift test above.
    const view = readFileSync(
      join(__dirname, "..", "..", "lib", "domain", "automation", "dispatch-detail-view.ts"),
      "utf8",
    );
    expect(view).toContain("datePart(item.dispatchedAt)");
    expect(view).toContain("timePart(item.dispatchedAt)");
    expect(view).not.toContain("datePart(shipment");
    expect(view).not.toContain("datePart(event");
  });
});
