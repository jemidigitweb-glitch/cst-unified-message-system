# CST Senior Developer Handover

**Date:** 2026-09-24
**Branch:** `sync-reconcile-late-arrivals`
**Baseline commit at audit:** `4aa5b6e`

Everything below was verified against the working tree on the date above. Where
a number appears, it was measured — by running the command shown, or by a query
recorded in `sql/`. Nothing here describes a plan.

---

## 1. System overview

An internal workspace that pulls live marketplace customer messages into one
place, groups them into conversations, resolves the verified order and product
context behind each one, and produces a **grounded draft reply for a human to
review**.

```
Live message → Thread → Verify context → AI draft → Review/Edit/Regenerate → Save → reviewed → STOP
```

`reviewed` is terminal. **The system cannot send.** That is enforced in four
independent places, and a senior developer should understand all four before
changing anything on the draft path:

| Level | Mechanism |
| ----- | --------- |
| Database | `ck_conversations_workflow_state` admits only `received · drafting · pending_review · reviewed` |
| Domain | `lib/domain/workflow.ts` permits no transition out of `reviewed` |
| API | No send route exists anywhere under `app/api/` |
| Build | `tests/guards/no-send-capability.test.ts` scans `app/` and `lib/` on every test run |

---

## 2. Architecture

```
┌──────────────── EXTERNAL SOURCES — ALL READ-ONLY ────────────────┐
│ SOURCE_DB  PostgreSQL "ledsone"                                   │
│   customer_service.{ebay_message_headers, ebay_messages,           │
│                     amazon_messages, shopify_messages,             │
│                     bandq_messages, temu_messages}                 │
│   order_management.{orders, order_item_info, shipment,             │
│                     carrier_service, sub_source, order_combo,      │
│                     order_info, note}                              │
│   customers.{customer_info, shipping_address}                      │
│   listings.ebay_listings                                           │
│   configurator.components_sot_*   (Google Sheet mirror)            │
│                                                                    │
│ DB_ORDER_*  MariaDB 10.4 — staff directory. SELECT on 26 tables    │
│ KNOWLEDGE_DB  PostgreSQL, optional, NOT on the draft path          │
│ Knowledge-source/*.xlsx  — 14 workbooks, 12 approved. Gitignored   │
│ Royal Mail Tracking API · OpenAI / Gemini                          │
└──────────┬─────────────────────────────────────────────────────────┘
           │ SELECT only. default_transaction_read_only=on pinned on the
           │ session, so the SERVER refuses a write — not just our code.
           ▼
┌──────────────── APPLICATION — Next.js 16.3.1 / React 19 ─────────┐
│ lib/marketplaces/<mp>/  message-repository → adapter → thread-builder │
│ lib/sync/               watermarked sync · idempotent writers         │
│ lib/context/            order · listing · SOT · bundle · tracking     │
│ lib/knowledge/          workbooks · category · priority · coverage    │
│ lib/ai/                 provider choice · prompt · accuracy gate      │
│ lib/repositories/       parameterised SQL                             │
│ lib/domain/             pure rules, no I/O                            │
│ app/api/  27 routes     components/  36 client components             │
└──────────┬─────────────────────────────────────────────────────────┘
           │ INSERT/UPDATE confined to schema cst_app
           ▼
┌──── APP_DB "varmen_db", schema cst_app — 26 tables / 19 migrations ────┐
│ conversations · conversation_messages · sync_state · context_snapshots │
│ context_order_candidates · context_items · draft_replies               │
│ draft_revisions · draft_revision_sources · cst_rules(+3) ·             │
│ cst_knowledge_sources · ai_usage_log · conversation_rule_analysis ·    │
│ automation_items/templates/settings · internal_notes ·                 │
│ follow_up_reminders · conversation_message_media · agent_activity ·    │
│ agent_directory · response_sla_policy ·                                │
│ unresolved_marketplace_messages · app_users · audit_log                │
└─────────────────────────────────────────────────────────────────────────┘
```

**No ORM, deliberately.** The source database has zero foreign keys, so every
join is an explicitly reviewed SQL relationship rather than one a mapper
inferred. All queries are parameterised.

**Pools live on `globalThis`** — not a style choice. Module-level bindings leaked
a new pool per `next dev` hot reload; a dev server under two hours old was
holding 17 `cst-app` connections against a pool `max` of 3. Pool *size* cannot
fix a leak in pool *count*. See the header of `lib/db/pools.ts`.

---

## 3. Folder structure

```
/
├── app/                        31  pages + 27 API route handlers
│   ├── api/                        conversations · draft · automations · cron …
│   ├── automations/  performance/  page.tsx entry points
│   └── page.tsx                    renders <Workspace />
├── components/                 36  client components (workspace.tsx is the shell)
├── lib/
│   ├── ai/                     11  provider selection, prompt, accuracy gate
│   ├── config/                  1  server-only validated env
│   ├── context/                11  order/listing/SOT/bundle/tracking resolvers
│   ├── db/                      4  pools + connection guards
│   ├── domain/                 48  pure rules, no I/O
│   ├── export/                  1  plain-text conversation export
│   ├── knowledge/              16  workbooks, category, priority, coverage
│   ├── marketplaces/           18  five adapters, one folder each
│   ├── repositories/           22  parameterised SQL
│   ├── sync/                   15  watermarked sync + idempotent writers
│   └── tracking/                6  carrier providers + cache
├── migrations/                 38  19 up/down pairs, applied BY HAND
├── scripts/                    16  import / sync / worker entry points
├── tests/                     172  incl. 26 architecture guards
├── Knowledge-source/            —  rule workbooks. GITIGNORED
│
│   ── twelve documentation folders ──
├── capability/                     what the system can do, per feature
├── closure/                        scope status per feature
├── data-maps/                      table + column maps
├── documentation/                  overviews and audits
├── duplicate-risk-reports/         duplicate-write risk analyses
├── evidence/                       measured evidence behind claims
├── handover/                       THIS FILE
├── prompts/                        prompt-design records
├── query-packs/                    reusable read-only query sets
├── sql/                            approved read-only inspection SQL
├── validation/                     validation status per feature
└── workflows/                      workflow definitions per feature
│
└── tmp/  logs/                     GITIGNORED local working artifacts
```

> `tmp/category-baseline-*.json` is the **frozen category-classifier baseline**.
> The category rule migration is paused after phase 0 and depends on it.
> **Do not delete `tmp/`.**

---

## 4. Feature list

### Implemented

| Feature | Where | Note |
| ------- | ----- | ---- |
| Five marketplace adapters | `lib/marketplaces/` | eBay/Amazon/Shopify `full`; B&Q/Temu `degraded` |
| Watermarked incremental sync | `lib/sync/message-sync.ts` | `(timestamp, pk)` row-value cursor; one transaction per page |
| Idempotent writers | `lib/sync/conversation-writer.ts` | Two unique constraints carry idempotency, not the watermark |
| Body repair pass | `lib/sync/body-repair.ts` | Reads by PK, consults no cursor — eBay writes header and body at different times |
| Derived conversation threading | `lib/domain/threading.ts` | Canonical-JSON thread keys; 30-day gap segmentation; rule-versioned |
| Order context resolution | `lib/context/resolve-order-context.ts` | eBay only; 8 facts; refuses on zero or >1 match |
| Listing / SOT / bundle / tracking context | `lib/context/` | eBay only |
| Grounded AI drafting | `lib/ai/` | Two providers behind one interface |
| Pre-call rule coverage gate | `lib/knowledge/rule-coverage.ts` | No corpus ⇒ no model call |
| Post-generation accuracy gate | `lib/ai/draft-validation.ts` | Deterministic; 6 finding types |
| Draft revisions | migration 0004 | Append-only; no DELETE route |
| Internal notes | migration 0012 | Guarded out of drafts, exports and automations |
| Follow-up reminders | migration 0014 | Reminds a person; cannot contact a customer |
| Post-dispatch automation | `lib/domain/automation/` | Renders to `test_mode` only; contacts nobody |
| Response SLA | migration 0019 | Per-scope policy |
| Performance dashboard | `app/performance/` | **Unauthenticated — see §9** |
| Conversation search, customer notes, unresolved feed, agent activity | various | — |

### Partially implemented

| Feature | State |
| ------- | ----- |
| Context resolution beyond eBay | Every other marketplace returns a deliberate empty fact list |
| SOT product catalogue | Parent-listing route reaches ~1% of listings; component route ~62%. A listing *title* resolves for essentially all |
| Category classification | Implemented and **frozen**; the rule migration is paused after phase 0 |
| Knowledge database | `KNOWLEDGE_DB` and `cst_rules` exist; the draft path reads workbooks from disk instead |

### Not implemented

- **Authentication.** None. No session, no login, no middleware.
- **Sending.** By design, at four levels (§1).
- **Timezone normalisation.** `source_ts_utc` is NULL on every row.
- **Migration runner / ledger.** Migrations are applied by hand.

---

## 5. AI workflow

```
POST /api/conversations/{id}/draft[?force=1][&selectedOrder=…]
│
├─ DEDUPE   newest generated revision postdates newest inbound? → return it, no model call
│
├─ GATE ONE loadRulesForConversation → coverageFor()
│           no corpus ⇒ 409 no_applicable_rule · finding stored · export offered
│
├─ FACTS    five resolvers, each independently try/catch'd so one failure
│           cannot discard another's facts:
│             order (→ manual selection → fallback buyer order)
│             return · SOT/bundle · listing · tracking
│
├─ PROMPT   contextBlocks(): category → order → product → relationship →
│           return → bundle → tracking → CUSTOMER-STATED LAST, not headed VERIFIED
│
├─ MODEL    provider.generate(), wrapped by withDraftValidation()
│
├─ GATE TWO validateDraftAccuracy() — deterministic, pure
│             critical → buys exactly ONE regeneration with corrections
│             minor    → flags for review, spends nothing
│             a draft is NEVER discarded
│
├─ settleReviewRequirement() — review can be FORCED, never CLEARED
│
└─ PERSIST  one transaction: saveRevision + advanceWorkflowState + clearRuleAnalysis
            usage recorded AFTER the commit, never inside it
```

Two properties are load-bearing and should survive any refactor:

1. **Review is a ratchet.** A model returning `requires_review: false` cannot
   talk its way past `settleReviewRequirement`.
2. **Regeneration is bought, not triggered.** Only findings that make a reply
   *wrong* justify a second call. A reply that is true but incomplete goes to
   the reviewer with the gap written down, at no model cost.

There is **deliberately no post-generation citation gate**. A version that had
one refused a conversation with all 1,329 rules available because that run's
refs failed to resolve. Unresolvable citations are an audit finding surfaced by
`/draft/evidence`; they never suppress a draft.

---

## 6. SOT workflow

"SOT" here is the **source-of-truth product catalogue**,
`configurator.components_sot_*` — an EAV mirror of a Google Sheet. It is
unrelated to the production message app's `sot_flag_keywords` feature, which
shares the acronym and nothing else.

```
order resolved and named a SKU?
   YES → resolveSotProductContextForSku(sku)      exact SKU, no guessing
   NO  → resolveSotProductContext(conversation)   parent listing row's SKU
                                                  (refuses if not exactly one)
        ↓
  s.sku = $1  — EXACT. no upper(), no btrim(), no case-fold, NO SPLIT ON '+'
        ↓
  FILTER 1  sotAttributeIsStatable(key) — 14 denylist families.
            Applied in SQL AND re-applied in code, deliberately: a filter that
            exists only in a query cannot be unit-tested.
        ↓
  FILTER 2  statableValue(value) — blank · >300 chars · [VERIFY] · claim words ·
            links · currency.  [VERIFY] is matched as a SUBSTRING, never by
            equality: 433 cells embed it in otherwise-real text.
        ↓
  nothing left → bundle resolver (order_combo decomposition, same two filters)
        ↓
  contextBlocks() buckets by fact NAME; values printed VERBATIM
        ↓
  sotProvenance() — flags a quoted sheet value as needing confirmation (minor)
```

The denylist is a **denylist, not an allowlist**, and it fails open by design:
the first version named seventeen permitted attributes, and a customer asking
"can this be used on a table lamp?" was answered with a request for their
voltage because nobody had added `table_lamp` to the list.

---

## 7. Database overview

**Two engines, four connections.** `SOURCE_DB` (PostgreSQL, read-only),
`APP_DB` (PostgreSQL, writes confined to `cst_app`), `KNOWLEDGE_DB` (PostgreSQL,
read-only, optional), `DB_ORDER_*` (MariaDB 10.4, read-only by GRANT —
MariaDB has no `transaction_read_only`, so `assertOrderSourceReadOnly` verifies
the privilege set at runtime rather than trusting a comment).

**Schema management: by hand.** 19 migrations, no runner, no ledger table. Which
migrations are live in which environment **cannot be determined from this
repository** — run `SELECT table_name FROM information_schema.tables WHERE
table_schema='cst_app'` against each environment.

Three schema decisions that must not be "simplified":

- **Timezone.** `source_ts` holds the naive value byte-for-byte; `source_ts_utc`
  and `source_ts_zone` are NULL until the zone is confirmed. A CHECK enforces
  that you cannot record a converted timestamp without recording the zone you
  assumed. The source server runs Europe/Berlin — an implicit cast would shift
  every message by +2h.
- **Exact SKU.** `context_items.exact_sku` is verbatim. The CHECK tests
  `length() > 0` and deliberately *not* `btrim()` equality: 16 source rows carry
  legitimately untrimmed SKUs.
- **No `selected` column** on `context_order_candidates`. Selection is recorded
  on `context_snapshots` with the confirming user, so no process can mark a
  candidate chosen by being newest — there is nowhere to write it.

---

## 8. Testing status

Measured 2026-09-24 on this checkout:

```
npx tsc --noEmit   → exit 0, clean
npx eslint .       → exit 0, clean
npx vitest run     → Test Files  156 passed | 13 skipped (169)
                     Tests     4,560 passed | 35 skipped (4,595)
                     Duration  ~48s
```

The 13 skipped files are **opt-in**, not broken. Each gates itself on an env
flag stated in its own header because it costs a token spend, a network call or
a live database session — `RUN_LIVE_GEMINI=1`, and equivalents for the source
and repository live suites. **They are not part of the default run and should
not be made so.**

**26 architecture guard tests** enforce design decisions that ordinary tests
cannot: `no-send-capability`, `automation-no-transport`, `internal-note-
visibility`, `no-customer-data`, `api-surface` (no component may import
`lib/config/`), `file-naming`, and others. Treat a guard failure as a design
question, not a test to fix.

**Known coverage gaps** (not failures — untested scenarios):

| Scenario | Status |
| -------- | ------ |
| Customer statement conflicting with a verified fact | **Not covered** |
| SOT data staleness affecting a reply | **Not covered** — `synced_at` is fetched and never used |
| Unsupported *product* claim (waterproof / dimmable / compatible) | Partial — `PROHIBITED_CLAIM_PATTERNS` covers refund/replacement/tracking/delivery/policy only |

One non-blocking warning during the run: a dynamic import in
`tests/marketplaces/shopify-inbox-filter.test.ts` that Vite cannot statically
analyse. It does not affect the result.

---

## 9. Known limitations

1. **No authentication anywhere.** `/performance` names individual staff and
   reports numbers about their work. Access control was deliberately lifted for
   an internal demo and deferred to Vercel Deployment Protection. Nothing in
   this repository limits it. `lib/domain/performance-dashboard-access.ts` is a
   one-line switch and its callers already handle refusal.
2. **Source timezone unconfirmed.** Every displayed timestamp is a naive value
   of unknown zone. Needs the ingestion owner, not code.
3. **Schema state per environment unknowable** from the repo (§7).
4. **Production ingestion cadence.** `vercel.json` runs `/api/cron/sync` once a
   day at 08:00, bounded to 3 pages × 300 rows per feed. An unmerged
   `sync-every-five-minutes` branch exists.
5. **`/api/cron/sync` fails closed** when `CRON_SECRET` is unset — correct, but
   a missing variable looks like an outage.
6. **SOT coverage is thin and `synced_at` is discarded** (§6, §8).
7. **`KNOWLEDGE_DB` / `cst_rules` are not on the draft path.** Whether the
   database snapshot is current, authoritative or abandoned is unverified.
8. **`.env.example` drift** — it omits `DB_ORDER_*` and `CRON_SECRET`, so a
   fresh clone following it gets no MariaDB source and a cron route that refuses
   every request.

---

## 10. Recommended next steps

**Read in this order.** The header comments are the most reliable documentation
in this repository — they record measured evidence and, repeatedly, the exact
bug a piece of code exists to prevent. Read the header before editing the body.

1. `README.md` → this file → `documentation/2026-09-08-implemented-system-overview.md`
2. `lib/db/pools.ts` — the connection model and why pools live on `globalThis`
3. `lib/domain/threading.ts` — why thread keys are canonical JSON
4. `lib/sync/message-sync.ts` + `conversation-writer.ts` — the whole ingestion contract
5. `app/api/conversations/[conversationId]/draft/route.ts` — the draft path end to end
6. `lib/ai/draft-validation.ts` — the accuracy gate

**Then, before writing code:**

1. **Confirm schema state** per environment (§7). Every plan depends on it.
2. **Confirm the rule corpus is reachable in the deployed build.** `Knowledge-
   source/` is gitignored while `.vercelignore` re-includes `*.xlsx`. A Vercel
   build from git has no workbooks, and `coverageFor()` would then refuse every
   draft — on the OpenAI path too, because that gate reads local files and never
   consults the vector store. **Verify this first; it decides whether the AI
   feature is live or dark in production.**
3. **Ask the ingestion owner the timezone question** (§9.2). One answer unblocks
   a permanent fix.

**Highest-value work, in dependency order:**

| # | Work | Risk |
| - | ---- | ---- |
| 1 | Sweep the SOT denylist against the live 6-tab schema. It was validated against 413 keys on a 3-tab schema; the catalogue is now 1,824 SKUs across 6 tabs, and the denylist fails open | Low — test only |
| 2 | Surface `synced_at` (already fetched, never used) | Low |
| 3 | Typed empty-reason from the SOT resolver, so a reply can say "we don't publish that" rather than promising to check | Low-Medium |
| 4 | Authentication, closing §9.1 and giving every write a real actor | Medium |
| 5 | Ground `ungroundedClaims` against *named* facts rather than a concatenated blob of all fact names and values | Medium |

**House rules to preserve:**

- Unmapped values are **rejected and counted**, never guessed.
- Ambiguity is **surfaced**, never resolved by the machine.
- Degradation is **reported**, never hidden — `unusableCount`,
  `excludedSystemNoticeCount`, `restricted` and `moreAvailable` all exist so a
  reader can tell "nothing found" from "stopped looking".
- New database access goes through `lib/db/pools.ts`. A module-level
  `new Pool()` reintroduces the measured hot-reload leak.
- Migrations are reviewed by **static tests that read the SQL as text and never
  execute it**. Follow that pattern for migration 0020.
