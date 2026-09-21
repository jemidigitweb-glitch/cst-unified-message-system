# Validation — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-validation-status.md](2026-09-08-validation-status.md).

## The eighteen checks the brief asked for

| # | Check | Where | Result |
| --- | --- | --- | --- |
| 1 | Dispatched shipment creates one scheduled record | `post-dispatch-scan.test.ts` "creates one scheduled record for a dispatched shipment" | pass |
| 2 | `scheduled_at = dispatched_at + 24h` by default | "puts a scheduled moment exactly 24 hours after dispatch by default" + "schedules from the dispatch time, not the scan time" | pass |
| 3 | Configurable delay works | "honours a configured delay other than 24" | pass |
| 4 | Disabled automation creates/processes nothing | "reads nothing from the source and creates nothing when disabled" + `post-dispatch-processing.test.ts` "does nothing at all once the automation is switched off" | pass |
| 5 | Disabled storefront is excluded | "excludes a storefront that is not enabled" + the eligibility case | pass |
| 6 | Due order is rechecked | `post-dispatch-processing.test.ts` "re-reads the current source state before processing" | pass |
| 7 | Cancelled order → skipped | "skips a cancelled order found at recheck time" | pass |
| 8 | Refunded order → skipped | "skips a refunded order found at recheck time" | pass |
| 9 | Returned order → skipped | "skips a returned order found at recheck time" — authoritative via `customer_service.ebay_returns` / `amazon_returns` | pass |
| 10 | Duplicate shipment creates no second record | "is idempotent: a repeated scan creates no duplicate", "lets the unique key stop a second insert on its own", "does not re-create a record for a shipment already processed" | pass |
| 11 | The selected saved template is used | "stamps the selected template and its version on the record", "fails when the stamped template version no longer matches", plus the rendering suite | pass |
| 12 | Test mode makes zero marketplace/email sends | "issues no statement that could reach a marketplace or a mailbox" + `automation-no-transport.test.ts` (no host, no URL, no `fetch`) | pass |
| 13 | Test mode reads zero marketplace credentials | `automation-no-transport.test.ts` "reads no marketplace, mail or model credential" | pass |
| 14 | Admin settings work | the "safe defaults" suite (10 cases) + live PATCH evidence | pass |
| 15 | Statuses are only the five | "has exactly the five specified statuses", the migration CHECK, and the lifecycle suite | pass |
| 16 | Post-dispatch AI/review workflow is removed | `automation-no-transport.test.ts` "imports nothing from the CST draft layer", "has removed the automation draft, client and writer modules" | pass |
| 17 | Unrelated CST AI/review functionality unchanged | `automation-no-transport.test.ts` "leaves the CST reply draft workflow intact", plus the whole pre-existing suite still green | pass |
| 18 | Source DB writes = ZERO | "writes nothing but SELECTs to the source" in both test files | pass |

## How to run

```
npx vitest run tests/automation tests/guards   # 424 tests
npx vitest run                                 # 3,547 tests, 128 files
npx eslint app lib components tests
npx tsc --noEmit
```

## State of the wider suite

`npx vitest run` passes: 128 files, 3,547 tests, plus 12 files / 30 tests
skipped (live-provider suites needing credentials). The pre-existing CST draft
and conversation suites are untouched and still green — which is check 17.

`npx eslint` reports 2 pre-existing `react-hooks/set-state-in-effect` errors in
`components/workspace.tsx` and `components/conversation-view.tsx`, and 2
pre-existing unused-import warnings. None is in the automation files; the count
is unchanged by this work.

`npx tsc --noEmit` reports one pre-existing error in `.next/types/validator.ts`,
a stale build artefact referencing a route that no longer exists.

## Guard changes made, and why they do not weaken anything

`tests/guards/no-send-capability.test.ts` and `draft-workflow.test.ts` each
forbade the literal `'sent'` everywhere. The automation was specified with it as
a lifecycle word, so both now carry a narrow, documented exemption for these
files only — listed by exact path in one, by an explicit predicate in the other.

In exchange, `automation-no-transport.test.ts` was **tightened**: it now permits
**zero** outbound URLs (previously one, for the model), forbids `fetch` outside
the browser component, forbids every marketplace/mail/model credential, and pins
0011's `CHECK (status <> 'sent' OR test_mode)`. The capability is checked harder
than before; only the assumption about spelling changed.

## Not covered by automated tests

- **The interface.** No DOM test environment exists in this project
  (`vitest.config.mts` sets `environment: "node"`), so the screens are covered by
  static guards and were exercised by hand against the running application.
- **A real marketplace transport.** There is none to test.
