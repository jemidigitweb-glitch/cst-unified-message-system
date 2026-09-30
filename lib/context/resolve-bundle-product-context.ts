import "server-only";

import type { BundleAttribute, BundleComponent, BundleContext } from "@/lib/domain/bundle-context";
import {
  type Queryable as SourceQueryable,
  findComponentAttributes,
  findComponentTitles,
  findDecompositions,
  findVariantSkus,
} from "@/lib/repositories/bundle-repository";
import {
  BLOCKED_SOT_ATTRIBUTE_PATTERNS,
  sotAttributeIsStatable,
  statableValue,
} from "./resolve-sot-product-context";

/**
 * Verified product context for a listing sold as a BUNDLE.
 *
 * WHAT PROBLEM THIS SOLVES. The single-SKU resolver answers from the listing's
 * parent row, and on a bundle listing that row is useless: measured live, 4,752
 * of 31,100 parent rows carry the placeholder "sku not assigneds" and 1,085
 * carry a combo SKU that no product sheet indexes. Two real pre-sale
 * conversations were traced to exactly that — the customer asked what the
 * package contains, the system held nothing, and the draft asked them for their
 * voltage. The components ARE described; only the bundle as a whole is not.
 *
 * IT NEVER SPLITS A SKU. Components come from `order_management.order_combo`,
 * which the order system writes when it picks a combo line — see
 * `lib/repositories/bundle-repository.ts` and `lib/domain/sku.ts`. A combo SKU
 * is one opaque identifier here as everywhere else.
 *
 * IT NEVER IDENTIFIES A VARIANT, AND DOES NOT NEED TO. A pre-sale message
 * cannot say which colour the customer means, and guessing is the failure this
 * whole design exists to prevent. So nothing here picks one: it states what is
 * true of EVERY option. Two mechanisms, and both are exact:
 *
 *   common components   the same component SKU in every decomposable variant.
 *                       One real listing puts the same ceiling rose and the same
 *                       holder in all ten of its options.
 *   variant agreement   for the components that DO differ, only attributes on
 *                       which every variant yields one identical value. The
 *                       eight colours of one shade share every dimension, ring
 *                       size and bulb fitting; they differ only in colour, and
 *                       colour is dropped automatically because the variants
 *                       disagree about it.
 *
 * The agreement rule is self-correcting: an attribute the options disagree on
 * cannot survive it, so no rule about "colour is special" is needed and none is
 * written.
 *
 * READ-ONLY. Four SELECTs, no snapshot, no cache, no write anywhere.
 */

export type ConversationForBundleContext = {
  readonly marketplace: string;
  readonly subSourceId: number | null;
  readonly listingItemRef: string | null;
};

/**
 * Attributes that describe WHAT IS IN THE BOX.
 *
 * Suppressed entirely unless every component has a product record, and that is
 * the sharpest safety rule in this file. On the listing that motivated it, the
 * shade's own `parts_list` reads "Lampshade, Reducer Ring" — true of the shade,
 * and catastrophic as an answer to "what does this come with", because the
 * bundle also contains a ceiling rose, an E27 holder and, on two options, a
 * bulb. A partial contents list is worse than none: it reads complete.
 */
const INCLUSION_ATTRIBUTES: ReadonlySet<string> = new Set([
  "parts_list",
  "fixings_incl",
  "instructions_incl",
  "tools_required",
  "qty_per_pack",
  "pack_qty",
]);

/** Deterministic, so the same listing always renders the same way. */
const bySku = (a: { sku: string }, b: { sku: string }): number => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);

/**
 * Component SKU -> attribute key -> the value this may state.
 *
 * ONE PLACE APPLIES THE POLICY, and both entry points below go through it. The
 * listing-keyed resolver and the ordered-SKU resolver must agree about what a
 * component's record says — if they could drift, a post-sale draft and a
 * pre-sale draft could describe the same physical part differently, and only
 * one of them would be right.
 *
 * The database already excluded the blocked patterns; re-applying them here is
 * deliberate, so this gives the same answer whether or not the query filtered
 * first. Same reasoning as `resolveSotProductContext`.
 */
async function statableComponentAttributes(
  sourceClient: SourceQueryable,
  componentSkus: readonly string[],
): Promise<Map<string, Map<string, string>>> {
  const rows = await findComponentAttributes(sourceClient, {
    componentSkus,
    blockedKeyPatterns: BLOCKED_SOT_ATTRIBUTE_PATTERNS,
  });

  const attributes = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (!sotAttributeIsStatable(row.key)) continue;
    const value = statableValue(row.value);
    if (value === null) continue;
    const forSku = attributes.get(row.sku) ?? new Map<string, string>();
    forSku.set(row.key, value);
    attributes.set(row.sku, forSku);
  }
  return attributes;
}

/**
 * The one decomposition this SKU always had, or null when its history disagrees.
 *
 * 2,438 of 19,868 decomposable eBay listing SKUs (12.3%) decompose differently
 * across orders — a bundle whose contents changed, or a mis-picked line. Those
 * are dropped rather than reconciled: this layer has no way to know which
 * version is current, and averaging two answers produces a third that was never
 * true.
 */
function stableComponents(lines: Map<string, Set<string>>): string[] | null {
  const shapes = new Set<string>();
  let first: string[] | null = null;
  for (const components of lines.values()) {
    const sorted = [...components].sort();
    shapes.add(JSON.stringify(sorted));
    first ??= sorted;
  }
  return shapes.size === 1 ? first : null;
}

/**
 * The verified product context for a bundle listing, or null.
 *
 * Null for every case that is not a clean answer, and the causes are not
 * distinguished because the caller does the same thing in all of them: a
 * non-eBay conversation, no sub-account or item reference, a listing with no
 * child rows, no variant with any order history, every variant's history
 * self-contradicting, or no component with a product record at all.
 */
export async function resolveBundleProductContext(
  sourceClient: SourceQueryable,
  conversation: ConversationForBundleContext,
): Promise<BundleContext | null> {
  if (conversation.marketplace !== "ebay") return null;
  if (conversation.subSourceId === null) return null;
  const itemRef = conversation.listingItemRef;
  if (itemRef === null || itemRef.trim() === "") return null;

  const variantSkus = await findVariantSkus(sourceClient, {
    itemId: itemRef,
    subSourceId: conversation.subSourceId,
  });
  if (variantSkus.length === 0) return null;

  const rows = await findDecompositions(sourceClient, variantSkus);
  if (rows.length === 0) return null;

  // variant -> order line -> the components that line recorded
  const byVariant = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    const lines = byVariant.get(row.variantSku) ?? new Map<string, Set<string>>();
    const components = lines.get(row.lineId) ?? new Set<string>();
    components.add(row.componentSku);
    lines.set(row.lineId, components);
    byVariant.set(row.variantSku, lines);
  }

  const stable = new Map<string, string[]>();
  for (const [variant, lines] of byVariant) {
    const components = stableComponents(lines);
    if (components !== null) stable.set(variant, components);
  }
  if (stable.size === 0) return null;

  const variantSets = [...stable.values()];
  const commonSkus = variantSets
    .slice(1)
    .reduce(
      (shared, components) => shared.filter((sku) => components.includes(sku)),
      [...variantSets[0]!],
    )
    .sort();

  const allComponents = [...new Set(variantSets.flat())].sort();

  const [attributes, titles] = await Promise.all([
    statableComponentAttributes(sourceClient, allComponents),
    findComponentTitles(sourceClient, allComponents),
  ]);

  const componentsWithoutRecord = allComponents.filter((sku) => !attributes.has(sku));
  const complete = componentsWithoutRecord.length === 0;
  const permitted = (key: string): boolean => complete || !INCLUSION_ATTRIBUTES.has(key);

  const common: BundleComponent[] = commonSkus
    .map((sku) => ({
      sku,
      title: titles.get(sku) ?? null,
      attributes: [...(attributes.get(sku) ?? new Map<string, string>())]
        .filter(([key]) => permitted(key))
        .map(([key, value]) => ({ key, value })),
    }))
    .sort(bySku);

  /**
   * Attributes every variant's DIFFERING components agree on.
   *
   * A key survives only when each variant produces exactly one value for it —
   * so a variant whose varying part holds two components that both define the
   * key is a disagreement within that variant and disqualifies the key — and
   * when every variant produced the same value. That single rule handles the
   * colour case (eight values, dropped), the "with bulb" case (an option whose
   * varying part adds a second product, so `product_type` disagrees and is
   * dropped) and the shared-dimension case, with nothing said about any of them.
   */
  // One entry per variant. `null` means that variant's varying components
  // disagreed with each other about this key, which disqualifies it outright.
  const perVariantValues = new Map<string, (string | null)[]>();
  for (const components of variantSets) {
    const varying = components.filter((sku) => !commonSkus.includes(sku));
    const seen = new Map<string, Set<string>>();
    for (const sku of varying) {
      for (const [key, value] of attributes.get(sku) ?? []) {
        const values = seen.get(key) ?? new Set<string>();
        values.add(value);
        seen.set(key, values);
      }
    }
    for (const [key, values] of seen) {
      const collected = perVariantValues.get(key) ?? [];
      // More than one value inside a single variant is itself a disagreement.
      collected.push(values.size === 1 ? [...values][0]! : null);
      perVariantValues.set(key, collected);
    }
  }

  const varyingAgreement: BundleAttribute[] = [...perVariantValues]
    .filter(
      ([key, values]) =>
        permitted(key) &&
        values.length === variantSets.length &&
        new Set(values).size === 1 &&
        values[0] !== null,
    )
    .map(([key, values]) => ({ key, value: values[0]! }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // A bundle nobody can say anything about is not context; it is a heading.
  if (common.every((component) => component.attributes.length === 0) && varyingAgreement.length === 0) {
    return null;
  }

  return {
    listingItemRef: itemRef,
    // Resolved from the listing, so nothing here knows which variant was bought.
    orderedSku: null,
    variantCount: stable.size,
    common,
    varyingAgreement,
    complete,
    componentsWithoutRecord,
  };
}

/**
 * The components of the SKU the customer ACTUALLY BOUGHT.
 *
 * WHY THIS EXISTS SEPARATELY, AND WHAT IT FIXES. `resolveBundleProductContext`
 * above enters the decomposition through the LISTING, because on a pre-sale
 * enquiry that is all there is. Where an order resolved, that is the wrong door
 * and it was measured costing real answers:
 *
 *   * `resolveSotProductContextForSku` matches the ordered SKU against the
 *     product sheet EXACTLY, and a sellable SKU usually has no sheet row of its
 *     own. Measured over the live conversations: 252 distinct ordered SKUs, 29
 *     with a sheet row — but 117 whose `order_combo` components have one. The
 *     catalogue held the answer for 88 more products than anything reached.
 *   * The listing-keyed fallback then answers about the listing's OTHER
 *     options. On one traced conversation the ordered SKU decomposed — stably,
 *     over 20 order lines — into four components with 74, 43, 58 and 63
 *     statable attributes each, every one of them recorded. The listing's three
 *     variants included a component with no record, so `complete` came out
 *     false and `parts_list` was suppressed — on a customer asking what was in
 *     their box. The gap was in a variant they had not bought.
 *
 * SO THE ORDER'S OWN SKU IS THE KEY. There is exactly one product, the order
 * named it, `order_combo` says what is in it, and completeness is computed over
 * THOSE components and no others.
 *
 * NOTHING IS SPLIT, AND THAT IS THE WHOLE POINT OF GOING THROUGH THIS TABLE.
 * The SKU travels to `findDecompositions` whole, as one element of a one-element
 * array, and is matched with `=`. `PSHYOS4BRBM+SPUPBM+SLDO210BM` is one opaque
 * identifier here as everywhere else — see `lib/domain/sku.ts`. Its components
 * come from what the order system recorded when it picked the line, never from
 * reading the string.
 *
 * ONE "VARIANT", SO NOTHING IS INTERSECTED AWAY. Every component is common,
 * because there is only one option in play; `varyingAgreement` is therefore
 * empty by construction rather than by filtering. The colour rule the listing
 * path needs does not arise: the order settled which colour this is.
 *
 * REFUSES RATHER THAN GUESSES, on the same rules as the listing path: no
 * recorded decomposition, a decomposition that disagrees with itself across
 * order lines (12.3% of decomposable SKUs), or no component with a product
 * record all return null. The caller then has no bundle, exactly as before.
 *
 * READ-ONLY. Two SELECTs, no snapshot, no cache, no write anywhere.
 */
export async function resolveBundleProductContextForSku(
  sourceClient: SourceQueryable,
  sku: string,
): Promise<BundleContext | null> {
  if (sku.trim() === "") return null;

  const rows = await findDecompositions(sourceClient, [sku]);
  if (rows.length === 0) return null;

  /**
   * Only this SKU's own lines, and the filter is not redundant.
   *
   * `FIND_DECOMPOSITIONS` is keyed `oii.item_sku = ANY($1)` and this passes one
   * element, so today every row already belongs to this SKU. The filter states
   * the invariant the rest of the function depends on: a component reaches a
   * customer's draft only because THEIR order line recorded it. If that query
   * is ever widened for another caller, this refuses the extra rows instead of
   * quietly describing somebody else's product.
   */
  const lines = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.variantSku !== sku) continue;
    const components = lines.get(row.lineId) ?? new Set<string>();
    components.add(row.componentSku);
    lines.set(row.lineId, components);
  }
  if (lines.size === 0) return null;

  // The same rule the listing path applies per variant: a SKU whose order
  // history decomposes two different ways is not one this can answer from.
  const components = stableComponents(lines);
  if (components === null) return null;

  const [attributes, titles] = await Promise.all([
    statableComponentAttributes(sourceClient, components),
    findComponentTitles(sourceClient, components),
  ]);

  const componentsWithoutRecord = components.filter((componentSku) => !attributes.has(componentSku));
  const complete = componentsWithoutRecord.length === 0;

  const common: BundleComponent[] = components
    .map((componentSku) => ({
      sku: componentSku,
      title: titles.get(componentSku) ?? null,
      attributes: [...(attributes.get(componentSku) ?? new Map<string, string>())]
        // Package contents stay suppressed unless EVERY component of THIS
        // product is described. The rule is unchanged; only the set it is
        // computed over is now the right one.
        .filter(([key]) => complete || !INCLUSION_ATTRIBUTES.has(key))
        .map(([key, value]) => ({ key, value })),
    }))
    .sort(bySku);

  // A bundle nobody can say anything about is not context; it is a heading.
  if (common.every((component) => component.attributes.length === 0)) return null;

  return {
    // Resolved from the order, not the listing. The message's listing is still
    // on the request as `listingItemRef`; it is not the provenance of these.
    listingItemRef: null,
    orderedSku: sku,
    variantCount: 1,
    common,
    // Nothing varies: one order line, one set of components.
    varyingAgreement: [],
    complete,
    componentsWithoutRecord,
  };
}
