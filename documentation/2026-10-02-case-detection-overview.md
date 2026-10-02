# Case Detection Indicator — overview

**Date:** 2026-10-02
**Branch:** `sync-reconcile-late-arrivals`
**Status:** built, imported, published, and visible in the running application.

A CST agent answering a return question had no way to tell whether a return was
already open without leaving this application for the message application. The
Case Detection Indicator puts that answer on the conversation, from a snapshot
imported into this application's own database.

```
Message application (MySQL, read-only)
        │  manual, standalone, one connection, twelve queries
        ▼
cst_app.marketplace_cases + cst_app.case_import_runs   (migration 0022)
        │  published run only
        ▼
marketplace-case-repository → resolve-case-context → GET /:id/cases
        │
        ├── flag above the thread      live cases, cannot scroll away
        └── details column section     every case, with its provenance
        ▼
      STOP.  Nothing is sent. Nothing is written back.
```

---

## 1. What it shows

**A flag above the thread** (`ConversationCaseFlag`), sky-tinted with a left
rail, for cases that are **not closed**. Case type, status chip, which order,
the date it was opened, and the two facts that change a reply — escalation and
damage reported.

**A section in the details column** (`ConversationCasesPanel`, heading
*Marketplace cases*), mounted directly beneath the order it describes. Every
case, split into two lists that never merge:

| List | Matched on |
| --- | --- |
| **On this order** | the order reference this conversation already resolved to |
| **Other orders by this customer** | the marketplace buyer handle, excluding this order |

Closed cases are kept but folded behind a disclosure, so a buyer with eleven
finished returns does not push the live one off the panel.

Per case: type, reference, lifecycle, the marketplace's own status, reason,
recorded resolution, damage, confirmed replacement, escalation, action owed and
due, quantity, refund amount with currency, opened and closed dates — each shown
only where the source recorded it.

---

## 2. The five things it refuses to say

Each is a claim the data does not support, and each was reachable by an ordinary
field dump. All five are pinned by tests.

**A Shopify refund is not an open return.** 2,019 of these records hold a date,
an order, an amount and a currency and nothing else. They render as *Refund
recorded*, never *Return*.

**An Amazon warehouse disposition is not a case status.** The source puts a case
status and a stockroom outcome in one column, split by fulfilment channel.
Migration 0022 splits them into two columns and the display labels the second
*Warehouse outcome (not a case status)*.

**An unknown lifecycle is not a closed one.** 14,436 of 21,022 cases are
`unknown`, overwhelmingly Amazon returns whose status reads `Approved` — the
request was approved, and the store records no closure event or date. They read
*Status not recorded* and sit in the prominent list, not behind the closed
disclosure.

**An available action is not a dispatched replacement.** The eBay return-action
table attaches "seller marked replacement shipped" to 51 returns and is an
available-actions snapshot, not history. 0022 makes a confirmed replacement
unrepresentable outside the Amazon resolution field; 15 cases carry one.

**An unverified order reference is not an exact match.** `order_match_method`
has four values and the panel qualifies three of them in words.

---

## 3. The publication gate

A case row is visible to CST **only when its `import_run_id` names a run whose
status is `published`**. Migration 0022 states that gate and then says plainly
that no schema can enforce it, so the repository owns it: every statement joins
`case_import_runs` and filters on `published`, with an INNER join so an
unpublished run removes the row rather than nulling it.

`tests/guards/case-detection-read-path.test.ts` sweeps every module under `lib/`
and `app/` that reads the case table and fails the build if one is missing the
join.

Runs 1 and 2 of the import are `failed` and own zero rows. They are the evidence
that the gate and the atomic publication work, and neither needs cleaning up.

---

## 4. Freshness is per source store

```sql
SELECT t, max(r.published_at)
  FROM cst_app.case_import_runs r, unnest(r.source_tables) AS t
 WHERE r.status = 'published'
 GROUP BY 1
```

A run may cover a subset, so one global timestamp would let a refresh of the
inquiry log make every return store look current. The panel reports the
**oldest** covered store, so the time on screen is a floor rather than a
flattering maximum.

A store absent from that result **has never been imported**, which is reported
as its own sentence and never as "no cases found".

---

## 5. The five states, and why none may collapse

| State | Meaning | On screen |
| --- | --- | --- |
| `unavailable` | the lookup failed | "Case records could not be checked." |
| `never_imported` | no published run covers this marketplace | "...have not been imported for this marketplace yet." |
| `no_search_key` | no resolved order and no verified customer | "...could not be matched." |
| `none_found` | every covered store searched, nothing found | "No marketplace cases recorded for this order or customer." |
| `found` | cases, split into the two lists | the lists |

Only `none_found` is evidence of absence, and even it is downgraded in wording
when a store has never been imported. A marketplace with no case source at all
(B&Q, Temu) renders **nothing** — a permanent "never imported" caveat about data
that is never going to arrive would teach an agent to ignore the heading.

---

## 6. No MySQL on the read path

The message application's MySQL account allows **100 queries and 50 connections
per hour**, shared with every other consumer including the message sync. One CST
agent working a shift would exhaust that in minutes if a page load could reach
it.

So MySQL is reachable from exactly one place: `scripts/import-marketplace-cases.mjs`,
run by hand. `tests/guards/case-import-isolation.test.ts` walks every module
reachable from `app/` by `@/` imports and fails on a driver or the MySQL reader,
directly or transitively. The read path additionally refuses to import the
importer's own writer, so that graph stays out of a route's dependencies.

---

## 7. What it does not do

- **It resolves no order.** The order comes from
  `cst_app.context_snapshots.order_number` — the answer the existing order
  resolver reached on its own evidence. Nothing here matches an order, ranks a
  candidate, reads a product title or SKU, or consults a model.
- **A manually selected order does not reach it.** A reviewer picking an order
  in the sidebar changes the order panel; that choice lives in the browser and
  is never stored, so the case lookup for such a conversation falls back to the
  customer's own cases. Making it travel would mean re-validating the chosen
  order against the live source on every case lookup.
- **It writes nothing.** GET only, no control of any kind, no transport.

---

## 8. Files

| Layer | File |
| --- | --- |
| Storage | `migrations/0022_marketplace_cases.{up,down}.sql` |
| Import | `scripts/import-marketplace-cases.mjs`, `lib/db/message-app-case-source.ts`, `lib/sync/marketplace-case-writer.ts` |
| Domain | `lib/domain/marketplace-case.ts`, `lib/domain/marketplace-case-extract.ts`, `lib/domain/marketplace-case-display.ts` |
| Read | `lib/repositories/marketplace-case-repository.ts`, `lib/context/resolve-case-context.ts` |
| API | `app/api/conversations/[conversationId]/cases/route.ts` |
| UI | `components/use-conversation-cases.ts`, `components/conversation-cases-panel.tsx`, `components/sidebar-section.tsx`, mounted from `workspace.tsx` into `conversation-view.tsx` and `context-panel.tsx` |

See also `evidence/2026-10-02-case-detection-evidence.md` for every number above
and what was **not** measured.
