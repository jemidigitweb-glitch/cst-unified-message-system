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
- Five guards were added on top, each after a specific failure in this system:
  - **marketplace isolation** — an eBay customer was sent Amazon's invoice path,
    from a rule that documents both platforms.
  - **never invent** — a fluent, confident, wrong commitment is the expensive
    failure mode.
  - **stated vs verified** — the model called a customer's own order number
    "verified", a claim we cannot support.
  - **nothing internal** — reasoning, gaps and rule references leaked into text
    meant for a customer.
  - **prior replies stand** — a colleague offered a resend, the customer
    accepted, and the draft refused it as unverified. See the section below.
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
- Going global changed none of that. It reads more conversations per request
  (244 across three marketplaces rather than 100 in one), and every one of them
  is read by the same pure phrase-and-clause classifier. No model is called at
  any point, for any marketplace.
- The feed refreshes when a draft is generated. ~~so the count drops as work is
  done.~~ (**Corrected** — a draft no longer removes a row; the refresh now
  updates its label. See "the notification draft fix" below.) That is a re-read
  of the existing classifier over existing rows — it costs no tokens and
  triggers no generation.

## Added: what this team has already said in this thread

The fifth guard, and now the largest single section of the system instruction.
The exchange it was written after, which happened:

```
customer   "I still have not received this item and it's been several weeks"
us         "...unfortunately there has been no update since the 26th. Would you
            be happy for us to resend the item for you?"
customer   "Yes please resend asap"
```

and the draft refused the resend as an unverified replacement decision. It was
refusing an offer we had made ourselves. The thread was never the problem — the
full ordered thread, with `CUSTOMER` and `OUR PREVIOUS REPLY` labels, already
reached the model. What was missing was any statement of what a previous reply
*means*.

**Prior replies stand.** A message marked `OUR PREVIOUS REPLY` was sent to this
customer under our name. It is a decision this team has already taken, not a
claim to re-check. A remedy we offered and the customer accepted is an agreed
decision, not a new request, and the draft confirms it and says what happens
next.

**The DECISION is not the OUTCOME.** This is the line that stops the guard
becoming a licence, and it is stated in the instruction and enforced
deterministically. An agreement establishes that we are doing something; only
the verified context establishes that it happened. "We are arranging a
replacement" can be grounded on the agreement. "We have dispatched a
replacement" cannot, and neither can a date, a courier or a tracking number.

**Never retract what we have already sent.** Where the model can verify less
than an earlier reply asserted, that is a gap in its context, not a mistake in
that reply. No "correction", no "to clarify my previous message", no "please
disregard".

**And then say it once.** Carrying the action forward produced a second defect:
a draft that restated our own previous message back to the person replying to
it — *"...The original parcel was last recorded as in transit on 26 August, but
we will proceed with the resend as requested."* Every word verified, and every
word already said. The instruction now states that everything supplied —
thread, verified context, tracking, product facts — is there to REASON from and
is not a list of things to repeat. Once a fact has been given and the
conversation has moved to an agreed action, the background stays where it is.

Four exceptions, and they are the whole safety of the rule. State an earlier
fact again when it answers what the customer has just written, when it makes
the agreed action clear, when they have asked about it again, or when a CST rule
requires it. The rule closes by saying it governs what the model SAYS — it keeps
using all of it to work out what is true and what it may not claim.

`verifiedTrackingBlock` in `lib/ai/draft-assembly.ts` says the same about its
own data, because the standing relevance rule decides from the customer's
message alone and on a delivery thread answers "give them the position" every
time, including after a colleague already did. The new sentence is gated on
three conditions at once — already given, an action agreed since, not currently
being asked about — and hands relevance straight back the moment the customer
asks again or contradicts the record.

**Nothing was removed from the model's input.** The tracking block, the scan
history and the customer-facing status are supplied exactly as before; the
block is byte-identical whether the conversation has settled or not. Only the
instruction reads the thread.

### The instruction now has a measured budget

`tests/ai/draft-validation-cost.test.ts` caps everything this application
composes at 2,000 estimated tokens — the guard that would catch the ~127,000
token Gemini corpus going inline. The first draft of this guard was 753 tokens
and broke it at 2,224.

The ceiling was **not** raised. The block was rewritten to 513 tokens with every
operative clause kept, and the composed input now measures **1,984.75 tokens**
— roughly 15 tokens of headroom, recorded in the doc comment beside the block
so the next addition is a decision rather than a surprise.

| | Tokens |
| --- | --- |
| Guard | 2,000 |
| Composed instruction + input, before this work | ~1,472 |
| First attempt | 2,224 (failed) |
| Shipped | **1,984.75** |

### What is model-side and what is enforced

Worth separating, because only half of this is deterministic.

| Rule | How it holds |
| --- | --- |
| A prior reply is authoritative | Instruction only |
| An accepted offer may ground "we are arranging" | **Deterministic** — `acceptedCommitments`, `ungroundedClaims` |
| "We have dispatched" still blocked | **Deterministic** — unchanged pattern |
| Do not repeat settled background | Instruction only |
| A terse reply is not faulted for it | **Deterministic** — coverage vocabulary |

The two no-repeat rules are guidance. Nothing stops a model restating tracking;
what changed is that the accuracy gate no longer *punishes* the draft that does
not.

## Next pending items

- Keep versioned change notes here when the instruction changes in a way worth
  explaining outside a commit message.
- **The instruction is within ~15 tokens of its cost guard.** The next addition
  needs an equivalent cut or an explicit, argued decision to raise the ceiling.
- `restrictedInstructions()` carries no prior-reply and no no-repeat rule. That
  was deliberate — it is the reduced instruction — but it means a restricted
  draft states no policy on either.
- No prompt work is planned for sending, VAT invoices or accounting — none of
  those exist, and none of them belongs in a draft.

## Added: message body repair — no AI involvement

- No prompt, no instruction, no assembly step, no provider call. Nothing in
  `lib/ai/` was read, imported or modified.
- Repair moves text from the source into `conversation_messages`. It never
  generates text, and it never asks a model what a message said.
- **It does change what a later draft is grounded on, and that is the point.** A
  message stored as `empty` reaches the model as an empty conversation turn; once
  repaired, the customer's actual words reach it. Grounding improves because the
  input is now complete, not because anything about the prompt changed.
- Any draft generated BEFORE a repair was grounded on the blank version. Those
  drafts are not regenerated automatically — nothing here touches
  `draft_replies`, and a human decides whether a draft written against an empty
  message needs redoing.
- No token is spent by running the repair, and nothing is written to
  `ai_usage_log`.

## Added: the notification draft fix — no AI involvement

Recorded here for the same reason the notification list itself was: a change with
"draft" in its description is exactly the kind of thing that quietly acquires a
model call, and this one has none.

- **No prompt, no instruction, no assembly step and no provider call.** Nothing
  in `lib/ai/` was read, imported or modified. `cstInstructions`,
  `buildDraftInput`, `validateDraftAccuracy` and every provider are
  byte-identical.
- The change is one SQL predicate deleted, one column projected, and a label in
  a drawer. It observes whether a `draft_replies` row exists; it never reads a
  draft's TEXT, its revisions, its sources or its findings.
- **Nothing about grounding changed.** What a draft may claim, what reaches the
  model, and what the accuracy gate does with the result are all untouched.
- No token is spent by the notification feed, before or after this fix, and
  nothing is written to `ai_usage_log`.
- The feed still refreshes when a draft is generated. That is a re-read of
  existing rows by an existing query — it costs no tokens and triggers no
  generation. Its purpose changed (the row's label updates rather than the row
  disappearing), its cost did not.

One thing worth noting for anyone reasoning about the drafting layer from this
document: the fix makes explicit, in code and in tests, that **a generated draft
is not a reply**. That was always true of this system — it is why `reviewed` is
terminal — but the notification feed had encoded the opposite assumption.

## Added: what the prompt says when there is no tracking

The sixth guard, and the only one added because of what the prompt did NOT say.

`verifiedTrackingBlock` returns null whenever no carrier result came back, and
the prompt omitted the block entirely — so on a delivery query with no shipment
data the model was told nothing whatsoever about tracking. It filled the gap:

```
"Here is your tracking number..."
"Please check your tracking details..."
"You can track your parcel using..."
```

**The omission was reasoned, and the reasoning was borrowed from the wrong
place.** It came from the bundle block: do not put a paragraph about a thing on
drafts that do not have that thing. True for a bundle, because a model does not
spontaneously describe package contents. False for tracking, because "where is
my parcel?" invites exactly the sentence we cannot support.

**TWO BRANCHES, because "no tracking" is two situations.** `null` from
`resolveTrackingContext` means six different things, and they do not all permit
the same reply:

| Established | The block says |
| --- | --- |
| A tracking number, no readable carrier update | `NO CARRIER UPDATE FOR THIS SHIPMENT` — you may give that number and say there is no further update; you may not state a position, a movement or an arrival |
| Nothing | `NO SHIPMENT TRACKING FOR THIS ORDER` — no number, link, courier or status; do not ask the customer to check or send tracking |

**"Tracking is unavailable" is refused too**, and this is the clause most likely
to be read as excessive later. It states no number and no status — and it still
tells the customer that a tracking record exists somewhere for them to chase.
The block says so in terms: the absence is in what we can see, not a fact about
the parcel.

**ONLY ON A DELIVERY QUERY.** Gated on the same category
(`"Delivery queries"`) that already decides whether to ask a carrier, so the
guidance appears exactly where the system would have had tracking to show and
adds nothing to a pre-sale question. `readConversation` is called once per draft
and shared with the category block.

### The deterministic half

A `GROUNDED_ASSERTIONS` entry rather than a prohibited-claim pattern, because
that mechanism allows an exact support condition — a verified `tracking_number`
fact — where the claim table only asks whether the word appears among the facts.

- Fires **critical**, so it buys a regeneration rather than a reviewer note.
- Grounded on the NUMBER, not on a `TrackingResult`, so the "no carrier update"
  branch above still works.
- Tested against three sentences it must not fire on: "we are on track",
  "I need to backtrack", "being picked and packed".

### What this cost, and what the guard was missing

`draft-validation-cost.test.ts` capped the composed prompt at 2,000 tokens and
measured a **cancellation** — a conversation that carries no tracking block. It
was blind to the dearest path in the application:

| Path | Composed |
| --- | --- |
| Pre-sale enquiry | 1,973.50 |
| Cancellation before dispatch | 1,984.75 |
| Delivery, tracking number no update | 2,095.75 |
| **Delivery, no shipment data** | **2,129.25** |

The cap is now **2,300**, measured across five paths, with the cheap ones still
held to 2,000 and asserted to carry no tracking guidance at all. Raising it was
put to the requester as a cost decision rather than taken quietly, and nothing
was shortened to fit.
