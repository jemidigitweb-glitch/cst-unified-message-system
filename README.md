# CST Unified Message System — Phase 1

Internal workspace that pulls live marketplace customer messages into one place,
groups them into conversations, shows the verified order/product context behind
each one, and helps a CST agent produce a grounded draft reply for human review.

## Purpose

Phase 1 exists to get a **reviewed draft**. Nothing more.

```
Live Message → Thread → Verify Context → AI Draft → Review/Edit/Regenerate → Save → Reviewed → STOP
```

`reviewed` is the terminal state.

## Scope

**All five marketplaces are active.** Each is ingested, threaded and rendered;
what differs is how much of a conversation its source can prove. The modes below
are declared once in `lib/domain/marketplace-capabilities.ts` and read by generic
components, so adding a marketplace is a data change rather than a UI edit.

| Marketplace | Mode           | What the source establishes                              |
| ----------- | -------------- | -------------------------------------------------------- |
| eBay        | `full`         | Direction from `folder_id`; previous CST replies present  |
| Amazon      | `full`         | Direction from sender domain + sender name                |
| Shopify     | `full`         | Direction from both addresses; 14.8% undecidable, rejected |
| B&Q         | `degraded`     | Inbound-only (verified); no counterparty identity         |
| Temu        | `degraded`     | Inbound-only (verified); no reliable conversation key      |

Order, listing and product context resolution is still **eBay-only** — see
`lib/context/`. Every other marketplace gets a deliberate empty fact list, and
the generator is told there is no resolved context rather than guessing one.

## Non-negotiable rules

### No sending

Phase 1 contains **no capability to transmit a reply to a customer** — no send
button, endpoint, queue, retry, marketplace connector, outbound credentials, or
copy-to-marketplace handoff. There is no workflow state after `reviewed`.

`tests/guards/no-send-capability.test.ts` enforces this on every test run.

### The source database is read-only

The live marketplace database is shared with unrelated production systems. This
application only ever reads from it. The read-only pool additionally sets
`default_transaction_read_only=on` at the session level, so the server rejects a
write rather than trusting the caller.

Application writes go to the application database, confined to the `cst_app`
schema. That schema is defined by the **19 migrations** in `migrations/`, applied
by hand — there is no migration runner and no ledger table, so which migrations
are live in a given environment is not knowable from this repository. Code
detects drift reactively, with errors naming the migration to apply.

### SKUs are atomic

A SKU is one opaque identifier. Never split on `+`, trim, normalise, case-fold,
reconstruct, or interpret separators. `PSHYOS4BRBM+SPUPBM+LSDO210BM` is a single
SKU with its own product master row; its components are already decomposed
upstream. **The database value always wins over an example written in
documentation.**

### Context is never guessed

Where a conversation matches several genuine purchases, the backend shows the
candidates and waits. It does not pick one, and order-derived facts stay out of
the AI draft until a human selects the right context.

## CST knowledge authority

The rule corpus is read from the workbooks in `Knowledge-source/`, which is
**gitignored** — the documents are the authority and no CST document content is
stored in this repository. Parsing is cached on every file's size and mtime, so
an edited workbook invalidates itself on the next read.

`lib/knowledge/knowledge-files.ts` names the **twelve approved workbooks** as an
exact-match allowlist, so a renamed or newly added file is silently *not*
uploaded to the vector store rather than silently uploaded. Two files present in
the folder are deliberately excluded: `B2B  customers .xlsx` (customer contact
data — must never leave the machine) and `Message rules final.xlsx` (an index
duplicate of MESSAGE HANDLING RULES).

**No corpus means no draft.** `coverageFor()` in `lib/knowledge/rule-coverage.ts`
runs *before* the model call; with nothing to ground a reply in, the request is
refused (409 `no_applicable_rule`), the finding is stored on
`cst_app.conversation_rule_analysis`, and the conversation is offered as a
plain-text export for a human instead.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck
npm run lint
npm test
npm run build
```

Copy `.env.example` to `.env` and fill in local values. `.env` is gitignored and
must never be committed. Every credential is server-side only — nothing is
exposed under `NEXT_PUBLIC_`, and config modules are marked `server-only` so
importing them from client code is a build error.

`GEMINI_API_KEY` is optional. Left unset, the application starts and runs
normally; only draft generation reports itself unconfigured, quoting the
variable to set. Check it without spending a token via `geminiStatus()` in
`lib/ai/gemini-client.ts`, which returns the model name and never the key.

## Layout

| Path                  | Files | Purpose                                                          |
| --------------------- | ----- | ---------------------------------------------------------------- |
| `app/`                | 31    | Pages and 27 route handlers                                       |
| `components/`         | 36    | Client components; `workspace.tsx` is the shell                   |
| `lib/config/`         | 1     | Server-only, validated environment access                         |
| `lib/db/`             | 4     | node-postgres pools (source RO / app / knowledge RO) + MariaDB RO |
| `lib/domain/`         | 48    | Pure domain rules and invariants. No I/O                          |
| `lib/marketplaces/`   | 18    | Per-marketplace repository → adapter → thread-builder             |
| `lib/sync/`           | 15    | Watermarked incremental sync and idempotent writers               |
| `lib/context/`        | 11    | Order / listing / SOT / bundle / tracking resolvers               |
| `lib/knowledge/`      | 16    | Workbook extraction, category, priority, rule coverage            |
| `lib/ai/`             | 11    | Provider selection, prompt assembly, accuracy gate                |
| `lib/repositories/`   | 22    | Parameterised SQL data access                                     |
| `lib/tracking/`       | 6     | Carrier providers and tracking cache                              |
| `lib/export/`         | 1     | Plain-text conversation export                                    |
| `migrations/`         | 38    | 19 up/down pairs, applied by hand                                 |
| `tests/`              | 172   | Domain, repository, sync, AI and 26 architecture guards           |
| `scripts/`            | 16    | Import, sync and worker entry points                              |
| `Knowledge-source/`   | —     | CST rule workbooks. **Gitignored**                                |

Twelve documentation folders sit alongside these — see **Documentation** below.

## Documentation

**Start at `handover/handover.md`.** It is the current system description:
architecture, feature status, AI and SOT workflows, database overview, measured
test results, known limitations, and a reading order.

The twelve folders each answer one question about a feature, and each carries a
`README.md` stating its own purpose:

| Folder                    | Answers                                      |
| ------------------------- | -------------------------------------------- |
| `capability/`             | What can the system do?                       |
| `closure/`                | What was in scope, and is it finished?        |
| `data-maps/`              | Which tables and columns does it touch?       |
| `documentation/`          | How does it work, in prose?                   |
| `duplicate-risk-reports/` | Where could it write the same thing twice?    |
| `evidence/`               | What was measured, and what did it show?      |
| `handover/`               | What does the next developer need?            |
| `prompts/`                | How was a prompt designed, and why?           |
| `query-packs/`            | Which read-only queries answer this again?    |
| `sql/`                    | Approved inspection SQL. Every statement a SELECT |
| `validation/`             | How was it checked?                           |
| `workflows/`              | What is the step-by-step flow?                |

Feature documents are dated (`2026-09-21-post-dispatch-automation-*.md`) because
they describe one piece of work at one time. `handover/handover.md` is not dated
in its filename because it is the living document — update it in place.

**The most reliable documentation in this repository is the header comment on
each module.** Headers record measured evidence — row counts, percentages, dated
incidents — and, repeatedly, the exact bug a piece of code exists to prevent.
Read the header before editing the body.

No ORM: the source database has no foreign keys, so every join must be an
explicitly reviewed SQL relationship rather than one a mapper infers. All queries
are parameterised.

## Status

**Implemented and running.** Five marketplace adapters with watermarked,
idempotent incremental sync; derived conversation threading; a 26-table `cst_app`
schema across 19 migrations; eBay order / listing / SOT-product / bundle /
tracking context resolution; grounded AI drafting behind two providers with a
deterministic post-generation accuracy gate; append-only draft revisions;
internal notes; follow-up reminders; a post-dispatch automation that renders in
`test_mode` and contacts nobody; and a performance dashboard.

Verified on the current checkout:

```
npx tsc --noEmit   → clean
npx eslint .       → clean
npx vitest run     → 156 files passed, 13 skipped; 4,560 tests passed, 35 skipped
```

The 13 skipped files are **opt-in** suites that cost a token spend, a network
call or a live database session. Each states its own flag in its header — for
example `RUN_LIVE_GEMINI=1`.

### Known limitations

- **No authentication of any kind** — no session, no login, no middleware, and
  `cst_app.app_users` holds zero rows. `/performance` names individual staff.
  See `lib/domain/performance-dashboard-access.ts`, which is a one-line switch.
- **Source timezone unconfirmed** — `conversation_messages.source_ts_utc` is NULL
  on every row by design. Naive source timestamps are preserved verbatim.
- **Order context is eBay-only.**
- **SOT catalogue coverage is thin** — the parent-listing route reaches ~1% of
  listings and the component route ~62%; a listing *title* resolves for
  essentially all of them. See `sql/sot-product-reachability.sql`.
- `tmp/` and `logs/` are gitignored local working artifacts, not build output.
  `tmp/category-baseline-*.json` is the frozen category-classifier baseline and
  must not be deleted.
