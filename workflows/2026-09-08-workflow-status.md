# Workflow status — 2026-09-08

## Purpose

How a conversation actually moves through the system today, described
independently of the code that enforces it.

## Current status

The Phase 1 workflow is implemented and running. `reviewed` is terminal. The
invoice is an on-demand side action off the verified-context step — it is **not**
a workflow state and adds none.

## Implemented features

### The conversation workflow

```
Live message → Thread → Verify context → AI draft
→ Review / Edit / Regenerate → Save → Reviewed → STOP
```

State machine (`lib/domain/workflow.ts`):

```
received ──▶ drafting ──▶ pending_review ──▶ reviewed
                 ▲              │
                 └──────────────┘
             (regenerate or edit again)
```

- `received` → `drafting` → `pending_review` → `reviewed`.
- `pending_review` → `drafting` exists so a regeneration or a further edit moves
  the thread back.
- `reviewed` has **no outgoing transition**. There is deliberately no `approved`,
  `sending`, `sent` or `manual_handoff` — adding one would mean adding a
  transport.

### Context resolution flow

```
                    conversation (marketplace, storefront, listing ref, buyer)
                                          │
                              eBay?  ─── no ──▶ messages only, no order facts
                                │ yes
                                ▼
                       strict order match
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
      exactly one          several            none
             │                  │                  │
             ▼                  ▼                  ▼
      verified facts     ask the reviewer    same-storefront
      (deterministic_    (candidates shown;   fallback, only if
       single)            no ranking, no      the buyer has
             │            newest, no first)   exactly one order
             │                  │                  │
             └──────────┬───────┴──────────────────┘
                        ▼
          order facts → AI draft   and   → Print invoice available
```

Listing context (title, options, URL) resolves from the item reference alone, so
it is available even where no order resolved — which is exactly the pre-sales
case.

### The invoice action

Not a state. A reviewer may print at any point once exactly one order has
resolved:

```
Print invoice → conversation id (+ the reviewer's choice, where one was made)
              → server derives the order from the conversation's own keys
              → invoice context read from the source
              → PDF built in memory → opened in a new tab
```

- The browser never names an order. It names a conversation and, where one
  exists, a choice.
- The button appears exactly where the endpoint would answer. An ambiguous
  conversation with no choice made has no button, because offering to print
  before the choice is made would be offering to print a guess.
- Nothing is stored, no record is created, no state changes.

### Threading rules

- No marketplace source exposes a thread id, so a thread key is derived and
  carries the identifier of the rule that produced it.
- Conversations segment when the gap between consecutive messages exceeds
  **30 days**.
- A group enters the reply inbox only if it holds at least one inbound customer
  message. Outbound-only groups stay visible elsewhere and are never dropped.

## Database / data source

- Conversation and workflow state live in `cst_app`.
- Order/listing/invoice facts are read live from the read-only marketplace
  source, with the order resolution cached in `cst_app.context_snapshots`.
- A reviewer's order selection is **not** written down as a resolution: the
  schema reserves `user_confirmed` for a confirmation that names the confirming
  user, and this application has no user identity. The selection grounds one
  generation and nothing more.

## User workflow (what an agent does)

1. Pick a marketplace tab and open a conversation. Messages read oldest →
   newest, customer and CST on opposite sides.
2. Read the context panel. If several orders matched, choose the right one.
3. Generate a draft. Read it against the verified facts shown beside it.
4. Edit or regenerate as needed. Save. Mark reviewed.
5. Print the invoice if the customer asked for one.
6. Stop. Any actual reply to the customer happens outside this system.

## Known limitations

- The order → draft → invoice path is eBay only. Other marketplaces stop at
  "read the messages".
- There is no assignment, ownership or queue model — any agent can open any
  conversation.
- No workflow state records *who* reviewed, because there is no user identity.
- `reviewed` being terminal means the system cannot record whether a reply was
  ever actually sent.

## Added: a view onto the workflow, not a step in it

**Superseded in part — see "the notification stops reading a draft as an answer"
below, which removes the draft condition.** As first built, the order-change
notification list observed two ABSENCES in the workflow above and added nothing
to it:

```
no draft row  +  no reply after the customer's newest message  →  listed
```

- It introduces no workflow state, no transition and no terminal state. The four
  states and their transition table are byte-identical.
- It reads the ABSENCE OF THE DRAFT ROW, never `workflow_state = 'received'`.
  The state is a proxy that a saved human edit does not move (a PATCH appends a
  revision and advances nothing), so a conversation carrying an edited draft
  would otherwise reappear as untouched work.
- A conversation leaves the list the moment a draft is written or a reply lands
  after the customer's message — as a consequence of the existing workflow
  running, never as an action taken on the list.
- Opening, reading or ignoring the list changes nothing.
- It now spans every marketplace, which changes **who sees** a notification and
  nothing about what the workflow does with it. A conversation still moves
  `received → drafting → pending_review → reviewed` by exactly the same two
  routes, driven by exactly the same buttons.
- One addition to what does NOT notify: a conversation whose
  `inbox_visibility` is `filtered` — a bounce, a courier notice, another
  channel's notification, unsolicited mail. The ingestion layer already decided
  those are not reply work and recorded why. They remain in the inbox and remain
  fully workable; they simply do not claim a customer is waiting.
- Clicking a notification moves the reviewer's marketplace tab, because the
  conversation lives in another one. That is navigation, not a workflow
  transition: no state is read, written or advanced by it.

## Added: the thread is read as a record of decisions, not as a new step

Drafting now treats a previous CST reply as something this team decided, and an
offer the customer accepted as an agreed action to continue. **No workflow state,
transition or terminal state changed.** The four states and their transition
table are byte-identical.

Where it sits in the flow above: entirely inside the "AI draft" box. The thread
was already being read there — the full ordered conversation has always reached
the model, labelled `CUSTOMER` and `OUR PREVIOUS REPLY`. What changed is what is
read OUT of it.

```
verify context ──▶ AI draft ──▶ review / edit / regenerate ──▶ save ──▶ reviewed
                      │
                      ├── verified facts        (backend established)
                      └── accepted commitments  (NEW: an offer we made,
                                                 accepted by a later message)
```

Two things worth stating plainly about this shape:

- **An accepted commitment is a second, deliberately narrower grounding source,
  not a widening of the first.** It can support only "we are arranging this",
  and only for a remedy that appears as an offer in one of our own replies and
  is accepted by a later customer message, in that order. It cannot support a
  dispatch, a date, a courier or a tracking number — those still require the
  verified context, and that is enforced deterministically.
- **It grounds one generation and nothing more.** Nothing is written down. The
  commitment is re-read from the thread on every draft call, exactly as the
  category and intent already are, so there is no stored decision to go stale
  and no backfill to run. A reviewer editing or regenerating re-reads it.

The regeneration loop is unchanged, including the part that matters most here:
the accuracy gate still buys exactly one regeneration and only for a critical
finding. What changed is which drafts are critical. A reply confirming an agreed
resend previously raised `unsupported_claim` and bought a regeneration that
rewrote it into a refusal; a correct terse reply that left settled background
out raised two `intent_not_addressed` findings and bought one that put the
background back. Both now pass, so the loop runs less often, not more.

## Next pending items

- Marketplace reply sending, and any state after `reviewed` — not built, out of
  scope for this phase.
- Automatic sending.
- Invoice email sending.
- User identity, which would let a selection be recorded as `user_confirmed` and
  a review be attributed.
- Phase 2 workflow work.

## Added: message body repair — a correction, not a step

Body repair introduces no workflow state, no transition and no terminal state.
The four states and their transition table are byte-identical.

```
message stored with no usable body  ──repair──▶  same message, body filled in
```

- It does not move a conversation between states. A thread sitting in `received`
  stays in `received`; one in `reviewed` stays `reviewed`.
- It does not create, modify or invalidate a draft. `draft_replies` is never
  queried.
- It does not re-thread. The thread builder is not called and the existing
  `conversation_id` is written straight back, so a repaired message stays in the
  conversation it was already in.
- It does not reorder. `source_ts` is INSERT-only in the upsert, so the message
  keeps its place and the thread's read/unread state is unaffected.
- It is not scheduled and not triggered by anything a reviewer does. An operator
  runs it.

**The one real consequence for the workflow** is upstream of it: a conversation
whose customer message was blank may have been drafted against nothing. Repair
fixes the input; it does not revisit the output. Deciding whether such a draft
needs regenerating is a human judgement, and the existing regenerate button is
how it is made.

## Added: the notification stops reading a draft as an answer

**No workflow state, transition or terminal state changed.** The four states and
their transition table are byte-identical. What changed is what an OBSERVER of
the workflow concluded from them.

The notification feed watched for two absences. One of them was wrong:

```
before:  no draft row  AND  no reply after the customer's newest message
after:                      no reply after the customer's newest message
```

The draft condition asserted that generating a draft answers a customer. It
does not, and in this system it cannot: `reviewed` has no outgoing transition
and there is no transport after it, so every draft is work in progress by
construction. The workflow always said so; the feed was reading it wrongly.

**Why the draft row was the wrong test even on its own terms.** It was chosen
over `workflow_state` deliberately and for a good reason — a saved human edit
appends a revision and advances no state, so the state under-reports work. But
both are measures of OUR progress, and the question the notification asks is
about the CUSTOMER's: have they had a reply? Only an outbound message answers
that. The fix replaces a proxy for our activity with the thing actually being
asked about.

The feed still refreshes when a draft is generated. Not to remove the row —
that was the bug — but because writing a draft changes what the row says about
itself, from nothing to "Draft ready".

**`reviewed` is now visible as a waiting state.** A conversation reviewed here
with no reply yet on the thread stays listed and says "Reviewed · not sent".
That is not a new state; it is the existing terminal state, described accurately
for the first time on this list.

## Added: no workflow change — a gap in what the model was told

The tracking-absence fix adds no state, no transition and no step. The four
states and their transition table are byte-identical, and the context-resolution
flow above is unchanged: `resolveTrackingContext` asks the same question of the
same conversations and returns the same answers.

What changed is what happens to ONE of those answers. That resolver returns null
for six distinct reasons — not a delivery query, no tracking number, no carrier,
carrier unrecognised, carrier unsupported, lookup failed — and the prompt
collapsed all six into "omit the tracking block". The flow was right; the
reading of its output was lossy.

```
resolveTrackingContext ──▶ a carrier result   ──▶ verified tracking block
                       └─▶ null               ──▶ (nothing at all)          BEFORE
                                              ──▶ "a number, no update"     AFTER
                                              ──▶ "nothing established"
```

The split is between two of those six reasons, and it matters because they
permit different replies: `no_tracking_number` means the customer cannot be
given anything, while `carrier_not_supported` and `lookup_failed` mean we hold a
verified number the carrier simply would not talk to us about.

**Nothing about the reviewer's path changed.** The same conversations resolve
the same context, the draft panel behaves the same way, and a reviewer still
reads, edits, regenerates, saves and marks reviewed exactly as before.
