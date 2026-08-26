# handover/

Everything a new owner or a returning contributor needs to pick this project up without re-deriving it from the code.

## What belongs here

- Handover packages summarizing a phase of work (what shipped, what's outstanding, what to watch)
- Environment/setup notes beyond what's in the root `README.md`'s "Local development" section — e.g. who holds which credentials, which database this app's `.env` should point at
- Ownership information: who to ask about the source database schema, who owns the CST rule corpus, who approves a production deploy of this application
- Known operational gotchas (e.g. the marketplace source database is shared with unrelated production systems and must stay read-only)

## What does not belong here

- Step-by-step technical documentation of how a feature works — that's `documentation/`
- Final sign-off records for a specific piece of work — that's `closure/`
- Credentials or `.env` values themselves — reference where they're stored, never the values
