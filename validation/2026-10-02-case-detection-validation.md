# Case Detection Indicator — validation

**Date:** 2026-10-02

Acceptance tests, including the ones **not yet run**.

---

## 1. Automated — run and passing

| Suite | File | Tests |
| --- | --- | ---: |
| Migration review (reads the SQL as text, never executes it) | `tests/migrations/marketplace-cases-schema.test.ts` | — |
| Extraction and collapse rules | `tests/domain/marketplace-case-extract.test.ts` | — |
| Importer, publication and rollback | `tests/sync/marketplace-case-import.test.ts` | — |
| MySQL isolation guard | `tests/guards/case-import-isolation.test.ts` | — |
| **Read path guard** (new) | `tests/guards/case-detection-read-path.test.ts` | 36 |
| **Repository** (new) | `tests/repositories/marketplace-case-repository.test.ts` | 23 |
| **Display rules** (new) | `tests/domain/marketplace-case-display.test.ts` | 35 |
| **Resolver** (new) | `tests/context/resolve-case-context.test.ts` | 18 |

Full run on 2026-10-02:

```
npx tsc --noEmit   → clean
npx eslint .       → clean
npx vitest run     → 196 files, 5,498 passed, 35 skipped, 8 failed
npx vitest run tests/guards/  → 27 files, 808 passed
```

The 8 failures are in `tests/ai/draft-validation-cost.test.ts`,
`tests/ai/knowledge-allowlist.test.ts` and
`tests/knowledge/cst-rules-files.test.ts`. **They predate this work**, concern
the gitignored spreadsheet corpus, and reproduce without any of these changes.
Nothing in this feature touches `lib/knowledge/` or `lib/ai/`.

---

## 2. What the automated tests pin

### The publication gate
- Every module under `lib/` and `app/` that reads `marketplace_cases` joins
  `case_import_runs` and filters on `published` — swept, not spot-checked.
- The join is INNER, so an unpublished run removes the row rather than nulling
  it.
- The repository's freshness statement and the writer's agree on what "current"
  means.

### No false associations
- The order reference is compared exactly; the buyer handle is folded on both
  sides.
- The customer list excludes this order with `IS DISTINCT FROM`, so a NULL order
  does not empty it and no case appears in both lists.
- The resolver reads only `context_snapshots`, `marketplace_cases` and
  `case_import_runs` — asserted by inspecting the statements it actually sends.
- It sends no write statement of any kind.

### The five states
- `never_imported` is returned **before** either lookup runs, so it cannot be
  reached by a query that happened to find nothing.
- A failed request becomes `unavailable`, never an empty list.
- `none_found` is downgraded in wording when a store has never been imported.

### The wording
- A refund is never worded as a return.
- An unknown lifecycle contains none of: closed, complete, resolved, finished,
  "no longer".
- A warehouse disposition can only render under its own label, and the panel
  never touches the field directly.
- A confirmed replacement never says dispatched, shipped or sent.
- `not_recorded` and `not_escalated` both render as nothing, and only a positive
  escalation renders.
- No stored identifier (`ITEM_NOT_RECEIVED`, `source_order_id_unverified`)
  reaches a label.

### The interface
- GET only; no POST/PATCH/PUT/DELETE/HEAD/OPTIONS on the route.
- `getAppPool` only — no source pool, no knowledge pool, no MySQL.
- No SQL in the route handler.
- No buyer handle, address, email or message body on the payload — asserted on
  the payload builder, not the whole file.
- The panel has no button, input, form or click handler, and makes no request.
- One fetch, from the hook, to one endpoint.
- The flag sits outside the message scroller and uses its own colour and icon,
  so three stacked strips stay distinguishable.
- The section is mounted after the order section and exactly once.
- The lookup is made once, in the workspace, and handed to both columns.

---

## 3. Verified by hand in the running application

On `localhost:3000`, 2026-10-02, reading the DOM:

| Check | Result |
| --- | --- |
| Conversation with an open escalated return | flag renders at y=165, no scrolling; full section renders in the details column |
| Conversation with no cases | no flag; section reads "No marketplace cases recorded for this order or customer." with the import time |
| API shape | `state: "found"`, `coverage: {covered: 5, neverImported: 0}`, `stale: false` |
| Case with a derived order match | renders the "identified from the marketplace item and transaction references" caveat |
| Escalated + closed case | renders both `Closed` and `Escalated at the marketplace` |
| Console | no errors |

---

## 4. NOT YET RUN

These are acceptance tests this feature deserves and has not had.

1. **A second apply run.** `cases_updated` is 0; the update path and live
   idempotency are proven by unit tests and a unique index, not by a second
   extraction. **Run this before trusting a refresh.** Expect: inserts near
   zero, updates near 21,022, duplicates still zero, and
   `customer_case_history` unchanged.
2. **A retracted run.** Moving a published run to `failed` should make its cases
   disappear from CST immediately, with the panel reporting `never_imported`
   rather than `none_found`. The gate is unit-tested; the live behaviour is not.
3. **A partial run.** A run covering a subset of stores should leave the others
   reporting their own older timestamps, and should raise the partial-coverage
   caveat. Not exercised — run 3 covered all nine.
4. **The staleness caveat on screen.** `stale` is false today because the
   snapshot is hours old. The wording has never been seen in the application.
5. **Amazon and Shopify conversations.** Every hand-check above was on eBay,
   because that is where conversations with resolved orders and cases coincide.
   The Amazon return population is the largest in the table and its panel has
   not been read on a real conversation.
6. **A capped list.** No customer in the snapshot has more than 8 cases, so
   `hasMore` has never been true outside a unit test.
7. **Accessibility and narrow widths.** The strip and the section have not been
   checked with a screen reader or below `sm`.
