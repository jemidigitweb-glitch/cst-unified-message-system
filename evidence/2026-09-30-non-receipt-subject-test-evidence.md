# Evidence — the DEL-13.1 subject test

**2026-09-30.** What was measured, and what was NOT.

---

## Measured

### The reported conversation, read from the app database

eBay **33222**, `single_order`, order status Completed. Four messages: a 2-core /
3-core cable question, our reply asking which, a month-later answer carrying the
missed-notification apology, and "I have ordered one now."

Every layer of the classifier was printed for each message before anything was
changed:

| Layer | Message 1 | Message 2 (the one that broke it) |
| --- | --- | --- |
| `classifyMessageCategory` (strict) | Pre sales queries | null |
| `classifyMessageCategoryWithFallback` | Pre sales queries | **Delivery queries** |
| `detectIntents` | `pre_sale_question` | `pre_sale_question`, **`delivery_request`** |
| `semanticsOf().requestedAction` | `technical_specification` | `technical_specification` |
| evidence upheld | `INT-PS19` "3 core" | **`DEL-13.1` "dont get notifications come"**, `INT-PS19` "3 core" |
| `readConversation` | — | **Delivery queries** |

`DEL-13.1`'s matched text is the measurement: `dont get notifications come`. The
window between the negator and the verb was 19 characters and its contents were
never tested.

`explainMessagePriority` on the same message returned `pre_sales_enquiry`, LOW —
so the chip and the ribbon disagreed, and that is what made the defect visible
rather than plausible.

After the fix, `readConversation` on the same four turns returns **Pre sales
queries**, and message 2's upheld evidence is `INT-PS19` alone.

### The corpus rejected the first fix, and named the row

A wider exclusion list — `notification`, `email`, `update`, `confirmation`,
`alert`, `text`, `sms` — made `cst-category-corpus.test.ts` fail with row **`5.2`**
newly stranded:

```
5.2  Delivery_Master_Rules final.xlsx · sheet 5 – Not Dispatched
     "No dispatch email received" · "No shipping confirmation at all"
     "No update at all since I ordered"
```

So a missing dispatch **email** is a delivery query in CST's own workbook. The
list was cut to the conversation's own vocabulary (notification / message / reply)
and given a parcel exception, after a corpus sweep found three more phrases that
had to survive:

- "No notification about where it was left" — sheet 2
- "No notification to collect" — sheet 11
- "Parcel was taken to a collection point but customer was not notified" — sheet 11

### Tests

- `tests/knowledge/category-regression.test.ts` — **288 passing**, including the new
  33222 block and its six controls.
- **1,292 category tests passing** across `tests/knowledge/` and
  `tests/guards/category-tag.test.ts` — `category-golden-set`,
  `category-regression`, `category-ownership`, `message-category`,
  `cst-category-corpus`, `cst-category-evidence`.
- Full suite **4,915 passing**, 35 skipped. Three failures, all pre-existing and
  confirmed pre-existing by running the same combination with the change stashed:
  `cst-rules-files` ×2 and `knowledge-allowlist` ×1 — the gitignored spreadsheet
  corpus, `documentation/ai-coding-context.md` §8.
- `npm run typecheck` and `npm run lint` clean.

### Live

33222 reads **Pre sales queries** in the running application
(`GET /api/conversations?marketplace=ebay`), priority LOW, `pre_sales_enquiry` —
chip and ribbon now agree.

## NOT measured, and stated plainly

- **How many other conversations change category.** The classifier is not
  persisted, so this was not swept store-wide. `DEL-13.1` is a catch-all and the
  change can only ever REMOVE matches, so the direction is known even where the
  count is not: some conversations that read Delivery will now read something
  else. Nothing was sampled beyond the golden set and the corpus reachability
  test.
- **Whether any of those is a genuine delivery query wrongly lost.** The controls
  cover every phrase sheet 13 quotes and the four parcel-notification phrases
  found by grep. A phrase in a workbook that uses the word "message" or "reply"
  about a parcel in wording none of those cover would be missed.
- **Two suites' worth of pre-existing flakiness was observed, not diagnosed.**
  `cst-rules-files > parses every workbook into rules` and
  `marketplace-isolation > sends an eBay conversation no Amazon-only rule` fail
  only when run inside a larger suite and pass in isolation — **with and without
  this change**, verified by stashing it. They are ordering- or timing-sensitive,
  as §8 warns, and were not investigated.
- **Conversation 38749 (`jessicamariarodriguez`) was inspected and NOT changed.**
  It reads Delivery queries, HIGH, `customer_urgency` / `problem_reported` /
  `action_required`. The thread opens as a pre-sales size question and becomes a
  delivery-delay dispute — a label created but not scanned by UPS, with a deadline.
  Delivery queries appears correct; no defect was identified and nothing was
  changed on its account. Put back to CST for a view.
