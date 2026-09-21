# Implemented scope — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-implemented-scope-status.md](2026-09-08-implemented-scope-status.md).

> **Superseded within the day.** An earlier version drafted with AI and used the
> CST review workflow. Simplified to the specified requirement.

## In scope, built, and running

| Step | Where | State |
| --- | --- | --- |
| Detect dispatch timestamp | `dispatch-event-repository.ts` (`order_info.shipped_time`) | done |
| Check configuration | `automation-settings-service.ts` (`scanRefusal`) | done |
| Create one scheduled record | `insertScheduledItem` | done |
| `scheduled_at = dispatched_at + delay_hours` | in SQL, at insert | done |
| Recheck when due | `processDueItems` → fresh source read | done |
| Load the selected saved template | `templateById`, by stamped id AND version | done |
| Render in test mode, locally | `renderTemplate` | done |
| Record the result | `markItemProcessed` / `markItemSkipped` / `markItemFailed` | done |
| Cancel a scheduled record | `cancelItem` | done |
| Admin page | `components/automation-admin.tsx` | done |

## Removed from this automation

AI-generated drafts · OpenAI retrieval · draft revisions · Edit · Regenerate ·
Mark Reviewed · `drafting` · `pending_review` · `reviewed`.

Files deleted: `lib/ai/automation-draft-generator.ts`,
`lib/ai/automation-draft-client.ts`, `lib/sync/automation-draft-writer.ts`,
`components/automation-message-view.tsx`,
`app/api/automations/[itemId]/{draft,workflow}/route.ts`,
`app/automations/[itemId]/page.tsx`.

`tests/guards/automation-no-transport.test.ts` asserts each is gone, that the
automation imports nothing from `@/lib/ai/` or `@/lib/knowledge/`, and — in the
same file — that the CST conversation draft workflow is still present.

## Explicitly out of scope, and absent

eBay API · email API · marketplace API · marketplace tokens or credentials · a
Send button · a send endpoint · a sender service · retry-send · a `sending`
status. None exists, and the guard fails the build on any outbound URL, any
`fetch` outside the browser component, or any marketplace/mail/model credential.

## Deliberate decisions

- **`sent` means "processed successfully".** It was specified. The database
  constrains it to test-mode rows and the interface labels it
  **Processed (test)**, so the word cannot become a claim about a customer. Two
  standing guards carry a narrow, documented exemption for it.
- **Test mode cannot be switched off.** There is no transport, so a live run
  could only fail; the settings API refuses the change rather than letting an
  operator reach a state where every record fails.
- **`failed` is terminal.** An automatic re-queue turns one outage into a loop.
- **No resend.** The natural key is the shipment and ignores status.

## Verified live

43 real dispatched shipments discovered and scheduled at exactly
`dispatched_at + 24h`; 25 processed in test mode; a repeated scan created 0 and
reported 43 duplicates; one record cancelled and then never claimed. Zero writes
reached the source database.
