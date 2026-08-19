# Repositories

**Empty by design.** Data access lands here in a later task; nothing is stubbed
out now just to fill the folder.

Each module in this directory owns the SQL for one source area (eBay messages,
orders, listings, application state). Rules for anything added here:

- **Parameterised SQL only** (`$1`, `$2`, …). Never interpolate values into a
  query string.
- **No ORM.** The source database has zero foreign key constraints, so every
  join is an explicitly reviewed relationship proven against real data during
  Day 1 discovery — not something a mapper may infer from column names.
- **Source repositories are read-only.** They use the read-only pool, which
  additionally pins `default_transaction_read_only=on` at the session level.
- Rows cross into the domain layer through a Zod schema, so a source column that
  changes shape fails loudly at the boundary instead of silently downstream.
- SKU values pass through **verbatim**. No trimming, casing, or splitting.
