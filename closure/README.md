# closure/

The record of what was decided and finished, once a piece of work is actually done.

## What belongs here

- Completion records for a task or feature: what was built, what was explicitly out of scope, what was verified before calling it closed
- Final decisions made along the way, especially ones that overrode an initial plan (e.g. why a feature's UI was added and then removed, while its backend resolver stayed because another feature depends on it)
- A short list of closed items for a phase of work, so a later contributor doesn't have to reconstruct "was this actually finished?" from commit history

## What does not belong here

- In-progress notes or plans — those aren't closed yet
- Test plans or acceptance criteria themselves — that's `validation/`; this folder records the *outcome*, not the checklist
- Anything that duplicates a git commit message — only add a closure record when there's context worth keeping that the commit message doesn't carry
