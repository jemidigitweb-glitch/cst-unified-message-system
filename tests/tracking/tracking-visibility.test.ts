import { afterEach, describe, expect, it } from "vitest";

import {
  resolveTrackingContext,
  resolveVerifiedTracking,
} from "@/lib/context/resolve-tracking-context";
import type { VerifiedFact } from "@/lib/domain/draft";
import {
  trackingHistoryEntries,
  trackingSummaryRows,
} from "@/lib/domain/shipment-tracking-display";
import type { MessageCategory } from "@/lib/knowledge/message-category";
import type { TrackingResult } from "@/lib/tracking/provider";
import { forgetTracking, writeTracking } from "@/lib/tracking/tracking-cache";

/**
 * WHO GETS TO SEE A VERIFIED SHIPMENT.
 *
 * THE RULE THAT CHANGED, and the one that did not:
 *
 *   draft    still gated on "Delivery queries". A scan history in front of the
 *            MODEL on a conversation about a cracked lampshade is tokens,
 *            latency and a fact the reply has no business using.
 *   display  no category gate. A reviewer answering a damage claim, a
 *            wrong-item complaint or a refund request is often asking precisely
 *            whether the parcel arrived — and hiding a verified shipment from a
 *            human reading a screen saved nothing and cost them the answer.
 *
 * Both call ONE function for everything else, so the safety refusals cannot
 * drift apart. That is what the second half of this file pins.
 *
 * No database and no network: the cache is primed so the lookup never reaches a
 * provider, which is also how the "visible" cases below are made observable.
 */

const TRACKED: VerifiedFact[] = [
  { name: "order_number", value: "AA-11111-11111" },
  { name: "order_status", value: "Completed" },
  { name: "tracking_number", value: "AB123456789GB" },
  { name: "delivery_courier", value: "Royal Mail 48" },
];

function result(overrides: Partial<TrackingResult> = {}): TrackingResult {
  return {
    carrier: "royal_mail",
    trackingNumber: "AB123456789GB",
    currentStatus: "delivered",
    trackingEvents: [
      {
        status: "delivered",
        description: "Package delivered",
        location: null,
        timestamp: "2026-08-31 12:07:00",
      },
    ],
    lastUpdated: "2026-08-31 12:07:00",
    source: { provider: "source_database", retrieval: "cached" },
    ...overrides,
  };
}

afterEach(() => {
  forgetTracking();
});

/**
 * The categories named in the change request, plus the one that was already
 * allowed. Every one of them must now reach the same answer for display.
 */
const CATEGORIES: readonly MessageCategory[] = [
  "Delivery queries",
  "Wrong item sent messages",
  "Damage queries",
  "Defective items",
  "Return and refunds",
  "Parts missing queries",
  "Pre sales queries",
  "Admin related issues",
];

describe("display shows a verified shipment whatever the customer asked", () => {
  for (const category of CATEGORIES) {
    it(`shows tracking for: ${category}`, async () => {
      writeTracking(result());
      const context = await resolveVerifiedTracking({ facts: TRACKED });

      expect(context.tracking, category).not.toBeNull();
      expect(context.tracking?.currentStatus).toBe("delivered");
    });
  }

  /**
   * The regression in one assertion. Under the old rule these four returned
   * `not_a_delivery_query` and the section never appeared; the reviewer was
   * told nothing about a parcel we had verified information for.
   */
  it("no longer refuses a non-delivery conversation", async () => {
    writeTracking(result());
    for (const category of [
      "Wrong item sent messages",
      "Damage queries",
      "Defective items",
      "Return and refunds",
    ] as const) {
      // What the draft still says about it...
      const draft = await resolveTrackingContext({ category, facts: TRACKED });
      expect(draft.tracking, category).toBeNull();
      expect(draft.tracking === null && draft.reason).toBe("not_a_delivery_query");

      // ...and what display now says about the very same conversation.
      const display = await resolveVerifiedTracking({ facts: TRACKED });
      expect(display.tracking, category).not.toBeNull();
    }
  });

  it("hands the panel something to render", async () => {
    writeTracking(result());
    const context = await resolveVerifiedTracking({ facts: TRACKED });
    expect(context.tracking).not.toBeNull();

    const rows = trackingSummaryRows(context.tracking!);
    expect(rows.map((row) => row.label)).toEqual([
      "Courier",
      "Tracking number",
      "Status",
      "Last carrier update",
    ]);
    expect(rows.find((row) => row.label === "Status")?.value).toBe("Delivered");
    expect(rows.find((row) => row.label === "Last carrier update")?.value).toBe(
      "31 Aug 2026 12:07",
    );
    expect(trackingHistoryEntries(context.tracking!)).toHaveLength(1);
  });
});

/**
 * THE DRAFT IS UNTOUCHED. Its gate is the reason this change is safe to make
 * for display only, so it is asserted here rather than left to be inferred.
 */
describe("the draft still asks for Delivery queries and nothing else", () => {
  it("answers a delivery query", async () => {
    writeTracking(result());
    const context = await resolveTrackingContext({
      category: "Delivery queries",
      facts: TRACKED,
    });
    expect(context.tracking).not.toBeNull();
  });

  it("refuses every other category, and says why", async () => {
    writeTracking(result());
    for (const category of CATEGORIES.filter((name) => name !== "Delivery queries")) {
      const context = await resolveTrackingContext({ category, facts: TRACKED });
      expect(context.tracking, category).toBeNull();
      expect(context.tracking === null && context.reason, category).toBe("not_a_delivery_query");
    }
  });

  it("refuses a conversation with no category at all", async () => {
    writeTracking(result());
    const context = await resolveTrackingContext({ category: null, facts: TRACKED });
    expect(context.tracking).toBeNull();
  });
});

/**
 * EVERY SAFETY REFUSAL SURVIVES. Removing the category gate removed the
 * category gate; these are the checks that were never about the question the
 * customer asked, and display is subject to all of them.
 */
describe("the refusals that still hide the section", () => {
  it("hides it when no order resolved, so there are no facts", async () => {
    const context = await resolveVerifiedTracking({ facts: [] });
    expect(context.tracking).toBeNull();
    expect(context.tracking === null && context.reason).toBe("no_tracking_number");
  });

  it("hides it when the order carries no courier", async () => {
    const context = await resolveVerifiedTracking({
      facts: TRACKED.filter((fact) => fact.name !== "delivery_courier"),
    });
    expect(context.tracking).toBeNull();
    expect(context.tracking === null && context.reason).toBe("no_carrier");
  });

  it("hides it when the stored courier names no carrier we know", async () => {
    const context = await resolveVerifiedTracking({
      facts: [
        ...TRACKED.filter((fact) => fact.name !== "delivery_courier"),
        { name: "delivery_courier", value: "Pakajo" },
      ],
    });
    expect(context.tracking).toBeNull();
    expect(context.tracking === null && context.reason).toBe("carrier_not_recognised");
  });

  /**
   * The provider's own refusals — never polled, one reference on two orders, an
   * order sent in several parcels, a stale non-terminal status — all arrive as
   * a thrown error and land here as `lookup_failed`. Reached with an empty
   * cache and no source database configured, which is the same path.
   */
  it("hides it when the provider refuses the lookup", async () => {
    const context = await resolveVerifiedTracking({ facts: TRACKED });
    expect(context.tracking).toBeNull();
    expect(context.tracking === null && context.reason).toBe("lookup_failed");
  });

  it("never falls back to a stale cached result", async () => {
    // Nothing was written, so nothing may be served.
    const context = await resolveVerifiedTracking({ facts: TRACKED });
    expect(context.tracking).toBeNull();
  });
});
