/**
 * Unresolved cases: total conversations minus the ones currently resolved.
 *
 * PURE. No network, no database, no clock.
 *
 * ------------------------------------------------------------------------
 * "CURRENTLY RESOLVED", NOT "EVER RESOLVED" — REOPENING IS REAL
 * ------------------------------------------------------------------------
 * A conversation can be resolved and then put back. Measured: 19 conversations
 * have a reopen recorded after a resolution, and 12 of them are still reopened
 * — the other 7 were resolved again afterwards.
 *
 * So the test is the LATEST state-changing action, not the presence of a
 * resolution anywhere in the history. Counting "ever resolved" reports 1,207
 * where the truth is 1,197, and the ten it overcounts are conversations
 * somebody deliberately reopened.
 *
 * ------------------------------------------------------------------------
 * CONVERSATIONS, NOT ACTIONS
 * ------------------------------------------------------------------------
 * There are 4,720 resolution actions against 1,207 conversations. One
 * conversation carries 13 of them. Counting actions would report nearly four
 * times the real figure, so every count here is DISTINCT on the conversation.
 *
 * ------------------------------------------------------------------------
 * ABSENCE OF A RESOLUTION IS NOT EVIDENCE OF BEING UNRESOLVED
 * ------------------------------------------------------------------------
 * This is the whole reason the headline is called "no recorded resolution".
 *
 * Only eBay has any resolution data at all — 12,517 Shopify, 4,247 B&Q, 1,126
 * Amazon and 312 Temu conversations have none. Subtracting across every
 * marketplace would report 18,875 unresolved cases, of which 18,605 are simply
 * unobserved. That is not a backlog; it is a gap in what was imported, and
 * stating it as a backlog would invent a crisis.
 *
 * Even within eBay the same caution applies at a smaller scale: 1,870
 * conversations, 1,467 with any activity recorded. The 403 with none cannot be
 * called unresolved either, so the breakdown separates them:
 *
 *   observedUnresolved   we have activity for it and no current resolution
 *   noActivityRecord     nothing was recorded; we genuinely do not know
 */

/** The two actions that change resolution state. Nothing else is read. */
export const RESOLVED_ACTION = "move_to_resolved";
export const REOPEN_ACTION = "move_to_todo";
export const RESOLUTION_ACTIONS = [RESOLVED_ACTION, REOPEN_ACTION] as const;

/**
 * `mark_as_no_need_reply` is DELIBERATELY NOT a resolution.
 *
 * It appears on 192 conversations, 145 of which also carry a real resolution —
 * so for those it adds nothing, and for the remaining 47 it means only that
 * somebody decided not to reply. "We are not answering this" and "this is
 * settled" are different statements, and nobody has said they are the same.
 * Treating it as a resolution would quietly reduce the backlog by 47.
 */
export const NOT_A_RESOLUTION = ["mark_as_no_need_reply"] as const;

/** Marketplaces with any resolution data. Measured, not assumed. */
export const RESOLUTION_SUPPORTED_MARKETPLACES = ["ebay"] as const;

export type ResolutionSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

export function resolutionSupport(marketplace: string | null): ResolutionSupport {
  if (marketplace === null) return { supported: true };
  if ((RESOLUTION_SUPPORTED_MARKETPLACES as readonly string[]).includes(marketplace)) {
    return { supported: true };
  }
  return {
    supported: false,
    reason: "No resolution activity is recorded for this marketplace.",
  };
}

export type UnresolvedCounts = {
  /** Conversations in scope. */
  readonly total: number;
  /** Of those, currently resolved — latest state is a resolution. */
  readonly resolved: number;
  /** Of those, resolved once and since reopened. */
  readonly reopened: number;
  /** Of those, with ANY activity recorded, resolution or otherwise. */
  readonly withActivity: number;
};

export type UnresolvedBreakdown = {
  /** The headline: total − resolved. Never called "unresolved". */
  readonly noRecordedResolution: number;
  /** We have activity for it and it is not currently resolved. */
  readonly observedUnresolved: number;
  /** Nothing was recorded at all. We do not know. */
  readonly noActivityRecord: number;
  /** Share of the scope we have any record for. Null when the scope is empty. */
  readonly coveragePercent: number | null;
};

export function breakdownOf(counts: UnresolvedCounts): UnresolvedBreakdown {
  const total = Math.max(0, Math.trunc(counts.total));
  // Clamped to the scope: a resolved count larger than the total would be a
  // query bug, and it must not produce a negative headline.
  const resolved = Math.min(total, Math.max(0, Math.trunc(counts.resolved)));
  const withActivity = Math.min(total, Math.max(0, Math.trunc(counts.withActivity)));

  return {
    noRecordedResolution: total - resolved,
    observedUnresolved: Math.max(0, withActivity - resolved),
    noActivityRecord: total - withActivity,
    coveragePercent: total === 0 ? null : Math.round((withActivity / total) * 1000) / 10,
  };
}
