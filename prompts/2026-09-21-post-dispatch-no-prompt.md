# Grounding — post-dispatch automation — 2026-09-21

Supplements [2026-09-08-grounding-status.md](2026-09-08-grounding-status.md).

## There is no prompt in this automation

The post-dispatch automation was simplified on 2026-09-21 to match its specified
requirement. It does not call a model, does not retrieve from the CST corpus,
and has no instructions of any kind. An earlier version of it did; that version
is gone, and `tests/guards/automation-no-transport.test.ts` fails the build if
anything under the automation imports `@/lib/ai/` or `@/lib/knowledge/` again.

What replaced it is deterministic:

- a **saved template** (`cst_app.automation_templates`), approved and versioned;
- `{{placeholders}}` substituted from **verified source values only**;
- a **missing value fails the record**, naming the value, rather than rendering
  a blank or a guess — `"Your order  has been dispatched"` and
  `"Your order null has been dispatched"` are both messages this business would
  not send, and both would pass a render that treated absent as empty.

The values a template may reference are `customer_name`, `order_number`,
`marketplace`, `storefront`, `dispatch_date`, `tracking_number`, `courier`,
`product_title`, `sku` — each copied from a column. No email address, postal
address or phone number is among them.

## The CST conversation draft workflow is unaffected

`lib/ai/instructions.ts`, `lib/ai/draft-generator.ts` and the whole grounding
design described in the 2026-09-08 document continue to govern customer replies,
unchanged. The guard above also asserts those files still exist, because
"we simplified the automation" is exactly the change that takes a shared module
with it by accident.
