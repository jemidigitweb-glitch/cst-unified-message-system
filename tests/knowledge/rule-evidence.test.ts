import { describe, expect, it } from "vitest";

import type { CstRule } from "@/lib/domain/knowledge";
import { resolveEvidence } from "@/lib/knowledge/rule-evidence";

/**
 * The audit trail behind a draft.
 *
 * The claim this supports is narrow and worth stating: it shows which supplied
 * rules a draft cited and where each one physically lives, so a human can open
 * the workbook and check. It does not claim the model's reasoning followed the
 * rule — no citation mechanism can — and these tests are written against that
 * narrower claim.
 *
 * Rule text here is synthetic. No document content is copied into the repo.
 */

function rule(overrides: Partial<CstRule> = {}): CstRule {
  return {
    ref: "DAM-ABC-12",
    title: "Cracked glass on arrival",
    text: "Ask for photographs before offering anything.",
    category: "Damage",
    sourceFile: "DAMAGE RULES.xlsx",
    sourceSheet: "2 - Damage Decisions",
    sourceRow: 12,
    ...overrides,
  };
}

describe("resolving citations to documents", () => {
  it("gives each cited rule its workbook, sheet and row", () => {
    const report = resolveEvidence([rule()], ["DAM-ABC-12"]);

    expect(report.cited).toHaveLength(1);
    expect(report.cited[0]).toMatchObject({
      ref: "DAM-ABC-12",
      sourceFile: "DAMAGE RULES.xlsx",
      sourceSheet: "2 - Damage Decisions",
      sourceRow: 12,
    });
    // The rule text travels with it, so checking does not require the file.
    expect(report.cited[0]!.text).toContain("photographs");
  });

  it("reports how much of the supplied corpus was actually cited", () => {
    const corpus = [rule(), rule({ ref: "DEL-XY-3" }), rule({ ref: "ADM-QQ-9" })];
    const report = resolveEvidence(corpus, ["DEL-XY-3"]);

    expect(report.rulesSupplied).toBe(3);
    expect(report.cited).toHaveLength(1);
  });

  it("lists the distinct documents behind the citations", () => {
    const corpus = [
      rule({ ref: "A-1", sourceFile: "DAMAGE RULES.xlsx" }),
      rule({ ref: "B-2", sourceFile: "DELIVERY RULES.xlsx" }),
      rule({ ref: "C-3", sourceFile: "DAMAGE RULES.xlsx" }),
    ];
    const report = resolveEvidence(corpus, ["A-1", "B-2", "C-3"]);

    expect(report.documents).toEqual(["DAMAGE RULES.xlsx", "DELIVERY RULES.xlsx"]);
  });

  /**
   * The important one. A draft written months ago cites a row that has since
   * been deleted or moved. Dropping it silently would render an ungrounded
   * draft as a fully grounded one, which is the exact failure an audit exists
   * to catch.
   */
  it("surfaces a citation that no longer resolves rather than dropping it", () => {
    const report = resolveEvidence([rule()], ["DAM-ABC-12", "GONE-999-1"]);

    expect(report.cited.map((r) => r.ref)).toEqual(["DAM-ABC-12"]);
    expect(report.unresolved).toEqual(["GONE-999-1"]);
  });

  it("reports everything unresolved when the corpus could not be read", () => {
    const report = resolveEvidence([], ["DAM-ABC-12", "DEL-XY-3"]);

    expect(report.cited).toHaveLength(0);
    expect(report.unresolved).toEqual(["DAM-ABC-12", "DEL-XY-3"]);
    expect(report.rulesSupplied).toBe(0);
  });

  /**
   * Refs written before the scheme changed must NOT be reported as missing
   * documents. `refFor` used to be area-row-nameSlug (`MESHAN-43-VATINVOI`) and
   * is now area-sheetCode-row (`ADM-HG9-5`); every draft written before that
   * change carries an unresolvable ref through no fault of the workbooks.
   * Calling those "no longer in the current documents" blamed the business for
   * our own migration, on every historical draft.
   */
  it("separates a stale reference format from a missing document", () => {
    const report = resolveEvidence(
      [rule({ ref: "ADM-HG9-5" })],
      ["ADM-HG9-5", "MESHAN-43-VATINVOI", "DEL-XY-3"],
    );

    expect(report.cited.map((r) => r.ref)).toEqual(["ADM-HG9-5"]);
    // Old scheme — ends in a name slug, not a row number.
    expect(report.legacy).toEqual(["MESHAN-43-VATINVOI"]);
    // Current scheme — genuinely absent, so a real finding.
    expect(report.unresolved).toEqual(["DEL-XY-3"]);
  });

  it("treats every current-format ref ending in a row number as current", () => {
    const report = resolveEvidence([], ["WROQUA-XK4-6", "MISPAR-A0B-142"]);
    expect(report.legacy).toEqual([]);
    expect(report.unresolved).toHaveLength(2);
  });

  it("keeps the order the draft cited them in", () => {
    const corpus = [rule({ ref: "A-1" }), rule({ ref: "B-2" }), rule({ ref: "C-3" })];
    const report = resolveEvidence(corpus, ["C-3", "A-1"]);

    expect(report.cited.map((r) => r.ref)).toEqual(["C-3", "A-1"]);
  });

  it("counts a repeated citation once", () => {
    const report = resolveEvidence([rule()], ["DAM-ABC-12", "DAM-ABC-12"]);
    expect(report.cited).toHaveLength(1);
  });

  it("says a rule has no address rather than inventing one", () => {
    // The older Google Sheet reader builds rules without coordinates.
    const report = resolveEvidence(
      [rule({ sourceFile: undefined, sourceSheet: undefined, sourceRow: undefined })],
      ["DAM-ABC-12"],
    );

    expect(report.cited[0]).toMatchObject({
      sourceFile: null,
      sourceSheet: null,
      sourceRow: null,
    });
    expect(report.documents).toEqual([]);
  });
});
