# Case Detection Indicator — scope status

**Date:** 2026-10-02
**Branch:** `sync-reconcile-late-arrivals` (uncommitted)

---

## Built and working

| | Status |
| --- | --- |
| Migration `0022_marketplace_cases` | **applied** to `varmen_db.cst_app`, 33 → 35 tables |
| Standalone importer | **run and published** — run 3, 21,022 cases, 2026-10-02 09:07:49+02 |
| Storefront verification for every marketplace | **done** — allowlist resolved from the order source at run time |
| Read repository with the publication gate | **done** |
| Per-store freshness | **done** |
| Case context resolver, five states | **done** |
| `GET /api/conversations/:id/cases` | **done**, GET-only |
| Flag above the thread | **done** |
| Details-column section | **done** |
| Tests: 112 new across four files | **done**, passing |
| Documentation across twelve folders | **done** |

---

## Decisions taken, and why

**The detail section is mounted after the order section**, because a case is a
fact about that order and reads as a non-sequitur above it.

**A flag was added above the thread anyway.** Measured on the running
application: the section sat 1,305px down a 2,174px sidebar, below the
root-cause chip grid. A correct panel nobody reaches is not a feature. The
detail stays where it belongs and the headline moved to where it is seen — the
same split, and the same mechanism, as the Repeat-Customer Warning.

**The details column was widened 300px → 380px** (320px below `xl`). Every row
in it is a label-left/value-right pair that truncates rather than wraps, and that
column now carries seven sections. `tests/guards/notification-bell.test.ts`
pinned the old tracks; the pinned values were **updated with the reason
recorded**, not the assertion removed — a drawer that silently reflowed the
workspace is still a failure and is still caught.

**The case lists are bounded at `max-h-96` with their own scrollbar**, so a buyer
with eight cases cannot push the rest of the column off the screen.

**`unknown` cases sit with the live ones**, not behind the closed disclosure.
14,436 of 21,022 cases are `unknown` and most are Amazon returns reading
`Approved` — nothing in the source says they are over.

**Coverage travels as counts, not store names.** A reviewer needs to know a case
source has never been imported; what the other system calls its tables is not
theirs to read.

**The freshness statement is duplicated** between the read repository and the
importer's writer, deliberately: importing the writer would pull the importer's
module graph into a route's dependencies. A guard asserts the two agree.

**`SECTION_HEADING_CLASS` moved to `components/sidebar-section.tsx`.** The cases
panel is a section of the context panel and is mounted by it, so importing the
constant back out of the parent would be a module cycle. `context-panel` re-
exports it, so the workspace and the evidence pane are unchanged.

---

## Not done, deliberately

- **No scheduler, cron entry or worker for the import.** MySQL access stays
  manual. A guard fails the build if `cron`, `setInterval`, `watermark` or
  `feed_key` appears in the importer.
- **No write path.** No control, no form, no status change, no way to act on a
  case from CST.
- **No reconciliation with `customer_case_history`.** The 1,098-case overlap is
  declared and the key shapes match so a future report can deduplicate; nothing
  sums the two today.
- **No manual-order-selection support.** A reviewer's in-browser choice does not
  reach the case lookup; making it would mean re-validating that order against
  the live source on every lookup.
- **No AI anywhere in this feature.** See `prompts/`.

---

## Open, and each is a decision rather than work

1. **A second apply run has never been performed.** The update path is unproven
   live. See `validation/` §4.1.
2. **Amazon `Approved` stays `lifecycle = unknown`** — 12,398 cases. If CST
   decides approved means something more specific, that is a vocabulary change
   to `lifecycleFor` and a re-import, not a display change.
3. **FBA warehouse outcomes are under-reported** because the event collapse lets
   a merchant-fulfilled row's status win. Nobody has counted by how much.
4. **Whether a cross-table case report should exist at all**, and which table it
   should prefer for the overlapping 1,098.
5. **The 24-hour staleness window is a decision, not a measurement.**

---

## Not touched

`lib/knowledge/message-category.ts` is unchanged and still frozen. The AI
drafting path, the accuracy gate, the Repeat-Customer Warning, the automation and
the order resolver are all unchanged. `customer_case_history` holds the same
1,098 rows with the same `imported_at`.
