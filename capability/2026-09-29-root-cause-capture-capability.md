# Root cause capture — what the system can and cannot do

**2026-09-29.** Describes what exists now. Supersedes nothing: the read-only
"Message App Root Cause" display recorded earlier this week is still there and
still read-only. This adds CST's own recording beside it.

**One thing is built but not live: migration `0020` has not been applied.** See
"Cannot, until 0020 is applied" below.

## Can

- A CST agent can record a root cause against any conversation, in any
  marketplace tab. Nothing here is marketplace-specific — it hangs off
  `cst_app.conversations`, which is marketplace-neutral.
- The agent chooses from **eighteen labels**, presented as a chip grid in the
  context panel. The labels are the message application's own, taken from what
  it has actually stored across all five marketplace tables — not invented, and
  not a parallel CST vocabulary.
- Choosing **OTHER** opens a box demanding at least 30 characters, and that
  prose is stored **as** the root cause. This copies the message application's
  behaviour exactly, including the number.
- Choosing **Delivery Issue**, **FULFILMENT_CARRIER** or **FULFILMENT_WAREHOUSE**
  opens three further levels: courier (required, ten options), courier issue
  type (optional, ten options), and a free-text note (optional).
- An agent can **change** a recorded root cause. Doing so records a second row;
  what was there before stays readable.
- Both values are on screen at once and separately labelled: what the message
  application recorded, and what CST recorded. Where they disagree, a reviewer
  can see it.
- Every recorded row is stamped with the vocabulary version that produced its
  labels, so a label can be read against the list that offered it.

## Cannot

- **Cannot write anything to the message application.** CST holds no write
  privilege there — measured, not assumed. A selection recorded here is a CST
  record and that application will never see it.
- **Cannot overwrite or delete a recorded selection.** The table is append-only.
  There is no PATCH and no DELETE on the route, no UPDATE and no DELETE in the
  writer, and no soft-delete column.
- **Cannot be seen by a customer.** There is no customer-facing client in this
  application, and this value is structurally absent from the three paths that
  do leave CST: the AI draft input, the conversation export, and the
  post-dispatch automation body.
- **Cannot record a courier against a cause that does not involve one.** A
  courier posted with, say, `OUT OF STOCK` is refused rather than dropped — a
  silently discarded answer would tell an agent it was saved when no report
  would ever show it.
- **Cannot record a courier or issue type outside the ten agreed for each.**
  Both are CHECK-constrained in the database and validated before the write.
- **Cannot store the literal word `OTHER` as a root cause.** The minimum-length
  rule refuses it and a CHECK stands behind that.
- **Cannot name who recorded it.** CST has no interactive sign-in; the author
  column exists and is written NULL. An absent author, never a guessed one.
- **Cannot report yet.** Capture only this pass. Counts, percentages and the
  Excel/CSV export are the next piece of work — see the handover.

## Cannot, until 0020 is applied

`migrations/0020_conversation_root_cause.up.sql` is **written, reviewed and
statically tested, but not applied**, following this project's convention that
migrations are run by hand.

Until it is applied, the application degrades honestly rather than breaking:

- The message-app display half of the panel works exactly as before.
- The CST half reads as "nothing recorded" and logs a warning server-side.
- An attempted recording answers **503 "Recording a root cause is not
  available"** rather than a 500.
