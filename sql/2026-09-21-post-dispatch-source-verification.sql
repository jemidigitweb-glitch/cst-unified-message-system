-- =============================================================================
-- Source verification for the post-dispatch automation — 2026-09-21
--
-- STRICTLY READ-ONLY. Every statement is a SELECT or a catalogue read. These
-- are the exact queries used to establish the shipment → order → customer
-- mapping before a line of the feature was written; nothing in it was assumed.
--
-- Run against the SOURCE database on a session with
-- default_transaction_read_only = on.
-- =============================================================================

-- 0. Prove the session cannot write before reading anything from it.
SHOW default_transaction_read_only;   -- expect: on


-- 1. Which tables exist in the order schema.
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'order_management'
 ORDER BY table_name;


-- 2. The columns actually available on each table in the chain.
SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'order_management'
   AND table_name IN ('orders', 'order_info', 'shipment', 'sub_source')
 ORDER BY table_name, ordinal_position;


-- 3. The authoritative status values. Counted, not assumed.
--    Result 2026-09-21: Completed 1,005,997 · New 141,623 · Cancelled 7,045 · null 1
SELECT status, count(*) FROM order_management.shipment GROUP BY status ORDER BY 2 DESC;

--    Result 2026-09-21: Completed 1,079,963 · Refunded 18,887 · Cancelled 10,726
--                       · Deleted 879 · Inprogress 699 · Hold 29 · New 8
SELECT status, count(*) FROM order_management.orders GROUP BY status ORDER BY 2 DESC;


-- 4. Platform identity. 17 platforms; this application has channels for five.
SELECT id, source_name FROM order_management.source ORDER BY id;

SELECT id, source_id, name FROM order_management.sub_source ORDER BY source_id, id;


-- 5. Which dispatch timestamp to use.
--    Result: shipped_time on 600,914 of 974,474 completed shipments;
--            shipment_created_at on 593,905.
SELECT count(*)                          AS completed_shipments,
       count(oi.shipped_time)            AS with_shipped_time,
       count(sh.shipment_created_at)     AS with_shipment_created_at
  FROM order_management.shipment sh
  JOIN order_management.order_info oi ON oi.order_id = sh.order_id
 WHERE sh.status = 'Completed';

--    How far apart they are. Result: shipped_time averages 1.799h AFTER the
--    label being created, over the last 30 days (n = 15,634).
SELECT round(avg(extract(epoch FROM (oi.shipped_time - sh.shipment_created_at)) / 3600)::numeric, 3)
         AS avg_hours,
       count(*) AS n
  FROM order_management.shipment sh
  JOIN order_management.order_info oi ON oi.order_id = sh.order_id
 WHERE sh.status = 'Completed'
   AND oi.shipped_time IS NOT NULL
   AND sh.shipment_created_at IS NOT NULL
   AND oi.shipped_time > now() - interval '30 days';


-- 6. Cardinality — why the natural key is the SHIPMENT, not the order.
--    Result: 998,111 orders have one completed shipment, 3,506 have two,
--            and one has ten.
SELECT n, count(*) FROM (
  SELECT order_id, count(*) AS n
    FROM order_management.shipment
   WHERE status = 'Completed'
   GROUP BY order_id
) t GROUP BY n ORDER BY n;

--    And why order_info can be joined without multiplying rows.
--    Result: exactly one row per order, across all 1,111,189 orders.
SELECT n, count(*) FROM (
  SELECT order_id, count(*) AS n FROM order_management.order_info GROUP BY order_id
) t GROUP BY n ORDER BY n;


-- 7. Customer context is reachable from the order.
--    Result 2026-09-21: 4,044 of 4,044 recent completed shipments.
SELECT count(*) AS n, count(sa.id) AS with_shipping_address
  FROM order_management.shipment sh
  JOIN order_management.orders o      ON o.id = sh.order_id
  JOIN order_management.order_info oi ON oi.order_id = o.id
  LEFT JOIN customers.shipping_address sa ON sa.order_id = o.id
 WHERE sh.status = 'Completed'
   AND oi.shipped_time > now() - interval '7 days';


-- 8. How many shipments a given floor and storefront would pick up. Run this
--    BEFORE enabling the automation: it is the size of the first scan.
SELECT count(DISTINCT sh.id) AS eligible_shipments,
       min(oi.shipped_time)  AS earliest,
       max(oi.shipped_time)  AS latest
  FROM order_management.shipment sh
  JOIN order_management.orders o      ON o.id = sh.order_id
  JOIN order_management.order_info oi ON oi.order_id = o.id
 WHERE sh.status = 'Completed'
   AND sh.cancelled_at IS NULL
   AND oi.shipped_time IS NOT NULL
   AND oi.shipped_time >= :floor::timestamp
   AND o.sub_source_id = :sub_source_id::int
   AND lower(COALESCE(o.status, '')) NOT IN ('cancelled', 'refunded', 'deleted');


-- =============================================================================
-- 9. Returns and cancellations — added when the automation gained a recheck for
--    them. These tables carry the MARKETPLACE order number and the storefront,
--    and nothing else that could join; this is the proof that is enough.
-- =============================================================================

--    Result 2026-09-21: 42,185 return rows, 42,185 matched to an order.
SELECT count(*) AS return_rows, count(o.id) AS matched_orders
  FROM customer_service.ebay_returns r
  LEFT JOIN order_management.orders o
    ON o.order_id = r.order_id AND o.sub_source_id = r.sub_source;

--    Result 2026-09-21: 15,636 rows, 13,085 matched.
SELECT count(*) AS return_rows, count(o.id) AS matched_orders
  FROM customer_service.amazon_returns r
  LEFT JOIN order_management.orders o
    ON o.order_id = r.order_id AND o.sub_source_id = r.sub_source;

--    Result 2026-09-21: 4,551 rows, 4,551 matched.
SELECT count(*) AS cancellation_rows, count(o.id) AS matched_orders
  FROM customer_service.ebay_order_cancellations c
  LEFT JOIN order_management.orders o
    ON o.order_id = c.order_id AND o.sub_source_id = c.sub_source;

--    WHY PRESENCE IS USED RATHER THAN STATE. 37,814 of the eBay return rows
--    carry a null current_state and a null status, so state cannot be the test;
--    the safe reading of a return request whose outcome is unrecorded is to say
--    nothing to the customer.
SELECT current_state, status, count(*)
  FROM customer_service.ebay_returns
 GROUP BY current_state, status
 ORDER BY 3 DESC;
