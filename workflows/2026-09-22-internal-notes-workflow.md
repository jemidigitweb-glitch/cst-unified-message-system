# Internal notes — how an agent uses them

**2026-09-22.**

This describes the working process, not the code. The conversation workflow it
sits beside is unchanged: `Live message → thread → verify context → AI draft →
review → reviewed → STOP`.

## Where notes sit in that workflow

**Alongside it, touching none of it.** An internal note changes no
`workflow_state`, blocks no transition, and is not a step anybody has to
complete. A conversation can reach `reviewed` with no notes at all, and writing
one does not move a conversation anywhere.

That independence is deliberate. The review workflow is what produces a reply
to a customer; notes are what CST tells itself about the case. Wiring one into
the other would put internal commentary on the path that ends in a customer
reply — which is the failure this feature is built to make impossible.

## The loop

```
open a conversation
   → the newest internal note is already pinned, between the header
     and the first message — read it before the thread
   → details column, Internal Notes section: the full history
        → Add note      short summary of where the case now stands;
                        it becomes the pinned note immediately
        → Edit          correct one that was wrong or incomplete
        → Delete        remove one that should not have been recorded
                        (confirm on the row; there is no undo)
```

Adding a note is the only action. There is no pin step and no Pin button: the
newest note is the pinned one because it is the newest note. Editing it
changes both the pinned card and the one in the details column, because they
are the same note shown twice.

Only internal notes are ever pinned. A customer message or a CST reply cannot
be pinned — this is not a message-pinning feature, and the pinned area has no
way to hold one.

## What belongs in a note

A short internal summary — the main point, the issue, the progress, the case
history. The examples the feature was specified with:

- "Customer is asking whether the replacement item has been dispatched."
- "Courier confirmed the parcel was delivered but customer says it was not
  received."
- "Supervisor instructed the agent to offer a replacement."
- "Listing issue: product dimensions shown in the listing do not match the
  actual item."
- "Case history: customer contacted CST previously about the same issue."

No category is chosen. If a note needs to say it came from the courier or from
a supervisor, the note says so in its own words, which is how the examples
above already read.

## What does not belong in a note

- **Anything written for the customer.** A note is never sent, quoted, or used
  to draft a reply. A sentence written as though the customer will read it will
  mislead the next agent about what has actually been said to them.
- **Who instructed what, if it matters formally.** Notes are unattributed —
  there is no sign-in — so "Supervisor instructed…" does not record which
  supervisor. If that matters, name them in the text; the system will not.
- **Anything that belongs in the reply.** If the customer needs to know it, it
  goes in the draft, not here.

## Two things to know about the process

**A deleted note is gone.** There is no archive and no undo. The interface asks
before deleting for exactly that reason. Deleting is also the only way to
clear the pinned area — a note cannot be unpinned and kept.

**An edited note keeps no history.** The card shows `· edited`, but the
previous wording is not retained. Correcting a typo is safe; rewriting a note
to say something materially different loses what it said before, so for a
change of position it is usually better to add a new note than to edit the old
one.
