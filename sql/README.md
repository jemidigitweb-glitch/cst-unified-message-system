# sql/

Approved, reviewed SQL for reference and inspection — not application code, and not how migrations are applied.

## What belongs here

- Approved inspection queries used to investigate the source database (e.g. how eBay's `market_place` code maps to a region, not a platform — a real finding from this project's own investigation)
- Read-only diagnostic queries worth keeping around for the next time a similar question comes up
- SQL referenced by a migration's own commentary, kept here for context rather than duplicated inline

## What does not belong here

- Migrations themselves — those live in `migrations/`, follow its `NNNN_<description>.up.sql` / `.down.sql` pairing, and are the only SQL this project actually runs against a database
- Any query embedded in application code — those live beside the repository function that runs them (e.g. `lib/repositories/order-context-repository.ts`), parameterised, never here as a loose copy
- Queries containing real customer data in their comments or example output — describe findings in prose instead

Every query kept here must be read-only against the marketplace source, or scoped to `cst_app` only, matching the rest of this project's read/write discipline.
