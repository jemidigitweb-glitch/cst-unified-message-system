# Query pack status — 2026-09-08

## Purpose

Reusable read-only investigation queries, grouped by the question they answer.
This document records which investigations the implemented system depends on, so
the next one does not start from zero.

## Current status

The investigations below have all been run and their findings are baked into the
implementation. **The queries themselves are not yet saved in this folder** —
they exist in ad-hoc form and in the doc comments of the modules they justify.
That is the main gap here.

## Implemented features (investigations run, findings in force)

### Pack A — is this eBay sub-account's `market_place` code the expected one?

Finding: `order_management.market_place` is a country/region code shared across
every marketplace, **not** a platform identifier. Sub-account 28 files orders
under a different code from the majority. eBay is identified by
`sub_source.source_id` instead.

Used by: `lib/repositories/order-context-repository.ts`.

### Pack B — context-resolution health

Counts of `cst_app.context_snapshots` by `resolution` (`single_order`,
`ambiguous`, `no_order`) and by marketplace. Used to see how much of the inbox is
waiting on a human choice, and to spot a matching regression after a change.

### Pack C — order-number uniqueness

Finding: 655 `orders.order_id` values are reused across 1,608 source rows, and
`(sub_source_id, order_id)` does not disambiguate them. This is why nothing in
the codebase resolves an order from an order number.

### Pack D — listing coverage

Finding: over every eBay conversation CST holds, 867 of 890 item references
resolve to exactly one listing URL, 23 have none, none is ambiguous. A listing
title resolves for 869 of 869 and variation options for 867, while the SOT
catalogue resolves for 3 of 869. This is why listing context exists separately
from catalogue context.

### Pack E — invoice source discovery (new)

The pack behind the invoice feature. Every query is a `SELECT` on the read-only
pool and returns counts and flags, never customer rows:

| Question | Answer found |
| --- | --- |
| Is there an invoice table, number sequence or stored document? | No. The order **is** the invoice; `orders.order_id` is the business's own "Invoice identifier". |
| Does a billing party exist per order? | 1,133,659 of 1,133,660 orders. |
| Is billing a copy of the delivery address? | No — 34,926 orders (3.1%) carry a different billing street, 23,756 (2.1%) a billing company. |
| Is `shipment.invoice` an invoice? | No — a DHL international export document path on 93 of 1,144,513 shipments (0.008%), shipment-scoped, 4 on cancelled shipments, absent from all 14 traced invoice-request orders. |
| Can VAT be asserted? | No — 260,833 of 1,101,548 orders (23.7%) record tax above zero, every GBP order sampled records 0.00, and 1 of 22 eBay storefronts has a `vat_no`. |
| How many orders have no lines? | 7,049. |
| How many order lines carry a combo SKU? | 129,783 of 633,970 live eBay lines. |
| Do duplicate billing rows exist? | Yes — 1 order in 1.13M. Handled by counting, not by picking. |

### Pack F — live invoice spot check

Not a loose query but a runnable, opt-in suite:

```
CST_INVOICE_LIVE=1 CST_INVOICE_ROW_IDS=<ids> \
  npx vitest run tests/source-validation/order-invoice-live-source.test.ts
```

Read-only, asserts on ids, statuses, counts and flags only, and holds **no
committed row ids** — a source row id identifies one real customer's order, so
the operator supplies them per run.

## Database / data source

- Every query kept here must be read-only against the marketplace source, or
  scoped to `cst_app` only.
- All parameterised.
- Query **output containing real customer data is never kept** — the query stays,
  the result rows do not. Local analysis artefacts go to the gitignored `/tmp/`
  and are deleted.

## User workflow

An investigator picks the pack matching their question, runs it against the
read-only source, and records the finding — not the rows — in the relevant
folder.

## Known limitations

- **The packs are described here but the SQL is not saved in this folder.** The
  findings are durable; the queries would have to be reconstructed.
- No pack exists yet for Amazon, Shopify, B&Q or Temu order matching, because no
  order context is resolved for those marketplaces.
- Pack B has no scheduled run; it is executed on demand.

## Added: the awaiting-response query

`LIST_AWAITING_RESPONSE`, in `lib/repositories/conversation-repository.ts`. It
is application SQL, so it lives beside its function rather than in this folder —
but its shape is worth recording here, because it answers a question a reviewer
may want to ask directly.

**The question:** which conversations, across any set of marketplaces, have a
customer message that nobody has answered, either with a draft or with a reply?

**Answered by four conditions in SQL** — an inner `JOIN LATERAL` for the newest
inbound message, `inbox_visibility <> 'filtered'`, `NOT EXISTS` on
`cst_app.draft_replies`, and `NOT EXISTS` on any outbound message ordered after
that inbound one by row-value comparison — **plus one in application code**, the
category, which cannot be a predicate because it is not stored.

Parameters: `$1` a marketplace array, `$2` the row bound **per marketplace**
(applied through `row_number() OVER (PARTITION BY c.marketplace ...)`, not as a
plain `LIMIT` — see `sql/` for why a shared bound returned nothing for Amazon).
Read-only, `cst_app` only, verified by `EXPLAIN ANALYZE` against the live schema.

A useful sizing query fell out of this work and is worth keeping: the same
predicates with `GROUP BY c.marketplace, c.inbox_visibility` and `count(*)`
answers "how big is the unanswered queue, and how much of it is filtered mail?".
On 2026-09-08: Shopify 3,342 + 4,452 filtered, eBay 309, Amazon 44.

**A caveat for anyone running it by hand:** the SQL alone answers "unanswered",
not "unanswered AND an order change". Without the classifier it returns every
case area, so a count taken from it will be larger than the notification list.

## Next pending items

- Save the actual SQL for packs A–E in this folder, parameterised and with the
  finding recorded beside each query.
- Add a snapshot-health pack that can be run on a schedule.
- Add a pack for verifying a context-snapshot reset after a matching-logic change.

## Added: Pack G — blank message bodies

The investigation behind body repair. Read-only, and it returns counts and
statuses only — never message text.

**G1 — how many messages show as blank, by marketplace and status.**

```sql
SELECT c.marketplace, m.body_decode_status, count(*)
FROM cst_app.conversation_messages m
JOIN cst_app.conversations c ON c.id = m.conversation_id
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

2026-09-08, before repair: eBay 5,666 decoded / 791 empty; Amazon 1,674 / 168;
Shopify 11,236 / 14; B&Q 3,773 / 0; Temu 220 / 0.

**G2 — of the blanks, how many could actually be fixed?** Take the `source_pk`
values from G1's empty rows and ask the source what it holds now:

```sql
SELECT count(*)                                                    AS blank_in_cst,
       count(*) FILTER (WHERE b.message IS NOT NULL
                          AND b.message <> 'null')                 AS body_present_now,
       count(*) FILTER (WHERE b.message = 'null')                  AS body_json_null,
       count(*) FILTER (WHERE b.message_id IS NULL)                AS no_body_row_at_all
FROM customer_service.ebay_message_headers h
LEFT JOIN customer_service.ebay_messages b ON b.message_id = h.ext_message_id
WHERE h.id = ANY($1::bigint[]);
```

Answer for the 791: **74** recoverable, 166 JSON `null`, 551 with no body row —
and all 551 have `ext_message_id IS NULL` and `message_type IS NULL`, which is
eBay's system-notice shape.

**G3 — is the body table lagging the header table?**

```sql
SELECT (SELECT count(*) FROM customer_service.ebay_message_headers) AS headers,
       (SELECT count(*) FROM customer_service.ebay_messages)        AS bodies,
       (SELECT max(id)  FROM customer_service.ebay_messages)        AS max_body_id;
```

~104k headers against 73,913 bodies. A body row written for a message received
minutes earlier carried an id near the maximum — the confirmation that bodies
arrive after headers rather than with them.

**G4 — recent daily gap**, to see whether the lag is ongoing:

```sql
SELECT date_trunc('day', h.receive_date)::date AS day, count(*) AS headers,
       count(*) FILTER (WHERE b.message IS NULL) AS no_body
FROM customer_service.ebay_message_headers h
LEFT JOIN customer_service.ebay_messages b ON b.message_id = h.ext_message_id
WHERE h.receive_date >= now() - interval '10 days'
GROUP BY 1 ORDER BY 1 DESC;
```

Between 20% and 40% of each day's headers have no body row at the moment of
reading. Most of that is system-notice traffic; some is a body still in flight.

The repair pass's own candidate query, `SELECT_REPAIR_CANDIDATES` in
`lib/sync/body-repair.ts`, is application SQL and lives beside its function.
