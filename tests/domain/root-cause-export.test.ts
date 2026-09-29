import { describe, expect, it } from "vitest";

import {
  csvField,
  rootCauseCsv,
  rootCausesForDisplay,
  type RootCauseExportRow,
} from "@/lib/domain/root-cause-export";

/**
 * The export's presentation rules.
 *
 * PURE. No database, no network, no clock. Every value here is synthetic.
 */

function row(overrides: Partial<RootCauseExportRow> = {}): RootCauseExportRow {
  return {
    conversationId: "50802",
    marketplace: "ebay",
    subSourceId: 4,
    // Synthetic: all-nines cannot be an issued reference, and is visibly not
    // one at a glance. A real order number here would be a customer-data leak.
    orderNumber: "99-99999-99999",
    customerName: "A Buyer",
    rootCauses: ["OUT OF STOCK"],
    customRootCause: null,
    courier: null,
    courierIssueType: null,
    issueNote: null,
    messageAppRootCause: "",
    recordedAt: "2026-09-29T08:00:00.000Z",
    ...overrides,
  };
}

describe("the Root Causes cell", () => {
  it("lists plain labels separated by a semicolon", () => {
    expect(rootCausesForDisplay(row({ rootCauses: ["OUT OF STOCK", "RETURN"] }))).toBe(
      "OUT OF STOCK; RETURN",
    );
  });

  /**
   * THE WORD "OTHER" NEVER REACHES THE CELL. `OUT OF STOCK; OTHER` tells a
   * reader nothing about the second cause — they have to look across to
   * another column to find out what it was.
   */
  it("shows the agent's own wording in place of OTHER", () => {
    const cell = rootCausesForDisplay(
      row({ rootCauses: ["OUT OF STOCK", "OTHER"], customRootCause: "product outof stock" }),
    );
    expect(cell).toBe("OUT OF STOCK; product outof stock");
    expect(cell).not.toContain("OTHER");
  });

  it("substitutes wherever OTHER sits in the set", () => {
    expect(
      rootCausesForDisplay(row({ rootCauses: ["OTHER", "RETURN"], customRootCause: "odd one" })),
    ).toBe("odd one; RETURN");
  });

  /** OTHER alone reads as the typed cause and nothing else. */
  it("shows only the typed cause when OTHER is the sole selection", () => {
    expect(
      rootCausesForDisplay(row({ rootCauses: ["OTHER"], customRootCause: "bracket wrong" })),
    ).toBe("bracket wrong");
  });

  /**
   * NOTHING IS LOST BY THE SUBSTITUTION, and this is the test that proves it.
   * `Custom Root Cause` is non-empty if and only if OTHER was selected, so
   * "how often did nothing fit" is still answerable from the file.
   */
  it("keeps the typed cause in its own column as well", () => {
    const csv = rootCauseCsv([
      row({ rootCauses: ["OUT OF STOCK", "OTHER"], customRootCause: "product outof stock" }),
    ]);
    const line = csv.split("\r\n")[1]!;
    expect(line).toContain("OUT OF STOCK; product outof stock");
    // Twice: once in the cell, once in its own column.
    expect(line.match(/product outof stock/g)).toHaveLength(2);
  });

  /** A label list without OTHER is untouched, whatever the custom column holds. */
  it("leaves a selection without OTHER alone", () => {
    expect(rootCausesForDisplay(row({ rootCauses: ["RETURN"], customRootCause: null }))).toBe(
      "RETURN",
    );
  });
});

describe("csv fields", () => {
  it("quotes a field containing a comma, quote or newline", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("one\ntwo")).toBe('"one\ntwo"');
  });

  /** A CSV field starting `=` is executed by Excel; the apostrophe defuses it. */
  it("defuses a formula-shaped value", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("@home")).toBe("'@home");
  });

  it("writes nothing for null", () => {
    expect(csvField(null)).toBe("");
  });
});
