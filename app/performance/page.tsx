import { notFound } from "next/navigation";

import { PerformanceDashboard } from "@/components/performance-dashboard";
import { performanceDashboardAccess } from "@/lib/domain/performance-dashboard-access";

/**
 * Customer Service Insights — its own page, like post-dispatch automation.
 *
 * THE GATE IS HERE AS WELL AS ON THE ROUTE, deliberately, and it stays here
 * even though it currently admits everybody. The page and the API are two
 * separate ways in, and a check on only one of them is a door with a lock on
 * the frame — so both keep asking, and both start refusing again the moment
 * `performanceDashboardAccess()` says no.
 *
 * It says yes in every environment today, for an internal demonstration from
 * the Vercel deployment, and this page is therefore readable by anyone with the
 * URL. See `lib/domain/performance-dashboard-access.ts` for what that exposes
 * and what is meant to replace it.
 *
 * `notFound()` renders the ordinary 404 rather than a 403: a refused visitor
 * should not learn what lives at this address.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Customer Service Insights — CST",
};

export default function PerformancePage() {
  if (!performanceDashboardAccess().allowed) notFound();
  return <PerformanceDashboard />;
}
