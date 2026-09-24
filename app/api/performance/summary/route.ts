import { NextResponse } from "next/server";

import { performanceDashboardAccess } from "@/lib/domain/performance-dashboard-access";
import { getAppPool, getSourcePool } from "@/lib/db/pools";
import {
  countsFrom,
  emptyCounts,
  feedbackSupport,
  negativeSharePercent,
  shareDenominatorLabel,
} from "@/lib/domain/customer-feedback";
import {
  FILTER_DEFINITIONS,
  KPI_DEFINITIONS,
  readiness,
} from "@/lib/domain/performance-metrics";
import {
  activityCoverage,
  agentOptions,
  ebayFeedbackCounts,
  messagesHandledByAgent,
  unresolvedCaseCounts,
} from "@/lib/repositories/performance-repository";
import { breakdownOf, resolutionSupport } from "@/lib/domain/unresolved-cases";

/**
 * GET /api/performance/summary — the Customer Service Insights dashboard.
 *
 * THE ACCESS CHECK IS THE FIRST THING THIS DOES, and a refusal answers 404 with
 * no body worth reading — see `performanceDashboardAccess()` for why it is 404
 * rather than 403, and what replaces it when authentication exists.
 *
 * That check currently admits every caller, including in production, for an
 * internal demonstration. This route therefore serves named per-agent figures
 * to anyone who can reach the deployment. The check is kept rather than removed
 * precisely so that closing it again is one edit in one module.
 *
 * READS POSTGRESQL ONLY. No MySQL client is imported here and none could be
 * usefully added: everything this serves was imported into `cst_app` first and
 * is kept current by `npm run sync:mysql`. A dashboard request must never wait
 * on a rate-limited source, and the MariaDB account allows 100 queries an hour.
 *
 * IT RETURNS THE UNAVAILABLE STATES AS DATA. The six KPIs that cannot be
 * computed are not omitted — they travel with the reason they are blocked, so
 * the interface renders a named absence rather than deciding for itself that a
 * missing tile means nothing to show.
 */
export const dynamic = "force-dynamic";

/** Whole days. `agent_activity.action_date` is a DATE and has no time. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WINDOW_DAYS = 30;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The requested window, clamped to something answerable.
 *
 * An unparseable bound falls back rather than failing: a mistyped URL should
 * show the default month, not an error page. An inverted range is swapped,
 * because a reader who picks the dates the wrong way round meant the range.
 */
function windowOf(params: URLSearchParams): { from: string; to: string } {
  const now = new Date();
  const rawTo = params.get("to");
  const rawFrom = params.get("from");

  const to = rawTo && DATE.test(rawTo) ? rawTo : isoDay(now);
  const fallbackFrom = new Date(now);
  fallbackFrom.setUTCDate(fallbackFrom.getUTCDate() - DEFAULT_WINDOW_DAYS);
  const from = rawFrom && DATE.test(rawFrom) ? rawFrom : isoDay(fallbackFrom);

  return from <= to ? { from, to } : { from: to, to: from };
}

const MARKETPLACES = ["ebay", "amazon", "shopify", "bandq", "temu"];

export async function GET(request: Request): Promise<NextResponse> {
  const access = performanceDashboardAccess();
  if (!access.allowed) {
    console.warn(`[performance] refused: ${access.reason}`);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const { from, to } = windowOf(params);

  const marketplaceParam = params.get("marketplace");
  const marketplace = marketplaceParam && MARKETPLACES.includes(marketplaceParam)
    ? marketplaceParam
    : null;

  const agentParam = params.get("agent");
  const sourceUserId =
    agentParam !== null && /^\d+$/.test(agentParam) ? Number(agentParam) : null;

  try {
    const pool = getAppPool();
    const [rows, coverage, agents] = await Promise.all([
      messagesHandledByAgent(pool, { from, to, marketplace, sourceUserId }),
      activityCoverage(pool),
      agentOptions(pool),
    ]);

    const messagesHandled = rows.reduce((total, row) => total + row.messagesHandled, 0);
    const attributed = rows
      .filter((row) => row.attributable)
      .reduce((total, row) => total + row.messagesHandled, 0);

    /*
     * Both counts come from ONE scoped query, so the total and the resolved
     * figure cannot be measured over different sets. "No recorded resolution"
     * is the headline rather than "unresolved": only eBay has any resolution
     * data, so subtracting elsewhere would report a backlog that is really an
     * import gap.
     */
    const resolution = resolutionSupport(marketplace);
    const unresolvedCounts = await unresolvedCaseCounts(pool, { from, to, marketplace });
    const unresolved = breakdownOf(unresolvedCounts);

    /*
     * FEEDBACK IS READ FROM THE SOURCE, NOT FROM cst_app.
     *
     * The session is read-only at the server, and the alternative — copying
     * 322,696 rows in order to count three of them — would be a second store to
     * keep in step for no gain. This is the one dashboard read that leaves
     * cst_app, and it is still PostgreSQL: no MySQL is touched here.
     *
     * The query only runs when the selected marketplace actually supports a
     * sentiment breakdown, so an Amazon or Shopify filter costs nothing.
     */
    const support = feedbackSupport(marketplace);
    const counts = support.supported
      ? countsFrom(await ebayFeedbackCounts(getSourcePool(), { from, to }))
      : emptyCounts();

    return NextResponse.json({
      filters: { from, to, marketplace, agent: sourceUserId },
      options: { marketplaces: MARKETPLACES, agents },
      coverage,
      readiness: readiness(),
      kpis: KPI_DEFINITIONS,
      filterDefinitions: FILTER_DEFINITIONS,
      messagesHandled: {
        total: messagesHandled,
        // Stated separately and always, so a total is never read as though every
        // message in it belongs to somebody named.
        attributed,
        unattributed: messagesHandled - attributed,
        rows,
      },
      unresolvedCases: {
        supported: resolution.supported,
        reason: resolution.supported ? null : resolution.reason,
        counts: unresolvedCounts,
        breakdown: unresolved,
        marketplacesCovered: ["ebay"],
      },
      customerFeedback: {
        supported: support.supported,
        reason: support.supported ? null : support.reason,
        counts,
        // Negative as a share of feedback RECEIVED — not of orders. Null when
        // nothing arrived, never 0: a silent period has no share, and 0% would
        // read as "nobody complained".
        negativeSharePercent: support.supported ? negativeSharePercent(counts) : null,
        denominator: support.supported ? shareDenominatorLabel(counts) : null,
        // eBay only, and the payload says so rather than leaving the interface
        // to infer it from an empty Amazon result.
        marketplacesCovered: ["ebay"],
      },
    });
  } catch (cause) {
    console.error("[performance] summary failed", cause);
    return NextResponse.json(
      { error: "Unable to load performance data — see server logs." },
      { status: 500 },
    );
  }
}
