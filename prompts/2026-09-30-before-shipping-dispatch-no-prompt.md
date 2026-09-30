# Prompts — the before-shipping dispatch rule has none

**2026-09-30.** Where AI grounding exists in this feature, and where it
deliberately does not.

---

## There is no prompt, no model call, and no retrieval

`lib/domain/before-shipping-dispatch-rule.ts` is a pure function of:

- the category the classifier already produced,
- the customer's own message text (exact pattern matching only),
- the order numbers the conversation is verified against,
- one boolean and one timestamp read from the source database.

No OpenAI client is imported anywhere beneath it. No vector store is queried. No
corpus document is retrieved. Nothing here is drafted, generated or reviewed.

## Why not — this is the part worth stating

The question "had this order shipped when the customer wrote" has an **answer in a
database**. A model asked to infer it from a sentence would produce a confident
guess where a `SELECT` produces a fact, and the guess would be wrong in the one
direction that matters: promising a customer their parcel can still be stopped after
it has left. `lib/knowledge/message-priority.ts` already refuses to guess it —
`ADDRESS_CHANGE_IS_NOT_ESCALATED` says so — and this feature is the integration layer
that comment defers to.

The one reading that IS textual, "did the customer ask to cancel", runs CST's own
approved trigger row `INT-OS01` **by id**, with the row's own regex. That is a
reviewer-checkable string match against an approved workbook row, not a model
judgement, and it is reported rather than allowed to decide anything.

## What this feature does NOT feed

- **No `VerifiedFact` is produced.** Nothing here reaches a prompt, a draft or a
  citation. The corrected category is display and triage only.
- **The draft path is not aware of it.** `lib/ai/draft-assembly.ts` and
  `lib/ai/draft-validation.ts` still call `readConversation` directly and ground
  against the classifier's uncorrected reading. Deliberate and recorded in
  `duplicate-risk-reports/`.
- **No template is rendered.** The post-dispatch automation's templates are a
  separate feature and share no code with this.

## If somebody later wants a model here

They should not. The failure direction is asymmetric and the fact is queryable. If
the requirement ever becomes "explain in prose why this conversation moved
category", the explanation is already computable without a model: the
`BeforeShippingOutcome` and the `RequestTarget` together say exactly which condition
decided and which order it was decided about.
