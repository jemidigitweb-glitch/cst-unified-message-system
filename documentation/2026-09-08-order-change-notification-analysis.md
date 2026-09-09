# Order-change notification layer — architecture analysis

**Date:** 2026-09-08
**Scope:** Discovery only. Read-only inspection of the repository. No code was
changed, no migration was written or run, no database was written to, no test
data was created, and no customer text or credential appears below.

**Question asked:** can a right-side notification panel list customer
conversations that are (a) categorised "Order change, before shipping queries",
(b) carry a customer message, (c) have no AI draft, and (d) have no CST reply —
purely by observing the existing system?

**Answer:** yes, as a read-only projection over `cst_app`, with **no new table
and no new column**. Two of the four conditions are already answered by stored
columns; the third is a stored table's absence; the category is *not* stored and
must be recomputed at fetch time exactly as the inbox already does.

---

## 1. Current architecture summary

| Layer | What it is |
| --- | --- |
| Framework | Next.js 16.3.1 (App Router), React 19.2.8, TypeScript, Tailwind 4 |
| Runtime deps | `next`, `pg`, `react`, `react-dom`, `server-only`, `zod`. No ORM |
| Frontend | One client component tree under `components/`, mounted by `app/page.tsx` → `components/workspace.tsx` |
| State | React `useState`/`useEffect` inside `Workspace`. No Redux/Zustand/Context, no client cache library, no SWR/React Query |
| Backend | Route handlers under `app/api/**`. Every one is `export const dynamic = "force-dynamic"` |
| Data access | `lib/repositories/*` (SELECT only) and `lib/sync/*` (writes). Routes never contain SQL — a guard test enforces this |
| Databases | Three lazily-created pools in `lib/db/pools.ts`: source marketplace DB (read-only, `default_transaction_read_only=on`), application DB (`cst_app`, read/write), knowledge DB (read-only) |
| Migrations | `migrations/0001`–`0010`, forward-only `.up.sql`/`.down.sql` pairs, `cst_app` only |

### Existing API routes

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/conversations` | GET | One marketplace's inbox page (`marketplace`, `offset`) |
| `/api/conversations/no-rule` | GET | One marketplace's No Rule conversations |
| `/api/conversations/[id]` | GET | One conversation + ordered messages |
| `/api/conversations/[id]/draft` | GET, POST, PATCH | Read / generate / edit a draft |
| `/api/conversations/[id]/draft/evidence` | GET | Usage + cited rules for the newest revision |
| `/api/conversations/[id]/order-context` | GET | Verified order context |
| `/api/conversations/[id]/listing` | GET | Listing URL |
| `/api/conversations/[id]/image-context` | GET | Image context |
| `/api/conversations/[id]/workflow` | POST | Workflow transition |
| `/api/marketplace-messages` | GET | Unresolved (direction-undecidable) feed |
| `/api/ai-usage` | GET | Global token/cost accounting |
| `/api/cron/sync` | GET | Scheduled sync trigger |

POST/PATCH exist **only** on `draft` and `workflow`; PUT/DELETE/HEAD/OPTIONS
exist nowhere. `tests/guards/api-surface.test.ts` enforces all of this, plus "no
SQL in a route handler" and "no raw DB error in a response body".

### Existing CST inbox / conversation components

`components/workspace.tsx` (the whole layout and all state), `inbox-list.tsx`,
`conversation-view.tsx`, `context-panel.tsx`, `draft-panel.tsx`,
`draft-evidence-panel.tsx`, `no-rule-list.tsx`, `no-rule-flag.tsx`,
`unresolved-message-list.tsx`, `unresolved-message-view.tsx`,
`marketplace-tabs.tsx`, `category-tag.tsx`, `priority-ribbon.tsx`,
`priority-filter.tsx`, `status-badge.tsx`, `usage-panel.tsx`,
`conversation-export-button.tsx`, `icons.tsx`.

---

## 2. Message → thread → category → draft/reply data flow

```
live marketplace source (read-only)
   lib/marketplaces/<name>/{adapter,message-repository,thread-builder}.ts
        │  derives a thread key (lib/domain/threading.ts) — no source thread id exists
        ▼
   lib/sync/message-sync.ts → lib/sync/conversation-writer.ts
        ▼
   cst_app.conversations           (one row per derived thread)
   cst_app.conversation_messages   (direction 'inbound' | 'outbound')
        ▼
   GET /api/conversations?marketplace=…
        ▼
   lib/repositories/conversation-repository.ts :: listConversations
        │  LIST_CONVERSATIONS selects the row PLUS two correlated subqueries:
        │    LAST_DIRECTION  — direction of the newest message
        │    INBOUND_TEXT    — every inbound body concatenated
        │    INBOUND_TEXTS   — every inbound body, separate and in order
        │
        ├─ categoryFor(row)  → classifyConversationCategory(inbound_texts)
        │                      lib/knowledge/message-category.ts   ← COMPUTED, NEVER STORED
        └─ priorityFor(row)  → classifyConversationPriority(inbound_texts)
        ▼
   InboxItem  { …, category, priority, workflowState, inboundCount, lastDirection }
        ▼
   Workspace state → InboxList (client-side read/category/priority filters)
        ▼
   select(id) → GET /api/conversations/[id] → ConversationView + DraftPanel
        ▼
   POST /api/conversations/[id]/draft
        │  gate: rule coverage → refusal writes cst_app.conversation_rule_analysis
        │  generate → validate → ONE transaction:
        │     saveRevision()            → draft_replies + draft_revisions + draft_revision_sources
        │     advanceWorkflowState()    → conversations.workflow_state 'received' → 'drafting'
        │     clearRuleAnalysis()
        ▼
   PATCH /draft (human edit → new revision, origin 'edited', no state change)
   POST  /workflow ('drafting' → 'pending_review' → 'reviewed', terminal)
```

### The four conditions, mapped onto that flow

| Condition | Where it lives today | Stored? |
| --- | --- | --- |
| Category = "Order change, before shipping queries" | `classifyConversationCategory()` called inside `conversation-repository.categoryFor()` | **No** — recomputed per request |
| A customer message exists | `cst_app.conversations.inbound_count >= 1` (also `inbox_visibility = 'reply_inbox'`, whose CHECK guarantees `inbound_count >= 1`) | Yes |
| No AI draft has been created | absence of a `cst_app.draft_replies` row for the conversation | Yes (as absence) |
| No CST reply has been created | see §4 — two candidate readings | Yes (both readings) |

---

## 3. Category architecture — read this before designing anything

**The category the requirement names does not exist under that name.** The
eleven categories are declared in `lib/knowledge/message-category.ts:53`
(`MESSAGE_CATEGORIES`) and the exact literal is:

```
"Order change, before shipping queries"
```

There is no string "Order Change Before Queries" anywhere in the repository.
The notification layer must use the exported constant, never a hand-typed
string — `CATEGORY_TAG_CLASS` in `components/category-tag.tsx` is keyed by
`MessageCategory` and is exhaustive by type, which is how a colour and a label
already stay in step.

**Where it comes from.** Not a database field, not an AI classification, not a
new rule classifier — it is a *deterministic, pure, in-process reading of the
customer's own text*, run at list-fetch time:

- Entry point: `classifyConversationCategory(readonly (string|null)[])`
  (`message-category.ts:6875`), which delegates to `readConversation`.
- It composes four independent witnesses — a phrase table (`SIGNALS`), an intent
  layer (`detectIntents`/`refine`), a 730-row reviewed workbook corpus
  (`readCorpus`, `lib/knowledge/cst-category-corpus.ts`), and a clause-level
  semantic reading (`semanticsOf`, `lib/knowledge/message-semantics.ts`) — and
  arbitrates between an "issue" axis and a "requested action" axis.
- `"Order change, before shipping queries"` is reached mainly via the
  `order_amendment` action (`AMENDMENT_REQUEST`, `amendsAnOrderAlreadyPlaced`,
  `ORDER_HAS_NOT_GONE_YET`, `ASKS_US_TO_CHANGE_IT` around lines 3461–3510 and
  6194–6310), covering cancellation and amendment before dispatch, including
  delivery-address changes.
- It returns `null` on a genuine tie rather than guessing. `null` is a real
  outcome, not a failure.
- No network, no model, no database.

**Consequences that constrain the design:**

1. **Category is not filterable in SQL.** There is no `conversations.category`
   column and no index on it. Any notification query must select the same
   `INBOUND_TEXTS` array `LIST_CONVERSATIONS` selects and classify in
   application code. Adding a stored category column would be a second source of
   truth that drifts the moment the phrase table changes — the module's own
   header states the no-storage rule explicitly ("a phrase-table change takes
   effect on the next request rather than needing a backfill").
2. **Two marketplaces are excluded by construction.**
   `CATEGORY_SUPPRESSED_MARKETPLACES = {bandq, temu}` in
   `conversation-repository.ts:327` short-circuits `categoryFor` to `null`. A
   B&Q or Temu order-change message can never appear in this notification list.
   That is a deliberate measured decision (their stored `body_text` carries raw
   email transport headers and boilerplate), and the notification layer must
   read the same constant rather than re-deciding it.
3. **Single-conversation reads carry no category.** `GET_CONVERSATION` selects
   neither `inbound_text` nor `inbound_texts`, so `getConversation()` always
   returns `category: null`. A notification panel cannot be built by re-reading
   one conversation at a time.
4. **Accuracy is known and documented.** `documentation/2026-09-03-category-classification-audit.md`
   measures ~83% correct on a representative eBay sample, with errors
   concentrated in the after-sales categories. Rows 24–29 and 46–47 of that
   audit are order-change threads, all of which classified correctly. The
   notification list inherits that accuracy exactly — it is not a new risk, but
   it is the reason the panel should read as "conversations that look like X"
   rather than a guaranteed-complete work queue.

---

## 4. Draft / reply workflow

### Where drafts live

| Table | Migration | Holds |
| --- | --- | --- |
| `cst_app.draft_replies` | 0004 | one row per conversation with a draft; `current_revision`; unique on `conversation_id` |
| `cst_app.draft_revisions` | 0004 | append-only history; `revision`, `origin ∈ {generated, edited}`, `body_text`, `missing_information[]`, `requires_review`, `model` |
| `cst_app.draft_revision_sources` | 0004 | citations per revision; `source_kind ∈ {cst_document, verified_fact}` |
| `cst_app.conversation_rule_analysis` | 0009 | one row per conversation refused for lack of an applicable rule |
| `cst_app.ai_usage_log` | 0006/0008 | tokens, cost, duration per revision |

Read path: `lib/repositories/draft-repository.ts :: getDraft` (SELECT only).
Write path: `lib/sync/draft-writer.ts :: saveRevision` / `advanceWorkflowState`.

### How draft status is tracked

`cst_app.conversations.workflow_state`, constrained by CHECK to exactly four
values, with the transition table in `lib/domain/workflow.ts`:

```
received → drafting → pending_review → reviewed        (reviewed is terminal)
                   ↖──────────┘   (regeneration / further edits)
```

- `received` → `drafting` happens **only** inside the draft POST transaction,
  alongside `saveRevision`.
- `drafting` → `pending_review` → `reviewed` happen only via
  `POST /api/conversations/[id]/workflow`, driven by `DraftPanel`.
- A PATCH edit adds a revision and does **not** move the state.

**Important subtlety for the filter:** `workflow_state = 'received'` is a
*proxy* for "no draft", not the fact itself. A `PATCH` that creates the first
revision would leave the state at `received` while `draft_replies` holds a row.
The authoritative test is the absence of the row:

```sql
NOT EXISTS (SELECT 1 FROM cst_app.draft_replies d WHERE d.conversation_id = c.id)
```

### Where CST/marketplace replies are stored

`cst_app.conversation_messages` with `direction = 'outbound'`. Direction is only
ever written where the source proves it (eBay `folder_id`; Amazon's two sender
fields; Shopify's addresses against `lib/domain/company-domains.ts`; B&Q and
Temu are inbound-only and have `hasOutboundHistory: false`).

**"No CST reply has been created" is ambiguous and the choice matters.** Two
defensible readings, both answerable from stored data:

| Reading | Predicate | What it means |
| --- | --- | --- |
| **A — nobody has answered the customer** | `LAST_DIRECTION = 'inbound'` (identical to the inbox's existing `readStateOf` → "unread") | Matches the existing Unread sub-tab. Includes threads where CST replied once long ago and the customer has since written again |
| **B — this system holds no reply of any kind** | `NOT EXISTS (outbound message)` **and** `NOT EXISTS (draft_replies row)` | Strictly "untouched". A conversation with an old outbound reply is excluded even if the customer has just written again |

Reading A is the one that matches the existing UI vocabulary and, in my
judgement, the intent ("nobody has dealt with this yet"). Reading B is stricter
and will produce a smaller list. **This is the one product decision the
implementation task needs answered before it starts.** Note there is no
"marketplace reply sending" in this system at all — no send button, endpoint,
queue or connector — so "CST reply" can only ever mean a historic outbound
message ingested from the source, never something this application sent.

---

## 5. Notification UI possibilities

### Existing layout

`components/workspace.tsx` renders a three-column CSS grid inside one `<div>`:

```
xl:grid-cols-[320px  minmax(0,1fr)  300px]
              ↑ aside  ↑ main         ↑ aside
              list     conversation   details panel
```

- **Left `<aside>`** — `InboxList` + `UnresolvedMessageList` (or `NoRuleList`).
  A permanent column from `xl` up; a hamburger drawer below `xl`.
- **`<main>`** — `ConversationView` (which contains `DraftPanel`) or
  `UnresolvedMessageView`.
- **Right `<aside>`** — `ContextPanel` then `DraftEvidencePanel`. Toggled by
  `detailsVisible`; a real grid column from `sm` up, a full-screen overlay below
  `sm`. Gated on `selectedKind !== "message"`, never on the marketplace.

There is **no existing notification component, no badge/toast/alert system, and
no global notification state.** The nearest analogues are the header tab buttons
"No Rule" and "AI Usage" (`view` state: `"inbox" | "status" | "no_rule"`), which
swap what the left column or the whole main area shows.

### The guard that shapes the recommendation

`tests/guards/review-sidebar.test.ts` is a standing guard on the right sidebar
and it will interact with any new right-hand panel:

- `expect(workspace.match(/<ContextPanel/g)).toHaveLength(1)` and the same for
  `<DraftEvidencePanel>` — exactly one mount each.
- It asserts section order: "Human action needed" → Current listing → order
  facts → `<ContextPanel>` before `<DraftEvidencePanel>` → "AI Usage" before
  "CST Rules Used".
- **`workspace.slice(workspace.lastIndexOf("<aside"))` must contain
  `selectedKind !== "message"` and must not contain `marketplace ===`.** A new
  `<aside>` added *after* the current last one takes over that slice and breaks
  the guard unless it carries the same gate — which a notification panel should
  not, because it is not scoped to a selection.

### Recommendation — safest location

**A fourth top-level `view`, rendered in the left column, not a new right-hand
`<aside>`.**

Concretely: add `"order_change"` to the existing `view` union, add a header tab
button beside "No Rule" and "AI Usage" (same `role="tab"` / `aria-selected`
pattern), and render an `OrderChangeNotificationList` in the existing left
`<aside>` in place of `InboxList`/`NoRuleList` — precisely the mechanism
`NoRuleList` already uses. Selecting a row calls the existing `select(id)`, so
the conversation, context panel and draft panel all open unchanged.

Why this over a genuine right-side panel:

1. It is the pattern the codebase already has for "a differently filtered list
   of conversations", proven by `NoRuleList` — same row shape, same `onSelect`,
   same detail pane.
2. It touches no existing sidebar assertion, so `review-sidebar.test.ts` stays
   green without being edited. Editing a standing guard to accommodate a new
   feature is exactly the move that guard exists to prevent.
3. The right column at `xl` is 300px and already holds two panes; a third
   competing for it, or a fourth grid column, would change the layout for every
   marketplace and every conversation, which is a much larger blast radius than
   the feature justifies.
4. `clearSelection()` already exists for exactly this — entering or leaving a
   list-swapping view.

**If a literal right-side panel is required** (the requirement does say "right-side
notification panel"), the least invasive form is a **new `<aside>` inserted
before the existing details `<aside>`**, so `lastIndexOf("<aside")` still finds
the details one and the guard is unaffected. It would need its own grid track
(e.g. `xl:grid-cols-[320px_minmax(0,1fr)_300px_280px]`), its own open/closed
state, and a decision about how it coexists with `detailsVisible` at `sm`–`xl`
widths where the details panel is already competing for horizontal space. This
is the more expensive option and the one more likely to need the guard revisited;
worth confirming with the requester which they actually want before building.

---

## 6. Database impact analysis

### Tables and fields involved (all in `cst_app`, all read-only for this feature)

| Table | Fields the notification filter needs |
| --- | --- |
| `conversations` | `id`, `marketplace`, `sub_source_id`, `counterparty_ref`, `listing_item_ref`, `workflow_state`, `needs_context`, `inbox_visibility`, `first_source_ts`, `last_source_ts`, `message_count`, `inbound_count` |
| `conversation_messages` | `conversation_id`, `direction`, `body_text`, `source_ts`, `source_pk` — for `INBOUND_TEXTS` (classification), `LAST_DIRECTION`, and the outbound-existence test |
| `draft_replies` | `conversation_id` — existence only |

Nothing else. Not `draft_revisions`, not `draft_revision_sources`, not
`conversation_rule_analysis`, not `context_snapshots`, not the source database.

### Is a new table required? **No.**

Every one of the four conditions is answerable from the three tables above:

```sql
-- shape only; the category filter is NOT in SQL, see below
FROM cst_app.conversations c
WHERE c.marketplace = $1
  AND c.inbound_count >= 1                                    -- customer message exists
  AND NOT EXISTS (SELECT 1 FROM cst_app.draft_replies d
                   WHERE d.conversation_id = c.id)            -- no AI draft
  AND NOT EXISTS (SELECT 1 FROM cst_app.conversation_messages m
                   WHERE m.conversation_id = c.id
                     AND m.direction = 'outbound')            -- no CST reply  (reading B)
```

…plus the same `INBOUND_TEXTS` correlated subquery `LIST_CONVERSATIONS` already
uses, with `classifyConversationCategory` applied in the repository and the
result compared against the `"Order change, before shipping queries"` constant —
identical to what `categoryFor()` does today.

Migration 0009's own header is the standard this should be held to: it states
plainly *why* a table was required (a finding that had to outlive the page). No
such reason exists here — nothing about this notification is a fact worth
persisting; it is a view over facts already stored, recomputed on each request
exactly as the inbox's category chip is.

**A new table would be actively wrong**, for the same reason the category is not
stored: a persisted "is an unanswered order-change" flag would drift the instant
the phrase table changed, and would need a backfill the current design
deliberately avoids.

---

## 7. Risks and unknowns

1. **Category name mismatch (certain, must be resolved).** The requirement says
   "Order Change Before Queries"; the system's literal is
   `"Order change, before shipping queries"`. Confirm these are the same
   category before writing any code.
2. **"No CST reply" is ambiguous (must be resolved).** See §4 — reading A
   (last message inbound) vs reading B (no outbound message at all) produce
   different lists. Reading A matches the existing Unread filter.
3. **Paging (real, needs a decision).** `/api/conversations` returns
   `DEFAULT_INBOX_LIMIT = 100` per page, newest-first, with `hasMore`. A
   notification panel built by filtering the loaded client-side array would only
   ever see page 1 — a genuine order-change conversation from four months ago
   would silently never appear, and the panel would read as "there are none".
   A dedicated server route that filters before limiting is the honest option.
4. **Classification cost.** `classifyConversationCategory` is pure but not
   cheap — it runs four witnesses over every inbound message. Filtering *after*
   classification means classifying the whole candidate set per request. Today
   the inbox pays that for 100 rows; a notification route that scans further
   back pays proportionally more. Measure before choosing a page size. It cannot
   be pushed into SQL without introducing the stored-category duplication §3
   rules out.
5. **B&Q and Temu are structurally invisible** to this feature
   (`CATEGORY_SUPPRESSED_MARKETPLACES`). The panel must not imply it covers all
   five marketplaces.
6. **Classifier accuracy ~83%** on a representative sample (see the 2026-09-03
   audit). False negatives are the risk that matters here: an order-change
   message read as something else never reaches the panel, and a panel that
   looks complete but is not is worse than one that says what it is.
7. **`workflow_state` is not the draft test.** Use `draft_replies` existence;
   see §4.
8. **Marketplace scoping.** Every existing conversation list is scoped to one
   marketplace by design (`parseMarketplaceForFeed`), because the workspace tabs
   exist to stop conversations with different direction guarantees sitting side
   by side. A cross-marketplace notification panel would be the first thing to
   break that rule — it should be per-marketplace unless the requester
   explicitly wants otherwise.
9. **Sidebar guard interaction** — see §5. `lastIndexOf("<aside")`.
10. **Unknown: refresh semantics.** There is no polling, no websocket and no
    revalidation anywhere in the app; every list loads once per marketplace
    switch. "Notification" usually implies liveness. Whether this panel should
    poll, or simply be a filtered view that refreshes when the marketplace tab
    is re-selected, is not answered by anything in the codebase.

---

## 8. Suggested next implementation task

Deliberately one task, read-only, additive, and behind no existing guard:

> **Add a read-only "Order change awaiting first response" list, per
> marketplace.**
>
> 1. `lib/repositories/conversation-repository.ts` — add
>    `listAwaitingResponseByCategory(client, { marketplace, category, limit, offset })`
>    as a new exported function with its own SQL constant. It reuses
>    `LAST_DIRECTION` and `INBOUND_TEXTS` verbatim, adds the two `NOT EXISTS`
>    predicates, and reuses `toInboxItem` (so `categoryFor`/`priorityFor` stay
>    the single implementation) then filters on the returned `category`. Do not
>    modify `LIST_CONVERSATIONS`, `listConversations`, `categoryFor`,
>    `priorityFor` or `toInboxItem`.
> 2. `app/api/conversations/awaiting-response/route.ts` — GET only,
>    `dynamic = "force-dynamic"`, `parseMarketplaceForFeed(..., "conversations")`,
>    error logged server-side and never returned. Mirrors `no-rule/route.ts`
>    exactly.
> 3. `components/workspace.tsx` — add `"order_change"` to the `view` union, one
>    header tab button beside "No Rule", one fetch alongside the three existing
>    ones in the `[marketplace]` effect, `clearSelection()` on toggle, and render
>    the new list in the existing left `<aside>` where `NoRuleList` renders.
> 4. `components/order-change-list.tsx` — a new list component modelled on
>    `no-rule-list.tsx`. Reuses `conversationTitle`, `CategoryTag`,
>    `PriorityRibbon`, `StatusBadge`, `formatSourceTimestamp`.
> 5. Tests: repository tests against an injected fake client (following
>    `tests/repositories/conversation-repository.test.ts`) covering — a draft
>    exists → excluded; an outbound message exists → excluded; `inbound_count = 0`
>    → excluded; a suppressed marketplace → empty; a non-order-change category →
>    excluded. Plus a guard assertion that the new route exports GET only.
>
> **Prerequisites, both answers needed before starting:** the category-name
> confirmation (§7.1) and the "no CST reply" reading (§7.2).
>
> **Explicitly out of scope:** any change to sync, threading, the classifier,
> draft generation, the reply workflow, `workflow_state`, or any migration.

Not in this task, and worth a separate decision: whether the panel must be a
literal right-hand column (§5), and whether it should poll (§7.10).
