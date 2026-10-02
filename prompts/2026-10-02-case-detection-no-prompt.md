# Case Detection Indicator — there is no prompt

**Date:** 2026-10-02

**No AI is involved in this feature at any point.** This file exists because the
twelve-folder record requires every feature to say where AI grounding exists —
and here the honest answer is "nowhere", which is worth stating rather than
leaving to inference.

---

## Nothing here calls a model

| Stage | What decides |
| --- | --- |
| Which cases exist | the imported snapshot, keyed on the source's own case identifier |
| Which case belongs to this conversation | an exact order reference, or an exact (case-folded) buyer handle |
| Which order the conversation is about | the existing order resolver's stored answer, not this feature |
| What a case's lifecycle is | `lifecycleFor()` — a pure function over each store's own closure column, from measured vocabularies |
| What the screen says | fixed label maps in `lib/domain/marketplace-case-display.ts` |

There is no provider call, no embedding, no similarity score, no ranking and no
free text anywhere in the path.

---

## Why that matters here specifically

The brief that produced this feature says it in one line: **do not use AI to
guess case/order relationships.**

A model asked "is this case about this conversation?" would answer plausibly
every time, including when it is wrong, and the cost of a wrong answer is an
agent telling a customer a return is open on an order that has none — or worse,
quoting another customer's case reference. The only two keys used are an order
reference the importer verified against `order_management.orders` and a
marketplace buyer handle. Where neither exists, the panel says so and shows
nothing.

Similarly, no label on screen is generated. Every one comes from a fixed map, and
a value with no wording falls through to silence rather than printing a raw
stored identifier at an agent.

---

## It does not reach the draft prompt either

The case list is **not** added to `contextBlocks()` and is not a verified fact for
drafting. `lib/ai/draft-assembly.ts` is unchanged by this feature.

That is a deliberate boundary and not an oversight. A draft that mentioned an
existing case would be asserting something about the customer's situation from a
snapshot that may be a day old, inside a reply a human is about to send —
and the accuracy gate has no way to check it against anything. The indicator's
job is to put the fact in front of the person writing the reply; what they do
with it is their judgement.

**If that changes**, it needs: the snapshot's age as a fact in the prompt, a rule
in `draft-validation.ts` for what a reply may claim about a case, and a decision
about whether an `unknown` lifecycle may be mentioned at all. None of that
exists today.
