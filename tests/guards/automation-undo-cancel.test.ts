import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cancelScheduledItem,
  claimAndProcessDue,
  restoreCancelledItem,
} from "@/lib/domain/automation/automation-runner";
import { POST_DISPATCH_AUTOMATION_KEY } from "@/lib/domain/automation/automation-types";
import {
  type ItemRecord,
  defaultSettings,
  defaultTemplate,
  dispatchEvent,
  fakeApp,
  fakeSource,
} from "../support/automation-fakes";

/**
 * Undo Cancel: the inverse of the cancellation, and nothing more.
 *
 * WHAT IS BEING PINNED HERE, in the order the task asked for it:
 *
 *   * a cancelled record goes back to `scheduled`
 *   * `scheduled_at`, `dispatched_at` and every provenance column are UNCHANGED
 *   * no new row is created and no `scheduled_at` is recalculated
 *   * an overdue record becomes processable, on its ORIGINAL time
 *   * a future record is not processable yet, and becomes so at that time
 *   * only `cancelled` can be restored; every other status is refused
 *
 * The last one is the reason this is a state-machine test rather than a route
 * test: `restoreItem`'s WHERE clause is the guarantee, so every status is walked
 * through it rather than trusting the two that were thought of.
 */

const ROOT = join(__dirname, "..", "..");

/** A scheduled record as the scan writes it, with an id and a moment of our choosing. */
function item(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: "42",
    automation_key: POST_DISPATCH_AUTOMATION_KEY,
    channel: "ebay",
    sub_source_id: 22,
    source_order_id: "900001",
    source_order_number: "TEST-ORDER-0001",
    source_shipment_id: "7000001",
    recipient_name: "Sam Tester",
    dispatched_at: "2026-09-20 08:00:00",
    dispatch_source: "order_info_shipped_time",
    dispatch_time_zone: "Europe/Berlin",
    scheduled_at: "2026-09-21T08:00:00.000Z",
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
    updated_at: "2026-09-21T07:00:00.000Z",
    ...overrides,
  };
}

/** A record already cancelled, which is the only state Undo Cancel may act on. */
function cancelled(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return item({
    status: "cancelled",
    cancelled_at: "2026-09-20T09:00:00.000Z",
    cancelled_reason: "Cancelled from the admin page",
    ...overrides,
  });
}

describe("Undo Cancel moves a cancelled record back to scheduled", () => {
  it("restores a cancelled record, keeping its schedule and provenance", async () => {
    const original = cancelled();
    const app = fakeApp({ settings: defaultSettings(), items: [{ ...original }] });

    expect(await restoreCancelledItem(app.pool, "42")).toBe(true);

    const restored = app.items[0]!;
    expect(restored.status).toBe("scheduled");

    // REQUIREMENT 4: nothing the record was promised is rewritten.
    expect(restored.scheduled_at).toBe(original.scheduled_at);
    expect(restored.dispatched_at).toBe(original.dispatched_at);
    expect(restored.source_shipment_id).toBe(original.source_shipment_id);
    expect(restored.source_order_id).toBe(original.source_order_id);
    expect(restored.sub_source_id).toBe(original.sub_source_id);
    expect(restored.channel).toBe(original.channel);
    expect(restored.template_id).toBe(original.template_id);
    expect(restored.template_version).toBe(original.template_version);

    // REQUIREMENT 5: no new row, and the id is the same record.
    expect(app.items).toHaveLength(1);
    expect(app.items[0]!.id).toBe("42");

    // The cancellation is kept rather than erased, so the history stays readable.
    expect(restored.cancelled_at).toBe(original.cancelled_at);
    expect(restored.cancelled_reason).toBe(original.cancelled_reason);
  });

  /**
   * REQUIREMENT 5, THE STRONGEST FORM IT CAN TAKE.
   *
   * The statement that does the restore names exactly two columns -- `status` and
   * `updated_at`. That is what makes "do not recalculate `scheduled_at`" a
   * property of the SQL rather than a promise in a comment: there is no
   * arithmetic to get wrong, and no INSERT to get wrong either.
   */
  it("writes only the status, so nothing can be recalculated", () => {
    const repository = readFileSync(
      join(ROOT, "lib", "repositories", "automation-repository.ts"),
      "utf8",
    );
    const statement = /UPDATE cst_app\.automation_items\s+SET status = 'scheduled',[\s\S]{0,200}?RETURNING id/.exec(
      repository,
    )?.[0];
    expect(statement).toBeDefined();
    // Two assignments, and neither is the schedule.
    const assignments = statement!.match(/SET ([\s\S]*?)\s+WHERE/)?.[1] ?? "";
    expect(assignments).toMatch(/status = 'scheduled'/);
    expect(assignments).toMatch(/updated_at = now\(\)/);
    expect(assignments).not.toMatch(/scheduled_at/);
    expect(assignments).not.toMatch(/dispatched_at/);
    expect(assignments).not.toMatch(/cancelled_at/);
    // ...and it is an UPDATE of the existing row, never an INSERT.
    expect(statement).toMatch(/^UPDATE cst_app\.automation_items/);
    expect(statement).not.toMatch(/INSERT/);
  });

  /**
   * THE REAL DATABASE USED TO REFUSE THIS UPDATE. 0011 required
   * `cancelled_at` to be null on every non-cancelled row, which is exactly the
   * write Undo Cancel makes. 0013 (and the 0011 CREATE TABLE, for a fresh
   * database) keeps "cancelled rows have a timestamp" and drops the other half.
   */
  it("is allowed by the cancel-pair CHECK, which no longer forbids history on a scheduled row", () => {
    const eleven = readFileSync(
      join(ROOT, "migrations", "0011_post_dispatch_automation.up.sql"),
      "utf8",
    );
    const thirteen = readFileSync(
      join(ROOT, "migrations", "0013_automation_restore_cancel_pair.up.sql"),
      "utf8",
    );
    expect(eleven).toMatch(
      /CONSTRAINT ck_automation_items_cancel_pair\s+CHECK \(status <> 'cancelled' OR cancelled_at IS NOT NULL\)/,
    );
    expect(eleven).not.toMatch(
      /\(status = 'cancelled'\) = \(cancelled_at IS NOT NULL\)/,
    );
    expect(thirteen).toMatch(/DROP CONSTRAINT IF EXISTS ck_automation_items_cancel_pair/);
    expect(thirteen).toMatch(/CHECK \(status <> 'cancelled' OR cancelled_at IS NOT NULL\)/);
  });
});

describe("only a cancelled record can be restored", () => {
  /**
   * EVERY OTHER STATE, one at a time. Cancelling is a decision an operator made;
   * a `sent`, `skipped` or `failed` record is an OUTCOME, and there is no button
   * anywhere that overturns one. `scheduled` is refused too, so a double-click or
   * a stale tab cannot move a record backwards twice.
   */
  for (const status of ["scheduled", "sent", "skipped", "failed"] as const) {
    it(`refuses to restore a '${status}' record`, async () => {
      const app = fakeApp({
        settings: defaultSettings(),
        items: [item({ status, skip_reason: "ORDER_RETURNED", last_error: "TEMPLATE_NOT_USABLE" })],
      });

      expect(await restoreCancelledItem(app.pool, "42")).toBe(false);
      expect(app.items[0]!.status).toBe(status);
    });
  }

  it("refuses a record that does not exist", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [] });
    expect(await restoreCancelledItem(app.pool, "999")).toBe(false);
  });

  it("is idempotent-ish: a second restore of the same record does nothing", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [cancelled()] });

    expect(await restoreCancelledItem(app.pool, "42")).toBe(true);
    // The record is `scheduled` now, so the second attempt matches nothing --
    // and in particular does not reset `cancelled_at` or create a second row.
    expect(await restoreCancelledItem(app.pool, "42")).toBe(false);
    expect(app.items).toHaveLength(1);
  });

  /** The pairing that makes the button safe: once restored, it can be cancelled again. */
  it("can be cancelled again after a restore, and restored again", async () => {
    const app = fakeApp({ settings: defaultSettings(), items: [cancelled()] });

    expect(await restoreCancelledItem(app.pool, "42")).toBe(true);
    expect(await cancelScheduledItem(app.pool, { id: "42", reason: null })).toBe(true);
    expect(app.items[0]!.status).toBe("cancelled");
    expect(await restoreCancelledItem(app.pool, "42")).toBe(true);
    expect(app.items[0]!.status).toBe("scheduled");
    expect(app.items).toHaveLength(1);
  });
});

describe("a restored record is processable on its original moment", () => {
  const settings = defaultSettings();

  /** An overdue record: its moment is in the past, so the due query matches it. */
  async function restoredOverdue() {
    const app = fakeApp({
      settings,
      templates: [defaultTemplate()],
      items: [
        cancelled({
          scheduled_at: "2026-09-25T08:00:00.000Z",
          // Well after the scheduled moment, so it is overdue when claimed.
          updated_at: "2026-09-25T08:00:00.000Z",
        }),
      ],
      now: () => new Date("2026-09-26T12:00:00.000Z"),
    });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });
    await restoreCancelledItem(app.pool, "42");
    return { app, source };
  }

  it("becomes processable immediately when its scheduled time has passed", async () => {
    const { app, source } = await restoredOverdue();

    const connection = await app.pool.connect();
    const outcome = await claimAndProcessDue({ app: app.pool, source, limit: 50 }, settings, connection);
    connection.release();

    expect(outcome.claimed).toBe(1);
    expect(outcome.processed).toBe(1);
    const processed = app.items[0]!;
    expect(processed.status).toBe("sent");
    // Test mode, and the moment it was processed was its ORIGINAL schedule.
    expect(processed.processed_mode).toBe("test_mode");
    expect(processed.scheduled_at).toBe("2026-09-25T08:00:00.000Z");
    // The source was read for the recheck, and read only.
    expect(source.statements.length).toBeGreaterThan(0);
    for (const statement of source.statements) {
      expect(statement.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });

  /**
   * REQUIREMENT 6, THE OTHER HALF. A future moment must NOT be processable yet.
   * The record waits, on the time it always had -- which is what makes "undo"
   * mean "put it back" rather than "run it now".
   */
  it("is NOT processable while its scheduled time is still in the future", async () => {
    const app = fakeApp({
      settings,
      templates: [defaultTemplate()],
      items: [cancelled({ scheduled_at: "2026-09-27T08:00:00.000Z" })],
      now: () => new Date("2026-09-26T12:00:00.000Z"),
    });
    const source = fakeSource({ byShipment: { "7000001": dispatchEvent() } });

    await restoreCancelledItem(app.pool, "42");

    const connection = await app.pool.connect();
    const outcome = await claimAndProcessDue({ app: app.pool, source, limit: 50 }, settings, connection);
    connection.release();

    expect(outcome.claimed).toBe(0);
    expect(outcome.processed).toBe(0);
    expect(app.items[0]!.status).toBe("scheduled");
    // No source read at all: there was nothing due to recheck.
    expect(source.statements).toEqual([]);
  });

  /**
   * THE RECHECK STILL RUNS, AND IT STILL WINS. An order cancelled or returned
   * while the record sat cancelled is skipped at processing time rather than
   * having a cheerful dispatch message rendered about it — undoing a
   * cancellation does not undo the order's state.
   */
  it("skips a restored record whose order has since been returned", async () => {
    const { app, source } = await restoredOverdue();
    // The same shipment, re-read: the customer sent it back in the meantime.
    const returned = fakeSource({
      byShipment: { "7000001": dispatchEvent({ returned: true }) },
    });
    void source;

    const connection = await app.pool.connect();
    const outcome = await claimAndProcessDue(
      { app: app.pool, source: returned, limit: 50 },
      settings,
      connection,
    );
    connection.release();

    expect(outcome.claimed).toBe(1);
    expect(outcome.processed).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(app.items[0]!.status).toBe("skipped");
    expect(app.items[0]!.skip_reason).toBe("ORDER_RETURNED");
  });
});

describe("the restore route exposes no way to send anything", () => {
  const route = readFileSync(
    join(ROOT, "app", "api", "automations", "[itemId]", "restore", "route.ts"),
    "utf8",
  );

  it("calls only the restore writer", () => {
    expect(route).toMatch(/restoreCancelledItem/);
    for (const forbidden of [
      "markItemProcessed",
      "runPostDispatchAutomation",
      "processDueItems",
      "selectDueItems",
      "insertScheduledItem",
      "updateAutomationSettings",
      "renderTemplate",
      "dispatchEventForShipment",
    ]) {
      expect(route, `restore route must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("carries no transport and no credential", () => {
    for (const pattern of [
      /\bfetch\s*\(/,
      /https?:\/\//,
      /ebay\.com/i,
      /amazonaws\.com/i,
      /myshopify\.com/i,
      /sendgrid|mailgun|postmark|nodemailer|smtp\./i,
      /EBAY_[A-Z_]*TOKEN/,
      /SMTP_[A-Z_]+/,
      /GEMINI_API_KEY/,
    ]) {
      expect(route).not.toMatch(pattern);
    }
  });

  it("exports no route method that could be mistaken for a trigger", () => {
    // POST only. No GET, so nothing can be reached by following a link, and no
    // PUT/DELETE, which the API-surface guard forbids everywhere.
    expect(route).toMatch(/export async function POST/);
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD"]) {
      expect(route).not.toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`));
    }
  });

  it("validates the id and refuses other statuses with a conflict", () => {
    expect(route).toMatch(/\/\^\\d\+\$\//);
    expect(route).toMatch(/status: 409/);
    expect(route).toMatch(/code: "not_restorable"/);
  });
});

describe("both record controls are offered on the right state only", () => {
  const admin = readFileSync(join(ROOT, "components", "automation-admin.tsx"), "utf8");

  /** REQUIREMENT 1: the confirmation, worded as specified. */
  it("asks before cancelling", () => {
    expect(admin).toContain("window.confirm(");
    expect(admin).toMatch(/Cancel this scheduled automation\?/);
    // The confirmation has to gate the request, not merely be present.
    const cancelBody = admin.slice(admin.indexOf("const cancel = useCallback"));
    expect(cancelBody.indexOf("window.confirm")).toBeLessThan(
      cancelBody.indexOf("/api/automations/${id}/cancel"),
    );
  });

  /** REQUIREMENT 2: only a cancelled row offers the undo. */
  it("offers Undo Cancel on cancelled rows and Cancel on scheduled ones", () => {
    expect(admin).toMatch(/item\.status === "cancelled" \? \(/);
    expect(admin).toContain("Undo Cancel");
    expect(admin).toMatch(/item\.status === "scheduled" \? \(/);
    expect(admin).toMatch(/\/api\/automations\/\$\{id\}\/restore/);
  });

  it("offers neither control on a finished record", () => {
    const controls = admin.slice(admin.indexOf('{item.status === "scheduled" ? ('));
    expect(controls).not.toMatch(/item\.status === "sent"/);
    expect(controls).not.toMatch(/item\.status === "skipped"/);
    expect(controls).not.toMatch(/item\.status === "failed"/);
  });

  /**
   * Requirement 2's counterpart in the Outcome column: a restored record shows
   * that it was cancelled and put back, rather than looking untouched.
   */
  it("says a restored record was restored", () => {
    expect(admin).toMatch(/item\.status === "scheduled" && item\.cancelledAt !== null/);
    expect(admin).toContain("Restored after cancel");
  });
});
