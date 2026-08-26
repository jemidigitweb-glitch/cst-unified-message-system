# workflows/

Business workflows, process diagrams, and state flows for the CST Unified Message System — how a conversation is meant to move, described independently of the code that enforces it.

## What belongs here

- The Phase 1 workflow diagram and its terminal-state rule: `Live Message → Thread → Verify Context → AI Draft → Review/Edit/Regenerate → Save → Reviewed → STOP` (see root `README.md`)
- State diagrams for a conversation's `workflow_state` transitions
- Process notes for how CST agents are expected to use the review UI day to day
- Diagrams of how context resolves (order → product → return), since several features chain off the same verified-order snapshot

## What does not belong here

- The workflow *implementation* — that's `lib/sync/draft-writer.ts` and `tests/guards/draft-workflow.test.ts`, which are the actual source of truth
- CST's customer-service business rules (refunds, returns policy, etc.) — those live in the knowledge base this app reads from, not here
