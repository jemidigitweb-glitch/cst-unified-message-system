# Implementation evidence — 2026-09-08

## Purpose

Proof that the implemented system was actually checked, and a record of what the
checks show. No customer data appears in this folder.

## Current status

Full automated suite green on 2026-09-08. The invoice path has unit, guard and
opt-in live-source coverage. No screenshots have been captured for the invoice
feature yet — that is the one gap in this folder.

## Implemented features (evidence held)

### Test run — 2026-09-08

```
npm test   (vitest run)

Test Files  124 passed | 13 skipped (137)
Tests       3365 passed | 32 skipped (3397)
Duration    33.40s
```

The 13 skipped files are opt-in live-source suites. They are skipped by design
and only run when an operator sets the relevant environment variable.

### Standing guards (fail the build if violated)

| Guard | What it proves |
| --- | --- |
| `tests/guards/no-send-capability.test.ts` | Nothing in `app/` or `lib/` can transmit a reply. Scans for sending identifiers and for post-review workflow states (`approved`, `sending`, `sent`, `manual_handoff`). |
| `tests/guards/no-customer-data.test.ts` | No real customer data in tracked files. Scans `git ls-files`. |
| `tests/guards/invoice-route.test.ts` | The invoice endpoint reads only `selectedOrder` from the request, refuses with 409 before rendering when no order resolved, writes nothing, stores nothing, logs no customer data, and never names `order_management.shipment`. |
| `tests/guards/print-invoice-button.test.ts` | The button appears exactly where the endpoint would answer, and the request carries a conversation id and a choice — never an order row id. |
| `tests/guards/draft-workflow.test.ts` | The workflow terminates at `reviewed`. |
| `tests/migrations/cst-core-schema.test.ts` | Migrations touch `cst_app` only, statically, without connecting to a database. |
| `tests/guards/file-naming.test.ts` | Migration naming convention. |

### Behavioural coverage for the invoice path

- `tests/repositories/order-invoice-repository.test.ts` — header/line mapping,
  `real_*` precedence, warning vocabulary, duplicate-row handling, row-id shape
  rejection.
- `tests/context/resolve-invoice-order.test.ts` — the four-branch precedence,
  including "ambiguous without a choice returns null" and "a choice naming an
  order the reviewer was never offered returns null".
- `tests/documents/invoice-document.test.ts` — layout, wrapping, the `—` absence
  marker, the customer-visible warning allow-list, and that no figure is derived.

### Opt-in live-source check

`tests/source-validation/order-invoice-live-source.test.ts`

```
CST_INVOICE_LIVE=1 CST_INVOICE_ROW_IDS=<ids> \
  npx vitest run tests/source-validation/order-invoice-live-source.test.ts
```

- Every statement is a `SELECT` on the read-only pool.
- Asserts on row ids, order numbers, statuses, counts and flags only. No name,
  address, email or phone number is read or logged — the repository returns the
  billing party as a boolean.
- **No row ids are committed.** A source row id identifies one real customer's
  order, so the operator supplies them per run and the file holds none. Without
  them the suite skips.
- `CST_INVOICE_PDF_OUT` can write a rendered PDF to a gitignored directory for
  visual inspection. A rendered invoice carries a real order number, SKUs and
  prices — it is an artefact to look at and delete, never to commit.

### Measured source facts behind the invoice decisions

These were established by read-only investigation and are recorded because they
are the reason the feature is shaped the way it is:

| Finding | Measurement |
| --- | --- |
| The order is the invoice | Billing party exists for 1,133,659 of 1,133,660 orders; 14 of 14 traced real invoice-request orders |
| Billing is a genuinely separate party | 34,926 orders (3.1%) carry a different billing street; 23,756 (2.1%) carry a billing company |
| `shipment.invoice` is not an invoice | DHL export document path on 93 of 1,144,513 shipments (0.008%); absent from all 14 traced orders; 4 on cancelled shipments |
| No VAT can be asserted | 260,833 of 1,101,548 orders (23.7%) record tax above zero; every GBP order sampled records 0.00; 1 of 22 eBay storefronts has a `vat_no` |
| Order numbers are not keys | 655 numbers reused across 1,608 rows |
| Combo SKUs are common | 129,783 of 633,970 live eBay order lines carry one |
| Orders with no lines exist | 7,049 |

## Database / data source

Every check above is either offline (source-text guards, unit tests with
synthetic rows) or read-only against the marketplace source. Nothing in this
folder was produced by a write.

## User workflow

Not applicable — this folder records checks, not usage.

## Known limitations

- **No screenshots exist for the invoice feature.** The evidence README asks for
  visual evidence of a running feature, and none has been captured for the
  "Print invoice" button or the rendered PDF.
- No coverage percentage has been captured recently
  (`npm run test:coverage` exists but no run is recorded here).
- The live invoice check has never been run unattended, by design.

## Added: order-change notification list

**What was built**

| File | Change |
| --- | --- |
| `lib/domain/inbox.ts` | modified — the read contract, the two constants, the feed schema |
| `lib/repositories/conversation-repository.ts` | modified — `LIST_AWAITING_RESPONSE` and `listAwaitingResponseByCategory` |
| `app/api/conversations/awaiting-response/route.ts` | new — GET only |
| `components/notification-bell.tsx` | new — the header control |
| `components/notification-drawer.tsx` | new — the right-side drawer |
| `components/icons.tsx` | modified — `BellIcon`, beside the two existing glyphs |
| `components/workspace.tsx` | modified — one bell, one drawer, one fetch, one boolean |
| `tests/repositories/awaiting-response.test.ts` | new — 26 tests |
| `tests/guards/notification-bell.test.ts` | new — 32 tests |

The list first shipped as a fourth workspace tab (`components/order-change-list.tsx`,
`view === "order_change"`). Both were **removed** when it became a bell and a
drawer: a tab changes what is on screen and this does not — it opens over
whatever the reviewer was already doing and closes when they pick something. A
guard now asserts the tab is gone and that the component file no longer exists.

**Evidence the existing system was not modified**

- `git status` shows three modified files, all additive; no existing function,
  query, component or test was edited.
- `lib/sync/*`, `lib/marketplaces/*`, `lib/knowledge/*`, `lib/ai/*` and
  `lib/context/*` are untouched — message sync, grouping, the classifier, AI
  drafting and order context are byte-identical.
- No migration was added; `migrations/` still ends at `0010`.
- The existing `LIST_CONVERSATIONS`, `listConversations`, `categoryFor`,
  `priorityFor` and `toInboxItem` are unchanged; the new function calls
  `toInboxItem` rather than reimplementing it, so a notification row's category
  and priority are the same readings the inbox shows.
- 3,242 pre-existing tests pass, including every standing guard. Two of them
  bound this work directly and were deliberately not edited:
  `marketplace-ui.test.ts` asserts the workspace has exactly two `<aside>`
  elements, and `review-sidebar.test.ts` asserts the last one is the details
  panel — which is why the list lives in the existing left column rather than a
  new right-hand one.

**Evidence the SQL is correct**

`EXPLAIN` against the live application schema, captured during the work: the
statement plans, and every access path is an index scan
(`ix_conversations_marketplace_sub_source`, a hash anti-join on the 198-row
`draft_replies`, and `ix_conversation_messages_thread_order` for both message
lookups). The three correlated subqueries sit above the `LIMIT`, so they are
evaluated for the returned rows, not for the whole candidate set.

## Next pending items

- Capture a screenshot of the context panel showing the "Print invoice" control
  against a resolved order, and one of a rendered invoice with synthetic or
  masked data.
- Record a coverage summary run.
- No evidence is needed for sending, VAT invoices or accounting integration —
  none of those exist.
