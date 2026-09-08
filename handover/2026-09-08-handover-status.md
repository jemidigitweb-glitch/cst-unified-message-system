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
