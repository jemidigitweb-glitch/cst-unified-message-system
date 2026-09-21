import { NextResponse } from "next/server";

import { scanRefusal } from "@/lib/domain/automation/automation-settings-service";
import {
  AUTOMATION_ITEM_STATUSES,
  type AutomationItemStatus,
  POST_DISPATCH_AUTOMATION_KEY,
} from "@/lib/domain/automation/automation-types";
import { getAppPool } from "@/lib/db/pools";
import {
  automationSettings,
  isAutomationStoreMissing,
  itemStatusCounts,
  listAutomationTemplates,
  listItems,
} from "@/lib/repositories/automation-repository";

/**
 * GET /api/automations — the post-dispatch configuration and its records.
 *
 * READ ONLY. Configuration is written through `/api/automations/settings`;
 * a record is only ever changed by the runner or by an explicit cancellation.
 *
 * Returns the settings, the templates an operator may choose from, one page of
 * records, and the per-status counts — the counts separately from the page,
 * because "how many were skipped?" cannot be answered from fifty rows out of
 * several thousand.
 */
export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function isStatus(value: string | null): value is AutomationItemStatus {
  return value !== null && (AUTOMATION_ITEM_STATUSES as readonly string[]).includes(value);
}

/** A page request, clamped. An unusable value falls back rather than failing. */
function queryOf(request: Request): {
  limit: number;
  offset: number;
  page: number;
  status?: AutomationItemStatus;
} {
  const params = new URL(request.url).searchParams;
  const requested = Number.parseInt(params.get("pageSize") ?? "", 10);
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const requestedPage = Number.parseInt(params.get("page") ?? "", 10);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const rawStatus = params.get("status");
  return {
    limit,
    offset: (page - 1) * limit,
    page,
    // An unrecognised filter is ignored rather than returning nothing: an empty
    // table caused by a typo in a query string is a confusing way to be wrong.
    status: isStatus(rawStatus) ? rawStatus : undefined,
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const { limit, offset, page, status } = queryOf(request);

  try {
    const pool = getAppPool();
    const settings = await automationSettings(pool, POST_DISPATCH_AUTOMATION_KEY);
    if (settings === undefined) {
      return NextResponse.json({
        settings: null,
        templates: [],
        scanStatus: { running: false, reason: "Post-dispatch automation is not configured." },
        items: [],
        counts: null,
        page: { page, pageSize: limit, total: 0, status: status ?? null },
      });
    }

    const refusal = scanRefusal(settings);
    const [templates, { items, total }, counts] = await Promise.all([
      listAutomationTemplates(pool),
      listItems(pool, { automationKey: POST_DISPATCH_AUTOMATION_KEY, limit, offset, status }),
      itemStatusCounts(pool, POST_DISPATCH_AUTOMATION_KEY),
    ]);

    return NextResponse.json({
      settings,
      templates,
      scanStatus:
        refusal === null
          ? { running: true, reason: null }
          : { running: false, reason: refusal.reason },
      items,
      counts,
      page: { page, pageSize: limit, total, status: status ?? null },
    });
  } catch (cause) {
    if (isAutomationStoreMissing(cause)) {
      return NextResponse.json({
        settings: null,
        templates: [],
        scanStatus: {
          running: false,
          reason: "Automation storage is not available yet. Apply migration 0011.",
        },
        items: [],
        counts: null,
        page: { page, pageSize: limit, total: 0, status: status ?? null },
        storeReady: false,
      });
    }
    console.error("[automations] list failed", cause);
    return NextResponse.json({ error: "Unable to load automation settings" }, { status: 500 });
  }
}
