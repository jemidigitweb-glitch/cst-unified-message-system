# documentation/

Technical and user documentation for the CST Unified Message System that doesn't belong in code comments or the root `README.md`.

## What belongs here

- Architecture notes that are too long-lived for a code comment (e.g. how the marketplace-adapter pattern works, why the source DB is read-only)
- User-facing guides for CST agents using the review UI
- Explanations of a subsystem that spans multiple files (e.g. how a conversation resolves from source message to verified order context to AI draft)
- Onboarding notes for a new contributor

## What does not belong here

- Anything that's really a decision record for one piece of work — that's `closure/`
- Handover-specific setup/ownership notes — that's `handover/`
- CST business rules themselves — those live in the knowledge base this app reads from (`Knowledge-source/`), not here

Keep documentation close to what it describes when possible; use this folder for things that genuinely don't have a natural home next to code.
