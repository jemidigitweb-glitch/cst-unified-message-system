# data-maps/

How data actually flows from the marketplace source database into this application — the mappings, not the code that implements them.

## What belongs here

- Source-to-application field mappings (e.g. `ebay_message_headers.item_id` → `cst_app.conversations.listing_item_ref`)
- Join paths discovered and verified against live data (e.g. the eBay order-context chain: `ebay_message_headers.item_id` + buyer → `order_management.order_item_info` → `order_management.orders` → `customers.shipping_address` / `order_management.shipment`)
- Notes on source-side quirks that shape the mapping (e.g. `order_management.market_place` is a country/region code shared across every marketplace, not a platform identifier — a real finding that changed how eBay orders are matched)
- Cross-schema relationships that have no foreign key in the source database and had to be verified by hand, since the source has none

## What does not belong here

- The SQL that implements a mapping — that's `lib/repositories/`, parameterised and tested
- Example rows containing real customer data — describe the shape and the join keys, not actual values
