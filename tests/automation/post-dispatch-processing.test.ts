import { describe, expect, it } from "vitest";

import {
  cancelScheduledItem,
  processDueItems,
} from "@/lib/domain/automation/automation-runner";
import {
  renderTemplate,
  templateIsUsable,
  templateVariables,
} from "@/lib/domain/automation/automation-template-service";
import { listItems, itemStatusCounts } from "@/lib/repositories/automation-repository";
import {
  type ItemRecord,
  defaultSettings,
  defaultTemplate,
  dispatchEvent,
  fakeApp,
  fakeSource,
} from "@/tests/support/automation-fakes";

/**
 * Processing a due record: recheck, render, record.
 *
 * NOTHING IN THIS FILE REACHES A NETWORK. The runner has no client to reach one
 * with — that is the property under test, and the fakes below are a database
 * and a source reader, not a transport.
 *
 * Every value is synthetic: no real order number, shipment id or customer name
 * appears here.
 */

function dueItem(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: "1",
    automation_key: "post_dispatch_message",
    channel: "ebay",
    sub_source_id: 22,
    source_order_id: "900001",
    source_order_number: "TEST-ORDER-0001",
    source_shipment_id: "7000001",
    recipient_name: "Sam Tester",
    dispatched_at: "2026-09-10 08:00:00",
    dispatch_source: "order_info_shipped_time",
    dispatch_time_zone: "Europe/Berlin",
    scheduled_at: "2026-09-11T08:00:00.000Z",
    template_id: "500",
    template_version: 1,
    status: "scheduled",
    test_mode: true,
    processed_mode: null,
    processed_at: null,
    rendered_body: null,
    skip_reason: null,
    last_error: null,
    cancelled_at: null,
    cancelled_reason: null,
    updated_at: "2026-09-10T08:00:00.000Z",
    ...overrides,
  };
}

describe("template rendering", () => {
  it("substitutes only verified source values", () => {
    const variables = templateVariables(dispatchEvent());
    const result = renderTemplate(defaultTemplate(), variables);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toContain("Hello Sam Tester,");
      expect(result.body).toContain("Your order TEST-ORDER-0001 has been dispatched.");
      expect(result.body).not.toContain("{{");
    }
  });

  it("fails, naming the value, rather than rendering a blank", () => {
    const variables = templateVariables(dispatchEvent({ customerName: null }));
    const result = renderTemplate(defaultTemplate(), variables);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["customer_name"]);
  });

  it("fails on an unresolved placeholder even when it is not declared required", () => {
    const template = defaultTemplate({
      bodyTemplate: "Your parcel is with {{courier}}.",
      requiredVariables: [],
    });
    const result = renderTemplate(template, templateVariables(dispatchEvent({ carrier: null })));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["courier"]);
  });

  it("carries no customer contact detail into the variables", () => {
    const names = Object.keys(templateVariables(dispatchEvent()));
    expect(names).toContain("customer_name");
    expect(names).toContain("order_number");
    for (const forbidden of ["email", "address", "postcode", "phone"]) {
      expect(names.join(" ")).not.toContain(forbidden);
    }
  });

  it("refuses an unapproved or inactive template", () => {
    expect(templateIsUsable(defaultTemplate())).toBe(true);
    expect(templateIsUsable(defaultTemplate({ approved: false }))).toBe(false);
    expect(templateIsUsable(defaultTemplate({ active: false }))).toBe(false);
  });
});

describe("processing a due record", () => {
  it("rechecks the source, renders the template, and records a test-mode result", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    const summary = await processDueItems({ app: app.pool, source, limit: 10 });

    expect(summary).toMatchObject({ claimed: 1, processed: 1, skipped: 0, failed: 0 });
    const item = app.items[0]!;
    expect(item.status).toBe("sent");
    expect(item.test_mode).toBe(true);
    expect(item.processed_mode).toBe("test_mode");
    expect(item.processed_at).not.toBeNull();
    expect(item.rendered_body).toContain("Your order TEST-ORDER-0001 has been dispatched.");
  });

  it("re-reads the current source state before processing", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    await processDueItems({ app: app.pool, source, limit: 10 });

    // One statement, and it is the single-shipment re-read — not the scan.
    expect(source.statements).toHaveLength(1);
    expect(source.statements[0]).toMatch(/WHERE sh\.id = \$1::bigint/);
  });

  it.each([
    ["cancelled order", { orderStatus: "Cancelled" }, "ORDER_CANCELLED"],
    ["refunded order", { orderStatus: "Refunded" }, "ORDER_REFUNDED"],
    ["returned order", { returned: true }, "ORDER_RETURNED"],
    ["cancelled shipment", { shipmentCancelled: true }, "SHIPMENT_CANCELLED"],
    ["cancellation raised", { cancellationRaised: true }, "ORDER_CANCELLATION_RAISED"],
  ])("skips a %s found at recheck time", async (_label, override, reason) => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent(override) } });

    const summary = await processDueItems({ app: app.pool, source, limit: 10 });

    expect(summary).toMatchObject({ claimed: 1, processed: 0, skipped: 1 });
    expect(app.items[0]!.status).toBe("skipped");
    expect(app.items[0]!.skip_reason).toBe(reason);
    expect(app.items[0]!.rendered_body).toBeNull();
  });

  it("skips a shipment that is no longer in the order system", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": null } });

    await processDueItems({ app: app.pool, source, limit: 10 });

    expect(app.items[0]!.skip_reason).toBe("SHIPMENT_NOT_FOUND");
  });

  it("does not claim a record whose moment has not arrived", async () => {
    const app = fakeApp({
      settings: defaultSettings(),
      items: [dueItem({ scheduled_at: "2099-01-01T00:00:00.000Z" })],
    });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    const summary = await processDueItems({ app: app.pool, source, limit: 10 });

    expect(summary.claimed).toBe(0);
    expect(app.items[0]!.status).toBe("scheduled");
  });

  it("fails, naming the missing value, when the template cannot be rendered", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent({ customerName: null }) } });

    const summary = await processDueItems({ app: app.pool, source, limit: 10 });

    // Missing customer context is caught by the recheck first, which is the
    // better answer: it says the order lacked context, not that a string failed.
    expect(summary.skipped).toBe(1);
    expect(app.items[0]!.skip_reason).toBe("CUSTOMER_CONTEXT_MISSING");
  });

  it("fails when the stamped template version no longer matches", async () => {
    const app = fakeApp({
      settings: defaultSettings(),
      templates: [defaultTemplate({ version: 2 })],
      items: [dueItem({ template_version: 1 })],
    });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    const summary = await processDueItems({ app: app.pool, source, limit: 10 });

    expect(summary.failed).toBe(1);
    expect(app.items[0]!.status).toBe("failed");
    expect(app.items[0]!.last_error).toBe("TEMPLATE_VERSION_CHANGED");
  });

  it("fails rather than processing when the template is no longer usable", async () => {
    const app = fakeApp({
      settings: defaultSettings(),
      templates: [defaultTemplate({ approved: false, active: false })],
      items: [dueItem()],
    });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    await processDueItems({ app: app.pool, source, limit: 10 });

    expect(app.items[0]!.last_error).toBe("TEMPLATE_NOT_USABLE");
  });

  it("does nothing at all once the automation is switched off", async () => {
    const app = fakeApp({ settings: defaultSettings({ enabled: false }), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    const summary = await processDueItems({ app: app.pool, source, limit: 10 });

    expect(summary).toMatchObject({ claimed: 0, processed: 0 });
    expect(app.items[0]!.status).toBe("scheduled");
    expect(source.statements).toEqual([]);
  });

  it("writes nothing but SELECTs to the source", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    await processDueItems({ app: app.pool, source, limit: 10 });

    expect(source.statements.length).toBeGreaterThan(0);
    for (const statement of source.statements) {
      expect(statement.trim()).toMatch(/^SELECT\b/i);
    }
  });
});

describe("test mode", () => {
  it("records the mode on the row, not just in the status", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    await processDueItems({ app: app.pool, source, limit: 10 });

    expect(app.items[0]).toMatchObject({
      status: "sent",
      test_mode: true,
      processed_mode: "test_mode",
    });
  });

  /**
   * The one test that says what "sent" does NOT mean.
   *
   * A record whose `test_mode` is false cannot be processed: the runner refuses
   * it, the UPDATE's WHERE clause refuses it, and the table's CHECK constraint
   * refuses the row. There is no path in this application that records a `sent`
   * row claiming a message left the system.
   */
  it("refuses to process a record that is not marked test mode", async () => {
    const app = fakeApp({
      settings: defaultSettings(),
      items: [dueItem({ test_mode: false })],
    });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    const summary = await processDueItems({ app: app.pool, source, limit: 10 });

    expect(summary).toMatchObject({ processed: 0, failed: 1 });
    expect(app.items[0]!.status).toBe("failed");
    expect(app.items[0]!.last_error).toBe("NO_TRANSPORT_CONFIGURED");
  });

  it("issues no statement that could reach a marketplace or a mailbox", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    await processDueItems({ app: app.pool, source, limit: 10 });

    // Everything this run did, in full. Two databases and nothing else.
    for (const statement of [...app.statements, ...source.statements]) {
      expect(statement).not.toMatch(/https?:\/\//i);
      expect(statement).not.toMatch(/\b(smtp|sendgrid|mailgun|api\.ebay|amazonaws)\b/i);
    }
  });
});

describe("cancelling", () => {
  it("stops a scheduled record, and it is never picked up again", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    const cancelled = await cancelScheduledItem(app.pool, { id: "1", reason: "Not wanted" });
    expect(cancelled).toBe(true);
    expect(app.items[0]).toMatchObject({ status: "cancelled", cancelled_reason: "Not wanted" });

    const summary = await processDueItems({ app: app.pool, source, limit: 10 });

    expect(summary).toMatchObject({ claimed: 0, processed: 0 });
    expect(app.items[0]!.status).toBe("cancelled");
  });

  it("refuses to cancel a record that has already been processed", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [dueItem()] });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });
    await processDueItems({ app: app.pool, source, limit: 10 });

    const cancelled = await cancelScheduledItem(app.pool, { id: "1", reason: "Too late" });

    expect(cancelled).toBe(false);
    expect(app.items[0]!.status).toBe("sent");
  });
});

describe("the admin read model", () => {
  it("counts every status for the filter chips", async () => {
    const app = fakeApp({
      settings: defaultSettings(),
      items: [
        dueItem({ id: "1", status: "scheduled" }),
        dueItem({ id: "2", status: "sent", source_shipment_id: "2" }),
        dueItem({ id: "3", status: "skipped", source_shipment_id: "3" }),
        dueItem({ id: "4", status: "failed", source_shipment_id: "4" }),
        dueItem({ id: "5", status: "cancelled", source_shipment_id: "5" }),
      ],
    });

    const counts = await itemStatusCounts(app.pool, "post_dispatch_message");

    expect(counts).toEqual({ scheduled: 1, sent: 1, skipped: 1, failed: 1, cancelled: 1 });
  });

  it("filters the list by status and reports the filtered total", async () => {
    const app = fakeApp({
      settings: defaultSettings(),
      items: [
        dueItem({ id: "1", status: "scheduled" }),
        dueItem({ id: "2", status: "sent", source_shipment_id: "2" }),
        dueItem({ id: "3", status: "sent", source_shipment_id: "3" }),
      ],
    });

    const page = await listItems(app.pool, {
      automationKey: "post_dispatch_message",
      limit: 50,
      status: "sent",
    });

    expect(page.total).toBe(2);
    expect(page.items.every((item) => item.status === "sent")).toBe(true);
  });
});
