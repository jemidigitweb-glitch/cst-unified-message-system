# query-packs/

Reusable collections of investigation queries — grouped by the question they answer, so the next investigation doesn't start from zero.

## What belongs here

- A named set of read-only queries for a recurring investigation (e.g. "does this eBay sub-account's orders use the majority `market_place` code, or a different one" — the exact check that found sub-account 28 filing orders under the wrong assumed code)
- Query packs for checking context-resolution health (e.g. counting `cst_app.context_snapshots` by `resolution` and marketplace)
- Packs used to verify a fix against real data before and after, kept for the next similar fix

## What does not belong here

- One-off ad hoc queries that answered a single question and won't be needed again
- Any query that writes to the marketplace source — every query kept here must be read-only there, matching this project's read-only source discipline
- Query output containing real customer data — keep the query, not the result rows
