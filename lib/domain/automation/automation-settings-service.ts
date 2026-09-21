import type { AutomationSettings, AutomationSettingsPatch } from "./automation-types";

/**
 * Whether a scan may run at all, decided before a single source row is read.
 *
 * PURE. No database, no network. Every reason is a configuration fact.
 *
 * `not_before` IS THE ONE THAT MATTERS, and it is why this file exists rather
 * than an `if (enabled)` at the call site. The source holds 600,914 shipments
 * with a recorded dispatch time. Every one of them is older than
 * `dispatched_at + 24h`, so a scan without a floor would discover all of them,
 * find all of them immediately due, and process a message for every order this
 * business has ever shipped. An unset floor is therefore a refusal, not a
 * default of "everything".
 */

export type ScanRefusal = { readonly reason: string; readonly code: ScanRefusalCode };

export const SCAN_REFUSAL_CODES = [
  "automation_disabled",
  "not_before_unset",
  "no_sub_sources_enabled",
  "no_template_selected",
  "time_zone_unset",
] as const;

export type ScanRefusalCode = (typeof SCAN_REFUSAL_CODES)[number];

/**
 * The reason a scan must not run, or null when it may.
 *
 * Ordered so the answer is the most useful one: an operator who has not turned
 * the automation on is told that, not that their storefront list is empty.
 */
export function scanRefusal(settings: AutomationSettings): ScanRefusal | null {
  if (!settings.enabled) {
    return {
      code: "automation_disabled",
      reason: "Post-dispatch automation is switched off.",
    };
  }
  if (settings.notBefore === null || settings.notBefore.trim() === "") {
    return {
      code: "not_before_unset",
      reason:
        "No earliest dispatch date is configured, so the scan refuses to run: " +
        "without one it would process every shipment ever dispatched.",
    };
  }
  if (settings.enabledSubSources.length === 0) {
    return {
      code: "no_sub_sources_enabled",
      reason: "No storefront is enabled for post-dispatch automation.",
    };
  }
  if (settings.templateId === null) {
    return {
      code: "no_template_selected",
      reason: "No message template is selected, so there is nothing to process.",
    };
  }
  if (settings.dispatchTimeZone.trim() === "") {
    return {
      code: "time_zone_unset",
      reason:
        "No dispatch time zone is configured. Source dispatch times are stored " +
        "without a zone and must not be assumed to be UTC.",
    };
  }
  return null;
}

/** Whether a scan may run. The reason is what callers should report. */
export function mayScan(settings: AutomationSettings): boolean {
  return scanRefusal(settings) === null;
}

/**
 * Whether an administrator's change may be applied.
 *
 * PURE, and it exists for one specific mistake: switching the automation on
 * with no earliest dispatch date set. That single click would schedule a record
 * for every shipment in the source — all of them already past
 * `dispatched_at + 24h`, so all of them immediately due. The scan refuses that
 * state anyway, but refusing to ENTER it is better than refusing to act on it:
 * an operator who sees "on" should not have to read a second panel to learn it
 * is not actually running.
 *
 * LEAVING TEST MODE IS REFUSED OUTRIGHT. There is no transport in this phase,
 * so `testMode: false` cannot describe anything this application can do; the
 * database refuses to record a non-test `sent` row, and this refuses to let an
 * operator reach a state where every record would simply fail.
 */
export function settingsPatchRefusal(
  current: AutomationSettings,
  patch: AutomationSettingsPatch,
): string | null {
  if (patch.testMode === false) {
    return (
      "Test mode cannot be switched off: this phase has no marketplace transport, " +
      "so there is nothing for a live run to do."
    );
  }

  const notBefore = patch.notBefore === undefined ? current.notBefore : patch.notBefore;
  const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
  const subSources =
    patch.enabledSubSources === undefined ? current.enabledSubSources : patch.enabledSubSources;
  const templateId = patch.templateId === undefined ? current.templateId : patch.templateId;

  if (!enabled) return null;

  if (notBefore === null || notBefore.trim() === "") {
    return (
      "Set an earliest dispatch date before switching this on. Without one the next " +
      "scan would process every shipment ever dispatched."
    );
  }
  if (subSources.length === 0) {
    return "Choose at least one storefront before switching this on.";
  }
  if (templateId === null) {
    return "Choose a message template before switching this on.";
  }
  return null;
}
