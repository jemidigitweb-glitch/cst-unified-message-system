import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LAST_CARRIER_UPDATE_LABEL,
  TRACKING_HEADING,
  TRACKING_HISTORY_TOGGLE,
} from "@/lib/domain/shipment-tracking-display";

/**
 * Standing guard on the shipment tracking section of the sidebar.
 *
 * Asserted against source, matching how the rest of this suite guards the
 * interface: no DOM environment is configured, and what matters here is
 * structural. The values themselves are unit-tested in
 * `tests/domain/shipment-tracking-display.test.ts`; what is guarded here is
 * that the component cannot get at anything those values were projected to
 * exclude, and cannot reach the database on its own.
 */

const ROOT = join(__dirname, "..", "..");

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const panel = read("components", "context-panel.tsx");
const display = read("lib", "domain", "shipment-tracking-display.ts");
const route = read("app", "api", "conversations", "[conversationId]", "order-context", "route.ts");

describe("the section renders from the response and nothing else", () => {
  it("renders tracking from OrderContextResponse.tracking", () => {
    expect(panel).toContain("function ShipmentTracking");
    expect(panel).toContain("context.tracking");
  });

  it("hides itself entirely when there is no tracking", () => {
    // Null is every refusal upstream — not a delivery query, no reference, an
    // unrecognised carrier, two orders, two parcels, or a stale status.
    expect(panel).toMatch(/if \(tracking === null\) return null;/);
  });

  it("sits below the order blocks, not inside one", () => {
    const orderList = panel.indexOf("ORDER_DETAIL_FIELDS");
    const trackingUse = panel.lastIndexOf("<ShipmentTracking");
    expect(orderList).toBeGreaterThan(-1);
    expect(trackingUse).toBeGreaterThan(orderList);
  });

  /**
   * Scoped to the tracking section on purpose. The order-context section above
   * has its own disclosure, and that one IS open by default while no order is
   * chosen — asserting over the whole file would conflate the two and fail on a
   * change that is correct.
   */
  it("offers the history as a collapsed disclosure", () => {
    const section = panel.slice(panel.indexOf("function ShipmentTracking"));
    const body = section.slice(0, section.indexOf("\n}"));
    // The heading reaches the screen through the shared constant, never as a
    // literal typed twice — asserted by name below.
    expect(body).toContain("<details");
    expect(body).toContain("<summary");
    // Collapsed by default: no `open` attribute on THIS disclosure.
    expect(body).not.toMatch(/<details[^>]*\sopen\b/);
  });

  it("names the heading and the toggle from the shared constants", () => {
    expect(panel).toContain("TRACKING_HEADING");
    expect(panel).toContain("TRACKING_HISTORY_TOGGLE");
    expect(TRACKING_HEADING).toBe("Shipment tracking");
    expect(TRACKING_HISTORY_TOGGLE).toBe("View tracking history");
  });

  /**
   * STACKED, not the label-left/value-right layout the order rows use. A
   * tracking reference is long enough for a right-aligned column to truncate,
   * and a truncated reference is worse than none — a reviewer copies it into a
   * carrier's site character for character.
   */
  it("stacks each label above its value rather than truncating it", () => {
    const section = panel.slice(panel.indexOf("function ShipmentTracking"));
    const body = section.slice(0, section.indexOf("\n}"));
    expect(body).toContain("<dt");
    expect(body).toContain("<dd");
    // The shared Row helper right-aligns and truncates; this section must not
    // use it for the summary.
    expect(body).not.toMatch(/<Row\b/);
  });

  it("shows a scan's own wording, falling back to its status", () => {
    const section = panel.slice(panel.indexOf("function ShipmentTracking"));
    expect(section).toContain("entry.description ?? entry.status");
  });

  /**
   * A TIMELINE: date and time stacked left, a node on a rule, the carrier's
   * wording right, newest at the top. Ordering is the projection's job and is
   * unit-tested; what is guarded here is that the component renders both halves
   * of the split timestamp rather than re-joining them.
   */
  it("renders the split date and time, not a re-joined string", () => {
    const section = panel.slice(panel.indexOf("function ShipmentTracking"));
    expect(section).toContain("entry.date");
    expect(section).toContain("entry.time");
    expect(section).not.toContain("entry.timestamp");
  });
});

describe("the panel never reaches the source database", () => {
  it("fetches only the order-context route", () => {
    expect(panel).toContain("/order-context");
    for (const forbidden of ["getSourcePool", "order_management", "pg", "SELECT "]) {
      expect(panel, forbidden).not.toContain(forbidden);
    }
  });

  /**
   * DISPLAY IS NOT GATED ON THE CUSTOMER'S QUESTION, and the draft still is.
   *
   * The route calls `resolveVerifiedTracking`, which shares every safety check
   * with the draft's `resolveTrackingContext` and skips only the delivery-query
   * gate. A route that classified the conversation would be re-introducing the
   * rule this change exists to remove, so the classifier's absence is asserted
   * rather than assumed.
   */
  it("looks tracking up without asking what the conversation is about", () => {
    expect(route).toContain("resolveVerifiedTracking");
    expect(route).not.toContain("classifyConversationCategory");
    expect(route).not.toContain("TRACKING_CATEGORY");
    // The route displays what the resolver produced; it decides nothing itself.
    expect(route).not.toContain("shipment_tracking_log");
    expect(route).not.toContain("carrierFrom");
  });

  /** The panel shows or hides on the result alone — never on a category. */
  it("renders on the presence of a result, not on a category", () => {
    const section = panel.slice(panel.indexOf("function ShipmentTracking"));
    expect(section).toContain("tracking === null");
    for (const forbidden of ["category", "Delivery queries", "MessageCategory"]) {
      expect(section, forbidden).not.toContain(forbidden);
    }
  });
});

describe("forbidden fields have nowhere to go", () => {
  it("renders no location, signer, photograph or internal field", () => {
    for (const forbidden of [
      "location",
      "signer",
      "geo",
      "pod_image",
      "parcel_image",
      "label_path",
      "invoice",
      "cost",
    ]) {
      expect(panel, forbidden).not.toMatch(
        new RegExp(`entry\\.${forbidden}|tracking\\.${forbidden}|event\\.${forbidden}`),
      );
    }
  });

  it("renders no raw events JSON", () => {
    expect(panel).not.toMatch(/JSON\.stringify\s*\(\s*[^)]*tracking/);
    // The panel reads the projected history, never `trackingEvents` directly.
    expect(panel).not.toContain("tracking.trackingEvents");
  });

  /**
   * The projection is the boundary, so the type behind it must stay closed.
   * A `location` reinstated on `TrackingHistoryEntry` would make every guard
   * above pass while putting an address back on screen.
   */
  it("gives the history entry no field a location could live in", () => {
    const entry = display.slice(display.indexOf("export type TrackingHistoryEntry"));
    const body = entry.slice(0, entry.indexOf("};"));
    expect(body).toContain("status");
    expect(body).toContain("description");
    expect(body).toContain("date");
    expect(body).toContain("time");
    for (const forbidden of ["location", "signer", "geo", "image", "city", "country"]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

describe("the wording is the one the data can support", () => {
  it("says Last carrier update", () => {
    expect(LAST_CARRIER_UPDATE_LABEL).toBe("Last carrier update");
    expect(display).toContain('"Last carrier update"');
  });

  it("never says live location or current position", () => {
    for (const source of [panel, display]) {
      expect(source).not.toMatch(/live location|current position/i);
    }
  });
});
