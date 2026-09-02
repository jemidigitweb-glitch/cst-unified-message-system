import "server-only";

/**
 * Read-only lookup of a listing's bundle composition.
 *
 * STRICTLY READ-ONLY. Every statement here is a SELECT against the source pool,
 * which the caller pins `default_transaction_read_only=on` for — see
 * `getSourcePool()`. Same discipline as `order-context-repository.ts`,
 * `ebay-image-repository.ts` and `sot-product-repository.ts`.
 *
 * WHERE THE COMPOSITION COMES FROM, AND WHY IT IS NOT A GUESS.
 * `order_management.order_combo` is written by the order system when a combo
 * line is picked: one row per component, keyed by `order_item_info_id`. It is
 * the table `lib/domain/sku.ts` already names as the place components "are
 * already decomposed upstream", which is why that module forbids parsing a SKU.
 *
 * The proof that it is authoritative rather than derivable: one real listing
 * carries child SKUs `ENC8740` and `ENC8742`, and `order_combo` decomposes each
 * into FOUR components including a bulb. No amount of reading the string
 * "ENC8740" yields that. 2,013,392 combo rows across 1,194,298 order lines.
 *
 * NOTHING IS SPLIT, NORMALISED OR RECONSTRUCTED. Component SKUs are read from
 * `order_combo.sku`; listing SKUs are matched with `=` and `= ANY(...)`, never
 * `upper`, `btrim`, `like` or a split on `+`. See `lib/domain/sku.ts`.
 *
 * `real_sku` IS DELIBERATELY NOT USED. It carries warehouse suffixes — the same
 * bundle appears as `CRSF100CH+PHCHPCRCH+LSMS320GY` in `item_sku` and
 * `...-DE` in `real_sku` — so keying on it would fragment one bundle into
 * several. The join is on `item_sku`, which is the listing's own value.
 *
 * COLUMNS DELIBERATELY NOT READ: `order_combo.qty`, `.color`, `.image`,
 * `order_item_info.item_price`, `.item_quantity`. `qty` in particular is what
 * one customer ORDERED — observed as 0, 1 and 2 for the same bundle — and is not
 * the bundle's composition. Reading it at all invites stating it.
 *
 * INTERPRETS NOTHING. Stability, common components and variant agreement are the
 * caller's decisions; this returns the rows and lets
 * `lib/context/resolve-bundle-product-context.ts` be the single place policy
 * lives and the single place a test has to look.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * The listing's per-option SKUs.
 *
 * `is_child = 1` ONLY, and that is not a detail. A listing's parent row is a
 * representative, and on 4,752 of 31,100 parent rows its `sku` is the literal
 * placeholder "sku not assigneds" — a string that is not a SKU and must never be
 * looked up as one. The child rows carry the SKUs that were actually sold.
 */
const FIND_VARIANT_SKUS = `
SELECT DISTINCT el.sku AS sku
FROM listings.ebay_listings el
WHERE el.item_id = $1
  AND el.sub_source = $2::int
  AND el.is_child = 1
  AND el.sku IS NOT NULL
  AND btrim(el.sku) <> ''`;

/**
 * Every recorded decomposition of these listing SKUs, one row per component per
 * order line.
 *
 * The line id travels so the caller can tell "this SKU decomposed the same way
 * 378 times" from "this SKU decomposed two different ways" — a distinction that
 * decides whether the bundle may be used at all. Both sides of the join are
 * indexed (`oii_item_sku_idx`, `order_combo_order_item_info_id_idx`); measured
 * at 47 ms for a listing with 17 variants and 5,012 component rows.
 */
const FIND_DECOMPOSITIONS = `
SELECT oii.item_sku AS variant_sku,
       oii.id::text  AS line_id,
       oc.sku        AS component_sku
FROM order_management.order_item_info oii
JOIN order_management.order_combo oc ON oc.order_item_info_id = oii.id
WHERE oii.item_sku = ANY($1::text[])`;

/**
 * Whitelisted attributes for a set of component SKUs.
 *
 * Same shape and same blocked-pattern contract as `sot-product-repository.ts`:
 * the commercial, channel and system columns never leave the database.
 */
const FIND_COMPONENT_ATTRIBUTES = `
SELECT s.sku      AS sku,
       a.key      AS attribute_key,
       v.value    AS value
FROM configurator.components_sot_skus s
JOIN configurator.components_sot_attribute_values v ON v.sot_sku_id = s.id
JOIN configurator.components_sot_attributes a ON a.id = v.attribute_id
WHERE s.sku = ANY($1::text[])
  AND a.key !~* ALL($2::text[])
ORDER BY s.sku, a.sort_order, a.id`;

/** Component names, for a block a reviewer can read. Title only — never price or stock. */
const FIND_COMPONENT_TITLES = `
SELECT DISTINCT ON (p.sku) p.sku AS sku, p.title AS title
FROM inventory.products p
WHERE p.sku = ANY($1::text[])
ORDER BY p.sku, p.id`;

export type DecompositionRow = {
  readonly variantSku: string;
  readonly lineId: string;
  readonly componentSku: string;
};

export type ComponentAttributeRow = {
  readonly sku: string;
  readonly key: string;
  readonly value: string | null;
};

/** The listing's child SKUs, exactly as stored. Empty when it is not a variation listing. */
export async function findVariantSkus(
  client: Queryable,
  options: { readonly itemId: string; readonly subSourceId: number },
): Promise<string[]> {
  const { rows } = await client.query({
    text: FIND_VARIANT_SKUS,
    values: [options.itemId, options.subSourceId],
  });
  return (rows as { sku: string }[]).map((row) => row.sku);
}

/** Every recorded component of these SKUs. Empty when none has ever been sold. */
export async function findDecompositions(
  client: Queryable,
  variantSkus: readonly string[],
): Promise<DecompositionRow[]> {
  if (variantSkus.length === 0) return [];
  const { rows } = await client.query({
    text: FIND_DECOMPOSITIONS,
    values: [[...variantSkus]],
  });
  return (rows as { variant_sku: string; line_id: string; component_sku: string }[]).map((row) => ({
    variantSku: row.variant_sku,
    lineId: row.line_id,
    componentSku: row.component_sku,
  }));
}

/** Permitted attributes for these components, values exactly as stored. */
export async function findComponentAttributes(
  client: Queryable,
  options: {
    readonly componentSkus: readonly string[];
    readonly blockedKeyPatterns: readonly string[];
  },
): Promise<ComponentAttributeRow[]> {
  if (options.componentSkus.length === 0 || options.blockedKeyPatterns.length === 0) return [];
  const { rows } = await client.query({
    text: FIND_COMPONENT_ATTRIBUTES,
    values: [[...options.componentSkus], [...options.blockedKeyPatterns]],
  });
  return (rows as { sku: string; attribute_key: string; value: string | null }[]).map((row) => ({
    sku: row.sku,
    key: row.attribute_key,
    value: row.value,
  }));
}

/** Product-master titles for these components. Missing components simply do not appear. */
export async function findComponentTitles(
  client: Queryable,
  componentSkus: readonly string[],
): Promise<Map<string, string>> {
  if (componentSkus.length === 0) return new Map();
  const { rows } = await client.query({
    text: FIND_COMPONENT_TITLES,
    values: [[...componentSkus]],
  });
  return new Map(
    (rows as { sku: string; title: string | null }[])
      .filter((row) => row.title !== null && row.title.trim() !== "")
      .map((row) => [row.sku, row.title!.trim()]),
  );
}
