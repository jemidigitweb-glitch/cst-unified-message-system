# Root cause capture — workflow

**2026-09-29.** What an agent does, and what the system does behind it.

## The agent's path

1. Open a conversation. The context panel shows **Message App Root Cause** (if
   that application recorded one) and, directly beneath, **CST Root Cause**.
2. Press **Record** — or **Change**, if something is already recorded.
3. Press one of eighteen chips.
   - Any label: an optional note box appears.
   - **OTHER**: a box appears demanding at least 30 characters, counting up as
     they type. What they write is stored **as** the root cause.
   - **Delivery Issue**, **FULFILMENT_CARRIER**, **FULFILMENT_WAREHOUSE**: ten
     courier chips appear. Once a courier is chosen, ten issue-type chips appear
     beneath it.
4. Press **Record**. The panel shows the new value; the form clears and closes.

The Record button is disabled until the selection is complete, and **the reason
it is disabled is on screen beside it** — "Choose the courier.", "That
explanation is 12 characters. Give at least 30." An agent never has to guess
which of four levels is incomplete.

## What the system does

```
  chip pressed
      │
      ├─ readRootCauseSelection(...)   in the browser
      │     └─ enables the button, or supplies the sentence under it
      │
  Record pressed
      │
      └─ POST /api/conversations/:id/root-cause
            │
            ├─ readRootCauseSelection(...)   again, on the server
            │     └─ refuses → 400 with the SAME sentence
            │
            ├─ recordRootCause()  → one INSERT, one table
            │     ├─ 23503 no such conversation   → 404
            │     ├─ 42P01 migration not applied  → 503
            │     └─ 23514 a CHECK refused it     → 400 + a loud server log
            │
            └─ 201 with the row the DATABASE stored
                  └─ panel renders that, never what it sent
```

**The same function runs at both ends.** That is what keeps "why can I not save"
answerable and stops the enabling rule and the saving rule drifting into
disagreement.

**A CHECK firing should be unreachable**, because the domain rule enforces the
same thing first. If it happens, the two statements of the rules have drifted —
so it is logged loudly rather than surfacing as an anonymous 500.

## Changing a recorded root cause

Press Change and record again. This **inserts**; it does not update. The
previous value stays in the table and stays readable through
`getRootCauseHistory`. There is no edit and no delete, at any layer — no PATCH,
no DELETE, no UPDATE statement, no soft-delete column.

## Switching conversations mid-selection

The panel keys the selector by conversation id, so switching threads unmounts
and remounts it and a half-filled selection cannot follow the agent to the next
case. This is load-bearing and pinned by a guard: if the key goes, the reset
goes silently with it.

## When the migration is not applied

The application degrades rather than breaking:

- The message-app display works exactly as before.
- The CST section reads as nothing recorded; the server logs a warning once per
  read.
- Pressing Record answers **503 "Recording a root cause is not available"**,
  shown to the agent in the same place as any other refusal.

## What has no workflow

Nothing here schedules, queues, wakes a worker, or is picked up by a later pass.
There is no state machine: a recorded root cause has no status, no assignee and
no lifecycle. It is a row somebody wrote and somebody else will count.

No customer is contacted, at any step. The table holds no recipient, no channel,
no template and no body, so there is nothing for a transport to read even by
accident.
