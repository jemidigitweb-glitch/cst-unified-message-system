# Working on this codebase with an AI assistant

**Read this before writing any code here.** It is written for a coding
assistant — Claude, Cursor, Copilot, Codex, whichever — joining a repository
whose conventions are unusual on purpose and whose test suite will reject a
change that ignores them.

Nothing here is style preference. Every rule below exists because breaking it
already caused a real problem, and the test that catches it names the problem.

---

## 1. What this application is

An internal CST (customer service team) workspace. It pulls live marketplace
customer messages into one place, groups them into conversations, resolves the
verified order and product context behind each one, and produces a **grounded
draft reply for a human to review**.

```
Live message → Thread → Verify context → AI draft → Review/Edit → Save → reviewed → STOP
```

It is a **reading and drafting** tool. It is not a helpdesk, not a sender, and
not a system of record for anything a customer sees.

---

## 2. The five rules that will fail your build

### 2.1 The application cannot send, and must never gain the ability

`reviewed` is a terminal state. There is no transport, no outbound queue, no
recipient column, no template renderer that reaches a customer. This is
enforced in four independent places:

| Level | Mechanism |
| --- | --- |
| Database | `ck_conversations_workflow_state` admits only `received · drafting · pending_review · reviewed` |
| Domain | `lib/domain/workflow.ts` permits no transition out of `reviewed` |
| API | No send route exists anywhere under `app/api/` |
| Build | `tests/guards/no-send-capability.test.ts` scans `app/` and `lib/` on every run |

Do not add a column, a status value, a route name or a helper that a transport
could later read. A column called `recipient` fails the build even if nothing
uses it.

### 2.2 The marketplace source database is strictly read-only

Two databases, and the split is the whole safety story:

| Name | Role | Access |
| --- | --- | --- |
| `varmen_db` → schema `cst_app` | this application's own data | read **and** write |
| `ledsone` → schemas `customer_service`, `order_management`, `customers` | the live marketplace source | **SELECT only** |

`getSourcePool()` pins `default_transaction_read_only=on` on its session, so
the server refuses a write from that path even if one is written. Do not
remove that. Do not add a writer that takes the source pool.

There is also a MariaDB staff-directory source (`DB_ORDER_*`), read-only by
GRANT. Some features are explicitly forbidden from using it — check the feature's
own documentation before reaching for it.

### 2.3 Migrations are applied by hand, and reviewed as text

There is no migration runner and no ledger table. `migrations/NNNN_name.up.sql`
and `.down.sql`, applied manually.

**A migration is reviewed by a test that reads the SQL as a string and never
executes it** — see `tests/migrations/`. That is why the suite runs anywhere
without a database. Follow the pattern: assert the columns, the constraints by
name, the index definitions, and the blast radius (what the file must *not*
touch).

**An unapplied migration may be edited in place. An applied one may not** — add
the next number instead. Which migrations are live in a given environment
cannot be determined from this repository; query
`information_schema.tables` against that environment.

### 2.4 Unmapped values are rejected and counted, never guessed

Ambiguity is surfaced, not resolved by the machine. Degradation is reported,
not hidden. You will see this shape everywhere:

- a resolution returns `resolved | unavailable | ambiguous`, not a nullable string
- a lookup returns `unreadableRowCount` alongside its answer
- a list returns `hasMore` so a caller can tell "that is everything" from
  "I stopped looking"

If you find yourself picking one of two conflicting values to keep a function
simple, you are writing the bug this codebase is shaped to prevent.

### 2.5 Comments explain WHY, and are load-bearing

Header comments record the measurement, the bug, or the decision behind the
code. They are the most reliable documentation in the repository — read the
header before editing the body.

Several tests **strip comments before asserting**, because prose saying "this
module must not touch X" is indistinguishable from a query against X to a text
search. If you add a guard that greps source, strip comments first.

---

## 3. Layout

```
app/api/…            route handlers — thin; no SQL lives here
lib/domain/…         pure rules. No network, no database, no clock.
lib/repositories/…   SQL. One module per concern. Parameterised, always.
lib/context/…        order/listing/tracking resolution
lib/marketplaces/…   per-marketplace adapters; source table names live here
lib/sync/…           ingestion writers
components/…         React. No database imports, ever.
migrations/…         hand-applied SQL pairs
tests/guards/…       24 architecture guards — read these first
documentation/ evidence/ validation/ handover/ …   written records
```

**`lib/domain` is pure.** If a domain module needs the time, the caller passes
it. This is what makes the rules unit-testable without a database, and it is
why the same function can run in the browser to enable a button and on the
server to authorise a write.

---

## 4. The guards — read these before your first change

`tests/guards/` holds 24 files that enforce decisions ordinary tests cannot.
They are not lint. A guard failure is a **design question**, not a test to fix.

Among them:

| Guard | Enforces |
| --- | --- |
| `no-send-capability` | §2.1 |
| `no-customer-data` | no real customer data in any tracked file |
| `api-surface` | which routes may mutate, and exactly what each writer touches |
| `internal-note-visibility` | notes never reach a draft, export or automation |
| `file-naming` | no `day2_`, `final`, `new`, `temp` in permanent names |
| `order-context-display` | the panel never shows system vocabulary to an agent |

**If a guard blocks something you were asked to do:** do not weaken it. Either
the request needs rethinking, or the guard's premise genuinely changed — in
which case rewrite it to enforce the *new* intent and say why in the comment.
Deleting an assertion to go green is the one thing that must not happen here.

### The customer-data guard is not theoretical

`tests/guards/no-customer-data.test.ts` scans everything `git ls-files`
reports. It has caught a real order number committed into four test fixtures,
and caught another during this feature's development. **Run it before you
commit** if you have been building fixtures from live output:

```bash
npx vitest run tests/guards/no-customer-data.test.ts
```

Use obviously-synthetic values in fixtures — `99-99999-99999`, `example.com`.

---

## 5. Conventions you will need immediately

**SQL**

- Every value is bound. No caller string is ever interpolated.
- A table or column name can never come from a database column — it cannot be
  a bound parameter, so interpolating one is injection through data. Build
  statements from compile-time constants and use the stored value only to
  *look up* a prepared statement.
- IDs are `bigint` and are selected as `id::text`. A JavaScript number silently
  rounds a large bigint, and a rounded id is a row nobody can find again.
- Timestamps: `timestamptz` for anything this application generates; naive
  `timestamp` only where a source value is preserved byte-for-byte.

**Append-only tables**

Several tables never update: a change inserts a new row and the newest wins,
ordered `recorded_at DESC, id DESC`. The `id` tiebreak is load-bearing — rows
written in one transaction share `now()`, so the timestamp alone is not a total
order. Do not "simplify" it away.

**React**

- Components never import `@/lib/db/` or `@/lib/config/`.
- `dangerouslySetInnerHTML` is forbidden.
- Do not call `setState` synchronously in an effect body; the lint rejects it.
  If a panel needs per-conversation state reset, the parent keys the component
  by conversation id and the remount does it.

**Tests**

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run test           # vitest run
npx vitest run tests/guards/          # the guards alone
```

13 test files are **opt-in** and skipped by default — each gates itself on an
env flag because it costs a token spend, a network call or a live database
session. Do not make them run by default.

---

## 6. Verifying your own work

Do not ask the user what is on their screen. The repository has tooling to
look:

- **Run the app and read it.** A dev server on `localhost:3000`; drive it
  headlessly and read the DOM and console rather than guessing. Two bugs in the
  root cause feature were found this way and would not have been found by
  reading the code — a race where a late fetch overwrote an agent's click, and
  a field that never appeared because it was gated on a sibling.
- **Query PostgreSQL read-only** to check a schema claim, with
  `SET default_transaction_read_only = on` on the session.

Two traps when driving the browser here:

- `innerText` applies `text-transform`, so a heading styled `uppercase` reads
  back as `CST ROOT CAUSE`, not `CST Root Cause`. Match case-insensitively.
- Opening a conversation is flaky on a single click. Retry until the thing you
  are waiting for exists rather than sleeping a fixed time.

---

## 7. What not to touch without being asked

- **The CST category classifier** (`lib/knowledge/message-category.ts`) is
  **frozen**. A baseline depends on it. It is a different system from root
  cause: different vocabulary, different storage, no shared code path.
- The AI drafting path and its accuracy gate.
- Authentication — there is none, deliberately, and adding it is its own piece
  of work.
- Anything under `Knowledge-source/` (gitignored spreadsheets).
- Unrelated schemas in the same cluster: `issue_tracking`, `poc_listing`,
  `review`, `sku360`, `inventory_control`.

---

## 8. Known-failing tests, so you do not chase them

Three tests in `tests/ai/knowledge-allowlist.test.ts` and
`tests/knowledge/cst-rules-files.test.ts` fail on a clean checkout. They concern
the gitignored spreadsheet corpus and a missing "Message Handling" area, and at
least one is timing-sensitive rather than deterministic.

**They are unrelated to application code.** If your change did not touch
`lib/knowledge/` or `lib/ai/`, they are not yours. A full run should otherwise
be green.

---

## 9. Where the written record lives

Twelve folders carry the project's own documentation, one file per feature:

```
capability/   what the system can and cannot do
closure/      what was built, and the decisions behind it
data-maps/    which column comes from where
documentation/ overviews
duplicate-risk-reports/  where double counting could occur
evidence/     what was measured, and what was NOT verified
handover/     handover.md is a living file, updated in place
prompts/      where AI grounding exists — and where it deliberately does not
query-packs/  the queries a feature runs, and the ones a report will need
sql/          measurement queries, kept so a number can be re-derived
validation/   acceptance tests, including ones not yet run
workflows/    what a person does, step by step
```

`evidence/` is the one to read if you are about to trust a number: it states
what was measured **and what was not**.

---

## 10. A worked example of the house style

The root cause feature (`lib/domain/root-cause-*`, `migrations/0020_*`) is the
most recent addition and demonstrates most of the above in one place:

- vocabulary **measured from live data**, not invented — the query is kept in
  `sql/` so the list can be re-derived and re-versioned
- the same pure function validates in the browser and on the server, so the
  reason a button is disabled is always on screen and the two ends cannot drift
- append-only storage with a child table, because a report must distinguish
  "how many cases" from "how many mentions"
- a cross-table rule enforced in the domain rather than by a trigger, with the
  migration stating plainly that the database is *not* checking it
- guards updated — not deleted — each time the feature's scope genuinely changed

If you are unsure how to shape something here, read that feature first.
