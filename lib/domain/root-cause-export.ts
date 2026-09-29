import { isOtherLabel } from "@/lib/domain/root-cause-vocabulary";

/**
 * Turning recorded root causes into a CSV an operator can open in Excel.
 *
 * ---------------------------------------------------------------------------
 * ONE ROW PER CASE, WITH ITS CAUSES IN ONE CELL
 * ---------------------------------------------------------------------------
 * The export answers "what did CST record", so its unit is the CURRENT
 * revision of a conversation — one line each. The selected causes are joined
 * into a single `Root Causes` cell rather than exploded into one line per
 * label, because a reader counting lines in a spreadsheet must be counting
 * CASES. Exploding them would make every multi-cause case look like several,
 * which is precisely the double count the schema was shaped to avoid.
 *
 * A `Root Cause Count` column carries the other number, so somebody who wants
 * mentions can still get them without re-deriving the set from text.
 *
 * ---------------------------------------------------------------------------
 * EXCEL-COMPATIBLE, AND THAT IS MORE THAN "COMMA SEPARATED"
 * ---------------------------------------------------------------------------
 * Three things break a CSV in Excel and all three are handled here:
 *
 *   * A field containing a comma, a quote or a newline must be quoted, with
 *     internal quotes doubled. `issue_note` and the typed cause are free text
 *     written by agents and will contain all three.
 *   * A field beginning with `=`, `+`, `-` or `@` is executed as a FORMULA by
 *     Excel and by Sheets. An agent writing "=customer refused" would produce a
 *     spreadsheet error at best; at worst this is the CSV-injection route into
 *     someone's machine. Such fields are prefixed with a single quote.
 *   * A UTF-8 BOM, or Excel reads `EVRI` fine but mangles any non-ASCII an
 *     agent typed — and agents type dashes and accented names.
 *
 * PURE. No network, no database, no clock.
 */

/** One current revision, flattened for export. */
export type RootCauseExportRow = {
  readonly conversationId: string;
  readonly marketplace: string;
  readonly subSourceId: number | null;
  /**
   * The order this case is about, where CST can name one.
   *
   * The VERIFIED snapshot order where the matcher resolved a single order;
   * otherwise the thread's own reference — except on eBay, where that
   * reference is a buyer username and never an order number. That is the rule
   * `conversation-repository.ts` already uses, reused rather than re-invented
   * so the export and the inbox cannot disagree about what a case's order is.
   */
  readonly orderNumber: string | null;
  /**
   * The customer's name, resolved from the READ-ONLY source at export time.
   *
   * NOT STORED, and this is deliberate: a name copied into `cst_app` would be
   * a second copy that goes stale the moment the source is corrected, and this
   * feature has no business owning customer identity. Empty where the source
   * cannot name one — which is honest, and better than the marketplace handle
   * dressed up as a person.
   */
  readonly customerName: string | null;
  readonly rootCauses: readonly string[];
  readonly customRootCause: string | null;
  readonly courier: string | null;
  readonly courierIssueType: string | null;
  readonly issueNote: string | null;
  /**
   * What the OTHER SYSTEM suggests for the same thread, for comparison.
   *
   * A SEPARATE COLUMN, never merged with CST's own. The two are recorded by
   * different people in different systems and either can be out of date; a
   * single column would have to pick a winner, and neither application has the
   * standing to be it. Empty where that system holds nothing, and a short
   * notice where its own rows disagree with each other — the export says
   * "disagrees" rather than silently choosing one, exactly as the panel does.
   */
  readonly messageAppRootCause: string;
  /** Empty when this conversation has no CST revision yet. */
  readonly recordedAt: string;
};

/**
 * The column order, named once.
 *
 * "Root Causes" is plural because it holds a set — a header reading "Root
 * Cause" beside three values invites a reader to treat the first as primary,
 * which is exactly the rank this model does not have.
 */
export const ROOT_CAUSE_EXPORT_HEADERS = [
  "Conversation",
  "Marketplace",
  "Store",
  "Order Number",
  "Customer",
  "Root Causes",
  "Root Cause Count",
  "Custom Root Cause",
  "Courier",
  "Courier Issue Type",
  "Issue Note",
  "System Suggestion",
  "Recorded At",
] as const;

/**
 * The `Root Causes` cell, with the agent's own wording standing in for OTHER.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WORD "OTHER" DOES NOT APPEAR IN THAT CELL
 * ---------------------------------------------------------------------------
 * `OUT OF STOCK; OTHER` tells a reader nothing about the second cause — they
 * have to look across to another column to find out what it was. Substituting
 * the typed text gives `OUT OF STOCK; product outof stock`, which reads as what
 * the agent actually meant.
 *
 * NOTHING IS LOST BY THE SUBSTITUTION, and that is what makes it safe. The
 * `Custom Root Cause` column still carries the same text, and it is non-empty
 * IF AND ONLY IF `OTHER` was among the selected labels — the domain rule
 * enforces that pairing in both directions. So "how often did nothing fit" is
 * still answerable from this file: it is the count of rows whose
 * `Custom Root Cause` is not blank.
 *
 * THE STORED DATA IS UNTOUCHED. `conversation_root_cause_labels` still holds
 * the literal `OTHER` as a peer label, which is what a query against the
 * database groups on. This is a presentation choice about one spreadsheet cell.
 */
export function rootCausesForDisplay(row: RootCauseExportRow): string {
  return row.rootCauses
    .map((label) =>
      isOtherLabel(label) && row.customRootCause !== null ? row.customRootCause : label,
    )
    .join("; ");
}

/** Characters Excel and Sheets treat as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV field: quoted where it must be, and never executable.
 *
 * The leading apostrophe on a formula-shaped value is what Excel itself uses to
 * mean "this is text" — it is stripped on display, so the operator sees what
 * the agent wrote and the spreadsheet evaluates nothing.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The whole file, as a string.
 *
 * CRLF line endings, because that is what the CSV spec says and what Excel on
 * Windows expects; a lone LF makes older Excel put the entire file on one row.
 */
export function rootCauseCsv(rows: readonly RootCauseExportRow[]): string {
  const lines = [ROOT_CAUSE_EXPORT_HEADERS.map(csvField).join(",")];

  for (const row of rows) {
    lines.push(
      [
        csvField(row.conversationId),
        csvField(row.marketplace),
        csvField(row.subSourceId),
        csvField(row.orderNumber),
        csvField(row.customerName),
        // The set in one cell; the separator is a semicolon so a reader can
        // split it again without colliding with the CSV's own commas.
        csvField(rootCausesForDisplay(row)),
        csvField(row.rootCauses.length),
        csvField(row.customRootCause),
        csvField(row.courier),
        csvField(row.courierIssueType),
        csvField(row.issueNote),
        csvField(row.messageAppRootCause),
        csvField(row.recordedAt),
      ].join(","),
    );
  }

  // A BOM, so Excel reads the file as UTF-8 rather than the system codepage.
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** The download name. Dated so two exports do not overwrite each other. */
export function rootCauseCsvFilename(isoDate: string): string {
  return `cst-root-causes-${isoDate.slice(0, 10)}.csv`;
}

/**
 * The same report as a real `.xlsx`, not a CSV with a different extension.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGES BETWEEN THE TWO FORMATS, AND WHY
 * ---------------------------------------------------------------------------
 * `Root Cause Count` is written as a NUMBER here, where the CSV can only offer
 * text that Excel guesses at. A reader can sum and sort it without first
 * converting a column.
 *
 * NO FORMULA-PREFIX GUARD. `csvField` prefixes a value starting `=` with an
 * apostrophe, because a CSV field is parsed by Excel and that is the injection
 * route. An xlsx cell is only a formula if it carries an explicit `<f>`
 * element, which `buildXlsx` never writes — so the guard is unnecessary here
 * and would be actively harmful: an agent who wrote "=1 missing part" would
 * find a stray apostrophe in the file somebody reads.
 *
 * The columns and their order are shared, so the two downloads cannot drift
 * into disagreeing about what the report contains.
 */
export function rootCauseXlsxRows(
  rows: readonly RootCauseExportRow[],
): (string | number | null)[][] {
  return rows.map((row) => [
    row.conversationId,
    row.marketplace,
    row.subSourceId,
    row.orderNumber,
    row.customerName,
    rootCausesForDisplay(row),
    row.rootCauses.length,
    row.customRootCause,
    row.courier,
    row.courierIssueType,
    row.issueNote,
    row.messageAppRootCause,
    row.recordedAt,
  ]);
}

/** The workbook's one sheet. Named for what it holds, not for the system. */
export const ROOT_CAUSE_SHEET_NAME = "Root causes";

/** The download name for the workbook. Dated, for the same reason as the CSV. */
export function rootCauseXlsxFilename(isoDate: string): string {
  return `cst-root-causes-${isoDate.slice(0, 10)}.xlsx`;
}
