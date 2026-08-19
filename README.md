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

**eBay-first.** eBay is the only marketplace where message direction is a stored
field and where previous CST replies actually exist in the source. Amazon, B&Q
and Temu hold inbound messages only; Shopify holds both directions with nothing
to tell them apart. Shipping those now would show half a conversation. The other
channels follow once their direction source is identified.

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
schema. That schema **does not exist yet** and no migration has been run.

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

The rule corpus that will ground AI drafts is **not yet settled**. A database
snapshot of CST rules exists, but its authority and freshness against the
"Message rules final" Google Sheet has not been compared. That review happens
**before** OpenAI integration. No CST document content is stored in this repo.

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

## Layout

| Path                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `app/`              | Routes, pages, and server route handlers             |
| `lib/config/`       | Server-only, validated environment access            |
| `lib/db/`           | node-postgres pools (source RO / app / knowledge RO)  |
| `lib/domain/`       | Domain rules and invariants from Day 1 discovery     |
| `lib/repositories/` | SQL data access (later task)                         |
| `tests/`            | Domain and guard tests                               |
| `migrations/`       | Application schema migrations (none yet)             |

No ORM: the source database has no foreign keys, so every join must be an
explicitly reviewed SQL relationship rather than one a mapper infers. All queries
are parameterised.

## Status

Repository foundation only. No database has been connected, no migration
written, no message ingestion or AI integration built.
