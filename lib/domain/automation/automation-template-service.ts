import type { AutomationTemplate, DispatchEvent } from "./automation-types";

/**
 * Rendering a saved template. Pure: no database, no network, no model.
 *
 * SUBSTITUTION ONLY, AND ONLY FROM VERIFIED VALUES. Every `{{placeholder}}` is
 * replaced by a value copied from a source column, or the render FAILS. There
 * is no expression language, no conditional, no fallback text and no default —
 * a template is a fixed message with holes in it, and a hole this system cannot
 * fill honestly is a reason to stop, not a reason to improvise.
 *
 * WHY A MISSING VALUE FAILS RATHER THAN RENDERING BLANK. "Your order  has been
 * dispatched" and "Your order null has been dispatched" are both messages this
 * business would not send, and both would sail through a render that treated an
 * absent value as an empty string. `requiredVariables` names the ones that must
 * resolve; anything else in the body that does not resolve fails too, because a
 * literal `{{courier}}` reaching a customer is worse than either.
 *
 * NOTHING HERE SENDS ANYTHING. It returns a string.
 */

export type RenderResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly missing: readonly string[] };

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/**
 * The values a template may reference, built from one source read.
 *
 * EVERY VALUE COMES FROM A COLUMN. A column the source did not fill is absent
 * here — never an empty string, never "unknown", never a placeholder. The
 * customer's name is included because the message is addressed to them; their
 * email, address and phone are not, because a dispatch update needs none.
 */
export function templateVariables(
  event: DispatchEvent,
): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {};
  const add = (name: string, value: string | null) => {
    if (value !== null && value.trim() !== "") variables[name] = value.trim();
  };

  add("customer_name", event.customerName);
  add("order_number", event.orderNumber);
  add("marketplace", event.channel);
  add("storefront", event.subSourceName);
  add("dispatch_date", event.dispatchedAt);
  add("tracking_number", event.trackingNumber);
  add("courier", event.carrier);
  add("product_title", event.productTitle);
  add("sku", event.sku);

  return variables;
}

/**
 * Renders one template, or reports exactly which values were missing.
 *
 * The missing list is the union of unresolved `requiredVariables` and any
 * placeholder in the body that did not resolve, deduplicated and ordered so the
 * same failure reads the same way twice.
 */
export function renderTemplate(
  template: AutomationTemplate,
  variables: Readonly<Record<string, string>>,
): RenderResult {
  const missing = new Set<string>();

  for (const name of template.requiredVariables) {
    const value = variables[name];
    if (value === undefined || value.trim() === "") missing.add(name);
  }

  const body = template.bodyTemplate.replace(PLACEHOLDER, (whole, rawName: string) => {
    const name = rawName.toLowerCase();
    const value = variables[name];
    if (value === undefined || value.trim() === "") {
      missing.add(name);
      // Left in place deliberately: the render is about to be discarded, and a
      // half-substituted body must not look like a usable one.
      return whole;
    }
    return value;
  });

  if (missing.size > 0) return { ok: false, missing: [...missing].sort() };
  return { ok: true, body };
}

/** Whether a template may govern a record at all. */
export function templateIsUsable(template: AutomationTemplate): boolean {
  return template.approved && template.active;
}
