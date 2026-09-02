import "server-only";

/**
 * Read-only SOT (source-of-truth) product attribute lookup for one eBay listing.
 *
 * STRICTLY READ-ONLY. Both statements here are SELECTs against the source pool,
 * which the caller pins `default_transaction_read_only=on` for — see
 * `getSourcePool()`. Same discipline as `order-context-repository.ts` and
 * `ebay-image-repository.ts`.
 *
 * WHAT SOT IS. `configurator.components_sot_*` is a three-table EAV mirror of a
 * Google Sheet: 1,001 SKUs across three tabs (lampshade, ceilingrose, bulb), 413
 * attribute keys, one row per (sku, attribute) pair. `components_sot_skus`
 * carries `sheet_gid`/`sheet_row`/`synced_at`, which is what makes it a mirror
 * rather than a system of record.
 *
 * THE PARENT ROW IS THE WHOLE SAFETY ARGUMENT. `item_id` is NOT 1:1 with a SKU:
 * a multi-variation listing stores one row per SKU-variant under the same
 * item_id, and 28,841 of 31,153 distinct item_ids (92.6%) carry more than one —
 * one observed live with 246. Joining on item_id alone would fan out into
 * hundreds of variants with no way to know which the customer means.
 * `is_parent = 1` picks the single representative row every listing has
 * (31,100 rows across 31,097 distinct item_ids), exactly as
 * `findProductListingImages` already does for the listing's photo gallery.
 *
 * A handful of item_ids nevertheless carry more than one parent row, so this
 * counts the DISTINCT SKUs it found and reports ambiguity rather than picking
 * one. See `findSotProductForListing`.
 *
 * SKUs ARE NEVER NORMALISED. The SOT match is `s.sku = $1` — exact,
 * case-sensitive, byte-for-byte, per `lib/domain/sku.ts`. There is no upper(),
 * no btrim(), no case-fold and no splitting on `+` anywhere in the match. This
 * loses nothing: measured live, matching SOT against eBay listing SKUs finds
 * 647 either way, so normalisation would buy zero extra rows and cost the
 * guarantee. A combo SKU (`PSHYOS4BRBM+SPUPBM+LSDO210BM`) is one opaque
 * identifier here like any other — it either has a SOT row under that exact
 * string or it does not.
 *
 * The `btrim(...) <> ''` in the first statement is a PREDICATE, not a
 * transformation: it excludes whitespace-only SKUs from consideration. The
 * value this returns is `el.sku` exactly as stored.
 *
 * WHICH ATTRIBUTES ARE READ IS THE CALLER'S DECISION. `blockedKeyPatterns` is
 * parameterised rather than fixed here, so the policy about what may be told to
 * a customer lives in one place — see `lib/context/resolve-sot-product-context.ts`.
 * This module reads faithfully and interprets nothing: `[VERIFY]` sentinels and
 * empty values come back as they are stored, for the caller to reject.
 *
 * THE PATTERNS ARE A BOUND, NOT THE POLICY. Applying them in SQL keeps the
 * commercial columns out of this process entirely rather than reading them and
 * discarding them afterwards. The caller applies the same patterns again to the
 * rows it gets back, because a filter that exists only in a query is a filter
 * that cannot be unit-tested.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/** One stored SOT attribute, exactly as the sheet holds it. */
export type SotAttribute = {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
};

/** The single SOT record a listing resolved to, and when it was last synced. */
export type SotProduct = {
  /** The exact SKU string, as stored on the listing and matched in SOT. */
  readonly sku: string;
  /** `components_sot_skus.synced_at` — this is a sheet mirror, so age matters. */
  readonly syncedAt: string | null;
  /** Which sheet tab the row came from (lampshade / ceilingrose / bulb). */
  readonly sourceTab: string | null;
  readonly attributes: readonly SotAttribute[];
};

/**
 * The parent listing row's own SKU, for one item on one storefront.
 *
 * `DISTINCT` so that a listing with duplicate parent rows carrying the SAME sku
 * reads as one answer rather than two — while genuinely different SKUs still
 * come back as several rows and are refused upstream.
 */
const FIND_PARENT_SKU = `
SELECT DISTINCT el.sku AS sku
FROM listings.ebay_listings el
WHERE el.item_id = $1
  AND el.sub_source = $2::int
  AND el.is_parent = 1
  AND el.sku IS NOT NULL
  AND btrim(el.sku) <> ''`;

/**
 * Every permitted attribute for one exact SKU.
 *
 * `s.sku = $1` is the exact match described in the module doc.
 *
 * `a.key !~* ALL($2)` is "matches NONE of the caller's blocked patterns" — the
 * commercial, channel and system columns never leave the database. Case
 * insensitive (`!~*`) because a sheet header's capitalisation is not policy.
 * An empty pattern array admits everything, which is why the caller must not
 * pass one and this function refuses it.
 *
 * `s.id` travels with each row so the caller can prove the rows belong to ONE
 * SOT record. `components_sot_skus.sku` is unique today (1,001 rows, 1,001
 * distinct SKUs) but this does not depend on that holding.
 *
 * Ordered by `a.sort_order` so the attributes read in the sheet's own order,
 * which is the order a human curating them chose.
 */
const FIND_SOT_ATTRIBUTES = `
SELECT s.id::text        AS sot_sku_id,
       s.sku             AS sku,
       s.source_tab      AS source_tab,
       s.synced_at::text AS synced_at,
       a.key             AS attribute_key,
       a.label           AS attribute_label,
       v.value           AS value
FROM configurator.components_sot_skus s
JOIN configurator.components_sot_attribute_values v ON v.sot_sku_id = s.id
JOIN configurator.components_sot_attributes a ON a.id = v.attribute_id
WHERE s.sku = $1
  AND a.key !~* ALL($2::text[])
ORDER BY a.sort_order, a.id`;

type ParentSkuRow = { sku: string };

type SotAttributeRow = {
  sot_sku_id: string;
  sku: string;
  source_tab: string | null;
  synced_at: string | null;
  attribute_key: string;
  attribute_label: string;
  value: string | null;
};

/**
 * The one SOT product record this listing resolves to, or null.
 *
 * NULL IS THE ORDINARY ANSWER and it is deliberately indistinguishable between
 * causes, because the caller does the same thing in every one of them:
 *
 *   - no parent listing row for this item on this storefront
 *   - a parent row carrying no SKU
 *   - MORE THAN ONE distinct parent SKU (never picks one)
 *   - no SOT row under that exact SKU (the common case — SOT holds 1,001 SKUs
 *     against 47,951 distinct eBay listing SKUs)
 *   - SOT rows spanning more than one `components_sot_skus.id` (never picks one)
 *
 * Two round trips rather than one join, on purpose: the first result is the
 * thing that has to be counted before anything else is fetched, and a single
 * query would have to return the fan-out in order to let the caller count it.
 */
export async function findSotProductForListing(
  client: Queryable,
  options: {
    readonly itemId: string;
    readonly subSourceId: number;
    /** Key patterns that must NOT reach a draft. Never empty — see the module doc. */
    readonly blockedKeyPatterns: readonly string[];
  },
): Promise<SotProduct | null> {
  // An empty list would mean "block nothing", which reads as a caller mistake
  // rather than an intention. Refusing is safer than admitting every column.
  if (options.blockedKeyPatterns.length === 0) return null;

  const parentResult = await client.query({
    text: FIND_PARENT_SKU,
    values: [options.itemId, options.subSourceId],
  });
  const parentRows = parentResult.rows as ParentSkuRow[];
  // Zero means no parent row; more than one means the listing has several and
  // choosing between them would be a guess.
  if (parentRows.length !== 1) return null;

  const sku = parentRows[0]!.sku;

  const attributeResult = await client.query({
    text: FIND_SOT_ATTRIBUTES,
    values: [sku, [...options.blockedKeyPatterns]],
  });
  const rows = attributeResult.rows as SotAttributeRow[];
  if (rows.length === 0) return null;

  const distinctRecords = new Set(rows.map((row) => row.sot_sku_id));
  if (distinctRecords.size !== 1) return null;

  const first = rows[0]!;
  return {
    // The SOT row's own sku, not the listing's — they are equal by the WHERE
    // clause, and returning the matched row's value keeps the record internally
    // consistent if that ever stops being true.
    sku: first.sku,
    syncedAt: first.synced_at,
    sourceTab: first.source_tab,
    attributes: rows.map((row) => ({
      key: row.attribute_key,
      label: row.attribute_label,
      value: row.value,
    })),
  };
}
