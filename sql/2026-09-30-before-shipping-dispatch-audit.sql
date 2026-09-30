-- ---------------------------------------------------------------------------
-- Before-shipping dispatch rule — the audit queries, kept so the numbers in
-- evidence/2026-09-30-before-shipping-dispatch-evidence.md can be re-derived.
--
-- 2026-09-30. READ ONLY. Run each block with
--   SET default_transaction_read_only = on;
-- on the session, against the database named in the block's header.
--
-- These two databases are separate and cannot be joined. Block A produces the
-- order keys; Block B is run with those keys as its parameter. The audit script
-- that did this on 2026-09-30 ran both and joined in application code.
-- ---------------------------------------------------------------------------

SET default_transaction_read_only = on;

-- ===========================================================================
-- BLOCK A — varmen_db (schema cst_app)
--
-- For named conversations: the order key the rule would look up, and when the
-- newest customer message arrived. Same expressions the application uses; the
-- eBay marketplace literal is inlined HERE only because this is a hand-run
-- measurement file, never application code -- see orderRefExpression, which
-- binds it as a parameter.
-- ===========================================================================
SELECT c.id::text                            AS conversation_id,
       c.marketplace,
       c.counterparty_ref,
       c.inbox_visibility,
       cs.resolution,
       CASE
         WHEN c.counterparty_ref LIKE 'unresolved:%'
           THEN CASE WHEN cs.resolution = 'single_order' THEN cs.order_number END
         ELSE COALESCE(
                CASE WHEN cs.resolution = 'single_order' THEN cs.order_number END,
                CASE WHEN c.marketplace <> 'ebay' THEN c.counterparty_ref END
              )
       END                                   AS order_key,
       (SELECT COALESCE(cm.source_ts_utc, cm.ingested_at)::text
          FROM cst_app.conversation_messages cm
         WHERE cm.conversation_id = c.id
           AND cm.direction = 'inbound'
         ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
         LIMIT 1)                            AS newest_message_at
  FROM cst_app.conversations c
  LEFT JOIN cst_app.context_snapshots cs ON cs.conversation_id = c.id
 WHERE c.id = ANY($1::bigint[]);

-- ===========================================================================
-- BLOCK B — ledsone (schema order_management)
--
-- The dispatch state for those keys, read exactly as
-- order-shipment-state-repository.ts reads it.
--
-- shipped_time ALONE is dispatch. A Completed shipment row is a PRINTED LABEL
-- and runs a median of 78 minutes ahead of the parcel leaving, so it is
-- selected here to be SEEN and never to decide -- see eBay 45862 in that
-- module's header for the conversation that settled it.
-- ===========================================================================
SELECT o.sub_source_id,
       o.order_id                                                    AS order_number,
       o.status                                                      AS order_status,
       o.order_date::text                                            AS order_date,
       max(oi.shipped_time)::text                                    AS shipped_time,
       (max(oi.shipped_time) IS NOT NULL)                            AS dispatched,
       bool_or(sh.status = 'Completed' AND sh.cancelled_at IS NULL)   AS labelled_only
  FROM order_management.orders o
  JOIN order_management.order_info oi ON oi.order_id = o.id
  LEFT JOIN order_management.shipment sh ON sh.order_id = o.id
 WHERE o.order_id = ANY($1::text[])
 GROUP BY o.sub_source_id, o.order_id, o.status, o.order_date;

-- ===========================================================================
-- BLOCK C — ledsone. Every order a named marketplace buyer holds.
--
-- WHY IT IS HERE. eBay 50802 is the multi-order shape the whole rule exists
-- for: the same buyer holding a 1-light and a 3-light variant of one listing,
-- asking for one of them to be cancelled. This is the query that showed the
-- orders were distinct rows with distinct SKUs and distinct dispatch states,
-- and it is what a reviewer runs to check a target-order decision by hand.
--
-- ci.ebay_buyer_id is the ONLY column in the source carrying a buyer username.
-- Measured 2026-09-23: populated on 0% of eBay orders under 6 hours old, 14% by
-- 12 hours, 100% only after 12-24 hours -- so an empty result for a new order
-- is the identity race, not an absent order.
-- ===========================================================================
SELECT o.order_id,
       o.sub_source_id,
       ss.name                                                     AS storefront,
       o.status                                                     AS order_status,
       o.order_date::text                                           AS order_date,
       max(oi.shipped_time)::text                                   AS shipped_time,
       string_agg(DISTINCT oii.item_id, ',')                        AS item_ids,
       string_agg(DISTINCT oii.item_sku, ',')                       AS skus
  FROM order_management.orders o
  JOIN order_management.sub_source ss ON ss.id = o.sub_source_id
  JOIN order_management.order_info oi ON oi.order_id = o.id
  JOIN order_management.order_item_info oii ON oii.order_id = o.id
  JOIN customers.customer_info ci ON ci.order_id = o.id
 WHERE ci.ebay_buyer_id = $1
 GROUP BY o.order_id, o.sub_source_id, ss.name, o.status, o.order_date
 ORDER BY o.order_date DESC;

-- ---------------------------------------------------------------------------
-- WHAT THESE QUERIES CANNOT ANSWER
--
-- Which conversations carry the "Order change, before shipping queries"
-- category. There is no category column -- it is computed on every request by
-- classifyConversationCategory from the customer's own text. Any store-wide
-- count of what this rule moves has to classify in application code first; the
-- two-step recipe is in
-- query-packs/2026-09-30-before-shipping-dispatch-query-pack.md.
-- ---------------------------------------------------------------------------
