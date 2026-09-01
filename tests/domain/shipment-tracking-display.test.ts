import { describe, expect, it } from "vitest";

import {
  COURIER_LABEL,
  LAST_CARRIER_UPDATE_LABEL,
  NO_CARRIER_UPDATE_TEXT,
  STATUS_LABEL,
  TRACKING_NUMBER_LABEL,
  formatCarrierTimestamp,
  trackingHistoryEntries,
  trackingSummaryRows,
} from "@/lib/domain/shipment-tracking-display";
import type { TrackingEvent, TrackingResult } from "@/lib/tracking/provider";

/**
 * What the sidebar is allowed to say about a shipment.
 *
 * These tests are the enforcement point for two rules that are invisible in the
 * component: the four summary lines say what they mean, and the forbidden
 * fields have nowhere to go. The projection in
 * `lib/domain/shipment-tracking-display.ts` is what makes the second one
 * testable at all — `location` is not filtered at render time, it has no field
 * in `TrackingHistoryEntry`, and these assert that.
 *
 * Synthetic references throughout.
 */

function event(overrides: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    status: "in_transit",
    description: "Item scanned on its journey",
    location: null,
    timestamp: "2026-08-30 09:00:00",
    ...overrides,
  };
}

function tracking(overrides: Partial<TrackingResult> = {}): TrackingResult {
  return {
    carrier: "royal_mail",
    trackingNumber: "AB123456789GB",
    currentStatus: "in_transit",
    trackingEvents: [event()],
    lastUpdated: "2026-08-30 09:00:00",
    source: { provider: "source_database", retrieval: "cached" },
    ...overrides,
  };
}

describe("the summary a reviewer reads", () => {
  it("states the four lines, in order", () => {
    const rows = trackingSummaryRows(tracking());
    expect(rows.map((row) => row.label)).toEqual([
      COURIER_LABEL,
      TRACKING_NUMBER_LABEL,
      STATUS_LABEL,
      LAST_CARRIER_UPDATE_LABEL,
    ]);
  });

  it("names the courier as a person would write it, not as an identifier", () => {
    expect(trackingSummaryRows(tracking()).find((r) => r.label === COURIER_LABEL)?.value).toBe(
      "Royal Mail",
    );
    expect(
      trackingSummaryRows(tracking({ carrier: "amazon_logistics" })).find(
        (r) => r.label === COURIER_LABEL,
      )?.value,
    ).toBe("Amazon Logistics");
  });

  it("shows the tracking number the provider returned, unchanged", () => {
    const rows = trackingSummaryRows(tracking({ trackingNumber: "JD0002123456789" }));
    expect(rows.find((r) => r.label === TRACKING_NUMBER_LABEL)?.value).toBe("JD0002123456789");
  });

  /** The delivered case, spelled out: this is what most real results look like. */
  it("reads a delivered parcel as delivered", () => {
    const rows = trackingSummaryRows(
      tracking({
        currentStatus: "delivered",
        lastUpdated: "2026-08-28 14:22:10",
        trackingEvents: [event({ status: "delivered", description: "Package delivered" })],
      }),
    );
    expect(rows.find((r) => r.label === STATUS_LABEL)?.value).toBe("Delivered");
    expect(rows.find((r) => r.label === LAST_CARRIER_UPDATE_LABEL)?.value).toBe(
      "28 Aug 2026 14:22",
    );
  });

  it("renders every status in words rather than as its identifier", () => {
    const statuses = [
      ["pre_transit", "Not yet with the carrier"],
      ["in_transit", "In transit"],
      ["out_for_delivery", "Out for delivery"],
      ["delivered", "Delivered"],
      ["attempted_delivery", "Delivery attempted"],
      ["awaiting_collection", "Awaiting collection"],
      ["returned_to_sender", "Being returned to us"],
      ["exception", "Held — needs investigation"],
      ["unknown", "Not known"],
    ] as const;

    for (const [status, label] of statuses) {
      const rows = trackingSummaryRows(tracking({ currentStatus: status }));
      expect(rows.find((r) => r.label === STATUS_LABEL)?.value, status).toBe(label);
    }
  });

  /**
   * A sentence, not a blank. A blank in this row reads as "not loaded" and a
   * dash as "no update exists"; this says which it is.
   */
  it("says so when the carrier has reported nothing", () => {
    const rows = trackingSummaryRows(tracking({ lastUpdated: null }));
    expect(rows.find((r) => r.label === LAST_CARRIER_UPDATE_LABEL)?.value).toBe(
      NO_CARRIER_UPDATE_TEXT,
    );
  });

  /**
   * THE WORDING RULE. The data is the sync's copy of what a carrier last
   * reported, so nothing may promise the present tense.
   */
  it("never claims to be a live position", () => {
    const rendered = trackingSummaryRows(
      tracking({ currentStatus: "out_for_delivery" }),
    )
      .map((row) => `${row.label} ${row.value}`)
      .join(" ");
    expect(rendered).toContain("Last carrier update");
    expect(rendered).not.toMatch(/live location|current position|right now/i);
  });
});

/**
 * REFORMATTED, NEVER CONVERTED. The carrier's zone is unknown, so the value is
 * re-rendered from its own characters and `Date` is never involved — a parse
 * would shift it by the server's offset and produce a confident wrong hour.
 */
describe("reading a carrier timestamp", () => {
  it("renders the shape the sync writes", () => {
    expect(formatCarrierTimestamp("2026-08-31 12:07:00")).toBe("31 Aug 2026 12:07");
    expect(formatCarrierTimestamp("2026-01-01 09:00:00")).toBe("01 Jan 2026 09:00");
    expect(formatCarrierTimestamp("2026-12-25 23:59:59")).toBe("25 Dec 2026 23:59");
  });

  it("accepts an ISO separator as readily as a space", () => {
    expect(formatCarrierTimestamp("2026-08-31T12:07:00")).toBe("31 Aug 2026 12:07");
  });

  it("keeps the 24-hour padding, so a column of times lines up", () => {
    expect(formatCarrierTimestamp("2026-08-31 09:05:00")).toBe("31 Aug 2026 09:05");
  });

  /** Unrecognised is returned untouched: it is still the carrier's answer. */
  it("returns anything it does not understand unchanged", () => {
    for (const raw of ["", "not a date", "31/08/2026", "2026-13-40 99:99:99"]) {
      expect(formatCarrierTimestamp(raw), raw).toBe(raw);
    }
  });

  it("shifts nothing, whatever the machine's timezone is", () => {
    // The hour that comes out is the hour that went in, character for
    // character. A `Date`-based implementation would fail this on any machine
    // not running in UTC.
    expect(formatCarrierTimestamp("2026-08-31 00:30:00")).toContain("00:30");
    expect(formatCarrierTimestamp("2026-08-31 23:45:00")).toContain("23:45");
    expect(formatCarrierTimestamp("2026-08-31 00:30:00")).toContain("31 Aug");
  });
});

describe("the expandable history", () => {
  it("lists one entry per scan", () => {
    const entries = trackingHistoryEntries(
      tracking({
        trackingEvents: [
          event({ description: "Data Received", timestamp: "2026-08-27 08:00:00" }),
          event({ description: "Item scanned on its journey", timestamp: "2026-08-28 08:00:00" }),
          event({
            status: "delivered",
            description: "Package delivered",
            timestamp: "2026-08-29 08:00:00",
          }),
        ],
      }),
    );
    expect(entries).toHaveLength(3);
  });

  /**
   * NEWEST FIRST here, oldest-first in `TrackingResult`. A reviewer opening the
   * history wants the latest line at the top; the prompt wants the last element.
   * Both are served without either sorting.
   */
  it("puts the most recent scan first", () => {
    const entries = trackingHistoryEntries(
      tracking({
        trackingEvents: [
          event({ description: "oldest", timestamp: "2026-08-27 08:00:00" }),
          event({ description: "newest", timestamp: "2026-08-29 08:00:00" }),
        ],
      }),
    );
    expect(entries[0]?.description).toBe("newest");
    expect(entries[1]?.description).toBe("oldest");
  });

  it("keeps the carrier's own wording verbatim", () => {
    const entries = trackingHistoryEntries(
      tracking({ trackingEvents: [event({ description: "【Frome DO,GB】正在派送途中" })] }),
    );
    expect(entries[0]?.description).toBe("【Frome DO,GB】正在派送途中");
  });

  it("states each scan's status in words", () => {
    const entries = trackingHistoryEntries(
      tracking({ trackingEvents: [event({ status: "attempted_delivery" })] }),
    );
    expect(entries[0]?.status).toBe("Delivery attempted");
  });

  /**
   * "● Delivered" above "Delivered" is a line of noise in a list a reviewer is
   * scanning. Dropped here rather than in the component so the decision is
   * testable.
   */
  it("drops a description that only repeats the status", () => {
    const entries = trackingHistoryEntries(
      tracking({ trackingEvents: [event({ status: "delivered", description: "Delivered" })] }),
    );
    expect(entries[0]?.status).toBe("Delivered");
    expect(entries[0]?.description).toBeNull();
  });

  it("keeps a description that says more than the status does", () => {
    const entries = trackingHistoryEntries(
      tracking({
        trackingEvents: [event({ status: "delivered", description: "Package delivered" })],
      }),
    );
    expect(entries[0]?.description).toBe("Package delivered");
  });

  it("treats an empty description as nothing to say", () => {
    const entries = trackingHistoryEntries(
      tracking({ trackingEvents: [event({ description: "   " })] }),
    );
    expect(entries[0]?.description).toBeNull();
  });

  /** The worked example from the specification, end to end. */
  it("renders the specified history shape", () => {
    const entries = trackingHistoryEntries(
      tracking({
        currentStatus: "delivered",
        trackingEvents: [
          event({
            status: "out_for_delivery",
            description: "Out for delivery",
            timestamp: "2026-08-28 09:00:00",
          }),
          event({
            status: "delivered",
            description: "Delivered",
            timestamp: "2026-08-28 10:31:00",
          }),
          event({
            status: "delivered",
            description: "Package delivered",
            timestamp: "2026-08-31 12:07:00",
          }),
        ],
      }),
    );

    expect(entries).toEqual([
      { date: "31 Aug 2026", time: "12:07", status: "Delivered", description: "Package delivered" },
      { date: "28 Aug 2026", time: "10:31", status: "Delivered", description: null },
      { date: "28 Aug 2026", time: "09:00", status: "Out for delivery", description: null },
    ]);
  });

  it("is empty when the carrier recorded no scans", () => {
    expect(trackingHistoryEntries(tracking({ trackingEvents: [] }))).toEqual([]);
  });
});

describe("fields that must never reach the screen", () => {
  /**
   * THE LOAD-BEARING TEST. `TrackingEvent` carries a location; the entry the
   * panel renders has no field to put one in. This asserts the projection
   * rather than a filter, because a filter is something a later edit can
   * remove and a missing field is not.
   */
  it("drops the event location entirely", () => {
    const entries = trackingHistoryEntries(
      tracking({
        trackingEvents: [event({ location: "12 Acacia Avenue, Bristol" })],
      }),
    );

    expect(entries[0]).toEqual({
      status: "In transit",
      description: "Item scanned on its journey",
      date: "30 Aug 2026",
      time: "09:00",
    });
    expect(Object.keys(entries[0]!).sort()).toEqual(["date", "description", "status", "time"]);
    expect(JSON.stringify(entries)).not.toContain("Acacia");
  });

  /**
   * The provider never selects these from the source database, so they cannot
   * arrive — but a future provider might, and this is the line that would fail
   * if one did and the panel started rendering whatever it was handed.
   */
  it("carries no signer, geo, photograph or internal field in either projection", () => {
    const contaminated = {
      ...tracking(),
      trackingEvents: [event({ location: "51.4545,-2.5879" })],
      // Fields no `TrackingResult` should ever have, present here to prove the
      // projection cannot pass one through even if it appeared upstream.
      signer: "J SMITH",
      geo: { lat: 51.4545, lon: -2.5879 },
      pod_image: "https://example.com/pod.jpg",
      parcel_image: "https://example.com/parcel.jpg",
      label_path: "/labels/12345.pdf",
      invoice: "INV-9001",
      cost: 3.85,
    } as unknown as TrackingResult;

    const rendered = JSON.stringify([
      trackingSummaryRows(contaminated),
      trackingHistoryEntries(contaminated),
    ]);

    for (const forbidden of [
      "J SMITH",
      "51.4545",
      "pod.jpg",
      "parcel.jpg",
      "labels/12345.pdf",
      "INV-9001",
      "3.85",
    ]) {
      expect(rendered, forbidden).not.toContain(forbidden);
    }
  });
});
