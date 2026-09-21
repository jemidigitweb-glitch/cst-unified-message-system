# Data map — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-implemented-data-map.md](2026-09-08-implemented-data-map.md).

## Source mapping: shipment → order → customer context

Verified live against the source database on 2026-09-21. Nothing below is
assumed; every table, column and join was read before it was used.

```
order_management.shipment sh                     ← the dispatch event (PK: id)
  └── sh.order_id      = order_management.orders o          .id
        ├── oi  = order_management.order_info      oi.order_id = o.id
        │           oi.shipped_time  ← THE DISPATCH TIME (naive timestamp)
        ├── ss  = order_management.sub_source      ss.id = o.sub_source_id
        │           ss.source_id     ← the PLATFORM
        │           ss.name          ← the storefront the customer bought from
        ├── ci  = customers.customer_info          ci.order_id = o.id
        │           ci.first_name, ci.last_name    ← recipient display name
        ├── sa  = customers.shipping_address       sa.order_id = o.id
        │           sa.address_name                ← recipient name fallback
        └── oii = order_management.order_item_info oii.order_id = o.id
                    oii.item_sku, oii.real_sku, oii.item_title
  └── sh.carrier_service_id = order_management.carrier_service cs.id
        cs.carrier  ← courier
```

`ci.order_id = o.id` and `sa.order_id = o.id` are the same joins
`order-context-repository.ts` and `order-display-repository.ts` already use.

## Returns and cancellations (added 2026-09-21)

Joined on the MARKETPLACE order number and the storefront — the only keys
these tables carry. Verified live:

| Table | Join | Matched |
| --- | --- | --- |
| `customer_service.ebay_returns` | `(order_id, sub_source)` | 42,185 / 42,185 |
| `customer_service.ebay_order_cancellations` | `(order_id, sub_source)` | 4,551 / 4,551 |
| `customer_service.amazon_returns` | `(order_id, sub_source)` | 13,085 / 15,636 |

The PRESENCE of a return row is treated as returned, whatever state it is in:
37,814 eBay rows carry a null state, and the safe reading of a return request
whose outcome is unrecorded is to say nothing to the customer.

Shopify, B&Q and Temu have no equivalent table in the source, so a return on
those channels is not detected. That is a stated gap, not an assumption.

## Platform id → channel

Read from `order_management.source`. 1 AMAZON, 2 EBAY, 3 SHOPIFY, 16 B&Q,
17 TEMU map to this application's five channels. 4 ETSY, 5 ONBUY, 6 WAYFAIR,
7 AVASAM, 8 MANOMANO, 9 MANUALORDER, 10 RESEND, 11 REPLACEMENT, 12 BOL,
13 MANUAL OM, 14 FAIRE, 15 WOO have no channel here and are **dropped**.

## Authoritative status values

Counted live, not assumed.

| Column | Values |
| --- | --- |
| `shipment.status` | `Completed` 1,005,997 · `New` 141,623 · `Cancelled` 7,045 · null 1 |
| `orders.status` | `Completed` 1,079,963 · `Refunded` 18,887 · `Cancelled` 10,726 · `Deleted` 879 · `Inprogress` 699 · `Hold` 29 · `New` 8 |

"Dispatched" is `shipment.status = 'Completed'` and nothing else.

## Cardinality

- `order_info` : `orders` is **1:1** across all 1,111,189 orders.
- Completed shipments per order: 998,111 orders have one; 3,506 have two; the
  largest has ten. The work item's natural key is therefore the SHIPMENT.

## Application tables written (`cst_app` only)

| Table | Holds |
| --- | --- |
| `automation_templates` | saved, versioned, approved message templates |
| `automation_settings` | enabled, delay_hours, enabled_sub_sources, not_before, dispatch_time_zone, template_id, test_mode |
| `automation_items` | one record per shipment: schedule, template, status, test-mode result |

No foreign key crosses into `order_management` or `customers`; source ids are
plain columns.

## Customer data stored

`automation_items.recipient_name` — a display name, nothing else. No
email address, postal address, phone number or marketplace handle is copied into
`cst_app` by this feature.
