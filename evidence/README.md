# evidence/

Proof that a piece of work was actually done and actually checked — not the work itself.

## What belongs here

- Screenshots of the running app (sidebar, draft panel, chat thread) showing a feature working
- Test run output / coverage summaries captured at a point in time
- Demo recordings or GIFs for a reviewer who wasn't in the session
- Before/after evidence for a bug fix (e.g. a broken draft vs. the corrected one)

## What does not belong here

- Real customer message text, buyer names, addresses, or emails — mask or use synthetic data, same rule as the test suite (`tests/repositories/*.test.ts` use only synthetic rows)
- API keys, database credentials, or any `.env` values
- Anything that duplicates what a test already proves — a passing test is evidence too; this folder is for things a test can't capture (visual state, a live run's output)

Name files by date and what they're evidence of, e.g. `2026-08-26-return-context-sidebar.png`.
