import { NextResponse } from "next/server";

import { getAppPool, getSourcePool } from "@/lib/db/pools";
import {
  ROOT_CAUSE_EXPORT_HEADERS,
  ROOT_CAUSE_SHEET_NAME,
  rootCauseCsv,
  rootCauseCsvFilename,
  rootCauseXlsxFilename,
  rootCauseXlsxRows,
} from "@/lib/domain/root-cause-export";
import { buildXlsx } from "@/lib/domain/xlsx";
import {
  exportCurrentRootCauses,
  isRootCauseStoreMissing,
} from "@/lib/repositories/conversation-root-cause-repository";
import { loadCustomerNamesByRef } from "@/lib/repositories/customer-name-repository";
import { loadMessageAppRootCausesForConversations } from "@/lib/repositories/root-cause-repository";

/**
 * GET /api/root-causes/export[?from=&to=]
 *
 * Every conversation's CURRENT recorded root cause, as a CSV that opens in
 * Excel. READ ONLY — this route has no POST and writes nothing.
 *
 * ---------------------------------------------------------------------------
 * ONE LINE PER CASE
 * ---------------------------------------------------------------------------
 * The unit is the current revision of a conversation, so counting lines counts
 * CASES. A case with three causes is one line with three values in its `Root
 * Causes` cell and a `Root Cause Count` of 3 — never three lines, which would
 * make every multi-cause case look like several and inflate any total a reader
 * takes from the spreadsheet.
 *
 * ---------------------------------------------------------------------------
 * THE DATE BOUNDS ARE OPTIONAL AND ALWAYS BOUND
 * ---------------------------------------------------------------------------
 * Both are passed to the statement as parameters, NULL when absent, so one
 * query serves "everything" and "this range". Nothing is string-built into a
 * WHERE clause — a date filter assembled by concatenation is how a reporting
 * endpoint becomes an injection point.
 *
 * An unparseable date is REFUSED rather than ignored. Silently exporting
 * everything when somebody asked for one month is worse than an error: they
 * would act on a number covering the wrong period without knowing.
 *
 * NO CUSTOMER DATA. The columns are the conversation id, the marketplace, the
 * store key, what CST recorded, and when. No customer name, address, message
 * text or order reference appears — the store NAME is deliberately not fetched
 * either, because it lives in the read-only source and this path must not reach
 * across databases.
 */
export const dynamic = "force-dynamic";

/** An ISO instant, or null for absent. Anything else is a refusal. */
function readBound(raw: string | null): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw.trim() === "") return { ok: true, value: null };
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? { ok: false } : { ok: true, value: parsed.toISOString() };
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;

  const from = readBound(params.get("from"));
  const to = readBound(params.get("to"));
  if (!from.ok || !to.ok) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  try {
    const app = getAppPool();
    const recorded = await exportCurrentRootCauses(app, { from: from.value, to: to.value });

    /*
     * THE MESSAGE APPLICATION'S VALUE, FETCHED IN ONE BATCH.
     *
     * Read here rather than in the CST repository, because that module must
     * never touch the read-only source — a guard asserts it names no source
     * pool. Joining the two halves is the route's job, which keeps the
     * separation a property of the code.
     *
     * A failure to read it must NOT fail the export: the CST half is what this
     * file is for, and an empty comparison column is a smaller loss than no
     * file at all. It is logged so the gap is visible.
     */
    let messageApp = new Map<string, { state: string; value: string | null; distinctLabelCount: number }>();
    try {
      messageApp = await loadMessageAppRootCausesForConversations(
        app,
        getSourcePool(),
        recorded.map((row) => row.conversationId),
      );
    } catch (cause) {
      console.error("[root-cause-export] message app values unavailable", cause);
    }

    /*
     * THE CUSTOMER NAMES, ALSO IN ONE BATCH, AND ALSO NON-FATAL.
     *
     * Resolved from the read-only source by thread reference — an order number
     * on most marketplaces, a buyer username on eBay. Nothing is stored: a name
     * copied into cst_app would be a second copy that goes stale the moment the
     * source corrects a spelling.
     *
     * A reference the source cannot match simply has no name, and the cell is
     * left empty. It must NEVER fall back to the reference itself: a
     * marketplace handle printed under "Customer" reads as a person's name to
     * whoever opens the report.
     */
    let customerNames = new Map<string, string>();
    try {
      customerNames = await loadCustomerNamesByRef(
        getSourcePool(),
        recorded.map((row) => row.counterpartyRef),
      );
    } catch (cause) {
      console.error("[root-cause-export] customer names unavailable", cause);
    }

    const rows = recorded.map((row) => {
      const theirs = messageApp.get(row.conversationId);
      // The thread reference is a lookup key, not a column: it leaves here.
      const { counterpartyRef, ...exported } = row;
      return {
        ...exported,
        customerName: customerNames.get(counterpartyRef) ?? null,
        /*
         * Their value verbatim when their own rows agree; a short notice when
         * they do not. The export says "disagrees" rather than picking one,
         * exactly as the panel refuses to — a spreadsheet cell showing one of
         * two conflicting labels is a number somebody would act on.
         */
        messageAppRootCause:
          theirs === undefined || theirs.state === "unavailable"
            ? ""
            : theirs.state === "ambiguous"
              ? `(${theirs.distinctLabelCount} conflicting values)`
              : (theirs.value ?? ""),
      };
    });

    /*
     * The filename is stamped with the date the export was TAKEN, not the range
     * it covers — two exports of the same range on different days are different
     * files, and one must not overwrite the other in a downloads folder.
     */
    const takenAt = new Date().toISOString();

    /*
     * XLSX BY DEFAULT, because "download the root causes" means a spreadsheet
     * somebody opens — and a real workbook arrives with its header frozen, its
     * columns sized and its count column numeric.
     *
     * CSV stays available at ?format=csv rather than being replaced. It is the
     * format a script or an import job wants, and removing it to add the other
     * would trade one audience for another.
     */
    if (params.get("format") === "csv") {
      const filename = rootCauseCsvFilename(takenAt);
      return new NextResponse(rootCauseCsv(rows), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          // A report is a snapshot; a cached one is a wrong one.
          "Cache-Control": "no-store",
        },
      });
    }

    const filename = rootCauseXlsxFilename(takenAt);
    const workbook = buildXlsx({
      sheetName: ROOT_CAUSE_SHEET_NAME,
      headers: [...ROOT_CAUSE_EXPORT_HEADERS],
      rows: rootCauseXlsxRows(rows),
    });

    /*
     * Copied into a plain ArrayBuffer because a `Uint8Array` over a pooled or
     * shared buffer is not a `BodyInit` the response type accepts — and a
     * mis-sliced view would ship an incomplete workbook, which Excel reports as
     * "the file is corrupt" with nothing to say why.
     */
    const body = workbook.buffer.slice(
      workbook.byteOffset,
      workbook.byteOffset + workbook.byteLength,
    ) as ArrayBuffer;

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(workbook.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (cause) {
    if (isRootCauseStoreMissing(cause)) {
      console.error("[root-cause-export] 0020 is not applied here");
      return NextResponse.json({ error: "Root cause export is not available" }, { status: 503 });
    }
    // The underlying error may name schemas, hosts or credentials.
    console.error("[root-cause-export] failed", cause);
    return NextResponse.json({ error: "Unable to export root causes" }, { status: 500 });
  }
}
