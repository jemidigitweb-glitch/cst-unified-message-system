import { describe, expect, it } from "vitest";

import { closeAllPools, getSourcePool } from "@/lib/db/pools";
import { carrierFrom } from "@/lib/tracking/carrier";
import { type TrackingResult } from "@/lib/tracking/provider";
import { createSourceDatabaseProvider } from "@/lib/tracking/source-database-provider";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * The provider against the real table.
 *
 * OPT-IN via RUN_LIVE_TRACKING=1. READ-ONLY and free — it spends no tokens and
 * contacts no carrier; every row it reads is already in the source database.
 *
 *   RUN_LIVE_TRACKING=1 npx vitest run tests/tracking/source-database-live.test.ts
 *
 * WHAT ONLY THIS CAN CATCH. The unit tests pin every decision against scripted
 * rows, which proves the logic and proves nothing about the query. A renamed
 * column, a changed join or a status word the sync started writing last week
 * would pass all of them and fail here.
 *
 * NO REFERENCE IS PRINTED. Tracking numbers are real consignment references;
 * they are masked in the output, and no customer name, address or delivery
 * photograph is read at all — the provider never selects the `events` blob.
 */

loadEnvFile();

const ready = process.env.RUN_LIVE_TRACKING === "1" && process.env.SOURCE_DB_HOST !== undefined;

function mask(reference: string): string {
  return reference.length <= 4 ? "****" : `${reference.slice(0, 2)}***${reference.slice(-2)}`;
}

/** One real reference per status the sync writes, chosen deterministically. */
async function references(): Promise<{ status: string | null; trackingNumber: string; courier: string | null }[]> {
  const { rows } = await getSourcePool().query(`
    SELECT l.status, MIN(l.tracking_number) AS tracking_number
      FROM order_management.shipment_tracking_log l
     GROUP BY l.status
     ORDER BY l.status`);

  const out: { status: string | null; trackingNumber: string; courier: string | null }[] = [];
  for (const r of rows as { status: string | null; tracking_number: string | null }[]) {
    if (r.tracking_number === null) continue;
    const { rows: courierRows } = await getSourcePool().query(
      `SELECT cs.carrier
         FROM order_management.shipment sh
         LEFT JOIN order_management.carrier_service cs ON cs.id = sh.carrier_service_id
        WHERE sh.tracking_number = $1
        LIMIT 1`,
      [r.tracking_number],
    );
    out.push({
      status: r.status,
      trackingNumber: r.tracking_number,
      courier: (courierRows[0] as { carrier: string | null } | undefined)?.carrier ?? null,
    });
  }
  return out;
}

describe.skipIf(!ready)("the source database provider, live", () => {
  it("answers or refuses correctly for every status the sync writes", async () => {
    const cases = await references();
    expect(cases.length).toBeGreaterThan(0);

    let answered = 0;
    for (const testCase of cases) {
      const carrier = carrierFrom(testCase.courier);
      if (carrier === null) continue;

      const provider = createSourceDatabaseProvider(carrier);
      let outcome: TrackingResult | string;
      try {
        outcome = await provider.track({ carrier, trackingNumber: testCase.trackingNumber });
        answered += 1;
      } catch (cause) {
        outcome = `${(cause as Error).name}: ${(cause as Error).message}`;
      }

      console.info(
        `[live] source status=${String(testCase.status).padEnd(14)} ref=${mask(testCase.trackingNumber)} → ` +
          (typeof outcome === "string"
            ? `REFUSED ${outcome}`
            : `${outcome.currentStatus} | last=${outcome.lastUpdated} | ` +
              `events=${outcome.trackingEvents.length} | retrieval=${outcome.source.retrieval} | ` +
              `scan="${outcome.trackingEvents[0]?.description ?? "(none)"}"`),
      );

      if (typeof outcome !== "string") {
        // Whatever it answers, the shape must be safe and complete.
        expect(outcome.trackingNumber).toBe(testCase.trackingNumber);
        expect(outcome.source.retrieval).toBe("cached");
        for (const event of outcome.trackingEvents) {
          // The one field that could only come from the forbidden jsonb.
          expect(event.location).toBeNull();
        }
      }
    }

    // At least one real reference must produce a real answer, or this proves
    // only that the provider can refuse.
    expect(answered).toBeGreaterThan(0);
    await closeAllPools();
  }, 300_000);
});
