import { describe, expect, it } from "vitest";

import { TrackingNotFound, TrackingUnavailable } from "@/lib/tracking/provider";
import {
  MAX_NON_TERMINAL_AGE_HOURS,
  type Queryable,
  SOURCE_DATABASE_PROVIDER_NAME,
  createSourceDatabaseProvider,
  isFreshEnough,
  statusFromScan,
  statusFrom,
} from "@/lib/tracking/source-database-provider";

/**
 * Tracking read from the source database.
 *
 * NO DATABASE HERE. The provider takes its query executor as an argument, so
 * every decision below is exercised against scripted rows. That is deliberate
 * rather than convenient: the branches worth pinning are the REFUSALS — stale,
 * ambiguous, multi-parcel, unknown — and a test that needed real rows in each
 * of those states could not pin them at all.
 *
 * Column names and value vocabularies match the live table: `status` is one of
 * six words, `last_event_desc` is one of 32, and `api_age_hours` is computed in
 * SQL so no clock is involved here.
 */

/** A stub executor returning scripted rows, recording what it was asked. */
function scripted(rows: unknown[]): Queryable & { statements: string[]; values: unknown[][] } {
  const statements: string[] = [];
  const values: unknown[][] = [];
  return {
    statements,
    values,
    async query(config: { text: string; values?: unknown[] }) {
      statements.push(config.text);
      values.push(config.values ?? []);
      return { rows };
    },
  };
}

/** One row as the query returns it. Overridable field by field. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: "900001",
    carrier_text: "Royal Mail 48",
    log_status: "Delivered",
    last_event_desc: "Package delivered",
    last_event_at: "2026-08-30 11:04:00",
    api_age_hours: 2,
    shipments_on_order: 1,
    ...overrides,
  };
}

const REQUEST = { carrier: "royal_mail", trackingNumber: "AB123456789GB" } as const;

function providerFor(rows: unknown[]) {
  const client = scripted(rows);
  return { provider: createSourceDatabaseProvider("royal_mail", client), client };
}

describe("a successful lookup", () => {
  it("returns the tracking result for a delivered parcel", async () => {
    const { provider } = providerFor([row()]);
    const result = await provider.track(REQUEST);

    expect(result.carrier).toBe("royal_mail");
    expect(result.trackingNumber).toBe("AB123456789GB");
    expect(result.currentStatus).toBe("delivered");
    expect(result.lastUpdated).toBe("2026-08-30 11:04:00");
    expect(result.source.provider).toBe(SOURCE_DATABASE_PROVIDER_NAME);
  });

  /**
   * "cached", not "live". Nothing here contacted a carrier — this is the
   * upstream sync's copy — and `verifiedTrackingBlock` turns "cached" into an
   * explicit instruction not to state it as the position right now.
   */
  it("reports itself as cached rather than live", async () => {
    const { provider } = providerFor([row()]);
    expect((await provider.track(REQUEST)).source.retrieval).toBe("cached");
  });

  it("states one event, from the safe columns only", async () => {
    const { provider } = providerFor([row()]);
    const result = await provider.track(REQUEST);

    expect(result.trackingEvents).toHaveLength(1);
    expect(result.trackingEvents[0]).toEqual({
      status: "delivered",
      description: "Package delivered",
      // Null on purpose: the only location this source holds is inside the
      // `events` jsonb, which carries signer, geo and delivery photographs.
      location: null,
      timestamp: "2026-08-30 11:04:00",
    });
  });

  it("states no event when the carrier recorded no wording", async () => {
    const { provider } = providerFor([
      row({ last_event_desc: null, safe_events: null }),
    ]);
    expect((await provider.track(REQUEST)).trackingEvents).toEqual([]);
  });

  it("uses a parameterised query and never interpolates the reference", async () => {
    const { provider, client } = providerFor([row()]);
    await provider.track(REQUEST);

    expect(client.values[0]).toEqual(["AB123456789GB"]);
    expect(client.statements[0]).toContain("$1");
    expect(client.statements[0]).not.toContain("AB123456789GB");
  });

  /**
   * THE SAFETY RULE, asserted against the statement itself.
   *
   * The query DOES read the `events` array — that is where the scan history
   * lives — but it rebuilds each element from three named keys rather than
   * passing it through. So the test is not "never mention events"; it is
   * "never name a key that must not be shown". Doing the projection in SQL is
   * what makes this assertion meaningful: a field not selected cannot leak,
   * whatever any later code does with the row.
   */
  it("names none of the unsafe event keys or internal columns", async () => {
    const { provider, client } = providerFor([row()]);
    await provider.track(REQUEST);

    const sql = client.statements[0]!;
    for (const forbidden of [
      "pod_image",
      "parcel_image",
      "signer",
      "geo",
      "city",
      "state",
      "country",
      "company",
      "label_path",
      "invoice",
      "cost",
      "shipping_address",
    ]) {
      expect(sql, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("extracts exactly three keys from each scan", async () => {
    const { provider, client } = providerFor([row()]);
    await provider.track(REQUEST);

    const sql = client.statements[0]!;
    const extracted = [...sql.matchAll(/e->>'([a-z_]+)'/g)].map((match) => match[1]);
    expect([...new Set(extracted)].sort()).toEqual([
      "event_code",
      "event_datetime",
      "event_desc",
    ]);
  });

  it("reads only the three tables it is allowed to", async () => {
    const { provider, client } = providerFor([row()]);
    await provider.track(REQUEST);

    const sql = client.statements[0]!;
    expect(sql).toContain("order_management.shipment");
    expect(sql).toContain("order_management.carrier_service");
    expect(sql).toContain("order_management.shipment_tracking_log");
    // SELECT only. Nothing here may write.
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
  });
});

/**
 * THE WHOLE JOURNEY, not just where it ended.
 *
 * A reviewer answering "it never arrived" needs to see that it was out for
 * delivery on Tuesday and attempted on Wednesday — the single last scan says
 * only "Delivery attempt unsuccessful" and hides the shape of the story.
 */
describe("the full scan history", () => {
  /** As the query returns it: already projected, already oldest-first. */
  const JOURNEY = [
    { at: "2026-05-14 05:27:25", desc: "Carrier update", code: "144" },
    { at: "2026-05-14 06:27:30", desc: "Data Received", code: "144" },
    { at: "2026-05-15 05:02:58", desc: "Received by local delivery company", code: "137" },
    { at: "2026-05-16 07:30:55", desc: "Out for delivery", code: "137" },
    { at: "2026-05-16 09:12:43", desc: "Package delivered", code: "121" },
  ];

  it("returns every scan, not only the last", async () => {
    const { provider } = providerFor([row({ safe_events: JOURNEY })]);
    const result = await provider.track(REQUEST);
    expect(result.trackingEvents).toHaveLength(5);
  });

  /** The contract: `trackingEvents` is oldest first, whatever the source order. */
  it("keeps them oldest first", async () => {
    const { provider } = providerFor([row({ safe_events: JOURNEY })]);
    const result = await provider.track(REQUEST);
    expect(result.trackingEvents.map((event) => event.timestamp)).toEqual([
      "2026-05-14 05:27:25",
      "2026-05-14 06:27:30",
      "2026-05-15 05:02:58",
      "2026-05-16 07:30:55",
      "2026-05-16 09:12:43",
    ]);
  });

  it("gives each scan its own status, read from its own wording", async () => {
    const { provider } = providerFor([row({ safe_events: JOURNEY })]);
    const result = await provider.track(REQUEST);
    expect(result.trackingEvents.map((event) => event.status)).toEqual([
      "in_transit",
      "pre_transit",
      "in_transit",
      "out_for_delivery",
      "delivered",
    ]);
  });

  it("carries no location on any scan", async () => {
    const { provider } = providerFor([row({ safe_events: JOURNEY })]);
    const result = await provider.track(REQUEST);
    for (const event of result.trackingEvents) expect(event.location).toBeNull();
  });

  it("skips a scan missing a timestamp or a description", async () => {
    const { provider } = providerFor([
      row({
        safe_events: [
          { at: null, desc: "Carrier update", code: "144" },
          { at: "2026-05-16 09:12:43", desc: "  ", code: "121" },
          { at: "2026-05-16 09:12:43", desc: "Package delivered", code: "121" },
        ],
      }),
    ]);
    const result = await provider.track(REQUEST);
    expect(result.trackingEvents).toHaveLength(1);
    expect(result.trackingEvents[0]?.description).toBe("Package delivered");
  });

  /** Some rows carry a last event and no array. One true line beats none. */
  it("falls back to the single last event when there is no array", async () => {
    const { provider } = providerFor([row({ safe_events: null })]);
    const result = await provider.track(REQUEST);
    expect(result.trackingEvents).toHaveLength(1);
    expect(result.trackingEvents[0]?.description).toBe("Package delivered");
  });

  it("still reports the row's status as the current one, not the last scan's", async () => {
    const { provider } = providerFor([
      row({
        log_status: "Delivered",
        safe_events: [{ at: "2026-05-16 07:30:55", desc: "Out for delivery", code: "137" }],
      }),
    ]);
    const result = await provider.track(REQUEST);
    expect(result.currentStatus).toBe("delivered");
    expect(result.trackingEvents[0]?.status).toBe("out_for_delivery");
  });
});

describe("reading one scan's wording", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["Package delivered", "delivered"],
    ["Item delivery confirmed", "delivered"],
    ["已签收", "delivered"],
    ["Delivered to Neighbour", "delivered"],
    ["Item collected from Delivery Office", "delivered"],
    ["Out for delivery", "out_for_delivery"],
    ["【Dulwich DO,GB】正在派送途中", "out_for_delivery"],
    // Contains "delivered", and is a promise rather than an arrival.
    ["Due to be delivered today", "out_for_delivery"],
    // Contains "delivery", and must never read as delivered.
    ["Delivery attempt unsuccessful", "attempted_delivery"],
    ["Delivery failed", "attempted_delivery"],
    ["Returned at Sort Facility Birmingham Service Centre - GBR", "returned_to_sender"],
    ["Arrived at pick-up point. Package available for collection.", "awaiting_collection"],
    ["Item Retention", "awaiting_collection"],
    ["待自取", "awaiting_collection"],
    ["Data Received", "pre_transit"],
    ["订单信息已收到", "pre_transit"],
    ["Carrier update", "in_transit"],
    ["Item scanned on its journey", "in_transit"],
    ["Received by local delivery company", "in_transit"],
    ["Accepted at Inward Mail Centre", "in_transit"],
  ];

  for (const [description, expected] of cases) {
    it(`reads "${description}" as ${expected}`, () => {
      expect(statusFromScan(description)).toBe(expected);
    });
  }

  it("calls a scan with no wording unknown, not moving", () => {
    expect(statusFromScan(null)).toBe("unknown");
    expect(statusFromScan("   ")).toBe("unknown");
  });
});

describe("a missing tracking log", () => {
  it("refuses when no shipment carries the reference", async () => {
    const { provider } = providerFor([]);
    await expect(provider.track(REQUEST)).rejects.toBeInstanceOf(TrackingNotFound);
  });

  /**
   * A LABEL IS NOT A POSITION. The shipment exists and the carrier has never
   * been polled for it. Reporting "Not known" under a heading that reads
   * VERIFIED TRACKING INFORMATION would claim we asked and were told nothing.
   */
  it("refuses when the shipment exists but was never polled", async () => {
    const { provider } = providerFor([
      row({ log_status: null, last_event_desc: null, last_event_at: null, api_age_hours: null }),
    ]);
    await expect(provider.track(REQUEST)).rejects.toBeInstanceOf(TrackingNotFound);
  });
});

describe("freshness", () => {
  /**
   * THE REGRESSION THIS EXISTS TO PREVENT. An "In transit" from weeks ago,
   * stated as the current position, is worse than saying nothing — it reads as
   * authoritative and it is wrong.
   */
  it("refuses a stale in-transit status", async () => {
    const { provider } = providerFor([
      row({
        log_status: "Intransit",
        last_event_desc: "Item scanned on its journey",
        api_age_hours: MAX_NON_TERMINAL_AGE_HOURS + 1,
      }),
    ]);
    await expect(provider.track(REQUEST)).rejects.toBeInstanceOf(TrackingUnavailable);
  });

  it("accepts a fresh in-transit status", async () => {
    const { provider } = providerFor([
      row({
        log_status: "Intransit",
        last_event_desc: "Item scanned on its journey",
        api_age_hours: 1,
      }),
    ]);
    expect((await provider.track(REQUEST)).currentStatus).toBe("in_transit");
  });

  /**
   * A parcel delivered a month ago is still delivered. Polling stops once there
   * is nothing left to poll for, so 94.6% of the live table is old AND correct;
   * applying the freshness rule here would discard all of it.
   */
  it("accepts delivered data of any age", async () => {
    const { provider } = providerFor([
      row({ log_status: "Delivered", api_age_hours: 24 * 365 }),
    ]);
    const result = await provider.track(REQUEST);
    expect(result.currentStatus).toBe("delivered");
  });

  it("accepts returned data of any age, for the same reason", async () => {
    const { provider } = providerFor([
      row({
        log_status: "Returned",
        last_event_desc: "Returned at Sort Facility Birmingham Service Centre - GBR",
        api_age_hours: 24 * 90,
      }),
    ]);
    expect((await provider.track(REQUEST)).currentStatus).toBe("returned_to_sender");
  });

  it("refuses a non-terminal status that was never polled at all", async () => {
    const { provider } = providerFor([row({ log_status: "Intransit", api_age_hours: null })]);
    await expect(provider.track(REQUEST)).rejects.toBeInstanceOf(TrackingUnavailable);
  });

  it("decides freshness the same way when asked directly", () => {
    expect(isFreshEnough("delivered", null)).toBe(true);
    expect(isFreshEnough("returned_to_sender", 10_000)).toBe(true);
    expect(isFreshEnough("in_transit", MAX_NON_TERMINAL_AGE_HOURS)).toBe(true);
    expect(isFreshEnough("in_transit", MAX_NON_TERMINAL_AGE_HOURS + 0.1)).toBe(false);
    expect(isFreshEnough("unknown", null)).toBe(false);
  });
});

describe("more than one parcel", () => {
  /**
   * NEVER SILENTLY CHOOSE ONE. About 1% of orders ship in several boxes, and
   * the order context upstream takes the most recently created shipment — so
   * without this a two-parcel order gets a confident "delivered" about whichever
   * box was labelled last, while the customer is writing about the other one.
   */
  it("refuses when the order was sent in more than one parcel", async () => {
    const { provider } = providerFor([row({ shipments_on_order: 2 })]);
    await expect(provider.track(REQUEST)).rejects.toBeInstanceOf(TrackingUnavailable);
  });

  it("says how many parcels, so the refusal can be understood", async () => {
    const { provider } = providerFor([row({ shipments_on_order: 3 })]);
    await expect(provider.track(REQUEST)).rejects.toThrow(/3 parcels/);
  });

  /**
   * The other multiplicity: one reference recorded against two orders. 380 of
   * 40,836 tracking numbers in a recent 90-day window do this.
   */
  it("refuses when one reference is recorded against two orders", async () => {
    const { provider } = providerFor([row({ order_id: "900001" }), row({ order_id: "900002" })]);
    await expect(provider.track(REQUEST)).rejects.toBeInstanceOf(TrackingUnavailable);
  });

  it("accepts a duplicate row that names the same single order", async () => {
    const { provider } = providerFor([row(), row()]);
    expect((await provider.track(REQUEST)).currentStatus).toBe("delivered");
  });
});

describe("the carrier must agree", () => {
  it("refuses when the shipment is recorded against a different carrier", async () => {
    const { provider } = providerFor([row({ carrier_text: "DPD" })]);
    await expect(provider.track(REQUEST)).rejects.toBeInstanceOf(TrackingUnavailable);
  });

  /**
   * 320,593 shipments carry no usable carrier string. An unrecognised value is
   * not a disagreement, so it proceeds on the carrier the caller resolved from
   * the same shipment row.
   */
  it("proceeds when the stored courier names no carrier this system knows", async () => {
    const { provider } = providerFor([row({ carrier_text: "Other" })]);
    expect((await provider.track(REQUEST)).carrier).toBe("royal_mail");
  });

  it("proceeds when no courier is stored at all", async () => {
    const { provider } = providerFor([row({ carrier_text: null })]);
    expect((await provider.track(REQUEST)).carrier).toBe("royal_mail");
  });
});

describe("status mapping", () => {
  const cases: readonly (readonly [string | null, string | null, string])[] = [
    ["Label Created", "Data Received", "pre_transit"],
    ["Intransit", "Item scanned on its journey", "in_transit"],
    ["Intransit", "Received by local delivery company", "in_transit"],
    ["Delivered", "Package delivered", "delivered"],
    ["Delivered", "已签收", "delivered"],
    ["Problem", "Carrier update", "exception"],
    ["Returned", "Returned at Sort Facility Birmingham Service Centre - GBR", "returned_to_sender"],
    // Cancelled on our side. Not a carrier position, so not stated as one.
    ["Deleted", null, "unknown"],
    [null, null, "unknown"],
    ["something the sync has never written", null, "unknown"],
  ];

  for (const [status, desc, expected] of cases) {
    it(`maps ${String(status)} to ${expected}`, () => {
      expect(statusFrom(status, desc)).toBe(expected);
    });
  }

  /**
   * `status` never distinguishes these — both sit under Intransit — and they
   * are exactly what a customer chasing a parcel is asking about.
   */
  it("refines a moving status from the carrier's own wording", () => {
    expect(statusFrom("Intransit", "Out for delivery")).toBe("out_for_delivery");
    expect(statusFrom("Intransit", "Due to be delivered today")).toBe("out_for_delivery");
    expect(statusFrom("Intransit", "正在派送途中")).toBe("out_for_delivery");
    expect(statusFrom("Intransit", "Delivery attempt unsuccessful")).toBe("attempted_delivery");
    expect(statusFrom("Intransit", "Delivery failed")).toBe("attempted_delivery");
    expect(statusFrom("Intransit", "Arrived at pick-up point. Package available for collection.")).toBe(
      "awaiting_collection",
    );
  });

  /**
   * A refinement must never contradict a terminal state. "Delivered" with an
   * out-for-delivery scan attached is a data ordering artefact, and reading it
   * as still-in-transit would tell a customer their delivered parcel is coming.
   */
  it("never lets a scan override a terminal status", () => {
    expect(statusFrom("Delivered", "Out for delivery")).toBe("delivered");
    expect(statusFrom("Returned", "Out for delivery")).toBe("returned_to_sender");
  });

  it("carries the mapped status onto the event it states", async () => {
    const { provider } = providerFor([
      row({ log_status: "Intransit", last_event_desc: "Out for delivery", api_age_hours: 1 }),
    ]);
    const result = await provider.track(REQUEST);
    expect(result.currentStatus).toBe("out_for_delivery");
    expect(result.trackingEvents[0]?.status).toBe("out_for_delivery");
  });
});

describe("when the database itself fails", () => {
  it("refuses without repeating the reference in the error", async () => {
    const failing: Queryable = {
      async query() {
        throw new Error(`relation missing while looking up ${REQUEST.trackingNumber}`);
      },
    };
    const provider = createSourceDatabaseProvider("royal_mail", failing);

    await expect(provider.track(REQUEST)).rejects.toBeInstanceOf(TrackingUnavailable);
    await expect(provider.track(REQUEST)).rejects.not.toThrow(
      new RegExp(REQUEST.trackingNumber),
    );
  });
});
