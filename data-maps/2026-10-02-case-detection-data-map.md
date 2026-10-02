# Case Detection Indicator — data map

**Date:** 2026-10-02

Which column comes from where, in both directions: source → store, and store →
screen.

---

## 1. Source → `cst_app.marketplace_cases`

Source database: `message_app` (MySQL, **read-only**, reached only by
`scripts/import-marketplace-cases.mjs`). Nine stores, each collapsed to one row
per CASE — never per event.

| Stored column | Source | Notes |
| --- | --- | --- |
| `source_database` | literal `'message_app'` | CHECK-pinned to one value |
| `source_table` | which of the nine stores | CHECK-pinned to the nine |
| `source_case_id` | the store's own CASE identifier | **text**, never a per-event row id; 20-digit at source |
| `marketplace` | `marketplaceFor(source_table)` | ebay · amazon · shopify |
| `sub_source_id` | the storefront on the case | verified against the order source's allowlist |
| `case_type` | store, plus the type column on the two inquiry logs | five values |
| `order_ref` | source order id, or derived | see §2 |
| `order_match_method` | how §2 resolved | four values |
| `order_line_item_ref`, `order_txn_ref` | the marketplace item + transaction ids | kept so a match can be re-derived |
| `counterparty_ref` | buyer handle | **NULL on four of the nine stores** — the source records none |
| `lifecycle` | `lifecycleFor()` over each store's own closure column | active · closed · unknown |
| `source_status` | the store's status column | merchant-fulfilled Amazon only, for that store |
| `source_state` | the store's state column | eBay returns, cancellations |
| `source_disposition` | Amazon status column **for FBA rows only** | a warehouse outcome; CHECK-pinned to `amazon_returns` |
| `source_resolution` | the store's resolution column | |
| `source_reason`, `source_reason_family` | the store's reason columns | |
| `damage_reported` | `damageReportedBy()` over a closed reason set | 1 eBay value, 4 Amazon values |
| `replacement_confirmed` | Amazon resolution ∈ {Replacement, ReturnlessReplacement} | CHECK-pinned to `amazon_returns` |
| `escalation` | `escalationFor()` | escalated · not_escalated · **not_recorded** |
| `seller_action_owed`, `seller_action_due_at` | the store's action columns | eBay returns populate both on 100% of header rows |
| `quantity`, `refund_amount`, `refund_currency` | the store's columns | amount is `numeric(12,2)`, cast once in SQL |
| `opened_at` | **earliest** date across the case's events | naive, byte-for-byte |
| `closed_at`, `source_updated_at` | the store's columns | naive |
| `source_row_count` | how many event rows collapsed in | **summing it is never a case count** |
| `imported_at` | `now()` | per-row "last confirmed", **not** the freshness answer |
| `import_run_id` | the run | the publication gate, FK, ON DELETE RESTRICT |

### The status trap, in two stores

`status` is NULL on the newest row of all 1,062 inquiry cases, and present on
only 4,427 of 42,931 eBay return rows. The collapse rule is therefore: **newest
row by (event sequence, row id) decides identity; newest NON-NULL value decides
status.** A plain "latest row wins" imports NULL for every case and looks like it
worked.

---

## 2. The order reference

| Method | How | Cases |
| --- | --- | ---: |
| `source_order_id_verified` | the store recorded an order id, and it names a real order on that storefront | 19,805 |
| `item_transaction` | derived from `item_id + transaction_id + storefront` → `order_item_info.item_id + item_transaction_id` | 1,055 |
| `source_order_id_unverified` | the store recorded an order id that resolves to no order here | 155 |
| `unmatched` | no reference at all | 7 |

The `item_transaction` route is the marketplace's own order-line identifier and
is unique by construction. It is used for the two inquiry logs, which carry both
parts on 100% of rows. **Several distinct matching orders is `unmatched`, never
the first one.**

`ck_marketplace_cases_order_ref_method` makes `unmatched` ⟺ `order_ref IS NULL` a
biconditional, so the two can never drift apart.

---

## 3. `cst_app.case_import_runs`

| Column | Meaning |
| --- | --- |
| `status` | `in_progress` · `published` · `failed`. **Only `published` may be read.** |
| `published_at` | set in the SAME transaction as the rows it publishes. The authoritative freshness value. |
| `source_tables` | what this run actually covered. Freshness is answered per element. |
| `mysql_connections`, `mysql_queries` | the source budget spent, auditable from the database |
| `cases_read/inserted/updated/rejected` | required once published |
| `rejection_summary` | jsonb, tallied by reason |

There is deliberately **no `mode` column**: a dry run writes no row anywhere, so
"a rehearsal changes no database" is a property of the schema.

---

## 4. Store → screen

Read by `lib/repositories/marketplace-case-repository.ts`, every statement
joined to a `published` run.

| Lookup | Predicate | Index |
| --- | --- | --- |
| On this order | `marketplace`, `sub_source_id`, `order_ref =` (exact) | `ix_marketplace_cases_order` (partial) |
| Same customer | `marketplace`, `sub_source_id`, `lower(counterparty_ref) =`, `order_ref IS DISTINCT FROM` | `ix_marketplace_cases_counterparty` (functional, partial) |
| Freshness | `unnest(source_tables)` over published runs | table scan, tens of rows |
| Publication gate | `import_run_id` | `ix_marketplace_cases_run` |

The order the case is matched against comes from
**`cst_app.context_snapshots.order_number`** for the conversation — non-null only
on a single-order snapshot, by `ck_context_snapshots_unresolved_has_no_order`.

### What crosses the wire

| Reaches the browser | Does not |
| --- | --- |
| case reference, type, lifecycle | the buyer handle |
| marketplace status / state | the source table name |
| warehouse disposition, under its own label | any customer name, address, email or phone |
| reason, resolution, damage, replacement, escalation | any message or case correspondence |
| action owed + due, quantity, refund + currency | any raw marketplace payload |
| opened / closed dates, order reference, match method | the `import_run_id` or any internal id |
| coverage as **two counts** and one timestamp | the list of store names |

---

## 5. Not touched

`cst_app.customer_case_history` (1,098 rows) is read by nothing in this feature
and written by nothing in it. The Repeat-Customer Warning keeps its table, its
three statements and its numbers exactly as they were.
