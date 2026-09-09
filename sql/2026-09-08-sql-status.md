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

## Added: one statement, in the repository beside the others

`LIST_AWAITING_RESPONSE` in `lib/repositories/conversation-repository.ts`. It
follows the same discipline as everything above: parameterised, `cst_app` only,
SELECT only, and it lives beside the function that runs it rather than as a
loose copy here.

Reads three tables and nothing else — `conversations`, `conversation_messages`,
and `draft_replies` for existence. It does not touch `draft_revisions`,
`draft_revision_sources`, `conversation_rule_analysis`, `ai_usage_log`,
`context_snapshots` or `audit_log`, and a test asserts that.

Four constructs worth naming, because all four are deliberate:

- **`c.marketplace = ANY($1::text[])`**, so one statement serves the global
  notification feed and a single-marketplace read alike. The array is always
  built from a fixed allowlist of literals; nothing a caller supplies reaches
  it, and it is never omitted.
- **`row_number() OVER (PARTITION BY c.marketplace ...)` in a CTE, with the
  expensive reads outside it.** The bound has to be per marketplace: measured
  live, Shopify has 3,342 unanswered conversations to Amazon's 44, so a shared
  `LIMIT 100` is ~90% Shopify and returned nothing at all for Amazon. Ranking in
  the CTE and projecting outside it keeps the three correlated subqueries off
  the ~3,700 rows that will be discarded. `EXPLAIN ANALYZE` confirms Postgres
  pushes the bound into the window as a `Run Condition`, so it stops early per
  partition: 14,915 conversations → 3,695 candidates → **246** rows projected.
- **`inbox_visibility <> 'filtered'`** — see the data map for why this is not
  the `reply_inbox`-only filter the inbox query removed on purpose.

- An **inner** `JOIN LATERAL` resolves the newest inbound message by
  `(source_ts, source_pk)` — the ordering every other view uses. Being inner, it
  is also the "a customer message exists" condition, so that condition is
  expressed once rather than duplicated as a second predicate that could
  disagree with `inbound_count`.
- A **row-value comparison**,
  `(o.source_ts, o.source_pk::bigint) > (latest.source_ts, latest.source_pk)`,
  decides whether a reply came after that message. The same idiom `sync_state`
  uses for its watermark, and for the same reason: the source timestamp is not
  unique, so a reply landing in the same second is ordered by the PK rather than
  missed.

**Verified by EXPLAIN against the live application schema**, not only by review.
The plan is index-driven throughout — `ix_conversations_marketplace_sub_source`
for the marketplace, ~~a hash anti-join against the small `draft_replies`
table,~~ (**that anti-join has since been removed** — see "one predicate deleted"
below; `draft_replies` is now read as a projected label)
and `ix_conversation_messages_thread_order` backward for both message lookups.
No migration was written, and no DDL exists for this feature.

## Added: the first saved inspection queries — `sot-product-reachability.sql`

**This folder is no longer empty.** `sql/sot-product-reachability.sql` holds the
seven read-only queries behind the pre-sale product investigation, which is the
first of the packs described in `query-packs/` to be written down here rather
than left in prose.

Seven statements, all `SELECT` against the marketplace source:

| # | Question |
| --- | --- |
| 1 | Which SOT attributes hold a *usable* value, applying the resolver's own `[VERIFY]`/blank test? |
| 2 | For an attribute reporting zero usable values, what is actually stored — `NULL`, or the sentinel? |
| 3 | How big is the catalogue and how is it organised into tabs? |
| 4 | How many parent listing SKUs are placeholders or combo strings? |
| 5 | **Reachability** — parent route vs component route, counted |
| 6 | Trace one listing end to end: parent, children, variations, catalogue presence |
| 7 | Variant agreement — which attributes a bundle listing may safely state |

Properties that made them fit to keep, matching the discipline above:

- **Read-only.** Every statement is a `SELECT`. The one non-`SELECT` line is
  `SET statement_timeout = '60s'`, guarding query 5, which joins across ~1.19M
  order lines and ~2.01M combo rows.
- **The `[VERIFY]` test mirrors the application exactly** — matched as a
  SUBSTRING, never as the whole value, because the sentinel appears embedded in
  otherwise-real text and an equality check would pass those through as facts.
  A measurement taken here therefore means what `statableValue` means.
- **SKUs are matched with `=` throughout.** No `upper()`, no `btrim()`, no
  case-fold, no split on `+` — the same rule `lib/domain/sku.ts` enforces in
  code. Measured live, normalising buys zero extra rows and costs the guarantee.
- **No customer data, and none can be added without changing the shape.** Every
  query returns catalogue metadata, listing metadata, SKU strings and counts.
  None reads a message, a buyer, an address or an order value.
- Query 6 carries a literal item id and query 7 a literal SKU list, because the
  file is run by hand. Both are listing/catalogue identifiers, not customer
  data. Parameterise if either is ever called from code.

### What query 5 established, and why it belongs in this folder

Two routes exist from a conversation into the product catalogue, and only one
of them was being measured:

| Route | Used by | Listings reached |
| --- | --- | --- |
| Parent listing SKU | `resolveSotProductContext` | 308 of 31,155 (1.0%) |
| Component decomposition | `resolveBundleProductContext` | **19,319 of 31,155 (62%)** |

The parent route fails structurally rather than through bad matching: 4,768
parent rows carry the literal placeholder `"sku not assigneds"` and 1,089 carry
a combo SKU no catalogue indexes. The component route works because
`order_management.order_combo` already holds the decomposition this codebase is
forbidden to derive for itself.

**A `NULL`-safe note for whoever runs query 1 next.** An attribute can have a row
for every SKU and still hold nothing: `weight_g` has 1,824 rows and zero usable
values (1,155 `NULL`, 669 `[VERIFY]`). Counting rows would have reported full
coverage of a column that has never been filled in. The `FILTER` clause is the
point of the query, not decoration.

## Next pending items

- Save the remaining packs (A–E) here in the same shape as
  `sot-product-reachability.sql` — read-only, commented with the finding, no
  customer data.
- Save the approved inspection queries described in
  `query-packs/2026-09-08-query-pack-status.md` into this folder, read-only and
  parameterised, with the finding recorded beside each.
- Reconcile the migrations status table with what is on disk and what is applied.
- No new application SQL is planned. Sending, VAT calculation and accounting
  integration do not exist and no query supports them.

## Added: message body repair — two statements

### The candidate query — `SELECT_REPAIR_CANDIDATES`

```sql
SELECT c.marketplace, m.conversation_id::text, m.source_database, m.source_schema,
       m.source_table, m.source_pk, m.direction, m.source_ts::text, m.body_decode_status
FROM cst_app.conversation_messages m
JOIN cst_app.conversations c ON c.id = m.conversation_id
WHERE m.body_decode_status <> 'decoded'
  AND c.marketplace = ANY($1::text[])
ORDER BY m.source_ts DESC, m.id DESC
LIMIT $2
```

- `<> 'decoded'` is the whole predicate, and it is the right one: `decoded` is
  exactly the state in which a reviewer sees the customer's words. `empty` and
  `failed` both render the unavailable placeholder.
- The join reads `c.marketplace` and nothing else — it decides which source
  repository can answer for the row. No draft, snapshot, order or `sync_state`
  table appears; a test asserts each of those names is absent.
- `::text` on `source_ts` for the reason it appears everywhere in this project:
  the driver would otherwise build a Date through the process timezone.
- Newest first, so a bounded run spends its budget where a late body is most
  likely to have landed.

### The by-pk source read — `buildPkFetchQuery`

```sql
SELECT <the adapter's own columns>
  FROM <schema>.<table> m
  WHERE m.<pk> = ANY($1::bigint[])
  ORDER BY m.<ts> ASC, m.<pk> ASC
```

eBay has its own, keeping the header/body LEFT JOIN:

```sql
SELECT <columns>
  FROM customer_service.ebay_message_headers h
  LEFT JOIN customer_service.ebay_messages b ON b.message_id = h.ext_message_id
  WHERE h.id = ANY($1::bigint[])
  ORDER BY h.receive_date ASC, h.id ASC
```

**THIS IS NOT A WINDOW AND MUST NOT BECOME ONE.** `buildFetchQuery` answers
"what is new?" and owns the watermark. This answers "what does row N say now?" —
no cursor, no resume point, no relationship to `sync_state`. Merging them would
hand repair a way to rewind a sync. They sit side by side in the same module with
that written above both.

Keys are parameterised as one bigint array — one round trip per batch, capped at
`MAX_PK_BATCH = 500`, and validated against `/^\d+$/` before the query is built
so a non-numeric key fails with a clear message rather than a cast error.

### The write

There is no new write statement. Repair runs `UPSERT_MESSAGES` — the same
constant the sync runs — so `conversation_messages` still has exactly one INSERT
in the codebase. Its `DO UPDATE` list is what bounds a repair:

```sql
ON CONFLICT (source_database, source_schema, source_table, source_pk) DO UPDATE SET
  conversation_id    = EXCLUDED.conversation_id,
  body_text          = EXCLUDED.body_text,
  body_decode_status = EXCLUDED.body_decode_status
```

`direction`, `source_ts` and `external_message_id` are INSERT-only, so a repair
structurally cannot move a message in time or flip which side sent it. The
`conversation_id` passed is the row's own stored value, so thread grouping cannot
move either. Tests pin both facts against the statement text.

## Added: one predicate deleted from LIST_AWAITING_RESPONSE

The smallest possible change to a statement in this codebase, and worth recording
because of what it says about writing predicates.

**Removed from the CTE's `WHERE`:**

```sql
AND NOT EXISTS (
  SELECT 1 FROM cst_app.draft_replies d WHERE d.conversation_id = c.id
)
```

**Added to the outer `SELECT`:**

```sql
EXISTS (
  SELECT 1 FROM cst_app.draft_replies d WHERE d.conversation_id = c.id
) AS has_draft
```

Same subquery, same table, same key. What changed is the CLAIM it makes. In the
`WHERE` it asserted "a draft row means this customer has been dealt with" — a
claim about the customer that the row cannot support, since `draft_replies`
records only what we wrote and nothing in `cst_app` records that anything was
sent. In the `SELECT` it asserts what it can: a draft exists.

**Placement is deliberate, and follows this file's existing rule.** The
projection sits in the OUTER query, not the CTE, so the new `EXISTS` is evaluated
only for rows that survived `row_number() OVER (PARTITION BY c.marketplace ...)`
— exactly as the three correlated subqueries above it already are. Putting it in
the CTE would have run it against every candidate row before the window discarded
most of them.

**The surviving predicate is now the only filter on "answered":**

```sql
AND NOT EXISTS (
  SELECT 1 FROM cst_app.conversation_messages o
  WHERE o.conversation_id = c.id
    AND o.direction = 'outbound'
    AND (o.source_ts, o.source_pk::bigint) > (latest.source_ts, latest.source_pk)
)
```

Still the row-value comparison `sync_state` uses for its watermark, so a reply
landing in the same second as the customer's message is ordered by the source PK
rather than missed.

**Unchanged:** parameterisation (`$1` marketplace array, `$2` row bound),
`cst_app`-only scope, SELECT-only, the tables read (three, and a test asserts
nothing else is touched), the index-driven plan, and the absence of any DDL. No
migration was written; `migrations/` still ends at `0010`.

**A note on testing a deleted predicate.** A fake client cannot execute SQL, so
its absence is pinned structurally — and naively asserting the statement no
longer contains `draft_replies` would be wrong, because the projection still
names it. The test asserts the precise shape instead: `cst_app.draft_replies`
must appear, and must NOT appear inside a `NOT EXISTS`.

## Added: no SQL changed by the tracking work

Recorded because a change described as "shipment tracking" invites the
assumption that a query moved, and none did.

- **No statement was added, edited or removed.** `resolveTrackingContext` asks
  the same question of the same conversations and returns the same answers; what
  changed is how the prompt reads a `null` from it.
- **No carrier is called that was not already called.** The gate on which
  conversations warrant a lookup is untouched, so the tracking cache and the
  provider see identical traffic.
- **No schema change and no migration.** `migrations/` still ends at `0010`.
- The two absence branches are decided from a fact already in the request — a
  non-empty `tracking_number` — not from a new read.

The notification test work in the same batch also touched no SQL: it added four
tests, two of them pinning the existing `LIST_AWAITING_RESPONSE` predicate more
precisely. One is worth naming here, because it constrains how that statement
may be rewritten:

> the outbound test must remain **bound to the newest inbound row**
> (`(o.source_ts, o.source_pk::bigint) > (latest.source_ts, latest.source_pk)`),
> never a bare "has this conversation ever had an outbound", and strictly `>`
> rather than `>=` — a reply landing in the same second is ordered by the source
> PK, and `>=` would drop a conversation on a tie.
