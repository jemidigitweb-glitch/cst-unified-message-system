# Root cause capture — no prompt

**2026-09-29.**

**This feature uses no model, no prompt and no AI of any kind.** It is recorded
here because this folder tracks where grounding exists, and an absence is worth
stating explicitly so nobody assumes otherwise.

## What decides the value

A CST agent, by pressing a chip. There is no suggestion, no ranking, no
pre-selection and no default. The form opens with nothing chosen.

## Why there is no suggestion, and it was considered

The message application has an AI-suggested root cause. Copying it was
deliberately not done in this pass, for two reasons:

1. **A suggestion on a reporting dimension is a thumb on the scale.** The whole
   point of asking which courier causes the most problems is to get an answer
   somebody can act on. A suggested courier that an agent accepts without
   reading produces a number that measures the suggester, not the courier — and
   nothing on the report would say which.
2. **There is nothing to ground it in.** CST holds no labelled training data for
   this, and the obvious source — the message application's own values — is
   written by a classifier that rewrites them every five minutes with no user
   and no log. Grounding a suggestion in that would launder one system's
   unaudited guess into another system's recorded decision.

If a suggestion is wanted later it needs its own decision, its own grounding and
its own column, so a report can separate "an agent chose this" from "an agent
accepted this". Not something to acquire by accident.

## Standing guard

`tests/guards/message-app-root-cause-panel.test.ts` asserts the display section
carries no confirmation or suggestion vocabulary — `confirm`, `suggest`,
`aiSuggested`, `confirmedBy` — so none of the message application's next three
behaviours appears here ahead of a decision to build it.

## What this feature must never reach

The AI draft input. The root cause an agent records is internal CST bookkeeping
and is structurally absent from the three paths that leave CST: the draft input,
the conversation export, and the post-dispatch automation body. Nothing in
`lib/domain/root-cause-*` or the writer is imported by any of them.
