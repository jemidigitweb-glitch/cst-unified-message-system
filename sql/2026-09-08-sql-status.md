# SQL status — 2026-09-08

## Purpose

Where the SQL this system actually runs lives, what discipline it follows, and
what belongs in this folder. This folder holds approved reference and inspection
SQL only — it is not application code and it is not how migrations are applied.

## Current status

All application SQL is implemented and lives beside the repository function that
runs it. No loose copies are kept here. This folder currently holds no saved
queries — that is the outstanding item.

## Implemented features

### Where the running SQL is

| Concern | Module |
| --- | --- |
| Marketplace message fetch (per marketplace) | `lib/marketplaces/<name>/message-repository.ts` |
| Conversation / message writes | `lib/sync/conversation-writer.ts` |
| eBay order matching | `lib/repositories/order-context-repository.ts` |
| Same-storefront fallback order | `lib/repositories/customer-order-fallback-repository.ts` |
| Context snapshots and candidates | `lib/repositories/context-snapshot-repository.ts` |
| Listing details and URL | `lib/repositories/ebay-listing-repository.ts` |
| SOT catalogue | `lib/repositories/sot-product-repository.ts` |
| Combo/bundle decomposition | `lib/repositories/bundle-repository.ts` |
| Returns | `lib/repositories/ebay-image-repository.ts`, return context resolver |
| Drafts and revisions | `lib/repositories/draft-repository.ts` |
| AI usage | `lib/repositories/ai-usage-repository.ts` |
| **Invoice (new)** | `lib/repositories/order-invoice-repository.ts` |

### The invoice SQL, as an example of the discipline

Two statements, both `SELECT`, both keyed on `orders.id`:

- **Header** — the order row, its storefront, and the *presence* of the billing
  party, the payment record and the invoice email. `sub_source` is a `LEFT JOIN`
  on a lookup primary key so an order whose storefront row is missing still
  returns its invoice data. Billing and contact names, addresses, phones and
  emails are **not selected at all**, so no later change to the mapper can start
  leaking one.
- **Lines** — `order_management.order_item_info` for that order, `ORDER BY
  oii.id`.

Properties worth copying:

- The row id is validated by shape (`^[0-9]+$`) before a query is built, so an
  order number can never reach a lookup.
- There is **no `ORDER BY` over orders and no `LIMIT`** — the query is given one
  order and can never pick between several. (`ORDER BY oii.id` on the line query
  is a reading order within one invoice, not a ranking between candidates.)
- Billing, payment and contact are read through **LATERALs**, so one order is one
  header row by construction, and a duplicate returns `NULL` values plus a count
  rather than an arbitrary pick — the established
  `CASE WHEN count(*) = 1 THEN …` idiom in this codebase.
- Every monetary column is `::text`. Nothing is parsed into a JavaScript number,
  so no float artefact can reach a document a customer or an accountant reads.
- The two comparisons that exist — "is `tax` above zero", "does a recorded
  discount appear nowhere in the total" — are evaluated by Postgres in exact
  `numeric` and produce booleans, never a figure.

### Hard rules in force

- The marketplace source database is **read-only**, and the pool pins
  `default_transaction_read_only=on`. No statement anywhere writes to it.
- Application writes are `cst_app` only.
- No ORM. The source has no foreign keys, so every join is an explicitly reviewed
  relationship, verified against live data — never one a mapper inferred.
- **All queries parameterised** (`$1`, `$2`, …). Never string-interpolated.
- `order_management.shipment` is never read on the invoice path, and
  `tests/guards/invoice-route.test.ts` asserts the SQL does not name it.

### Migrations

Under `migrations/`, as numbered `NNNN_<description>.up.sql` / `.down.sql` pairs.
`0001`–`0010` exist on disk. They target the application database only and create
objects only inside `cst_app`. `tests/migrations/cst-core-schema.test.ts`
enforces that statically, by reading the SQL as text without connecting to any
database.

## Database / data source

Three connections: source (read-only), application (`cst_app`), knowledge
(read-only). See `lib/db/pools.ts`.

## User workflow

Not applicable — no agent runs SQL. This folder is for developers and
investigators.

## Known limitations

- **This folder is empty of saved queries.** The approved inspection SQL behind
  the `market_place` finding, the order-number-uniqueness finding and the invoice
  discovery has not been written down here; only the findings have.
- `migrations/README.md`'s status table lists `0001`–`0005` while ten pairs
  exist, and which are applied to the application database is not recorded
  anywhere in writing.

## Next pending items

- Save the approved inspection queries described in
  `query-packs/2026-09-08-query-pack-status.md` into this folder, read-only and
  parameterised, with the finding recorded beside each.
- Reconcile the migrations status table with what is on disk and what is applied.
- No new application SQL is planned. Sending, VAT calculation and accounting
  integration do not exist and no query supports them.
