# Duplication and re-sync risk status — 2026-09-08

## Purpose

Whether re-running a sync, a resolver or the new invoice path produces the same
result twice or something different, and where duplicate source rows could
otherwise cause a wrong match.

## Current status

The sync writers are idempotent and the order matchers refuse to collapse a
duplicate by picking one. The invoice path added no new write, no new cache and
no new storage, so it introduced no new idempotency surface — but it did add a
new place where a duplicate source row must not be silently resolved, and that
is handled by counting rather than picking.

## Implemented features (protections in place)

### Sync idempotency

- `cst_app.conversation_messages` is unique on
  `(source_database, source_schema, source_table, source_pk)`. A repeated sync
  run upserts rather than duplicates.
- `cst_app.conversations` is unique on `(threading_rule_version, thread_key)`.
  A grouping-rule change produces new conversations under a new version rather
  than corrupting existing ones.
- Idempotency does **not** rest on the watermark being correct. The watermark in
  `cst_app.sync_state` only decides how much work is re-done; the unique
  constraints decide correctness.
- The eBay feed key is `ebay-message-headers` (the source table's name), matching
  the cursor the original bootstrap wrote. A mismatched key would leave two
  cursor rows for one feed.

### Thread-key collision safety

The thread key is a canonical JSON array, not a delimiter join. With a `|` join
these two distinct conversations produce an identical key:

```
{ listingItemRef: "1",   counterpartyRef: "a|b" }
{ listingItemRef: "1|a", counterpartyRef: "b"   }
```

Two different customers would silently merge into one thread. JSON escaping makes
the encoding injective and keeps `null` distinguishable from the empty string.

### Duplicate source data — known and handled

- **One eBay `item_id` is not one listing.** A multi-variation listing stores one
  row per SKU variant under the same item id (one live listing carried 246
  variant rows). Order matching therefore never treats an item id as a unique
  product.
- **Order numbers are reused.** 655 `orders.order_id` values appear across 1,608
  source rows, and `(sub_source_id, order_id)` does not disambiguate them. No
  code anywhere resolves an order from an order number. Everything keys on
  `orders.id`.
- **Return evidence** must match on `order_id` + `item_id` + `sub_source`, never
  `item_id` alone, or a different buyer's return would surface.
- **Several matching orders is a state, not a problem to be solved.** The
  matcher reports `ambiguous` and stops. A reviewer picks.

### Invoice-specific duplication risk (new)

`lib/repositories/order-invoice-repository.ts` reads billing, payment and contact
rows through LATERALs rather than joins, so one order is one header row by
construction — an order with two billing rows cannot fan out into two invoice
headers.

Where a LATERAL finds more than one row:

- the value columns come back `NULL` from the database itself
  (`CASE WHEN count(*) = 1 THEN …`), and
- the count travels alongside, so the caller is **told** a duplicate exists
  rather than handed an arbitrary one of them.

The resulting warnings are `billing_address_duplicated` (measured: 1 order in
1.13M) and `order_info_duplicated`.

`min()` and `bool_or()` are safe here only because they are read exclusively
under `count(*) = 1`.

The line query's `ORDER BY oii.id` is a **reading order within one invoice**, not
a ranking between candidates — every row belongs to the one order the caller
already resolved. Without it the same invoice would print its lines in a
different sequence on each read.

### Re-generation safety

- The invoice is generated on demand, in memory, and nothing is written. Printing
  the same invoice twice reads the same rows and produces the same document.
  There is no invoice record, no file, no URL and no sequence number to collide.
- Draft revisions are append-only. Regenerating adds a revision; it never
  overwrites one.
- A reviewer's order selection is not persisted as a resolution, so it cannot
  become a stale duplicate answer.

## Database / data source

- Source: read-only, so no duplicate can be created there by this application.
- Application writes: `cst_app` only, through the existing writers.
- The header query returns null unless **exactly one** row comes back for the
  primary key — never "take the first".

## User workflow

Invisible to the agent. The visible consequence is that an ambiguous
conversation shows candidate orders and asks, instead of showing one.

## Known limitations

- If the order-matching logic changes, `cst_app.context_snapshots` holds the
  previous answer. A matching-logic fix needs the affected snapshots reset, or
  conversations keep the old resolution.
- The sync's unusable-row counts are reported per run but are not aggregated
  anywhere for trend analysis.
- No automated check re-runs a full sync against a copy and diffs the result;
  idempotency is enforced structurally and by tests, not by a periodic audit.

## Added: order-change notification list — duplication assessed

**No new duplication risk.** The list writes nothing, so it cannot duplicate a
row, and it introduces no second copy of anything:

| Could have been duplicated | What was done instead |
| --- | --- |
| The category detector | `toInboxItem` is called, so a notification row's category is the SAME reading the inbox shows. No second classifier, no keyword match, no stored copy — a test asserts the SQL contains no category, order-change or cancellation vocabulary at all. |
| The inbox query | A separate statement, because the inbox's contract is "every stored conversation, whatever its placement" and adding a narrowing predicate to it is how 3,046 conversations became unreachable once before. The shared parts (`LAST_DIRECTION`, `INBOUND_TEXT`, `INBOUND_TEXTS`) are the same constants, interpolated, not retyped. |
| The row shape | `AwaitingResponseConversationItem` extends `inboxItemSchema` rather than restating it. |
| The message preview | The shared `previewOf` / `displayBody`, so an undecodable body reads the same here as in the thread view. |
| The selection path | The same `onSelect` → `select(id)` the inbox and No Rule lists use, so there is one conversation-detail path, not two. The drawer is handed `onSelect` and calls it; it cannot reach `setDetail` or `setView`, so it has no way to grow a second meaning for "selected". |
| The priority colours | `PRIORITY_RIBBON_CLASS`, read from the same exported table the inbox ribbon reads, so red cannot mean one thing in the drawer and another in the list. A guard asserts the drawer contains no inline copy of those classes. |

**One conversation can legitimately appear in two lists** — the inbox and this
one, or No Rule and this one. That is not duplication: they are different
questions about the same row, and each list is defined by its own predicate.
Nothing dedupes across them and nothing should.

**Going global added no second query and no merge step.** The obvious way to
build a cross-marketplace feed is one request per marketplace merged in
JavaScript, and that would have introduced exactly the risks this folder exists
to catch: N round trips, a hand-written sort that could disagree with the SQL's,
and a merge that could double a row. Instead the marketplace became an array
parameter on the one statement (`= ANY($1::text[])`), and fair representation
became a window function inside it. One query, one ordering, one code path —
and the single-marketplace read is the same function with a one-element array.

**The per-marketplace bound cannot duplicate a row either.** `row_number()`
assigns each row exactly one rank within one partition, and a conversation
belongs to exactly one marketplace, so no row can be counted in two windows.

## Next pending items

- A periodic snapshot-health query pack (counts by `resolution` and marketplace)
  run on a schedule rather than on demand.
- A recorded procedure for resetting stale context snapshots after a matching
  change.
- Nothing invoice-related is pending here: the path holds no state to duplicate.
