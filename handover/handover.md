# CST  Handover

**Date:** 2026-09-29
**Branch:** `sync-reconcile-late-arrivals`
**Baseline commit at audit:** `9a541b2`

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
| Post-dispatch automation | `lib/domain/automation/` | Renders to `test_mode` only; contacts nobody — **see §8** |
| Category tagging | `lib/knowledge/message-category.ts` | Eleven case areas, deterministic, not persisted — **see §7** |
| Response SLA | migration 0019 | Per-scope policy |
| Message App root cause display | `lib/domain/message-app-root-cause.ts` | Read-only; shows the other system's value, refuses to pick when a thread's values disagree |
| CST root cause capture | migration 0020 — **NOT APPLIED** | Append-only; 18 measured labels + courier/issue-type/note — **see §13** |
| Performance dashboard | `app/performance/` | **Unauthenticated — see §11** |
| Conversation search, customer notes, unresolved feed, agent activity | various | Customer notes carry a search box — order reference or name, across marketplaces |

### Partially implemented

| Feature | State |
| ------- | ----- |
| Context resolution beyond eBay | Every other marketplace returns a deliberate empty fact list |
| SOT product catalogue | Parent-listing route reaches ~1% of listings; component route ~62%. A listing *title* resolves for essentially all |
| Category classification | Implemented and **frozen**; the rule migration is paused after phase 0 |
| Knowledge database | `KNOWLEDGE_DB` and `cst_rules` exist; the draft path reads workbooks from disk instead |

### Searching the customer-notes panel

The notes drawer carries a search box above its marketplace tabs. It reads the
**order reference** and the **customer name** — never the note text, or typing
an order number would return the note that mentions it beside the note that is
it, and the row prints only those two fields so a reader could not tell which.

**It narrows what is already loaded.** No request, no endpoint, no query
parameter: the panel holds one bounded page and the box filters it, which is
why the "most recent customer notes" caveat beneath the list changes from
*Showing* to *Searched* while a query is active. A searchable list otherwise
reads as a complete index of every note there has ever been.

**The search runs before the tabs are counted**, so the counts describe the
search: an agent with an order number who does not know which marketplace it
was bought on reads `Amazon 1` rather than an empty eBay list. When the current
tab has no match and another does, the empty state says how many.

`searchCustomerNotes` is a pure function in `lib/domain/customer-note.ts`; the
drawer still holds no state of its own. A reference is matched with punctuation
removed from both sides — the marketplaces do not agree on any of it — and
every whitespace-separated term must match, so a second word narrows.

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

## 7. Category tagging flow

**Eleven CST case areas, assigned deterministically at read time, stored
nowhere.** This is the chip beside each conversation in the inbox, the inbox
filter, and one input to the draft prompt.

```
MESSAGE_CATEGORIES (lib/knowledge/message-category.ts)
  Delivery queries · Pre sales queries · Admin related issues
  Order change, before shipping queries · Defective items · Damage queries
  Wrong item sent messages · Parts missing queries · Wrong quantity sent issues
  Wrong description issues · Return and refunds
```

### The pipeline

```
listConversations()  ← INBOUND_TEXTS already selected for this row
        │
        ▼
categoryFor(row)  — four outcomes, in this order:
  1. marketplace is bandq or temu       → null      (suppressed: stored text is
                                                     known to carry non-customer
                                                     content, so any fallback
                                                     would turn noise into findings)
  2. readable customer text              → classify, and WHATEVER IT RETURNS STANDS,
                                           including null
  3. inbound exists but every body empty → "Admin related issues"
                                           (UNREADABLE_CONTENT_CATEGORY)
  4. no inbound message at all           → null     (outbound-only threads)
        │
        ▼
classifyConversationCategory(readable[])      ← per-message array, in order
   (falls back to classifyMessageCategoryWithFallback for older projections)
        │
        ├── SIGNALS            hand-written phrase table, scored by match count
        ├── corpusMatches()    730 rows / 7,825 phrases from eleven workbooks
        ├── CST_EVIDENCE       ownership resolution — whose thing is broken
        └── semanticsOf()      speech act, claim status, clause splitting
        │
        ▼
  tie between two equally strong signals → null (uncategorised), never a coin toss
        │
        ▼
CategoryTag  — renders NOTHING when null. An absent chip is the honest rendering
               of "no category was established"; a grey "Uncategorised" chip
               would spend a row's attention reporting nothing.
```

### Four properties that define this design

**It is not a model call.** The classifier is a phrase table a reviewer can read
and challenge. `lib/knowledge/message-category.ts` is pure — no network, no
model, no database.

**It is not persisted.** Classification runs on the read path of every
conversation in the inbox. A phrase-table change therefore takes effect on the
next request rather than needing a backfill, and there is no stored category
that can go stale against the code that produced it.

**A corpus match is a candidate, never a verdict.** `cst-corpus-match.ts` finds
which of 7,825 phrases appear in a message and stops there. Three rules keep
that from degenerating into a blind keyword vote:

| Guard | Effect |
| ----- | ------ |
| `RuleRole` | Only `PRIMARY_ISSUE` rows may propose a category. "Please refund me" matches rows in six workbooks and is a reason to file under none of them |
| Shared phrases | A phrase claimed by three or more categories decides nothing. It stays in the corpus so a reviewer can see that "not what I ordered" appears in four books — it just cannot vote. Measured from the corpus itself, so it stays true as the workbooks change |
| The caller | `message-category.ts` checks each proposal against what the whole message says and resolves ownership before anything becomes a category |

**The thread is read in order.** The per-message array is preferred over a
concatenated column, because that is what stops a closing "found it, all sorted"
costing a conversation the category its opening message earned — and what stops
two unrelated sentences in two unrelated messages forming a phrase neither
contains.

### A negated receipt needs a SUBJECT — 2026-09-30

eBay 33222 was tagged **Delivery queries**. It is a 2-core / 3-core cable enquiry.
The customer answered our question a month late and apologised:

> "Hi i need a 3 core. So sorry, i dont get notifications come through."

`DEL-13.1`, the sheet 13 non-receipt catch-all, matched `dont` ... `come` straight
across " get notifications ". It asked whether a receipt had been NEGATED and never
asked WHAT had failed to arrive. Delivery is a case category and Pre sales is not,
so one fabricated parcel report took the thread — while `INT-PS19` matched "3 core"
in the very same sentence.

**The chip and the ribbon disagreed, and that is how it was found.**
`explainMessagePriority` read `pre_sales_enquiry`, LOW. The two are allowed to
differ, but a flat disagreement about what a conversation IS is worth reporting.

The fix is a subject test on that one pattern, in
`lib/knowledge/cst-category-evidence.ts`. Two lookaheads, because the subject lands
on either side of the verb — "dont get NOTIFICATIONS come" before, "did not receive
any NOTIFICATION" after. Both windows stop at a sentence boundary, so a customer
who says both still reports a non-delivery.

**THE CORPUS CUT THE FIX DOWN, and this is the part to read before widening it.**
The first attempt excluded everything that arrives by wire — notification, email,
update, confirmation, alert, text, sms. `cst-category-corpus.test.ts` failed and
named row `5.2`: **sheet 5 – Not Dispatched owns "No dispatch email received", "No
shipping confirmation at all" and "No update at all since I ordered".** A customer
chasing a missing dispatch email is reporting a parcel that never left, which IS a
delivery query.

So the list is only the conversation's own words — notification, message, reply —
with a parcel exception, because three more corpus phrases had to survive: "No
notification about where it was left" (sheet 2), "No notification to collect" and
"Parcel was taken to a collection point but customer was not notified" (sheet 11).
`PARCEL_QUALIFIER_BEFORE` / `_AFTER` are what keep them. **That reachability test is
the guard on this change — do not widen the list without it passing.**

`message-category.ts` is NOT edited; this is one trigger pattern in the evidence map
it consults, and the frozen baseline is otherwise untouched (1,292 category tests
pass). Controls for every phrase sheet 13 quotes are pinned in
`tests/knowledge/category-regression.test.ts`.

Full detail: `documentation/2026-09-30-non-receipt-subject-test-overview.md`.

### The one correction an ORDER makes to the category — 2026-09-30

Everything above reads TEXT. One category makes a claim the text cannot settle:
"Order change, **before shipping** queries" asserts something about the order.
CST's rule, in their words: *the conversation's order had not shipped when the
message was received; if it is shipped, it is not order before shipping.*

Nothing was checking that, so a request made days after dispatch still arrived
under a heading asserting the window was open. Two conversations found on screen:

| Conversation | What the customer wrote | The order |
| ------------ | ----------------------- | --------- |
| eBay 50802 | Received the 1-light, proceeding with the cancellation of the 3-light | that order shipped **nine days earlier** |
| eBay 40467 | "thinking 3 separate lights might be more suitable, how do we go about swapping them" | shipped **the day before** — and this is not a cancellation at all |

```
category === "Order change, before shipping queries" ?
   │ no  → nothing happens. No other category claims anything about an order.
   ▼ yes
requestTargetOrder()   which order is the request about?
   ├── one order number the customer TYPED            → resolved
   ├── two typed, or several known and none typed     → ambiguous  → no change
   └── no order known at all                          → unavailable → no change
   ▼ resolved
the dispatch state whose orderNumber IS the target's
   ├── none supplied / a SIBLING's was supplied       → no change, and it says which
   ├── not dispatched                                 → before shipping stands
   ├── shipped unambiguously AFTER the message        → before shipping stands
   └── shipped                                        → "Return and refunds"
```

**Three things to know before editing it** (`lib/domain/before-shipping-dispatch-rule.ts`):

- **The classifier did not move.** `lib/knowledge/message-category.ts` is
  untouched and still frozen. This is a separate pure rule applied to the
  category it produced — the classifier reads the request, the source reads the
  order, and the two axes stay apart.
- **The dispatch state names its own order.** `VerifiedDispatch` is
  `{orderNumber, dispatched, dispatchedAt}` and the rule compares that name
  against the resolved target. Reducing it to a bare boolean would make "use the
  displayed order's status by mistake" a one-line regression again, and
  untestable. The negative half of
  `tests/domain/before-shipping-dispatch-rule.test.ts` exists for exactly this.
- **No new vocabulary.** The cancellation reading runs CST evidence row
  `INT-OS01` **by id** — the row whose own condition already said "CANCELLATION —
  not dispatched. Check dispatch status first". It is *reported*, never a
  condition: 40467 is a swap, and the ORDER is what decides.

**The ordering of the two timestamps is asserted only past 24 hours**
(`DISPATCH_ORDERING_MARGIN_HOURS`). `shipped_time` is naive in the source and the
message instant is `COALESCE(source_ts_utc, ingested_at)`; the margin is wider
than any inhabited zone offset, and anything closer resolves to "the order has
gone" — a parcel that left within a day of the message cannot be stopped now.

**It runs on the ordinary inbox stream**, via `applyBeforeShippingDispatchRule`,
not only on the urgent sweep — 50802's newest message is OURS, so it was never an
urgent candidate. `beforeShipmentOutcome` still reads `already_dispatched`
alongside the corrected chip, because the correction is applied *after* the
urgent rule and never before.

**Measured 2026-09-30:** 9 of ~900 conversations across three marketplaces still
carry the category; all nine audited — 4 have no verified order, 5 are genuinely
unshipped. Re-derive with `sql/2026-09-30-before-shipping-dispatch-audit.sql`.

**Two things left open, both CST's to settle:**

1. `cst-category-corpus.ts` row `2 A2` is called "Customer requests cancellation
   — order ALREADY dispatched" and its `category` field says *Order change, before
   shipping queries*, while its `condition` describes a return. The rule
   implements the condition; the workbook still says the other thing.
2. A post-dispatch **address change** now becomes Return and refunds.
   `marketplaceAddressAdmin` already files it as Admin where the TEXT says the
   order has gone. Nobody has counted how many exist.

Full detail: `documentation/2026-09-30-before-shipping-dispatch-rule-overview.md`.

### Where the category is consumed

| Consumer | Use |
| -------- | --- |
| Inbox list | The chip (`components/category-tag.tsx`) and the category filter |
| Before-shipment urgency | `ORDER_CHANGE_CATEGORY` is imported, not retyped, so the flag and the notification feed match on the same string |
| Draft prompt | `categoryBlock()` emits it as **INTERNAL GUIDANCE**, explicitly not a verified fact — *"where it disagrees with what the customer plainly wrote, the customer's own words win"*, and the model is told never to mention it |
| Draft validation | `categoryCoverage()` re-reads it to check the reply addressed what was asked |

**The draft path reads the UNCORRECTED category.** `draft-assembly.ts` and
`draft-validation.ts` call `readConversation` directly, so a conversation the inbox
now shows as "Return and refunds" is still graded against the intent owning "Order
change, before shipping queries". Deliberately out of scope on 2026-09-30 and the
next thing to reconcile — see
`duplicate-risk-reports/2026-09-30-before-shipping-dispatch-duplicate-risk.md`.

### The URGENT badge stops when the customer signs off

`isPleasantryOnly` (`lib/knowledge/message-category.ts`) is the wording half of
the closure signal; the repository supplies the other half (`ever_replied`), and
`beforeShipmentEligibility` returns `thread_resolved`. Two conversations found
on screen drove it:

| Conversation | Newest inbound | Was |
| ------------ | -------------- | --- |
| eBay `piotr.woss-uk` | "Great Thanks" ×2 | URGENT, SLA 14 days overdue |
| eBay `david_tuck_ward` | "Many thanks James, that is much appreciated. Best regards, David." | URGENT, SLA counting down |

The second needed three things no vocabulary can hold — the agent's name, the
customer's own name, and an appreciation clause. So the two positional name
slots (vocative after a thanks or greeting, signature at the very end) are
removed by `withoutNames`, `NOT_A_NAME` keeps a request out of those slots, and
what remains is tested against `SIGN_OFF_ONLY` — `PLEASANTRY_ONLY` plus
`APPRECIATION_CLAUSE`.

**A cancellation is never a sign-off.** That direction is the one the rule may
not fail in: a wrong sign-off costs a red badge on a finished thread, a wrong
cancellation drops the most time-critical message in the inbox out of the urgent
block while its window closes. Ten phrasings are pinned in
`tests/guards/before-shipment-urgency.test.ts`.

**The classifier did not move.** `PLEASANTRY_ONLY` is unchanged in what it
matches and is still the only pattern the thread reading consults, so the frozen
baseline below is untouched — the wider reading lives in `SIGN_OFF_ONLY` and is
consulted only by the urgent rule.

### Related but separate — do not merge these

- **`classifyCaseType`** names the request behind a conversation the rule base
  could *not* ground a reply for, and joins `cst_app.conversation_rule_analysis`
  and the No Rule list. It has its own label vocabulary. Reusing one for the
  other would either break stored, compared-against data or make the two tabs
  call the same thing by different names.
- **`explainConversationPriority`** answers "how soon", not "what about". It is
  deliberately a second, independent reading of the same column and shares no
  code with the category.

### Corpus regeneration

`lib/knowledge/cst-category-corpus.ts` is **generated — do not edit by hand**:

```bash
node scripts/build-category-corpus.mjs --write
```

It is committed rather than parsed at runtime because classification is on the
read path; reading eleven spreadsheets per message would not be cheap,
deterministic or local. The workbooks remain the authority and this is their
reviewed, reproducible projection.

### Current state — FROZEN

The category rule migration is **paused after phase 0** and the classifier is
frozen pending a decision to resume. `tmp/category-baseline-*.json` is the
baseline that work depends on; **do not delete `tmp/`**. Unmerged branches
`phase-1-category-storage`, `store-category-rules`,
`prepare-category-rules-for-the-database` and
`classify-from-the-whole-cst-corpus` belong to it.

Coverage as measured 2026-09-24 — 1,032 tests across six files, all passing:

```
tests/knowledge/category-golden-set.test.ts   tests/knowledge/message-category.test.ts
tests/knowledge/category-regression.test.ts   tests/knowledge/cst-category-corpus.test.ts
tests/knowledge/category-ownership.test.ts    tests/guards/category-tag.test.ts
```

Background on why the fallback is what it is:
`documentation/2026-09-03-category-classification-audit.md`.

---

## 8. Dispatch automation flow

**It schedules, rechecks and renders. It contacts nobody.** The post-dispatch
automation is the only scheduled writer in the system besides the sync. It is
deterministic: no model runs, no corpus is retrieved, nothing is drafted or
reviewed. The CST draft workflow is a different feature and is untouched by it.

### Lifecycle

```
AUTOMATION_ITEM_STATUSES  (lib/domain/automation/automation-types.ts)
  scheduled   discovered, waiting for scheduled_at
  sent        processed successfully — in this phase ALWAYS in test mode
  skipped     the recheck found the order no longer qualified
  failed      processing could not complete
  cancelled   an operator stopped it before processing
```

There is deliberately no `sending`, no `drafting`, no `pending_review` and no
`reviewed`. `PROCESSED_MODES` has exactly one member, `test_mode` — *"a second
would mean a transport exists."*

### The run

```
runPostDispatchAutomation({ app, source, scanLimit≤1000, draftLimit≤200 })
│
├─ settings row missing?        → refuse. A missing row is NOT "use the defaults";
│                                 it means 0011 was never seeded, and inventing a
│                                 not_before here is the backfill this design exists
│                                 to prevent
├─ scanRefusal(settings)        → one refusal covers BOTH halves. Switching the
│                                 automation off stops scheduled records too —
│                                 draining a queue after the switch was thrown is
│                                 the opposite of what "off" means
├─ template missing/unapproved/inactive → refuse
│
├─ SCAN   findDispatchedShipments(source, { notBefore, subSourceIds, limit })
│   └─ per shipment:
│        eligibilityForPostDispatch()  ← SQL floor and scope re-applied IN CODE.
│                                        Two implementations agreeing is what makes
│                                        the query an optimisation, not the policy
│        itemExistsForShipment()       ← app asks first, so a repeated scan writes
│                                        nothing; uq_automation_items_shipment
│                                        decides anyway, so two concurrent scans
│                                        cannot both insert. Status-blind
│        insertScheduledItem()         ← stamps templateId + templateVersion NOW,
│                                        so changing the selection tomorrow does
│                                        not rewrite today's provenance
│
└─ PROCESS  processDueItems() — oldest first
     SELECT … FOR UPDATE SKIP LOCKED, every outcome written in the SAME
     transaction: a second run cannot take a record this one holds, and a crash
     mid-run leaves rows `scheduled` rather than half-processed
        │
        ├─ FRESH source read + eligibility recheck  → skipped
        ├─ renderTemplate()                         → failed on any unresolved hole
        └─ markItemProcessed(testMode)              → sent
```

### Why eligibility runs twice

Once at scan time so an ineligible shipment never becomes a record, and again
immediately before processing **on a fresh source read** — because the delay
between those two moments is exactly when an order gets cancelled, refunded or
returned, and a message rendered from the scan's snapshot would be a cheerful
dispatch update about a parcel the customer has already sent back.

Status values are the source's own, confirmed live rather than assumed:

| Column | Values |
| ------ | ------ |
| `shipment.status` | Completed (1,005,997) · New (141,623) · Cancelled (7,045) |
| `orders.status` | Completed (1,079,963) · Refunded (18,887) · Cancelled (10,726) · Deleted (879) · Inprogress (699) · Hold (29) · New (8) |

"Dispatched" means `shipment.status = 'Completed'` **and nothing else** — `New`
is a shipment that has not gone out. Comparison is case-insensitive because the
source's capitalisation is a display choice, not a contract.

Returns and cancellations are authoritative and join cleanly on (order number,
storefront): `ebay_returns` matched all 42,185 rows, `ebay_order_cancellations`
all 4,551, `amazon_returns` 13,085 of 15,636. **A return row means "returned"
whatever state it is in** — 37,814 eBay rows carry a null state, and the safe
reading of a return whose outcome is unrecorded is to say nothing.

### Template rendering

Substitution only — no expression language, no conditionals, no fallback text,
no defaults. Every `{{placeholder}}` is replaced by a value copied from a source
column, **or the render fails**:

> "Your order  has been dispatched" and "Your order null has been dispatched"
> are both messages this business would not send, and both would sail through a
> render that treated an absent value as an empty string.

A literal `{{courier}}` reaching a customer is worse than either, so anything
unresolved fails, not just `requiredVariables`. The customer's name is available
because the message is addressed to them; their email, address and phone are
not, because a dispatch update needs none.

### Triggers

| Entry point | Cadence |
| ----------- | ------- |
| `GET /api/cron/automation` | Fails closed without `CRON_SECRET`; asserts app DB + read-only source first. **No `vercel.json` cron entry exists for it** |
| `npm run worker:automation` | Long-running. Sleeps until the soonest `scheduled_at` rather than polling |
| `npm run worker:automation:once` | One pass, exit |

The worker is woken by **two mechanisms, deliberately**: `pg_notify('cst_automation_wake', …)`
fired inside the writing transaction (migration 0015), so a rolled-back insert
wakes nobody — plus one small indexed `SELECT` every 15 seconds against
`ix_automation_items_due`. *"The second is the guarantee; LISTEN is the speed."*
Nothing is processed early because of the recheck.

### Safety, enforced not asserted

| Level | Mechanism |
| ----- | --------- |
| Database | `ck_automation_items_sent_requires_test_mode` — a row cannot reach `sent` unless it is a test-mode row |
| Database | `uq_automation_items_shipment` — one record per shipment |
| Domain | `PROCESSED_MODES` has one member |
| Build | `tests/guards/automation-no-transport.test.ts` — no marketplace client, mail host, credential, outbound URL or sender anywhere beneath the runner |

`no-send-capability.test.ts` grants this automation — and only it — the literal
word `sent`, by exact path. The prohibition is on a **capability**, not a
spelling, and the database refuses a non-test-mode `sent` row regardless.

Migration 0013 exists because 0011's original cancel CHECK was a biconditional
(`cancelled_at` set **iff** `status = 'cancelled'`), which forbade Undo Cancel:
restoring sets `status` back to `scheduled` while deliberately keeping
`cancelled_at` as history. 0013 relaxes it to one direction only.

### Current state

Working and running in **test mode only**. Every processed record is a rendered
string in `cst_app`; nothing has ever been transmitted. Turning that into real
customer contact means **adding the transport it was deliberately built
without** — that is new capability requiring business approval, not a
configuration change.

Coverage measured 2026-09-24 — 145 tests across five files, all passing:

```
tests/automation/post-dispatch-scan.test.ts        tests/guards/automation-undo-cancel.test.ts
tests/automation/post-dispatch-processing.test.ts  tests/guards/automation-worker.test.ts
tests/guards/automation-no-transport.test.ts
```

Further reading: `documentation/2026-09-21-post-dispatch-automation-overview.md`,
`workflows/2026-09-21-post-dispatch-workflow.md`,
`sql/2026-09-21-post-dispatch-source-verification.sql`.

---

## 9. Database overview

**Two engines, four connections.** `SOURCE_DB` (PostgreSQL, read-only),
`APP_DB` (PostgreSQL, writes confined to `cst_app`), `KNOWLEDGE_DB` (PostgreSQL,
read-only, optional), `DB_ORDER_*` (MariaDB 10.4, read-only by GRANT —
MariaDB has no `transaction_read_only`, so `assertOrderSourceReadOnly` verifies
the privilege set at runtime rather than trusting a comment).

**Schema management: by hand.** 20 migrations, no runner, no ledger table. Which
migrations are live in which environment **cannot be determined from this
repository** — run `SELECT table_name FROM information_schema.tables WHERE
table_schema='cst_app'` against each environment.

**0020 is written and NOT APPLIED anywhere.** It is the only migration in this
state. The application degrades honestly without it — see §13.

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

## 10. Testing status

Measured 2026-09-25 on this checkout:

```
npx tsc --noEmit   → exit 0, clean
npx eslint .       → exit 0, clean
npx vitest run     → Test Files  156 passed | 13 skipped (169)
                     Tests     4,599 passed | 35 skipped (4,634)
                     Duration  ~58s
```

The 13 skipped files are **opt-in**, not broken. Each gates itself on an env
flag stated in its own header because it costs a token spend, a network call or
a live database session — `RUN_LIVE_GEMINI=1`, and equivalents for the source
and repository live suites. **They are not part of the default run and should
not be made so.**

**Re-measured 2026-09-29**, after root cause capture: `npx vitest run` →
**4,784 passed**, 35 skipped, across 161 passing files. `tsc` and `eslint` clean.

**Three failures predate that work and are unrelated to it.**
`tests/knowledge/cst-rules-files.test.ts` fails on a missing "Message Handling"
area in the spreadsheet corpus and on a cache-timing assertion. They reproduce
without the root cause changes; nothing in that feature touches `lib/knowledge/`.

**24 architecture guard files** enforce design decisions that ordinary tests
cannot: `no-send-capability`, `automation-no-transport`, `internal-note-
visibility`, `no-customer-data`, `api-surface` (no component may import
`lib/config/`), `file-naming`, `message-app-root-cause-panel`, and others. Treat
a guard failure as a design question, not a test to fix.

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

## 11. Known limitations

1. **No authentication anywhere.** `/performance` names individual staff and
   reports numbers about their work. Access control was deliberately lifted for
   an internal demo and deferred to Vercel Deployment Protection. Nothing in
   this repository limits it. `lib/domain/performance-dashboard-access.ts` is a
   one-line switch and its callers already handle refusal.
2. **Source timezone unconfirmed.** Every displayed timestamp is a naive value
   of unknown zone. Needs the ingestion owner, not code.
3. **Schema state per environment unknowable** from the repo (§9).
4. **Production ingestion cadence.** `vercel.json` runs `/api/cron/sync` once a
   day at 08:00, bounded to 3 pages × 300 rows per feed. An unmerged
   `sync-every-five-minutes` branch exists.
5. **`/api/cron/sync` fails closed** when `CRON_SECRET` is unset — correct, but
   a missing variable looks like an outage.
6. **SOT coverage is thin and `synced_at` is discarded** (§6, §10).
7. **`KNOWLEDGE_DB` / `cst_rules` are not on the draft path.** Whether the
   database snapshot is current, authoritative or abandoned is unverified.
8. **`.env.example` drift** — it omits `DB_ORDER_*` and `CRON_SECRET`, so a
   fresh clone following it gets no MariaDB source and a cron route that refuses
   every request.
9. **Migration 0020 is written and unapplied**, so CST root cause capture is
   dark everywhere (§13). The panel degrades honestly rather than breaking.
10. **The root cause vocabulary is a snapshot, not a live link.** The 18 labels
    were measured out of the source on 2026-09-29. New labels appearing there
    will not appear here until the measurement query is re-run and
    `ROOT_CAUSE_VOCABULARY_VERSION` bumped.

---

## 12. Recommended next steps

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

1. **Confirm schema state** per environment (§9). Every plan depends on it.
2. **Confirm the rule corpus is reachable in the deployed build.** `Knowledge-
   source/` is gitignored while `.vercelignore` re-includes `*.xlsx`. A Vercel
   build from git has no workbooks, and `coverageFor()` would then refuse every
   draft — on the OpenAI path too, because that gate reads local files and never
   consults the vector store. **Verify this first; it decides whether the AI
   feature is live or dark in production.**
3. **Ask the ingestion owner the timezone question** (§11.2). One answer unblocks
   a permanent fix.

**Highest-value work, in dependency order:**

| # | Work | Risk |
| - | ---- | ---- |
| 0 | **Apply migration 0020**, following the acceptance test in `validation/2026-09-29-root-cause-capture-validation.md`, then build the root cause report (§13) | Low to apply; the report needs a deliberate decision about double counting |
| 1 | Sweep the SOT denylist against the live 6-tab schema. It was validated against 413 keys on a 3-tab schema; the catalogue is now 1,824 SKUs across 6 tabs, and the denylist fails open | Low — test only |
| 2 | Surface `synced_at` (already fetched, never used) | Low |
| 3 | Typed empty-reason from the SOT resolver, so a reply can say "we don't publish that" rather than promising to check | Low-Medium |
| 4 | Authentication, closing §11.1 and giving every write a real actor | Medium |
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
  execute it**. `tests/migrations/conversation-root-cause-schema.test.ts` is the
  most recent example.

---

## 13. Root cause — two values, two systems

**The business question.** Which courier causes the most problems, how often, by
date range, courier, store and issue type, with counts and percentages,
exportable.

**Why the other system cannot answer it.** The message application records one
flat label. `FULFILMENT_CARRIER` says a carrier was involved and nothing about
which one or what they did. CST cannot fix that at source: it holds **no write
privilege** on that database — measured, `SHOW GRANTS FOR CURRENT_USER()`
returns `USAGE ON *.*` plus SELECT on 25 named tables in `order_management`, and
`message_app` is not granted at all.

**So there are two values on screen, separately labelled, and neither
overwrites the other:**

| | Message App Root Cause | CST Root Cause |
| --- | --- | --- |
| Owned by | the message application | CST |
| Read from | `customer_service.*.root_cause`, 5 tables, read-only | `cst_app.conversation_root_causes` |
| Written by | their agents and their classifier, every 5 min, no user, no log | a CST agent, by pressing a chip |
| Shape | one label | cause → courier → issue type → note |
| History | overwritten on change | **append-only**; nothing is ever lost |
| Component | `MessageAppRootCauseSection` — no control of any kind | `components/root-cause-selector.tsx` |

They **will** disagree, routinely. That is the point of showing both. Nothing
reconciles them and nothing should.

**The vocabulary was measured, not designed.** The 18 labels are the distinct
stored values across all five source tables on 2026-09-29 — query and result in
`sql/2026-09-29-root-cause-vocabulary-measurement.sql`. Case variants folded;
free prose (the OTHER flow) left out; nothing invented. `Delivery Issue`,
`FULFILMENT_CARRIER` and `FULFILMENT_WAREHOUSE` open the courier levels, and
they are existing labels so CST rows stay comparable with theirs.

**Append-only is deliberate and load-bearing.** Changing a root cause inserts.
No UPDATE, no DELETE, no soft delete, no PATCH route, and no unique constraint
on `conversation_id` — the last is the most likely well-meant edit and a test
guards it. The reason: the whole point of asking which courier is worst is that
somebody will later ask how a number was arrived at.

**The consequence for the report, which is NOT built:** a naive `count(*)`
double counts a conversation whose cause was corrected. Decide between counting
current values per conversation and counting rows, and **say which on the
report**. Both queries are written out in
`query-packs/2026-09-29-root-cause-query-pack.md`. "By store" is not in this
table — join `cst_app.conversations`.

**Status: 0020 is not applied.** Until it is, the message-app half works
unchanged, the CST half reads as nothing recorded, and pressing Record answers
503. Apply it via the acceptance test in
`validation/2026-09-29-root-cause-capture-validation.md`. Before ever running
the rollback: the table holds hand-recorded decisions with **no upstream copy**
— take a dump first.

Full detail: `documentation/2026-09-29-root-cause-capture-overview.md` and
`handover/2026-09-29-root-cause-capture-handover.md`.
