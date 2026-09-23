/**
 * Whether the Customer Service Insights dashboard may be served at all.
 *
 * ------------------------------------------------------------------------
 * IT IS CLOSED IN PRODUCTION, AND THAT IS NOT A CONFIGURATION CHOICE
 * ------------------------------------------------------------------------
 * This dashboard names individual members of staff and reports numbers about
 * their work. Every other screen in this application shows customer messages to
 * whoever opens it, which is already more than it should — but a per-agent
 * productivity report is a different kind of exposure, and the application has
 * no authentication of any kind: 26 API routes, none of them checking a user,
 * `cst_app.app_users` holding zero rows, and no session anywhere.
 *
 * So the gate is not "is a flag set". It is "does a deployed environment exist
 * that can identify who is asking", and today the answer is no. There is
 * deliberately NO environment variable that opens this in production, because a
 * variable is a thing somebody sets in a hurry.
 *
 * ------------------------------------------------------------------------
 * WHAT REPLACES THIS
 * ------------------------------------------------------------------------
 * When `verifySession()` exists — a real session, read close to the data, as
 * `node_modules/next/dist/docs/01-app/02-guides/authentication.md` describes —
 * this module's body becomes that check and the production refusal goes away.
 * The call sites do not change: the page and every route already ask this one
 * question, so the whole surface opens and closes in one edit.
 *
 * ------------------------------------------------------------------------
 * WHY IT LIVES IN `lib/domain` AND NOT `lib/config`
 * ------------------------------------------------------------------------
 * It sat beside `env.ts` at first, which looked tidy and was wrong: a guard in
 * `tests/guards/api-surface.test.ts` forbids any component importing
 * `@/lib/config/`, because that directory holds database credentials and a
 * browser bundle must never reach it. The page has to ask this question before
 * it renders, so the question belongs where a page may look.
 *
 * It is also simply not configuration. It reads no credential and no setting —
 * it is a policy decision about who may be shown named staff activity, which is
 * domain logic, and it is pure.
 *
 * ------------------------------------------------------------------------
 * IT ANSWERS 404, NOT 403
 * ------------------------------------------------------------------------
 * A 403 confirms the address is real and worth trying again later. There is
 * nothing to gain from telling an unauthenticated caller that a staff
 * performance report exists here, so callers render `notFound()` and routes
 * return 404. The reason below is for the developer reading logs, never for the
 * response body.
 */

export type DashboardAccess =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * `NODE_ENV === "production"` covers every deployment, including Vercel
 * previews, which build as production. That is intended: a preview URL is as
 * reachable as a production one.
 */
export function performanceDashboardAccess(): DashboardAccess {
  if (process.env.NODE_ENV === "production") {
    return {
      allowed: false,
      reason:
        "The performance dashboard is closed in every deployed environment until " +
        "authenticated access exists. It reports named staff activity and this " +
        "application has no session, no login and no user records.",
    };
  }
  return { allowed: true };
}

/** Convenience for route handlers, which only ever need the boolean. */
export function performanceDashboardIsOpen(): boolean {
  return performanceDashboardAccess().allowed;
}
