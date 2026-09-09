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

## Added: accepted commitments — duplication assessed

**No new duplication risk.** Reading a commitment writes nothing, stores nothing
and caches nothing, so there is no row to duplicate and no snapshot to go stale.
What it could have duplicated, and what was done instead:

| Could have been duplicated | What was done instead |
| --- | --- |
| The grounding check | `ungroundedClaims` gained a third parameter, defaulting to `[]`. There is still one prohibited-claim table and one scan. No second validator, no parallel "commitment-aware" path. |
| The claim patterns | The replacement entry was **split**, not copied: "arranged" carries the commitment, "dispatched" does not. Two rows in the one table, so a future edit to the wording cannot update one copy and miss another. |
| The message body reader | `displayBody`, the same function the thread view and the notification preview use. An undecodable body reads the same everywhere, and an offer inside one grounds nothing. |
| The intent detector | `WANTS_A_RESEND` is a new constant read **only** by `detectIntents`, added beside `WANTS_A_REPLACEMENT` rather than merged into it — precisely so the category decision in `refine` keeps reading the same expression it read before, and the frozen classifier baseline does not move. |
| The reply-side coverage vocabulary | `INTENT_COVERAGE.wants_replacement.topic` was widened in place. One expression, still. |

**The commitment cannot be double-counted within one thread.**
`acceptedCommitments` returns a de-duplicated list of at most two kinds, and an
acceptance is matched against offers seen strictly BEFORE it. A thread
containing three separate resend offers and one acceptance yields
`["replacement"]` once, not three times.

**Re-generation safety is unchanged and slightly improved.** The commitment is
re-derived from the same stored thread on every call, so two generations of the
same conversation see the same commitments — this is a pure function of rows
that already exist, with no clock, no random and no cache. The observable change
is that the accuracy gate now buys **fewer** regenerations: a confirmation of an
agreed remedy previously raised a critical `unsupported_claim` and a correct
terse reply raised two critical `intent_not_addressed` findings, and each bought
a rewrite that made the draft worse.

**One risk worth naming rather than dismissing.** The offer and acceptance
patterns are regular expressions over customer and agent prose, so they are a
judgement, not a proof. A false positive would let a draft say "we are arranging
a replacement" where no offer was really made. Three things bound it: the offer
must appear in an OUTBOUND message, the acceptance must come after it, and the
only claim it can license is an arrangement — never a dispatch, a date, a
courier or a tracking number, all of which remain blocked by the unchanged
patterns and still require the verified context.

## Added: SOT product facts — no duplication, and one latent collision

The pre-sale product investigation made no code change, but it did surface a
duplication risk worth recording before someone meets it.

**`"sku not assigneds"` is a placeholder that behaves like a key.** 4,768 eBay
parent listing rows carry that literal string in `sku`. It is non-empty, so it
passes `btrim(el.sku) <> ''` and is handed to `findSotProductBySku` as though it
were a SKU. Today it matches nothing and the lookup harmlessly returns null —
which means **those 4,768 listings currently depend on the ABSENCE of a
catalogue row under that exact string.** If one were ever created, one product's
attributes would attach to 4,768 unrelated listings at once, and every one of
them would present it as verified. Rejecting the placeholder before the lookup
is about three lines; it was not done, because this was an investigation.

**The existing anti-duplication rules held everywhere else**, and are worth
recording as having been checked rather than assumed:

- `findSotProductForListing` counts distinct parent SKUs and returns null on
  more than one. It never picks.
- `findSotProductBySku` counts distinct `components_sot_skus.id` and returns
  null on more than one, so rows spanning two catalogue records are refused
  rather than merged.
- SKUs are matched exactly — no `upper()`, no `btrim()`, no case-fold, no split
  on `+`. Normalisation would buy zero extra rows (647 either way, measured) and
  cost the guarantee.
- The bundle resolver's variant-agreement rule is itself a de-duplicator: an
  attribute survives only where every variant yields one identical value, so a
  7-pattern listing contributes one fitting type and **no** diameter, because
  the patterns disagree (135/150/160/190mm).

## Next pending items

- Reject the `"sku not assigneds"` placeholder before the catalogue lookup, so
  those 4,768 listings do not depend on a row never being created.
- A periodic snapshot-health query pack (counts by `resolution` and marketplace)
  run on a schedule rather than on demand.
- A recorded procedure for resetting stale context snapshots after a matching
  change.
- Nothing invoice-related is pending here: the path holds no state to duplicate.

## Added: message body repair — duplication assessed

**No new duplication risk, and no new idempotency surface.** Repair issues
exactly one write statement, and it is the statement that already existed.

| Could have been duplicated | What was done instead |
| --- | --- |
| The message INSERT | `repairMessageBodies` runs the SAME `UPSERT_MESSAGES` constant `persistConversations` runs. There is still exactly one INSERT into `conversation_messages` in the codebase, so the two paths cannot drift on what a stored message looks like. |
| The source read | The by-pk read is a second FUNCTION, not a second query builder: `buildPkFetchQuery` sits beside `buildFetchQuery` in the shared module and reuses each adapter's own `SELECT_COLUMNS`. The projection, the casts and the normaliser are the sync's. |
| The thread key | Never computed. The thread builder is not imported. The existing `conversation_id` is read from the row and written straight back. |
| The watermark | Not read, not written, not consulted. A test asserts no statement in the pass contains `sync_state` or `watermark`. |

**A repeat run cannot duplicate a row.** The unique key is
`(source_database, source_schema, source_table, source_pk)` — the same key the
sync relies on — so a second repair of the same message is an UPDATE. Verified
live: after two passes, `count(*)` and
`count(DISTINCT (source_database, source_schema, source_table, source_pk))` over
`conversation_messages` are both 23,557.

**A repeat run also does no work.** A repaired message is `decoded` and so is no
longer a candidate. Measured: first pass repaired 74, second pass repaired 0.

**The risk that IS present, and how it is handled.** The source row is identified
by primary key, so a row edited upstream could carry a different direction or
timestamp than the message stored against it. Writing that body would restate the
message rather than repair it. `decideRepair` checks identity BEFORE content and
refuses, reporting `source_direction_changed` or `source_timestamp_changed`. A
test pins the ordering: a row with both a changed direction and a newly available
body is refused, not repaired.

`repairMessageBodies` also counts rows it had to INSERT rather than update.
Expected zero — every target was read back from the table moments earlier — and a
non-zero count is printed as a warning rather than absorbed.
