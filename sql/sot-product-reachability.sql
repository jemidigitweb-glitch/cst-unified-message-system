-- =============================================================================
-- SOT product catalogue: reachability and attribute coverage
-- =============================================================================
--
-- Approved read-only inspection SQL. Every statement here is a SELECT against
-- the marketplace source database, matching the discipline in
-- `sql/2026-09-08-sql-status.md`. Nothing here writes, and nothing here is
-- application code -- the queries the application runs live beside their
-- repository functions in `lib/repositories/sot-product-repository.ts` and
-- `lib/repositories/bundle-repository.ts`.
--
-- WHY THIS FILE EXISTS. A pre-sale draft answered "I'll check the exact weight
-- and come back to you" to a customer asking a lampshade's weight, and the
-- report assumed the catalogue held the weight and the drafting layer had
-- failed to use it. Both halves needed measuring rather than reasoning about.
-- These are the queries that settled it, so the next such question starts from
-- here instead of from zero.
--
-- WHAT THEY ESTABLISHED (2026-09-09):
--
--   * No usable weight exists for ANY product. `weight_g` is NULL on 1,155 of
--     1,824 SOT SKUs and the `[VERIFY]` sentinel on the other 669.
--   * The parent-listing route into the catalogue reaches 308 of 31,155 parent
--     listings (1.0%); the component route reaches 19,319 (62%).
--   * 4,768 parent listing rows carry the literal placeholder "sku not
--     assigneds", which is non-empty and therefore reaches the SOT lookup as
--     though it were a SKU.
--
-- NO CUSTOMER DATA. Every query returns catalogue and listing metadata, counts
-- and SKU strings. None reads a message, a buyer, an address or an order value,
-- and none should be extended to.
--
-- A NOTE ON `[VERIFY]`. The sheet's "not confirmed yet" marker is matched as a
-- SUBSTRING, never as the whole value: it appears embedded in otherwise-real
-- text (e.g. "Kitchen, Dining, Hallway [VERIFY]"), and an equality check would
-- pass those through as facts. `statableValue` in
-- `lib/context/resolve-sot-product-context.ts` uses the same rule; these
-- queries mirror it so a measurement here means what the resolver means.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Attribute coverage: which SOT attributes actually hold a usable value?
--
-- The `usable` column applies the resolver's own test -- not null, not blank,
-- not carrying the [VERIFY] marker. An attribute with rows but zero usable
-- values is present in the schema and absent in practice, which is the case
-- that misleads a reader of the column list.
--
-- Adjust the `a.key ~*` filter to the attribute family in question. As written
-- it answers the weight question.
-- -----------------------------------------------------------------------------
SELECT a.key,
       a.label,
       count(*) AS rows,
       count(*) FILTER (
         WHERE v.value IS NOT NULL
           AND btrim(v.value) <> ''
           AND v.value !~* '\[VERIFY\]'
       ) AS usable
FROM configurator.components_sot_attributes a
JOIN configurator.components_sot_attribute_values v ON v.attribute_id = a.id
WHERE a.key ~* 'weight|mass|gram|kg'
GROUP BY a.key, a.label
ORDER BY usable DESC, a.key;


-- -----------------------------------------------------------------------------
-- 2. What is actually stored in an attribute that reports zero usable values?
--
-- Distinguishes "nobody filled it in" (NULL) from "somebody marked it as needing
-- verification" ([VERIFY]). The distinction matters: the second means the sheet
-- owner knows the value is outstanding.
-- -----------------------------------------------------------------------------
SELECT coalesce(v.value, '<null>') AS stored_value,
       count(*) AS n
FROM configurator.components_sot_attributes a
JOIN configurator.components_sot_attribute_values v ON v.attribute_id = a.id
WHERE a.key = 'weight_g'
GROUP BY v.value
ORDER BY n DESC
LIMIT 20;


-- -----------------------------------------------------------------------------
-- 3. How big is the catalogue, and how is it organised?
--
-- Worth re-running before sizing any change: the module doc comments still
-- describe 1,001 SKUs across three tabs, and it has since grown to 1,824 across
-- six.
-- -----------------------------------------------------------------------------
SELECT source_tab, count(*) AS skus
FROM configurator.components_sot_skus
GROUP BY source_tab
ORDER BY skus DESC;


-- -----------------------------------------------------------------------------
-- 4. Parent-listing SKU health.
--
-- `findSotProductForListing` resolves through the `is_parent = 1` row's SKU.
-- This counts how many of those SKUs are placeholders or combo strings that no
-- catalogue indexes -- i.e. how much of the route is structurally dead before
-- any matching is attempted.
-- -----------------------------------------------------------------------------
SELECT count(*)                                          AS parent_rows,
       count(DISTINCT item_id)                           AS distinct_items,
       count(*) FILTER (WHERE sku ~* 'not assigned')     AS placeholder_sku,
       count(*) FILTER (WHERE sku LIKE '%+%')            AS combo_sku
FROM listings.ebay_listings
WHERE is_parent = 1;


-- -----------------------------------------------------------------------------
-- 5. THE REACHABILITY MEASUREMENT -- the one that changed the conclusion.
--
-- Two independent routes from a listing into the catalogue:
--
--   parent route     the is_parent row's own SKU, matched exactly.
--                    Used by `resolveSotProductContext`.
--   component route  the child SKUs, decomposed through `order_combo` into
--                    component SKUs, each matched exactly.
--                    Used by `resolveBundleProductContext`.
--
-- SKUs are matched with `=` throughout -- no upper(), no btrim(), no case-fold,
-- no split on '+'. That is deliberate and matches `lib/domain/sku.ts`; measured
-- live, normalisation buys zero extra rows and costs the atomicity guarantee.
--
-- Runs in well under a minute on the live schema, but it is a wide join over
-- ~1.19M order lines and ~2.01M combo rows -- run it deliberately, not in a
-- loop.
-- -----------------------------------------------------------------------------
SET statement_timeout = '60s';

WITH parent AS (
  SELECT DISTINCT item_id, sku
  FROM listings.ebay_listings
  WHERE is_parent = 1
    AND sku IS NOT NULL
    AND btrim(sku) <> ''
),
parent_hit AS (
  SELECT p.item_id
  FROM parent p
  WHERE EXISTS (
    SELECT 1 FROM configurator.components_sot_skus s WHERE s.sku = p.sku
  )
),
child_hit AS (
  SELECT DISTINCT el.item_id
  FROM listings.ebay_listings el
  JOIN order_management.order_item_info oii ON oii.item_sku = el.sku
  JOIN order_management.order_combo oc      ON oc.order_item_info_id = oii.id
  JOIN configurator.components_sot_skus s   ON s.sku = oc.sku
  WHERE el.is_child = 1
)
SELECT (SELECT count(*) FROM parent)     AS parent_listings,
       (SELECT count(*) FROM parent_hit) AS resolves_by_parent_sku,
       (SELECT count(*) FROM child_hit)  AS reachable_via_components,
       (SELECT count(*)
          FROM child_hit c
         WHERE NOT EXISTS (
           SELECT 1 FROM parent_hit p WHERE p.item_id = c.item_id
         ))                              AS gained_by_components;


-- -----------------------------------------------------------------------------
-- 6. Trace one listing end to end.
--
-- Given an eBay item_id and storefront, answers: what does the parent row carry,
-- what do the child rows carry, what do they decompose into, and which of those
-- components has a catalogue record? This is the query to run when someone
-- reports that a specific conversation got no product facts.
--
-- Parameterise in application use. Written with literals here because this file
-- is run by hand.
-- -----------------------------------------------------------------------------
WITH target AS (
  SELECT '306735062506'::text AS item_id, 24::int AS sub_source
)
SELECT el.is_parent,
       el.is_child,
       el.sku,
       el.selected_variations::text AS variations,
       EXISTS (
         SELECT 1 FROM configurator.components_sot_skus s WHERE s.sku = el.sku
       ) AS sku_in_sot
FROM listings.ebay_listings el, target t
WHERE el.item_id = t.item_id
  AND el.sub_source = t.sub_source
ORDER BY el.is_parent DESC, el.sku;


-- -----------------------------------------------------------------------------
-- 7. Variant agreement -- what a bundle listing may safely state.
--
-- `resolveBundleProductContext` states an attribute only where EVERY variant
-- yields one identical value. This shows which attributes survive that rule for
-- a given set of component SKUs and which are dropped, and it is the query to
-- run when a reviewer asks why a draft did not mention a dimension.
--
-- `distinct_values = 1` survives; anything higher is correctly withheld.
-- -----------------------------------------------------------------------------
SELECT a.key,
       count(DISTINCT v.value)                              AS distinct_values,
       string_agg(DISTINCT v.value, ' | ' ORDER BY v.value) AS values
FROM configurator.components_sot_skus s
JOIN configurator.components_sot_attribute_values v ON v.sot_sku_id = s.id
JOIN configurator.components_sot_attributes a       ON a.id = v.attribute_id
WHERE s.sku IN (
        'LSMCBESBRE', 'LSMCSPDRFL', 'LSMCSPFLMC', 'LSMCSPMSMC',
        'LSMCSPSQMC', 'LSMCSQWYBL', 'LSMCSQWYRE'
      )
  AND v.value IS NOT NULL
  AND btrim(v.value) <> ''
  AND v.value !~* '\[VERIFY\]'
GROUP BY a.key
ORDER BY distinct_values, a.key;
