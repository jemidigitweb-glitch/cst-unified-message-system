# duplicate-risk-reports/

Findings about duplication and re-sync safety — whether re-running a sync or a resolver produces the same result twice, or something different.

## What belongs here

- Idempotency findings for the sync writers (e.g. `cst_app.conversation_messages`'s uniqueness on `(source_database, source_schema, source_table, source_pk)` is what makes a repeated sync run upsert rather than duplicate — see `lib/sync/conversation-writer.ts`)
- Duplicate-detection analysis for source data itself (e.g. a single eBay `item_id` is not unique to one listing — a multi-variation listing stores one row per SKU-variant under the same item_id, confirmed live with one listing carrying 246 variant rows)
- Risk reports on any matching logic that could double-count or double-match (e.g. why return-evidence matching must use `order_id` + `item_id` + `sub_source`, never `item_id` alone, to avoid surfacing a different buyer's return)
- Notes on what happens if a resolver's cache (`cst_app.context_snapshots`) goes stale after a matching-logic fix, and what had to be reset

## What does not belong here

- General bug reports unrelated to duplication or idempotency — those belong wherever this project tracks issues
- Real customer data used as a duplicate example — describe the shape of the collision, not actual rows
