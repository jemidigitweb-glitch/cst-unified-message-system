-- =============================================================================
-- 2026-09-29-root-cause-vocabulary-measurement.sql
--
-- WHERE THE EIGHTEEN ROOT CAUSE LABELS CAME FROM.
--
-- CST has no access to the message application's own option list: it lives in
-- that application's UI, backed by a database this one holds no grant on. So the
-- vocabulary in `lib/domain/root-cause-vocabulary.ts` was MEASURED rather than
-- copied — every label offered on screen is one its agents have really chosen.
--
-- TARGET:  the read-only marketplace SOURCE (`ledsone`), schema
--          `customer_service`. SELECT ONLY. This is not a migration and must
--          never be run against the application database.
--
-- RE-RUN THIS when the list needs refreshing, and when it changes, BUMP
-- `ROOT_CAUSE_VOCABULARY_VERSION`. A row stamped with a version can be read
-- against the list that produced it; a list that changes without a bump makes
-- yesterday's rows unreadable.
--
-- HOW THE RESULT BECOMES THE LIST — three rules, applied by hand:
--
--   1. Case variants fold to one label. `Out of stock` (8 rows) is the same
--      thing as `OUT OF STOCK` (9,409): the writer validates case-insensitively
--      and stores verbatim. Keep the dominant spelling; offering both would
--      split one label across two chips.
--   2. Free prose is not an option. Rows holding a sentence rather than a label
--      are the OTHER flow working as designed. Leave them out.
--   3. Nothing is added. No label goes on the list that no agent has chosen.
--
-- Then order by `rows` descending — most-used nearest — and move `OTHER` to the
-- end, where an escape hatch belongs.
-- =============================================================================

SELECT root_cause,
       sum(n)   AS rows,
       count(*) AS tables_carrying_it
FROM (
  SELECT root_cause, count(*) AS n
    FROM customer_service.ebay_message_headers
   WHERE root_cause IS NOT NULL AND btrim(root_cause) <> ''
   GROUP BY 1
  UNION ALL
  SELECT root_cause, count(*)
    FROM customer_service.amazon_messages
   WHERE root_cause IS NOT NULL AND btrim(root_cause) <> ''
   GROUP BY 1
  UNION ALL
  SELECT root_cause, count(*)
    FROM customer_service.shopify_messages
   WHERE root_cause IS NOT NULL AND btrim(root_cause) <> ''
   GROUP BY 1
  UNION ALL
  SELECT root_cause, count(*)
    FROM customer_service.bandq_messages
   WHERE root_cause IS NOT NULL AND btrim(root_cause) <> ''
   GROUP BY 1
  UNION ALL
  SELECT root_cause, count(*)
    FROM customer_service.temu_messages
   WHERE root_cause IS NOT NULL AND btrim(root_cause) <> ''
   GROUP BY 1
) t
GROUP BY root_cause
ORDER BY rows DESC;

-- -----------------------------------------------------------------------------
-- THE RESULT ON 2026-09-29, which is what version 1 of the vocabulary encodes.
--
-- Eighteen labels, one of which (OTHER) is offered and never stored:
--
--   OUT OF STOCK           9,409   all 5 tables
--   OTHER                  7,028   all 5    -- offered, never stored; see below
--   LISTING_CONTENT        5,501   all 5
--   RETURN                 4,624   all 5
--   CUSTOMER_MISUSE        2,747   all 5
--   Charge Back            2,488   all 5
--   Delivery Issue         2,133   all 5    -- opens the courier levels
--   INVOICE                1,981   all 5
--   PRODUCT_QUALITY        1,823   all 5
--   Wrong Address          1,659   all 5
--   FULFILMENT_WAREHOUSE   1,651   all 5    -- opens the courier levels
--   FULFILMENT_CARRIER     1,616   all 5    -- opens the courier levels
--   MARKETPLACE_ADMIN      1,558   all 5
--   PRE_SALES_QUERY        1,373   all 5
--   PARTS MISSING            708   4 tables
--   DISCOUNT                 354   all 5
--   EBAY_RECALL               39   3 tables
--   TRANSFORMER_ISSUE         18   3 tables
--
-- Folded away by rule 1:  `Out of stock` (8), `Return` (1).
-- Left out by rule 2:     5 rows of an agent's own prose, 1 row each — the OTHER
--                         flow, which stores the explanation AS the root cause.
--
-- `OTHER` IS THE SECOND MOST RECORDED VALUE IN THE SOURCE and is nonetheless
-- placed last on screen. Put where frequency would put it, the escape hatch
-- sits beside the answer as the easy way out of thinking of one.
-- -----------------------------------------------------------------------------

-- The prose rows, if you want to see the OTHER flow's output for yourself.
-- Length is the discriminator: a label is short, an explanation is a sentence,
-- and the writer demands at least 30 characters of one.
--
-- SELECT root_cause, length(root_cause)
--   FROM customer_service.ebay_message_headers
--  WHERE root_cause IS NOT NULL AND length(btrim(root_cause)) >= 30
--  ORDER BY 2 DESC
--  LIMIT 20;
