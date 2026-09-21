import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { eligibilityForPostDispatch } from "@/lib/domain/automation/automation-eligibility-service";
import { runPostDispatchAutomation } from "@/lib/domain/automation/automation-runner";
import {
  mayScan,
  scanRefusal,
  settingsPatchRefusal,
} from "@/lib/domain/automation/automation-settings-service";
import {
  isDue,
  isTerminal,
  mayTransition,
  scheduledAtFrom,
} from "@/lib/domain/automation/automation-work-item-service";
import { AUTOMATION_ITEM_STATUSES } from "@/lib/domain/automation/automation-types";
import { insertScheduledItem } from "@/lib/repositories/automation-repository";
import {
  defaultSettings,
  defaultTemplate,
  dispatchEvent,
  fakeApp,
  fakeSource,
} from "@/tests/support/automation-fakes";

/**
 * Discovery, configuration and scheduling.
 *
 * Every value here is synthetic. No real order number, shipment id or customer
 * name appears in this file.
 */

/**
 * A clock BEFORE anything discovered here comes due.
 *
 * These tests are about discovery: with a fixed earlier "now" the same run's
 * processing pass claims nothing, so what each assertion sees is what the scan
 * alone did. It also makes them independent of the real date, which a test
 * asserting a schedule must be.
 */
const BEFORE_DUE = () => new Date("2026-09-10T12:00:00.000Z");

/** The repository source, so the insert's own SQL can be asserted. */
const REPOSITORY_SOURCE = readFileSync(
  join(__dirname, "..", "..", "lib", "repositories", "automation-repository.ts"),
  "utf8",
);

describe("safe defaults", () => {
  /** The seeded row, restated. A default install must process nothing. */
  const seeded = defaultSettings({
    enabled: false,
    enabledSubSources: [],
    notBefore: null,
  });

  it("is switched off", () => {
    expect(seeded.enabled).toBe(false);
  });

  it("defaults the delay to 24 hours", () => {
    expect(seeded.delayHours).toBe(24);
    expect(defaultSettings().delayHours).toBe(24);
  });

  it("defaults test mode to on", () => {
    expect(seeded.testMode).toBe(true);
  });

  it("has no floor and no storefront", () => {
    expect(seeded.notBefore).toBeNull();
    expect(seeded.enabledSubSources).toEqual([]);
  });

  it("cannot be switched on without a floor", () => {
    expect(settingsPatchRefusal(seeded, { enabled: true })).toMatch(/earliest dispatch date/i);
  });

  it("cannot be switched on without a storefront", () => {
    expect(settingsPatchRefusal(seeded, { enabled: true, notBefore: "2026-09-01" })).toMatch(
      /storefront/i,
    );
  });

  it("cannot be switched on without a template", () => {
    expect(
      settingsPatchRefusal(defaultSettings({ enabled: false, templateId: null }), {
        enabled: true,
      }),
    ).toMatch(/template/i);
  });

  it("refuses to leave test mode, there being no transport", () => {
    expect(settingsPatchRefusal(defaultSettings(), { testMode: false })).toMatch(
      /no marketplace transport/i,
    );
  });

  it("accepts a complete, deliberate change", () => {
    expect(
      settingsPatchRefusal(seeded, {
        enabled: true,
        notBefore: "2026-09-01",
        enabledSubSources: [22],
      }),
    ).toBeNull();
  });

  it("always accepts switching off", () => {
    expect(settingsPatchRefusal(defaultSettings(), { enabled: false, notBefore: null })).toBeNull();
  });
});

describe("the scan refuses to run unless it is safe", () => {
  it("refuses when no earliest dispatch date is configured", () => {
    const refusal = scanRefusal(defaultSettings({ notBefore: null }));
    expect(refusal?.code).toBe("not_before_unset");
    expect(refusal?.reason).toMatch(/every shipment ever dispatched/i);
    expect(mayScan(defaultSettings({ notBefore: null }))).toBe(false);
  });

  it("refuses when the automation is switched off", () => {
    expect(scanRefusal(defaultSettings({ enabled: false }))?.code).toBe("automation_disabled");
  });

  it("refuses when no storefront is in scope", () => {
    expect(scanRefusal(defaultSettings({ enabledSubSources: [] }))?.code).toBe(
      "no_sub_sources_enabled",
    );
  });

  it("refuses when no template is selected", () => {
    expect(scanRefusal(defaultSettings({ templateId: null }))?.code).toBe("no_template_selected");
  });

  it("runs only when every condition is met", () => {
    expect(scanRefusal(defaultSettings())).toBeNull();
  });

  it("reads nothing from the source and creates nothing when disabled", async () => {
    const app = fakeApp({ settings: defaultSettings({ enabled: false }) });
    const source = fakeSource({ discovered: [dispatchEvent()] });

    const summary = await runPostDispatchAutomation({ app: app.pool, source });

    expect(summary.scan.ran).toBe(false);
    expect(source.statements).toEqual([]);
    expect(app.items).toEqual([]);
  });
});

describe("eligibility", () => {
  const settings = defaultSettings();

  it("accepts a dispatched shipment on an active order", () => {
    expect(eligibilityForPostDispatch(settings, dispatchEvent()).eligible).toBe(true);
  });

  it("rejects a shipment that has not gone out", () => {
    expect(eligibilityForPostDispatch(settings, dispatchEvent({ shipmentStatus: "New" }))).toEqual({
      eligible: false,
      reason: "SHIPMENT_NOT_DISPATCHED",
    });
  });

  it("rejects a shipment cancelled after dispatch, whatever its status says", () => {
    expect(eligibilityForPostDispatch(settings, dispatchEvent({ shipmentCancelled: true }))).toEqual(
      { eligible: false, reason: "SHIPMENT_CANCELLED" },
    );
  });

  it("rejects a cancelled order", () => {
    expect(
      eligibilityForPostDispatch(settings, dispatchEvent({ orderStatus: "Cancelled" })),
    ).toEqual({ eligible: false, reason: "ORDER_CANCELLED" });
  });

  it("rejects a refunded order", () => {
    expect(eligibilityForPostDispatch(settings, dispatchEvent({ orderStatus: "Refunded" }))).toEqual(
      { eligible: false, reason: "ORDER_REFUNDED" },
    );
  });

  it("rejects a returned order", () => {
    expect(eligibilityForPostDispatch(settings, dispatchEvent({ returned: true }))).toEqual({
      eligible: false,
      reason: "ORDER_RETURNED",
    });
  });

  it("rejects an order with a cancellation raised on the marketplace", () => {
    expect(
      eligibilityForPostDispatch(settings, dispatchEvent({ cancellationRaised: true })),
    ).toEqual({ eligible: false, reason: "ORDER_CANCELLATION_RAISED" });
  });

  it("rejects a storefront that is not in scope", () => {
    expect(eligibilityForPostDispatch(settings, dispatchEvent({ subSourceId: 999 }))).toEqual({
      eligible: false,
      reason: "SUB_SOURCE_NOT_ENABLED",
    });
  });

  it("rejects a dispatch older than the floor", () => {
    expect(
      eligibilityForPostDispatch(settings, dispatchEvent({ dispatchedAt: "2026-08-01 08:00:00" })),
    ).toEqual({ eligible: false, reason: "DISPATCHED_BEFORE_FLOOR" });
  });

  it("rejects an order with no recipient recorded", () => {
    expect(eligibilityForPostDispatch(settings, dispatchEvent({ customerName: null }))).toEqual({
      eligible: false,
      reason: "CUSTOMER_CONTEXT_MISSING",
    });
  });
});

describe("scanning", () => {
  it("creates one scheduled record for a dispatched shipment", async () => {
    const app = fakeApp({ settings: defaultSettings(), now: BEFORE_DUE });
    const source = fakeSource({ discovered: [dispatchEvent()] });

    const summary = await runPostDispatchAutomation({ app: app.pool, source });

    expect(summary.scan).toMatchObject({ ran: true, examined: 1, created: 1, duplicates: 0 });
    expect(app.items).toHaveLength(1);
    expect(app.items[0]).toMatchObject({
      status: "scheduled",
      source_shipment_id: "7000001",
      channel: "ebay",
      recipient_name: "Sam Tester",
      test_mode: true,
    });
  });

  it("stamps the selected template and its version on the record", async () => {
    const app = fakeApp({
      settings: defaultSettings({ templateId: "500" }),
      templates: [defaultTemplate({ id: "500", version: 3 })],
      now: BEFORE_DUE,
    });
    const source = fakeSource({ discovered: [dispatchEvent()] });

    await runPostDispatchAutomation({ app: app.pool, source });

    expect(app.items[0]).toMatchObject({ template_id: "500", template_version: 3 });
  });

  it("creates nothing for a cancelled, refunded or returned order", async () => {
    const app = fakeApp({ settings: defaultSettings(), now: BEFORE_DUE });
    const source = fakeSource({
      discovered: [
        dispatchEvent({ shipmentId: "1", orderStatus: "Cancelled" }),
        dispatchEvent({ shipmentId: "2", orderStatus: "Refunded" }),
        dispatchEvent({ shipmentId: "3", returned: true }),
        dispatchEvent({ shipmentId: "4", shipmentCancelled: true }),
      ],
    });

    const summary = await runPostDispatchAutomation({ app: app.pool, source });

    expect(summary.scan).toMatchObject({ examined: 4, created: 0, ineligible: 4 });
    expect(app.items).toEqual([]);
  });

  it("excludes a storefront that is not enabled", async () => {
    const app = fakeApp({ settings: defaultSettings({ enabledSubSources: [22] }), now: BEFORE_DUE });
    const source = fakeSource({
      discovered: [dispatchEvent({ subSourceId: 99 }), dispatchEvent({ subSourceId: 22 })],
    });

    const summary = await runPostDispatchAutomation({ app: app.pool, source });

    expect(summary.scan).toMatchObject({ examined: 2, created: 1, ineligible: 1 });
    expect(app.items).toHaveLength(1);
    expect(app.items[0]!.sub_source_id).toBe(22);
  });

  it("is idempotent: a repeated scan creates no duplicate", async () => {
    const app = fakeApp({ settings: defaultSettings(), now: BEFORE_DUE });
    const source = fakeSource({ discovered: [dispatchEvent()] });

    await runPostDispatchAutomation({ app: app.pool, source });
    const second = await runPostDispatchAutomation({ app: app.pool, source });

    expect(second.scan).toMatchObject({ examined: 1, created: 0, duplicates: 1 });
    expect(app.items).toHaveLength(1);
    // The application-side check answered first, so no insert was attempted.
    expect(app.conflicts).toBe(0);
  });

  /**
   * The second half of the duplicate protection, exercised on its own.
   *
   * `insertScheduledItem` is called DIRECTLY here, bypassing the
   * application-side existence check — which is exactly the situation two
   * concurrent scans produce: both look, both see nothing, both insert. Only
   * the unique key can decide that, and this is the test that it does.
   */
  it("lets the unique key stop a second insert on its own", async () => {
    const app = fakeApp({ settings: defaultSettings(), now: BEFORE_DUE });
    const input = {
      automationKey: "post_dispatch_message",
      event: dispatchEvent(),
      dispatchTimeZone: "Europe/Berlin",
      delayHours: 24,
      templateId: "500",
      templateVersion: 1,
      testMode: true,
    };

    const first = await insertScheduledItem(app.pool, input);
    const second = await insertScheduledItem(app.pool, input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(app.items).toHaveLength(1);
    expect(app.conflicts).toBe(1);
  });

  it("states the natural key in the insert itself", () => {
    expect(REPOSITORY_SOURCE).toMatch(
      /ON CONFLICT \(automation_key, sub_source_id, source_shipment_id\) DO NOTHING/,
    );
  });

  it("does not re-create a record for a shipment already processed", async () => {
    const app = fakeApp({ settings: defaultSettings(), now: BEFORE_DUE });
    const source = fakeSource({ discovered: [dispatchEvent()] });

    await runPostDispatchAutomation({ app: app.pool, source });
    // Whatever state it reaches, the key takes no account of status.
    app.items[0]!.status = "sent";

    const second = await runPostDispatchAutomation({ app: app.pool, source });

    expect(second.scan).toMatchObject({ created: 0, duplicates: 1 });
    expect(app.items).toHaveLength(1);
  });

  it("writes nothing but SELECTs to the source", async () => {
    const app = fakeApp({ settings: defaultSettings(), now: BEFORE_DUE });
    const source = fakeSource({ discovered: [dispatchEvent()] });

    await runPostDispatchAutomation({ app: app.pool, source });

    expect(source.statements.length).toBeGreaterThan(0);
    for (const statement of source.statements) {
      expect(statement.trim()).toMatch(/^SELECT\b/i);
      expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
    }
  });
});

describe("scheduling", () => {
  it("schedules from the dispatch time, not the scan time", () => {
    const dispatchedAt = new Date("2026-09-10T08:00:00.000Z");
    expect(scheduledAtFrom(dispatchedAt, 24).toISOString()).toBe("2026-09-11T08:00:00.000Z");
  });

  it("puts a scheduled moment exactly 24 hours after dispatch by default", async () => {
    const app = fakeApp({ settings: defaultSettings(), now: BEFORE_DUE });
    const source = fakeSource({ discovered: [dispatchEvent({ dispatchedAt: "2026-09-10 08:00:00" })] });

    await runPostDispatchAutomation({ app: app.pool, source });

    const item = app.items[0]!;
    const gapHours =
      (Date.parse(item.scheduled_at) - Date.parse(`${item.dispatched_at.replace(" ", "T")}Z`)) /
      3_600_000;
    expect(gapHours).toBe(24);
  });

  it("honours a configured delay other than 24", async () => {
    const app = fakeApp({ settings: defaultSettings({ delayHours: 72 }), now: BEFORE_DUE });
    const source = fakeSource({ discovered: [dispatchEvent({ dispatchedAt: "2026-09-10 08:00:00" })] });

    await runPostDispatchAutomation({ app: app.pool, source });

    const item = app.items[0]!;
    const gapHours =
      (Date.parse(item.scheduled_at) - Date.parse(`${item.dispatched_at.replace(" ", "T")}Z`)) /
      3_600_000;
    expect(gapHours).toBe(72);
  });

  it("makes a record discovered after its moment due immediately", () => {
    const scheduled = scheduledAtFrom(new Date("2026-09-01T08:00:00.000Z"), 24);
    expect(
      isDue(
        { status: "scheduled", scheduledAt: scheduled.toISOString() },
        new Date("2026-09-20T00:00:00Z"),
      ),
    ).toBe(true);
  });

  it("does not make a future record due", () => {
    expect(
      isDue(
        { status: "scheduled", scheduledAt: "2026-12-01T00:00:00.000Z" },
        new Date("2026-09-20T00:00:00Z"),
      ),
    ).toBe(false);
  });

  it("never treats a non-scheduled record as due", () => {
    for (const status of ["sent", "skipped", "failed", "cancelled"] as const) {
      expect(isDue({ status, scheduledAt: "2020-01-01T00:00:00.000Z" }, new Date())).toBe(false);
    }
  });

  it("refuses a negative or fractional delay rather than guessing", () => {
    expect(() => scheduledAtFrom(new Date(), -1)).toThrow();
    expect(() => scheduledAtFrom(new Date(), 1.5)).toThrow();
  });
});

describe("the lifecycle", () => {
  it("has exactly five statuses, with no sending and no review", () => {
    expect([...AUTOMATION_ITEM_STATUSES]).toEqual([
      "scheduled",
      "sent",
      "skipped",
      "failed",
      "cancelled",
    ]);
    for (const forbidden of ["sending", "drafting", "pending_review", "reviewed"]) {
      expect(AUTOMATION_ITEM_STATUSES as readonly string[]).not.toContain(forbidden);
    }
  });

  it("permits only the transitions the design allows", () => {
    expect(mayTransition("scheduled", "sent")).toBe(true);
    expect(mayTransition("scheduled", "skipped")).toBe(true);
    expect(mayTransition("scheduled", "failed")).toBe(true);
    expect(mayTransition("scheduled", "cancelled")).toBe(true);
    expect(mayTransition("cancelled", "sent")).toBe(false);
    expect(mayTransition("sent", "scheduled")).toBe(false);
  });

  it("makes every state but scheduled terminal", () => {
    expect(isTerminal("scheduled")).toBe(false);
    for (const status of ["sent", "skipped", "failed", "cancelled"] as const) {
      expect(isTerminal(status)).toBe(true);
    }
  });
});
