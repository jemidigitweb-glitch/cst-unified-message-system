/**
 * Whether the Customer Service Insights dashboard may be served at all.
 *
 * ------------------------------------------------------------------------
 * IT IS CURRENTLY OPEN EVERYWHERE, FOR AN INTERNAL DEMONSTRATION
 * ------------------------------------------------------------------------
 * This module used to refuse in production. That refusal was lifted so the
 * dashboard could be shown from the Vercel deployment, and the consequence is
 * worth writing down rather than leaving to be discovered:
 *
 *   This page names individual members of staff and reports numbers about
 *   their work, and the application still has no authentication of any kind —
 *   no session, no login, no middleware, and zero rows in `cst_app.app_users`.
 *   Anyone holding the deployment URL can read it. NOTHING IN THIS REPOSITORY
 *   LIMITS THAT. If the demo needs limiting, it is limited at the platform
 *   edge — Vercel Deployment Protection — and not here.
 *
 * ------------------------------------------------------------------------
 * WHAT SHOULD REPLACE THIS, AND HOW TO CLOSE IT AGAIN
 * ------------------------------------------------------------------------
 * The call sites did not change when this opened and will not change when it
 * closes. The page, the API route and the navigation link all ask this one
 * question, so the whole surface moves together in one edit to the body below.
 * That is the reason the refusal branch is kept in the type rather than
 * deleted: closing this is a returned value, not a rewrite.
 *
 * The intended end state is not the old `NODE_ENV` refusal — that was a stand-in
 * for a check that did not exist yet — but a real one: `verifySession()` read
 * close to the data, as
 * `node_modules/next/dist/docs/01-app/02-guides/authentication.md` describes,
 * admitting `cst_app.app_users.cst_role = 'admin'`. The design is recorded in
 * `handover/2026-09-22-internal-notes-handover.md`: authenticate against
 * `issue_tracking.management_users`, which `app_users.management_user_id` was
 * built to reference.
 *
 * ------------------------------------------------------------------------
 * A REFUSAL IS STILL 404, NOT 403
 * ------------------------------------------------------------------------
 * Unchanged, and still true of whatever check replaces this. A 403 confirms the
 * address is real and worth trying again later; there is nothing to gain from
 * telling a refused caller that a staff performance report lives here. Callers
 * render `notFound()` and routes return 404. The reason below is for the
 * developer reading logs, never for the response body.
 *
 * ------------------------------------------------------------------------
 * WHY IT LIVES IN `lib/domain` AND NOT `lib/config`
 * ------------------------------------------------------------------------
 * A guard in `tests/guards/api-surface.test.ts` forbids any component importing
 * `@/lib/config/`, because that directory holds database credentials and a
 * browser bundle must never reach it. The page has to ask this question before
 * it renders, so the question belongs where a page may look.
 *
 * It is also not configuration. It reads no credential and no setting — it is a
 * policy decision about who may be shown named staff activity, and it is pure.
 */

export type DashboardAccess =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Open in every environment, including production.
 *
 * This deliberately consults nothing — not `NODE_ENV`, not a flag, not a
 * variable. Opening and closing this dashboard is an edit to this function, so
 * it is a thing that appears in a diff and gets read, rather than a value
 * somebody sets in a hurry in a dashboard somewhere.
 *
 * Returning the `DashboardAccess` union rather than a bare `true` is what keeps
 * that edit to one line: the callers already handle a refusal.
 */
export function performanceDashboardAccess(): DashboardAccess {
  return { allowed: true };
}

/** Convenience for route handlers, which only ever need the boolean. */
export function performanceDashboardIsOpen(): boolean {
  return performanceDashboardAccess().allowed;
}
