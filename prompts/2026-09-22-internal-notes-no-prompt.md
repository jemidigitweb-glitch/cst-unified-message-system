# Internal notes — no prompt change

**2026-09-22.**

**The internal-notes feature sends nothing to a model, and no prompt changed.**
This note exists so that the absence is recorded rather than assumed, the same
reason `2026-09-21-post-dispatch-no-prompt.md` exists.

## What was not touched

`cstInstructions()`, `restrictedInstructions()` and `marketplaceClause()` in
`lib/ai/instructions.ts` are unchanged. `buildDraftInput()`,
`conversationBlock()` and `contextBlocks()` in `lib/ai/draft-assembly.ts` are
unchanged. `DraftRequest` in `lib/ai/provider.ts` is unchanged.

## What does not reach the model, and why it cannot

The model's user content is composed from `DraftRequest` — the thread, the
marketplace, the verified facts, and optionally tracking, bundle and correction
blocks. **`DraftRequest` has no field for a note and gains none here**, so
there is no way for one to be composed into a draft, whatever a later edit to
the assembly file does.

The point is not stylistic. A note reading

> Supervisor instructed the agent to offer a replacement.

is an instruction to a colleague. A model handed that as conversation context
would reasonably write "we can offer you a replacement" into a reply to the
customer — turning an internal deliberation into a commitment nobody approved.
That is the specific failure this feature is designed to make impossible, and
it is prevented structurally rather than by prompt wording, because a prompt
instruction not to use a piece of context is a request, not a guarantee.

`tests/guards/internal-note-visibility.test.ts` fails the build if
`lib/ai/` imports any internal-note module, or if `provider.ts` or
`draft-assembly.ts` so much as mention one.

**Still true after the CRUD revision.** Edit and delete added two more ways for
a note to change, and none of them added a way for one to reach a model:
`DraftRequest` gained no field, the assembly file gained no block, and the two
new writer functions are imported by exactly one route.

## If a later phase wants notes in a draft

It would be a deliberate feature with its own design, not a widening of this
one. At minimum it would need: a per-note decision about whether it may inform
a reply, a prompt block that frames a note as background rather than as
something to repeat or promise, and an accuracy check that catches an internal
instruction surfacing as a commitment. None of that is in scope here, and the
guard should stay until it is built.
