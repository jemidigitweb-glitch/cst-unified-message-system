# AI grounding and prompt status — 2026-09-08

## Purpose

What reaches the drafting model today, what deliberately does not, and where the
live prompt-building code lives. Nothing in this folder runs.

## Current status

Draft generation is implemented and in use. The model is grounded in the CST
knowledge base and in verified facts the backend established; it is never asked
to work out a business fact for itself, and it never sends anything.

## Implemented features

### Where the live code is

| Concern | File |
| --- | --- |
| The shared CST system instruction | `lib/ai/instructions.ts` |
| Prompt assembly (conversation + context blocks) | `lib/ai/draft-assembly.ts` |
| Provider selection | `lib/ai/draft-service.ts` |
| Post-generation accuracy checks | `lib/ai/draft-validation.ts` |

### What the instruction asks for

- Reproduces the CST ChatGPT project instruction CST staff already work with:
  find the applicable rules, apply specialist and cross-cutting rules together,
  check evidence, approval, escalation, safety and marketplace requirements,
  never invent policy.
- Four guards were added on top, each after a specific failure in this system:
  - **marketplace isolation** — an eBay customer was sent Amazon's invoice path,
    from a rule that documents both platforms.
  - **never invent** — a fluent, confident, wrong commitment is the expensive
    failure mode.
  - **stated vs verified** — the model called a customer's own order number
    "verified", a claim we cannot support.
  - **nothing internal** — reasoning, gaps and rule references leaked into text
    meant for a customer.
- The instruction states plainly: "You never send anything. There is no recipient
  and no transport; a human reviews every draft."
- It also tells the model how to *use* the knowledge base — work out everything
  the customer is raising, search for each of those rather than the first, and
  combine them into one reply. The failure this addresses is drafts that settled
  on the first matching rule and stopped.

### What reaches the model

- The conversation text.
- A **VERIFIED CONTEXT** block, containing only facts the backend established
  from the source database. When there is no order, the block says so explicitly
  rather than being omitted — a blank section invites the model to fill it.
- The eight allowed order facts: `order_number`, `order_status`, `order_date`,
  `tracking_number`, `delivery_courier`, `delivery_address`, `sku`,
  `product_title`.
- Listing facts (title, variation options) where they resolve, stated as what the
  *listing* offers, never as what this customer bought.
- The classifier's reading of the customer's intent, marked as **internal
  guidance, not a fact** — the conversation wins where the two disagree.
- The applicable CST rules: retrieved per conversation via File Search on the
  OpenAI path, or inline on the Gemini fallback path (~127,000 tokens of rules).

### What never reaches the model

- Images. This project has no vision or image-analysis call of any kind.
- Billing names, addresses, phone numbers or email addresses. The invoice
  resolver returns the billing party as a presence boolean, so those values are
  not in scope on any path that could reach a prompt.
- An order the system merely guessed at. Where a conversation matches several
  genuine purchases, order-derived facts stay out of the prompt until a human
  selects one.
- Raw database ids.
- Any invoice document. The invoice is generated for a human to print and is not
  part of the draft path.

### After generation

`lib/ai/draft-validation.ts` checks the returned draft deterministically — no
network, no database, no model — against the draft text, the verified facts and
the customer's own words. It can name: contradicts a verified fact, rule not
followed, intent not addressed, unsupported claim, internal language exposed.

A failing draft is regenerated **once** with the findings as correction
instructions, and whatever comes back is still shown to a human. This layer can
ask for a rewrite and force review. It cannot approve, discard or transmit
anything.

A model is deliberately never asked to grade another model's draft: a wrong draft
and a wrong grade would share a cause, leaving the reviewer no independent signal.

## Database / data source

- CST rules come from the knowledge database and the approved rule corpus, read
  only. `cst_knowledge_sources.active` requires `status = 'approved'`, so an
  unreviewed spreadsheet row cannot ground a customer-facing reply.
- Verified facts come from the read-only marketplace source via the context
  resolvers.
- No CST document content is stored in this repository.

## User workflow

The agent presses generate, reads the draft alongside the verified context,
edits or regenerates, saves, and marks it reviewed. The model is never in the
loop after that, because there is no after.

## Known limitations

- The instruction is duplicated in no other place, but there is no versioned
  change log for it in this folder — changes are visible only in git history.
- Grounding quality depends on the rule corpus being current; the corpus is
  maintained outside this repository.
- Prompt content is eBay-shaped in practice, because only eBay resolves verified
  order context.

## Added: order-change notification list — no AI involvement

Recorded here because a "notification" feature is exactly the kind of thing that
quietly acquires a model call, and this one has none.

- No prompt, no instruction, no assembly step and no provider call. Nothing in
  `lib/ai/` was read, imported or modified.
- The case area comes from `classifyConversationCategory`, which is a phrase
  table plus a clause-level reading — pure, deterministic, no network and no
  model. It is the same classifier the inbox chip already uses, called through
  the same `toInboxItem`; no second detector exists.
- Nothing about the list changes what a draft is grounded on, when one is
  generated, or what it may claim. Selecting a row opens the existing draft
  panel, unchanged.
- No token is spent by opening, refreshing or ignoring the list, and nothing is
  written to `ai_usage_log`.

## Next pending items

- Keep versioned change notes here when the instruction changes in a way worth
  explaining outside a commit message.
- No prompt work is planned for sending, VAT invoices or accounting — none of
  those exist, and none of them belongs in a draft.
