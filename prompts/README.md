# prompts/

AI prompts and prompt-related reference material — for the drafting model this project calls, and for AI coding assistants working on this repo.

## What belongs here

- Versioned copies or change notes for the draft-generation instructions (the live versions are `cstInstructions()` / `restrictedInstructions()` / `marketplaceClause()` in `lib/ai/instructions.ts`) — kept here when a change is worth explaining outside a commit message
- Notable Claude Code prompts used for a significant piece of work on this repo, when worth preserving for reuse
- Notes on what context reaches the model vs. what stays UI-only (e.g. verified order/return facts reach the AI as plain text; images never do — this project has no vision/image-analysis call)

## What does not belong here

- The live prompt-building code itself — that's `lib/ai/draft-assembly.ts` and `lib/ai/instructions.ts`; nothing here is what actually runs
- Real customer conversation text used as a prompt example — use synthetic examples, same rule as `tests/`
- API keys or provider configuration — those are `.env`-only, per `lib/config/env.ts`
