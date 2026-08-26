# validation/

Test plans, acceptance checks, and validation results for CST features — the record of *how* something was confirmed to work, separate from the automated test suite in `tests/`.

## What belongs here

- Manual test plans for things automated tests can't fully cover (e.g. "open a real eBay conversation with a verified return, confirm the sidebar shows Return context and the AI draft doesn't claim to have seen a photo")
- Acceptance checklists tied to a specific task's requirements
- Results of validation runs against real (read-only) data — counts, pass/fail summaries, not raw customer records
- Regression checklists to re-run before a risky change (e.g. the order-context marketplace-code matching)

## What does not belong here

- The automated tests themselves — those live in `tests/` and run via `npm test`
- Raw query output containing customer message text or personal data — summarize findings, don't paste rows
- Final sign-off/closure notes — that's `closure/`; this folder is the checklist and its results, not the decision
