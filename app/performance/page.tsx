import { notFound } from "next/navigation";

import { PerformanceDashboard } from "@/components/performance-dashboard";
import { performanceDashboardAccess } from "@/lib/domain/performance-dashboard-access";

/**
 * Customer Service Insights — its own page, like post-dispatch automation.
 *
 * THE GATE IS HERE AS WELL AS ON THE ROUTE, deliberately. The page and the API
 * are two separate ways in, and a check on only one of them is a door with a
 * lock on the frame. `notFound()` renders the ordinary 404 — a signed-out
 * visitor learns nothing about what lives at this address.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Customer Service Insights — CST",
};

export default function PerformancePage() {
  if (!performanceDashboardAccess().allowed) notFound();
  return <PerformanceDashboard />;
}
