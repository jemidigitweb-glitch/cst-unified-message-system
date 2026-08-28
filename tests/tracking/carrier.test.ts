import { describe, expect, it } from "vitest";

import { CARRIERS, CARRIER_LABELS, type Carrier, carrierFrom, isCarrier } from "@/lib/tracking/carrier";

/**
 * Recognising a carrier from what the shipment table actually stored.
 *
 * Every string asserted below is a real `carrier_service.carrier` value, with
 * its live shipment count in the comment. The point of this table is that those
 * strings are inconsistent in ways no caller should have to know, so the tests
 * are written against the real spellings rather than tidy ones.
 */
describe("recognising a carrier", () => {
  /**
   * The case that motivates the whole module: Royal Mail is stored under four
   * different strings, which are service levels rather than companies. A
   * provider keyed on the raw value would answer for one and fail three.
   */
  it("resolves all four Royal Mail spellings to one carrier", () => {
    for (const stored of [
      "Royal Mail", // 82,070 shipments
      "Royal Mail 48", // 88,079
      "Royal Mail 1st Class", // 42,372
      "Royal Mail 24", // 1,644
    ]) {
      expect(carrierFrom(stored), stored).toBe("royal_mail");
    }
  });

  /** Evri is stored under its current name and its former one. Same company. */
  it("treats Hermes as Evri", () => {
    expect(carrierFrom("Evri")).toBe("evri"); // 277,993
    expect(carrierFrom("Hermes")).toBe("evri"); // 137
  });

  it("collapses the other stored variants", () => {
    expect(carrierFrom("gls")).toBe("gls");
    expect(carrierFrom("gls international")).toBe("gls");
    expect(carrierFrom("UPS")).toBe("ups");
    expect(carrierFrom("UPS Express")).toBe("ups");
    expect(carrierFrom("parcel force")).toBe("parcelforce");
    expect(carrierFrom("Amazon Logistics Europe")).toBe("amazon_logistics");
  });

  it("recognises the remaining carriers by their stored spelling", () => {
    const expected: readonly (readonly [string, Carrier])[] = [
      ["DHL", "dhl"],
      ["DPD", "dpd"],
      ["Etrak", "etrak"],
      ["Canada Post", "canada_post"],
      ["USPS", "usps"],
      ["FedEx", "fedex"],
      ["Yodel", "yodel"],
      ["Colissimo", "colissimo"],
    ];
    for (const [stored, carrier] of expected) {
      expect(carrierFrom(stored), stored).toBe(carrier);
    }
  });

  /**
   * REFUSES RATHER THAN GUESSES. Asking one carrier about another's
   * consignment would produce a confident answer about the wrong parcel, so an
   * unrecognised string has to be absent rather than approximate.
   */
  it("returns null for anything it does not recognise", () => {
    for (const stored of [
      "Other", // 18,203 shipments — a real value, and not a carrier
      "wayfair", // 26,600 — a marketplace, not a carrier
      "Pakajo",
      "ICS",
      "Intelcom Standard",
      "Stallion Express",
      "some courier nobody has heard of",
    ]) {
      expect(carrierFrom(stored), stored).toBeNull();
    }
  });

  /** 320,593 shipments carry no carrier at all. Null is the common case. */
  it("returns null for absent, empty and whitespace values", () => {
    expect(carrierFrom(null)).toBeNull();
    expect(carrierFrom(undefined)).toBeNull();
    expect(carrierFrom("")).toBeNull();
    expect(carrierFrom("   ")).toBeNull();
  });

  it("names every carrier it can return", () => {
    for (const carrier of CARRIERS) {
      expect(CARRIER_LABELS[carrier], carrier).toBeTruthy();
    }
    expect(Object.keys(CARRIER_LABELS).sort()).toEqual([...CARRIERS].sort());
  });

  it("guards the carrier vocabulary", () => {
    expect(isCarrier("royal_mail")).toBe(true);
    expect(isCarrier("Royal Mail")).toBe(false);
    expect(isCarrier("wayfair")).toBe(false);
  });
});
