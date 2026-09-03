# Category classification audit — issue vs. requested action

**Date:** 2026-09-03
**Scope:** eBay conversations. Read-only analysis. No production data was modified; every
statement issued against the source database was a `SELECT` on a pool that pins
`default_transaction_read_only=on`.
**Status:** Fixes A and B implemented (see §8), with FP-4 and FP-5 alongside them because
the requested behaviour depended on them. Fixes C and F remain open.

---

## 0. Files inspected

| File | Why |
| --- | --- |
| `lib/knowledge/message-category.ts` (5,300 lines) | Every layer: phrase table, intent layer, evidence map, corpus, `semanticsOf`, and both conversation readers |
| `lib/knowledge/message-semantics.ts` | Clause segmentation, `claimStatus`, `speechActOf` — the gate every problem claim passes through |
| `lib/knowledge/cst-category-evidence.ts`, `cst-category-corpus.ts`, `cst-corpus-match.ts` | The reviewed evidence map and the 730-row workbook corpus, and their category gates |
| `lib/marketplaces/ebay/adapter.ts`, `message-repository.ts`, `thread-builder.ts` | How an eBay thread is assembled, and the header↔body join |
| `tests/knowledge/message-category.test.ts`, `category-regression.test.ts`, `category-ownership.test.ts`, `cst-category-*.test.ts` | What is pinned today, so a proposed fix can be checked against it |
| `tests/source-validation/category-live-sample.test.ts` | The existing read-only live sampler this audit's harness was modelled on |
| `lib/ai/draft-validation.ts` | Only to confirm the classifier↔draft join (`intentOwningCategory`); not changed, not proposed for change |

**Sample.** 6,000 eBay message rows over 180 days → **1,335 threads** with at least one
inbound message, grouped by `(item_id, counterparty)`. Each thread was run through
`readConversation`, and each inbound message through `semanticsOf`, `detectIntents`,
`readCorpus`, `classifyMessageCategory` and `classifyMessageCategoryWithFallback`.

---

## 1. The current decision flow

```
                       ┌─────────────────────────────────────────┐
   one inbound message │  FOUR INDEPENDENT WITNESSES             │
   ────────────────────┤                                         │
                       │  1. classifyMessageCategory   SIGNALS   │  phrase table
                       │  2. detectIntents             refine()  │  intent layer + CST evidence map
                       │  3. readCorpus                730 rows  │  workbook corpus, category-gated
                       │  4. semanticsOf               claims    │  clause-level reading
                       └─────────────────────────────────────────┘
                                        │
                                        ▼
       ┌──────────────────────────────────────────────────────────────────┐
       │  readConversation(turns)          message-category.ts:4918       │
       │  outbound turns discarded; address-only turns silenced           │
       └──────────────────────────────────────────────────────────────────┘
                    │                                   │
        ISSUE axis  │                                   │  ACTION axis
        (what       ▼                                   ▼   (what they want)
        happened)  semanticsOf(m).event                semanticsOf(m).requestedAction
                   ── ONLY witness 4 ──                ── ONLY witness 4 ──
                   earliest owning issue wins          LATEST stated action wins
                   filtered by somethingWasSupplied (:4973)
                    │                                   │
                    └──────────────┬────────────────────┘
                                   ▼
   :5022   if issue==none && action==refund_or_return → maybe re-read as whereabouts/order_amendment
   :5071   if action==whereabouts && a return is under way → action := none
                                   ▼
   :5080   ┌── issue != none ──────────────────► ISSUE_CATEGORY[issue]          ✅ issue wins
           │
   :5111   ├── action is an ENQUIRY and the positional reading names a case
           │                          ────────► that case category              ✅ escape hatch
           │
   :5122   ├── ACTION_CATEGORY[action] defined ► that category                  ⚠️  ACTION WINS HERE
           │
   :5126   └── otherwise ─────────────────────► positionalConversationCategory  (witnesses 1–3)
                                                 :5190 — per message:
                                                   ownedIntentCategory → classifyMessageCategory
                                                   → readCorpus → categoryFromSemantics → Admin
```

### Where each thing happens

| Question | Answer | Location |
| --- | --- | --- |
| Where is the **issue** detected? | `semanticsOf().event`, from `claims` produced by `claimStatus` | `message-category.ts:3994`, gated by `message-semantics.ts:245` |
| Where is the **requested action** detected? | `semanticsOf().requestedAction` | `message-category.ts:3926` (the ternary chain) |
| Where is the **final category** selected? | `readConversation` | `message-category.ts:5080`, `:5111`, `:5122`, `:5126` |
| Where do **conflicts** happen? | `:5122` — `ACTION_CATEGORY` is consulted **before** the positional reading, so an action beats a problem that only witnesses 1–3 saw | see §3 |

### Are the two axes the single source of truth? No.

The issue axis reads **one** witness (`semanticsOf`). The other three witnesses can name a
problem category, and the only path that consults them is
`positionalConversationCategory` — which sits **below** `ACTION_CATEGORY`. The moment a
customer states a remedy, the three witnesses that saw the problem are never asked.

Measured over the sample:

* **1,054 of 1,335 threads (79%) resolve with `issue: "none"`.**
* **51 of 362 messages (14%) carry a problem intent from the intent layer while
  `semanticsOf().event` is `"none"`.**
* **21 of 61 threads (34%) containing a `wrong_item_supplied` event have that issue
  discarded before the axes are read**, by the receipt gate at `:4973`.

---

## 2. The brief's four examples, as the code behaves today

| # | Message | Expected | Current | Verdict |
| --- | --- | --- | --- | --- |
| 1 | "One of the items came with two dents. How do you want to proceed?" | Damage queries | **Damage queries** | ✅ already correct — `physical_damage` is `asserted`, so the issue axis fires |
| 2 | "My parcel is late. Please refund me." | Delivery queries | **Return and refunds** | ❌ `event=none`, `intents=[wants_refund]` — "late" is a delivery issue to no witness |
| 2b | "My parcel is late" (alone) | Delivery queries | Delivery queries | ✅ only via the positional fallback; add a remedy and it is lost |
| 3 | "Only 1 pendant was delivered." | Wrong quantity sent issues | **Wrong quantity sent issues** | ✅ fixed earlier today (see §7) |
| 4a | "I want to return this item" | Return and refunds | Return and refunds | ✅ |
| 4b | "Please refund me" | Return and refunds | Return and refunds | ✅ |
| 4c | "When will my refund arrive?" | Return and refunds | **Delivery queries** | ❌ "when will … arrive" fires `delivery_request` on the money |
| 4d | "I sent it back already" | Return and refunds | **Admin related issues** | ❌ `RETURN_UNDER_WAY` has `send it back` but not the past tense |

---

## 3. Identified failure points

### FP-1 — `INTERROGATIVE_FRAME` reads plain declaratives as questions (highest value)

`message-semantics.ts:172` treats an auxiliary followed by a determiner or pronoun as a
question frame:

```
\b(?:does|do|did|is|are|was|were|has|have|can|could|would|will|shall|should)\s+(?:it|this|that|these|they|the|you|i|there|my)\b
```

`are the`, `is the`, `was the`, `were the` occur in ordinary **statements**. The file
already recognises this problem for wh-words — *"A WH-WORD IS ONLY A QUESTION WHERE IT
OPENS ONE"* — and applies a start-of-clause anchor there. The auxiliary alternative never
got the same treatment.

Measured:

| Message | `claimStatus` | `speechActOf` | `semanticsOf().event` |
| --- | --- | --- | --- |
| "They are the wrong colour" | `asked` | `question` | `none` |
| "This is the wrong item" | `asked` | `question` | `none` |
| "The ceiling roses are the wrong ones" | `asked` | `question` | `none` |
| "It was the wrong type sent again" | `asked` | `question` | `none` |
| "The shades are the wrong size" | `asked` | `question` | `none` |

Every one of these is a customer reporting a wrong item, and the issue axis sees nothing.
This is the root cause behind most of the Wrong-item→Return mismatches in §4.

### FP-2 — the action is consulted before the other witnesses (the structural defect)

`message-category.ts:5122`. When `issue === "none"`, `ACTION_CATEGORY[action]` returns
before `positionalConversationCategory` is ever called — so the phrase table, the intent
layer and the corpus are all silenced by a stated remedy.

The code already knows this is wrong: `:5111` is a hand-built escape hatch that lets the
positional reading beat the action, but **only** for `technical_specification` and
`availability`. The same reasoning applies to every action, and the brief states it
directly: *"Refund/return should only affect requested action, not replace the issue."*

Measured: **79 threads** where the action decided the category while another witness named
a problem; of those, ~40 land on a category that is not the problem.

### FP-3 — the receipt gate is English-only

`:4973`. `wrong_item_supplied` is dropped from the issue axis unless some message passes
`SOMETHING_DIFFERENT_WAS_SUPPLIED` or `hasTakenDelivery` — both built on English arrival
verbs (`GOODS_HAVE_ARRIVED`). A German customer writing *"bei meiner Bestellung kamen diese
beiden Leuchtmittel mit der falschen Fassung an"* has `event = wrong_item_supplied`
correctly detected and then **discarded**:

```
alone:            {category: "Wrong item sent messages", issue: "none",  action: "none"}
+ "please send a return label": {category: "Return and refunds", issue: "none", action: "refund_or_return"}
English equivalent:            {category: "Wrong item sent messages", issue: "wrong_item_supplied", ...}
```

The gate exists to stop a pre-dispatch mis-order reading as a seller error — a good rule —
but it is enforced with a vocabulary that only exists in one language.

### FP-4 — "late" / "delayed" / "overdue" is a delivery issue to no witness

`HAS_NOT_ARRIVED` requires a *negated* arrival verb; `CHASING_A_CONSIGNMENT` requires
"where is" plus a consignment noun. A parcel that is simply **late** reaches neither, so
`event = none` and `detectIntents` returns `[]`. "My parcel is late" survives only through
the positional fallback; the moment a remedy is attached it becomes Return and refunds. The
refund-deferral block at `:5022` cannot save it either, because that block tests for the
`delivery_request` intent, which was never raised.

### FP-5 — return-lifecycle wording is not owned by Return and refunds

* `RETURN_UNDER_WAY` (`:1264`) has `send (it|them|this|these) back` but no past tense. "I
  sent it back already", "I posted it back last week", "All goods will be sent back" all
  miss — the last one produced the sample's only `null` category.
* `REFUND_NOT_RECEIVED` (`:3149`) is negation-shaped. A refund chased as a **question** —
  "When will my refund arrive?", "How long does a refund take?" — instead raises
  `delivery_request` and lands on Delivery queries.

### FP-6 — `MEASURED_AGAINST_THE_ORDER` fires on a purchase verb anywhere in the message

`:2209`. The anchor that separates a quantity error from a parts case matches `purchased`
wherever it appears. In conversation **#84962** — *"we have just opened the light fixture we
have purchased and there is only 2 light bulbs in the box where there should be 3"* — the
word `purchased` describes the fixture, not the count. The message says plainly that the
shortfall is inside the box (`should be 3` … `in the box`), which the module's own rule
calls a parts case, and it was filed as a quantity error.

---

## 4. Conversation sample (52 threads)

**How to read this.** IDs are the internal `ebay_message_headers.id` of the thread's first
message — meaningless outside the source database. Two slices, and the difference matters:

* **Slice A (rows 1–29)** — deliberately selected because the action axis decided the
  category while another witness disagreed. **Not representative**; this is where the
  defects live.
* **Slice B (rows 30–52)** — a deterministic stratified sample, 2 per current category, of
  everything else. This one *is* representative.

Customer text is quoted only in fragments, with no names, addresses, emails, order numbers
or tracking references.

### Slice A — action-decided threads (biased selection)

| # | Conv. ID | Current | Expected | Issue | Action | Reason for mismatch |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 79330 | Return and refunds | Return and refunds | none | refund_or_return | ✅ genuine refund chase |
| 2 | 79516 | Return and refunds | Return and refunds | none | refund_or_return | ✅ refund not received after return delivered |
| 3 | 79595 | Return and refunds | **Wrong item sent messages** | none | refund_or_return | FP-1 — "are the wrong ones/colour" read as a question; FP-2 |
| 4 | 79619 | Return and refunds | Return and refunds | none | refund_or_return | ⚠️ borderline — spec dispute closed with "Rückerstattung" |
| 5 | 79656 | Return and refunds | Return and refunds | none | refund_or_return | ✅ return logistics + refund chase |
| 6 | 80194 | Return and refunds | Return and refunds | none | refund_or_return | ⚠️ borderline — pre-purchase assurance was wrong; arguably Wrong description |
| 7 | 80234 | Return and refunds | **Delivery queries** | none | refund_or_return | FP-2 — courier cannot deliver; refund is the remedy |
| 8 | 80365 | Return and refunds | **Wrong item sent messages** | none | refund_or_return | FP-1 — "it was the wrong type sent again"; FP-2 |
| 9 | 80399 | Return and refunds | Return and refunds | none | refund_or_return | ✅ German return awaiting collection + refund chase |
| 10 | 81439 | Return and refunds | **Wrong item sent messages** | none | refund_or_return | German "nicht die gleichen / Farbunterschied" reaches no witness; FP-2 |
| 11 | 82137 | Return and refunds | **Pre sales queries** | none | refund_or_return | "Can I return if doesn't fit?" is a pre-purchase question; FP-2 |
| 12 | 83189 | Return and refunds | Return and refunds | none | refund_or_return | ✅ |
| 13 | 84304 | Return and refunds | **Wrong item sent messages** | none | refund_or_return | FP-1 + FP-2 — "return the lights as they are the wrong ones" |
| 14 | 84936 | Return and refunds | **Wrong item sent messages** | none | refund_or_return | **FP-3** — `event=wrong_item_supplied` detected then discarded by the English-only receipt gate |
| 15 | 85883 | Return and refunds | **Defective items** | none | refund_or_return | FP-2 — product condemned as unsafe |
| 16 | 85915 | Return and refunds | **Wrong item sent messages** | none | refund_or_return | FP-1 + FP-2 — bronze supplied where brass was confirmed |
| 17 | 87113 | Return and refunds | Return and refunds | none | refund_or_return | ✅ |
| 18 | 87218 | Return and refunds | Return and refunds | none | refund_or_return | ✅ German withdrawal + refund |
| 19 | 87511 | Return and refunds | **Defective items** | none | refund_or_return | FP-1 — "as it is defective" split into a clause ending in "?" → `asked` |
| 20 | 87579 | Return and refunds | Admin related issues | none | refund_or_return | ⚠️ borderline — invoice correction after a defective return |
| 21 | 87976 | Return and refunds | **Wrong item sent messages** | none | refund_or_return | FP-2 — "Ordered white one and gold one sent" |
| 22 | 88114 | Return and refunds | **Defective items** | none | refund_or_return | FP-2 — German "Led Treiber defekt", intent layer saw it, action won |
| 23 | 88298 | Return and refunds | Admin related issues | none | refund_or_return | ⚠️ borderline — customer asking what the eBay safety notice meant |
| 24 | 80284 | Order change | Order change | none | order_amendment | ✅ customer's own mis-order |
| 25 | 80697 | Order change | Order change | none | order_amendment | ✅ |
| 26 | 82550 | Order change | Order change | none | order_amendment | ✅ |
| 27 | 83078 | Order change | Order change | none | order_amendment | ✅ German own mis-order |
| 28 | 84715 | Order change | Order change | none | order_amendment | ✅ |
| 29 | 88083 | Order change | **Wrong item sent messages** | none | order_amendment | FP-1 + latest-action-wins — wrong-colour report superseded by a scheduling message |

### Slice B — stratified control sample (representative)

| # | Conv. ID | Current | Expected | Issue | Action | Reason for mismatch |
| --- | --- | --- | --- | --- | --- | --- |
| 30 | 79076 | Admin related issues | Admin related issues | none | none | ✅ acknowledgement of arrival |
| 31 | 83639 | Admin related issues | **Pre sales queries** | none | none | "what type of bulb they take" — no attribute stem matched, fell to the catch-all |
| 32 | 79087 | Pre sales queries | Pre sales queries | none | technical_specification | ✅ |
| 33 | 84046 | Pre sales queries | Pre sales queries | none | technical_specification | ✅ |
| 34 | 79085 | Return and refunds | Return and refunds | none | refund_or_return | ✅ |
| 35 | 84964 | Return and refunds | Return and refunds | none | refund_or_return | ✅ |
| 36 | 79119 | Delivery queries | Delivery queries | none | none | ✅ chasing a replacement dispatch |
| 37 | 83488 | Delivery queries | Delivery queries | parcel_not_received | whereabouts | ✅ delivered-not-received, later located |
| 38 | 79081 | Parts missing queries | Parts missing queries | component_missing | none | ✅ |
| 39 | 84399 | Parts missing queries | Parts missing queries | component_missing | none | ✅ |
| 40 | 79080 | Wrong item sent messages | Wrong item sent messages | wrong_item_supplied | refund_or_return | ✅ **issue correctly beats the refund** |
| 41 | 84199 | Wrong item sent messages | Wrong item sent messages | wrong_item_supplied | technical_specification | ✅ German, receipt gate happened to pass |
| 42 | 79124 | Damage queries | Damage queries | none | none | ✅ via the positional reading |
| 43 | 84282 | Damage queries | Damage queries | physical_damage | technical_specification | ✅ escape hatch at `:5111` worked |
| 44 | 79251 | Defective items | Defective items | functional_failure | whereabouts | ✅ |
| 45 | 84413 | Defective items | Defective items | none | technical_specification | ✅ German, via escape hatch + positional |
| 46 | 79094 | Order change | Order change | none | order_amendment | ✅ |
| 47 | 83874 | Order change | Order change | none | order_amendment | ✅ delivery address change |
| 48 | 79631 | Wrong description issues | Wrong description issues | listing_mismatch | none | ✅ |
| 49 | 85716 | Wrong description issues | Wrong description issues | listing_mismatch | none | ✅ |
| 50 | 79797 | Wrong quantity sent issues | Delivery queries | quantity_mismatch | whereabouts | ⚠️ borderline — the quantity note refers to a *different* order |
| 51 | 84962 | Wrong quantity sent issues | **Parts missing queries** | quantity_mismatch | technical_specification | **FP-6** — `purchased` anchored a box-contents shortfall to the order |
| 52 | 87748 | *(null)* | **Return and refunds** | none | none | FP-5 — "All goods will be sent back" matches no return pattern |

### Tally

| Slice | Threads | Correct | Wrong | Borderline |
| --- | --- | --- | --- | --- |
| A (biased) | 29 | 13 | 12 | 4 |
| B (representative) | 23 | 19 | 3 | 1 |
| **Total** | **52** | **32 (62%)** | **15 (29%)** | **5 (9%)** |

Slice B is the honest accuracy signal: **~83% correct on a representative sample**, with
the errors concentrated in exactly the after-sales categories this brief is about. The
whole-corpus estimate for the structural class (FP-2) is **33 threads of 1,335 (2.5%)**
whose category would move — see §5.

---

## 5. Recommended fix — smallest safe change

Two structural changes and four vocabulary ones. **A and B are the audit's recommendation;
C–F are follow-ups that should be measured separately.**

### Fix A — anchor the interrogative frame to the start of a clause (FP-1)

`message-semantics.ts:172`. Require the auxiliary-inversion alternative to open its clause,
exactly as the wh-word alternative already does. An explicit `?` still counts on its own, so
real questions are unaffected; `clausesOf` already splits on `,\s*(?=(can|could|would|…))`,
which is where a mid-sentence question actually begins.

**Effect:** "They are the wrong colour" becomes `asserted` → `event = wrong_item_supplied`
→ the issue axis fires → the category is the problem, whatever remedy follows.
**Risk:** a question written without a question mark and without inversion could be demoted
to an assertion. Must be measured against the full suite before landing.

### Fix B — a problem outranks a remedy, always (FP-2)

`message-category.ts:5122`. Today:

```ts
const fromAction = ACTION_CATEGORY[action];
if (fromAction !== undefined) return { category: fromAction, issue, requestedAction: action };
return { category: positional, issue, requestedAction: action };
```

Proposed — generalise the escape hatch that already exists at `:5111` from two actions to
all of them:

```ts
// A PROBLEM ANY WITNESS NAMED OUTRANKS THE REMEDY ASKED FOR. The issue axis reads
// `semanticsOf().event` alone; the phrase table, the intent layer and the corpus reach
// the thread only through the positional reading, and until now a stated remedy
// returned before they were ever asked.
if (positional !== null && REPORTED_PROBLEM.includes(positional)) {
  return { category: positional, issue, requestedAction: action };
}
const fromAction = ACTION_CATEGORY[action];
…
```

**`PROBLEM_CATEGORIES` may not be reused here as-is.** It contains
`"Order change, before shipping queries"` (`:723`), which is not a problem with the goods
but a request about the order — reusing it would let a positional order-change reading beat
a genuine refund request. Fix B needs a narrower list, `REPORTED_PROBLEM`: the seven
`ISSUE_CATEGORY` values, i.e. `PROBLEM_CATEGORIES` minus Order change. That list is already
written in the file, as the range of `ISSUE_CATEGORY` (`:4807`) — deriving
`REPORTED_PROBLEM` from `Object.values(ISSUE_CATEGORY)` keeps the two in step by
construction and adds no new list to maintain.

Return and refunds is not in it either, so a genuine return request with no problem behind
it is untouched. The resolution window at `:4937` already prevents a closed problem from
claiming the thread.

**Measured blast radius (estimate):** 33 of 1,335 threads (2.5%) change category —
Return→Delivery 11, Return→Wrong item 8, Return→Defective 4, Order change→Delivery 3,
Admin→Wrong item 2, Return→Wrong quantity 2, Admin→Delivery 2, Order change→Wrong item 1.
39 further threads already agree and do not move.

⚠️ **The 11 Return→Delivery moves need review before this lands.** A *return* parcel runs
its own journey and the customer narrates it in chase vocabulary; `readConversation`
already guards the action axis against this at `:5071`, and the corpus guards its own
Delivery reading, but the positional path's guard has not been verified for this case.

### Fix C — teach the receipt gate German (FP-3)

`:4973`. Add German arrival verbs (`angekommen`, `erhalten`, `geliefert`, `bekommen`,
`kamen … an`) to the witness used by `somethingWasSupplied`. It can only ever re-enable an
issue `semanticsOf` already asserted, so the gate keeps doing its job for pre-dispatch
mis-orders.

### Fix D — a late parcel is a delivery issue (FP-4)

Add `late` / `delayed` / `overdue` / `still waiting for` (predicated on the consignment,
not on the money) to the delivery chase evidence, so "My parcel is late. Please refund me."
raises `delivery_request` and the existing refund deferral at `:5022` moves the action to
`whereabouts`. Must be predicated on a consignment noun — a *refund* being late is Return's.

### Fix E — the return lifecycle (FP-5)

* `RETURN_UNDER_WAY`: add the past tense — `sent it/them back`, `posted it back`,
  `(goods|items|parcel) … sent back`.
* `REFUND_NOT_RECEIVED`: add the interrogative shape — `when will … refund`,
  `where is my refund`, `how long … refund` — so a refund chased as a question is Return's
  and not Delivery's.

### Fix F — anchor the quantity/parts split to the count, not the message (FP-6)

`MEASURED_AGAINST_THE_ORDER` must not fire on a purchase verb that governs a different noun
than the count. Narrowest form: require the anchor within the clause the count sits in
(the module already has `clauseBefore`/`clauseAfter` for exactly this).

### Suggested order

1. **Fix A** alone, full suite + re-run this harness, diff the 1,335 categories.
2. **Fix B** alone, same measurement, plus manual review of the 11 Return→Delivery moves.
3. C, D, E, F individually — each is small and independently measurable.

Do **not** ship A and B together: A shrinks B's blast radius (it moves threads onto the
issue axis, where they never reach `:5122`), and shipping both at once makes the two
impossible to attribute.

---

## 6. Regression tests required

All in `tests/knowledge/category-regression.test.ts` unless noted.

**For Fix A** (`tests/knowledge/message-semantics.test.ts` for the first two):

1. `claimStatus("They are the wrong colour", A_MISMATCH)` → `asserted`
2. `speechActOf("The shades are the wrong size")` → `assertion`
3. `speechActOf("Are they the wrong colour?")` → `question` *(inversion still reads)*
4. `speechActOf("Is this suitable for a bathroom")` → `question` *(no question mark)*
5. `classifyConversationCategory(["The ceiling roses are the wrong ones as I ordered copper. Can I return them?"])` → `Wrong item sent messages`

**For Fix B:**

6. `["It arrived damaged", "Please refund me"]` → `Damage queries`
7. `["The transformer is faulty", "I would prefer a refund thank you"]` → `Defective items`
8. `["The courier could not deliver it", "please get it returned to you for a refund"]` → `Delivery queries`
9. **Negative control:** `["I want to return this item, nothing wrong with it at all", "Please send a label"]` → `Return and refunds`
10. **Negative control:** `["A part is missing", "Found it, all sorted", "Please refund me anyway"]` → `Return and refunds` *(the resolution window must still hold)*
11. **Negative control:** `["I ordered the wrong size by mistake, can I return it"]` → `Return and refunds`

**For Fix C:**

12. German wrong-item thread + return-label follow-up → `Wrong item sent messages`
13. **Negative control:** German pre-dispatch mis-order (`"leider habe ich einen falschen Artikel bestellt"`) → `Order change, before shipping queries`

**For Fix D:**

14. `["My parcel is late. Please refund me."]` → `Delivery queries`
15. **Negative control:** `["I posted the return last week and my refund is late"]` → `Return and refunds`

**For Fix E:**

16. `["I sent it back already"]` → `Return and refunds`
17. `["When will my refund arrive?"]` → `Return and refunds`
18. `["All goods will be sent back"]` → `Return and refunds`

**For Fix F:**

19. `["We have just opened the light fixture we have purchased and there is only 2 light bulbs in the box where there should be 3"]` → `Parts missing queries`
20. **Negative control:** `["I ordered 6 bulbs but only received 3."]` → `Wrong quantity sent issues`

Plus, for every fix: re-run this audit harness and record the whole-corpus category diff, so
the blast radius is a measured number and not an estimate.

---

## 8. What was implemented (2026-09-03, after this audit was reviewed)

**Fix B, with the bound the measurement forced.** A reported problem now outranks the
remedy at `readConversation`, using `REPORTED_PROBLEM` — derived from
`Object.values(ISSUE_CATEGORY)`, **not** `PROBLEM_CATEGORIES` — but only where the message
that named the problem is not the message that stated the action. That bound is not a
refinement: without it the promotion also promotes the positional layer's *false*
positives, and it broke two pinned conversations immediately (`INT-DF05` reading "won't
work" as a fault, and the measurement rows reading "too big" as a wrong item — both goods
that are fine and unsuitable for the buyer). A single message naming a problem and a remedy
in one breath is already arbitrated by `refine`, `ownedIntentCategory` and the strict
table's Return gate, and those judgements are measured; a problem in one message and a
remedy in a later one is what nothing arbitrated.

A second bound followed from the same measurement: `Delivery queries` is not promoted while
a **return** is under way and nothing says our own parcel is missing. Two threads went the
wrong way without it, exactly as §5 warned.

**FP-4 and FP-5 came with it**, because the requested behaviour depended on them:
`CONSIGNMENT_IS_LATE` (bounded to a consignment noun, and unable to cross the money);
`REFUND_NOT_RECEIVED` extended to the interrogative chase; `delivery_request` dropped in
`refine` when it is the money being chased and no parcel is also missing; and
`RETURN_UNDER_WAY` given the past tense it never had.

**Two live conversations reported during the work**, both vocabulary gaps:
`dings` was absent from the damage vocabulary while `dents` was present, and the
substitution shape ("should have had X but was sent Y", "black instead of chrome") reached
nothing. Both fixed, and both bounded hard after measurement — a bare `should have` is how
every category states what was due, and a bare `instead of` moved four threads that had
nothing wrong with the item, so it is anchored to a finish named immediately before it.

**Measured over the same 1,334 threads: 11 moved (0.82%)** — 9 clear improvements, 2
borderline, 0 regressions.

**Fix A landed next**, on its own so it could be attributed: `INTERROGATIVE_FRAME`'s
auxiliary alternative is now anchored to the start of its clause, the same rule the wh-words
already had. No existing test needed changing. **10 further threads moved** — 8 clear
improvements (including three of the audit's own rows), 1 borderline, and **1 regression**:
thread `#81694`, a parcel Evri lost, moved Delivery → Wrong description. Diagnosed: the
message says *"i have photo evidence to show where they left it should you need it"*, and
`LISTING_MISMATCH` fires on a photograph of a DELIVERY LOCATION. That false positive already
existed; the interrogative bug was masking it, because `should you need it` — a conditional,
not a question — used to make the whole clause read as `asked`. **Open follow-up:** bound
`LISTING_MISMATCH` to a photograph of the PRODUCT.

**A pre-sales gap was reported separately and fixed with it.** `looksPreSales` required a
physical attribute — colour, material, wattage, size — so the two things a buyer says first
reached nothing: that they are trying to buy ("Hi I am trying to buy the hook"), and what it
costs ("What is the price?"). Both added, both behind the existing "is asking something"
requirement, which is NOT relaxed: dropping it immediately claimed a pinned return-postage
negotiation that mentions a future purchase and asks nothing. 3 further threads moved, all
Admin → Pre sales, all correct.

## 7. Note on uncommitted work in the tree

Two files were changed earlier today, before this audit was requested, and are still
uncommitted:

* `lib/knowledge/message-category.ts` — a `DELIVERY_WAS_SHORT` pattern (a delivery short
  against the order is a quantity error) and a delivery-location shape (`misplaced at …`,
  `left it at the petrol station`).
* `tests/knowledge/category-regression.test.ts` — 20 regression tests covering both.

They are the reason example 3 in §2 now passes. Full suite: **2,505 passed, 30 skipped**.
`npm run typecheck` and `eslint` have **not** been run against them yet.
