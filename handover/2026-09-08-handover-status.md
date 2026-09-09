# Handover status — 2026-09-08

## Purpose

What a new owner or returning contributor needs to pick this project up: what is
running, what it touches, what must not be changed casually, and what is still
open.

## Current status

Phase 1 is live for eBay and reading messages from all five marketplaces. The
most recent work added the invoice path. The system produces reviewed drafts and
printable invoices; it sends nothing.

## Implemented features

- Scheduled live message sync from the marketplace source into `cst_app`.
- Conversation threading, customer/CST separation, oldest → newest display.
- eBay order context with explicit ambiguity handling and human selection.
- Listing context (title and options) resolved separately from the order.
- AI draft generation grounded in CST rules, deterministic validation, and a
  review / edit / regenerate / save / reviewed workflow terminating at
  `reviewed`.
- On-demand invoice PDF for the resolved order, printed from the context panel.

See `documentation/2026-09-08-implemented-system-overview.md` for the full
technical description and `capability/2026-09-08-system-status.md` for what the
system can and cannot do.

## Database / data source

| Database | Access | Notes |
| --- | --- | --- |
| Marketplace source (`ledsone`) | **Read-only** | Shared with unrelated production systems. The pool pins `default_transaction_read_only=on` at session level, so the server rejects a write rather than trusting the caller. |
| Application | Read/write, `cst_app` schema only | Nothing in `issue_tracking`, `poc_listing` or `public` may be referenced, altered or dropped. |
| Knowledge | Read-only | CST rule corpus. |

Operational rules that must survive any handover:

1. **Never write to the source database.** Not a migration, not a fix, not a
   one-off.
2. **No migration without approval**, and migrations target `cst_app` only.
3. **No invented joins.** The source has no foreign keys; every join is
   explicitly reviewed SQL, verified against live data.
4. **All queries parameterised** (`$1`, `$2`, …). Never string-interpolated.
5. **The selected order is `orders.id`.** `orders.order_id` is not unique (655
   numbers across 1,608 rows) and must never be a lookup key.
6. **SKUs are atomic.** Never split, trim, normalise or case-fold one. The
   database value always wins over an example in documentation.
7. **No post-review workflow state.** Adding one means adding a transport.

### Environment

- Copy `.env.example` to `.env`; `.env` is gitignored and must never be
  committed. Every credential is server-side only — nothing under
  `NEXT_PUBLIC_`, and config modules are `server-only`.
- `DB_SSL_MODE` defaults to `require` (encrypted, certificate unverified). Set
  `verify` once a CA certificate is available for these hosts.
- AI: `OPENAI_API_KEY` + `OPENAI_VECTOR_STORE_ID` (primary) or `GEMINI_API_KEY`
  (fallback). `DRAFT_PROVIDER` forces one. With none set the app runs normally
  and only draft generation reports itself unconfigured.
- Configuration is read on every draft call, so a rotated key takes effect on the
  next draft rather than the next restart.

### Operations

- `npm run sync:auto` runs the message sync; `npm run sync:schedule` registers it
  as a Windows scheduled task. `/api/cron/sync` exists for a hosted scheduler.
- `/logs/` and `/tmp/` are gitignored. `/tmp/` holds local analysis artefacts
  pulled from the source database and routinely contains **real order numbers,
  SKUs and prices** — never commit them.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` before any
  change lands. Suite as at 2026-09-08: 3,365 passing, 32 skipped.

### Ownership still to be named

- Who owns the marketplace source database schema.
- Who owns the CST rule corpus and signs off a rule change.
- Who approves a production deploy of this application.
- Who holds the AI provider credentials.

These were open at the last handover and remain open.

## User workflow

```
Live message → thread → verify context → AI draft
→ review / edit / regenerate → save → reviewed → STOP
```

Print invoice is available once exactly one order has resolved for the
conversation.

## Known limitations

- Order, listing, return, tracking and invoice context are **eBay only**.
- The application has no user identity, so nothing can be recorded as
  `user_confirmed` and a reviewer's order selection grounds one generation only.
- The invoice prints no billing address and no seller/company block; the
  resolver deliberately carries the billing party as a presence boolean.
- No VAT is calculated and the document is never headed "VAT Invoice".
- The source timestamp zone is unconfirmed; timestamps are stored naive.
- `migrations/README.md`'s status table lists only `0001`–`0005` while ten
  migration pairs exist on disk. **Which migrations are applied to the
  application database has not been confirmed in writing** — verify against the
  live application database before assuming.
- The root `README.md` still describes the project as "repository foundation
  only… no database connected", which is no longer true. It has not been updated
  in this pass.

## Added: order-change notification list

**Where it lives.** `listAwaitingResponseByCategory` in
`lib/repositories/conversation-repository.ts`, behind
`GET /api/conversations/awaiting-response?marketplace=<name>`, rendered by
`components/notification-bell.tsx` (header, top right) and
`components/notification-drawer.tsx` (a `fixed` right-side overlay). There is no
Order Change tab and no `view` for it; both were removed.

**What to know before changing it:**

- The case area is `ORDER_CHANGE_CATEGORY` in `lib/domain/inbox.ts`, typed as
  `MessageCategory`. Its value is the classifier's own wording — *"Order change,
  before shipping queries"*. Nothing anywhere says "Order Change Before
  Queries"; if a brief uses that phrasing, it means this.
- The category cannot become a SQL predicate. It is not stored and must not be;
  the reasons are in `data-maps/` and in the header of
  `lib/knowledge/message-category.ts`.
- B&Q and Temu will always show an empty list. That is
  `CATEGORY_SUPPRESSED_MARKETPLACES`, inherited from the inbox, not a bug.
- Two standing guards constrain the layout: the workspace must keep exactly two
  `<aside>` elements, and the last one must be the details panel. Adding a
  right-hand column means revisiting both, deliberately.
- **Two spellings, on purpose.** `ORDER_CHANGE_CATEGORY` is the classifier's
  value and the only one that may reach a comparison;
  `ORDER_CHANGE_NOTIFICATION_TITLE` ("Order Change Before Shipping Queries") is
  the drawer's heading and is display copy only. Do not "fix" one to match the
  other without deciding which register the change belongs to.
- **The feed is global and the bound is per marketplace.** Both matter. It reads
  every conversation-backed marketplace in one query, and gives each its own
  window — because Shopify has 3,342 unanswered conversations to Amazon's 44,
  and a shared window is ~90% Shopify. Removing the `PARTITION BY` would silently
  hide every Amazon and eBay notification; that is exactly what it did before.
- It excludes `inbox_visibility = 'filtered'` — mail the ingestion layer already
  recorded as not reply work. Those conversations are still in the inbox.
- The list is bounded by candidates, not matches. If a reviewer reports a
  conversation missing, check `scanned`/`hasMore` first — it may simply be older
  than that marketplace's window. See `capability/` for the live figures.
- **Clicking a notification switches the marketplace tab.** It has to: the detail
  route 404s a conversation from another marketplace. `select(id, from)` takes
  the marketplace explicitly; the default is the selected tab, so every other
  caller is unchanged. If you add a caller that passes an explicit marketplace,
  it must switch the tab to the same value — `marketplace-ui.test.ts` enforces
  this by scanning for the call shape.

**Nothing new to operate.** No migration to apply, no environment variable, no
scheduled job, no credential. The feature is live as soon as the code is
deployed.

## Added: prior CST replies as agreed decisions

**Where it lives.** `acceptedCommitments` in `lib/domain/draft.ts` (the reader
and the claim table), `threadCommitments` in `lib/ai/draft-validation.ts` (the
adapter from conversation messages), the `PRIOR_REPLIES` block in
`lib/ai/instructions.ts` (the instruction), and one sentence inside
`verifiedTrackingBlock` in `lib/ai/draft-assembly.ts`. Nothing else.

**What to know before changing it:**

- **DECISION versus OUTCOME is the whole safety argument.** An agreement lets a
  draft say we are ARRANGING something. It does not let it say the thing has
  HAPPENED. In `PROHIBITED_CLAIM_PATTERNS` exactly one entry carries a
  `commitment` field — "replacement arrangement". "Replacement decision"
  (dispatched/sent) deliberately does not, and neither does any refund entry.
  **If you add a `commitment` to a second pattern, be sure you have decided
  that an agreement can establish that claim**, because that is what you are
  saying.
- **The commitment is derived, never stored.** No column, no snapshot, no
  migration. It is re-read from the thread on every draft call, like the
  category and the intent. Do not add a table for it; the reasons are the same
  ones recorded in `data-maps/` for the category.
- **Both new parameters default to `[]`.** `ungroundedClaims(draft, facts,
  commitments = [])` and `settleReviewRequirement(result, facts,
  commitments = [])`. A caller that does not pass a thread behaves exactly as it
  did before — including `lib/ai/draft-generator.ts`, which is off the live path
  and was deliberately left on the default. If you wire a new caller, passing
  the thread is opt-in.
- **`WANTS_A_RESEND` is beside `WANTS_A_REPLACEMENT`, not merged into it, and
  this is load-bearing.** `WANTS_A_REPLACEMENT` is also read by `refine` for the
  `exchange_or_replacement` CATEGORY decision, and the classifier is frozen
  against a compiled baseline. Merging the two would move that baseline. The new
  constant is wired only into `detectIntents`.
- **The instruction is ~15 tokens under its cost guard.**
  `tests/ai/draft-validation-cost.test.ts` caps the composed instruction and
  input at 2,000 estimated tokens; it currently measures 1,984.75. The guard is
  there to catch the ~127,000-token Gemini corpus going inline, so **do not
  raise it to make room** — cut something instead, or make raising it an
  explicit, argued decision. The block was already rewritten from 753 tokens to
  513 for exactly this reason.
- **The accuracy gate can fight an instruction, and it did.** Before the
  coverage vocabulary learned the word "resend", the correct terse draft raised
  two critical findings and would have bought a regeneration that undid the
  instruction. If you add a rule telling the model to say LESS, check what
  `validateDraftAccuracy` makes of the draft you want, or the gate will buy a
  rewrite back to the draft you don't.
- **A correct draft still carries one minor `intent_not_addressed` finding** on
  a settled delivery thread. Expected, asserted in the test, and harmless —
  minor findings buy no model call and change no text.
- **`restrictedInstructions()` has none of this.** It is the reduced
  instruction and carries no prior-reply or no-repeat rule. Deliberate, but know
  it before assuming the policy is global.

**Nothing new to operate.** No migration, no environment variable, no scheduled
job, no credential. Live as soon as the code is deployed.

## Added: what a new owner should know about product facts

Investigated 2026-09-09 after a pre-sale draft declined to state a lampshade's
weight. **No code changed.** Three things are worth carrying forward:

1. **There is no weight in the source, for any product.** `weight_g` is `NULL`
   or `[VERIFY]` on all 1,824 SOT SKUs, as are every packaged, volumetric, outer
   and chargeable weight column, and `suppliers.child_item_products` holds no
   weights either. A draft asked for a weight can only say it will check. If
   this is reported as a bug again, it is a **data** task — populate `Weight_g`
   in the SOT sheet — and no code change will help.
2. **The "SOT resolves for 3 of 869" figure describes one route of two.** The
   parent-listing route reaches 308 of 31,155 parent listings (1.0%); the
   component route through `order_combo`, which `resolveBundleProductContext`
   already uses, reaches 19,319 (62%). Do not conclude from the small figure
   that the catalogue is unreachable — most pre-sale conversations that get
   product facts get them through the bundle path.
3. **`"sku not assigneds"` is a placeholder on 4,768 parent listing rows**, and
   it is passed to the catalogue lookup as though it were a SKU. It misses
   today. Those listings therefore depend on nobody ever creating a catalogue
   row under that literal string; if one appeared, one product would attach to
   all 4,768. Rejecting it before the lookup is a few lines and is listed below.

Also: the doc comments in `lib/context/resolve-sot-product-context.ts` and
`lib/repositories/sot-product-repository.ts` still say SOT holds 1,001 SKUs
across three tabs. It now holds 1,824 across six (lampshade, ceilingrose, bulb,
lampholder, pendantholder, wallarm). Stale comment, not a defect — but do not
size a change from it.

## Next pending items

- Reject the `"sku not assigneds"` placeholder before the SOT lookup.
- Populate `Weight_g` in the SOT sheet, or accept that weight questions are
  unanswerable — a business decision, not an engineering one.
- Marketplace reply sending — not built and out of Phase 1 scope.
- Automatic sending.
- Invoice email sending.
- VAT invoice generation — blocked on the business stating the authoritative VAT
  rule.
- Seller invoice details and billing address rendering.
- Full accounting integration.
- Phase 2 work.
- Naming the owners listed above.
- Reconciling `migrations/README.md` and the root `README.md` with the running
  system.

## Added: message body repair — how to run it

```
npm run repair:bodies                                  dry run, all marketplaces
npm run repair:bodies -- --apply
npm run repair:bodies -- --apply --marketplace=ebay --limit=1000
npm run repair:bodies -- --apply --batch-size=200
```

Dry run is the default and reports exactly what would change. The script refuses
to write unless `current_database()` is `varmen_db` and `current_user` is
`varmen_user`, and refuses to read unless the source session is read-only.

**When to run it.** When a reviewer reports a blank message bubble on a
conversation the customer clearly wrote to. eBay is the marketplace where this
happens, because it stores the header and the body in two tables and does not
write them together.

**What the output means.**

| Line | Reading |
| --- | --- |
| `repaired` | messages that now show the customer's text |
| `still_empty_at_source` | the source genuinely has no body — nothing to fetch |
| `still_failed_at_source` | a body exists but is not decodable text |
| `source_row_missing` / `source_row_unusable` | the source cannot answer for the row |
| `source_direction_changed` / `source_timestamp_changed` | the source row was edited; repair refuses rather than restate the message |
| `MORE AVAILABLE` | the `--limit` was reached; re-run |

**Safe to re-run at any time**, including while a sync is running. It touches no
cursor, so the two cannot interfere.

**Not scheduled, and that is a decision.** Wiring it into `sync:auto` would
double the hourly source read to catch a handful of rows. If it is ever
scheduled, run it far less often than the sync — daily at most.

**Known limitation.** A blank bubble caused by a genuinely empty source message
and one caused by a body CST failed to pick up look identical in the UI. Repair
tells them apart in its log; the workspace does not.
