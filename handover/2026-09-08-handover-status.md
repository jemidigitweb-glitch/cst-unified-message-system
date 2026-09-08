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

## Next pending items

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
