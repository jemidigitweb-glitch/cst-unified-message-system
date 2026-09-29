# Root cause capture — evidence

**2026-09-29.** What was measured, what was run, and what is still unverified.

## Measured against the live source

The eighteen labels were not designed. They are the distinct non-blank values of
`root_cause` across all five `customer_service` message tables, read-only, on
2026-09-29. Query and full result:
`sql/2026-09-29-root-cause-vocabulary-measurement.sql`.

Headline numbers, for anyone checking the list is plausible:

| Label | Rows | Tables |
| --- | ---: | ---: |
| `OUT OF STOCK` | 9,409 | 5 |
| `OTHER` | 7,028 | 5 |
| `LISTING_CONTENT` | 5,501 | 5 |
| `RETURN` | 4,624 | 5 |
| `CUSTOMER_MISUSE` | 2,747 | 5 |
| `Charge Back` | 2,488 | 5 |
| `Delivery Issue` | 2,133 | 5 |
| `INVOICE` | 1,981 | 5 |
| `PRODUCT_QUALITY` | 1,823 | 5 |
| `Wrong Address` | 1,659 | 5 |
| `FULFILMENT_WAREHOUSE` | 1,651 | 5 |
| `FULFILMENT_CARRIER` | 1,616 | 5 |
| `MARKETPLACE_ADMIN` | 1,558 | 5 |
| `PRE_SALES_QUERY` | 1,373 | 5 |
| `PARTS MISSING` | 708 | 4 |
| `DISCOUNT` | 354 | 5 |
| `EBAY_RECALL` | 39 | 3 |
| `TRANSFORMER_ISSUE` | 18 | 3 |

Three findings from that read, each of which changed the design:

1. **Case variants are real.** `Out of stock` (8 rows) sits beside `OUT OF
   STOCK` (9,409), and `Return` (1) beside `RETURN`. The writer validates
   case-insensitively and stores verbatim. They fold to one chip; comparison
   folds case, display never does.
2. **Free prose is real.** Five rows hold sentences — "customer is returning the
   item via Royal Mail…", "item not received case, ebay has to take the final
   decision". Those are the OTHER flow working as designed, and confirm the
   30-character rule is enforced upstream.
3. **`OTHER` is the second most common value.** 7,028 rows. That is why it is
   placed last on screen rather than second.

## Run and passing

```
npx vitest run tests/migrations/conversation-root-cause-schema.test.ts   35 passed
npx vitest run tests/domain/root-cause-vocabulary.test.ts                21 passed
npx vitest run tests/domain/root-cause-selection.test.ts                 31 passed
npx vitest run tests/repositories/conversation-root-cause-repository.test.ts  20 passed
npx vitest run tests/guards/                                            714 passed (24 files)
npx tsc --noEmit                                                          clean
npx eslint <the five new/changed files>                                   clean
npx vitest run                                                    4,784 passed
```

**Three pre-existing failures, unrelated to this work.**
`tests/knowledge/cst-rules-files.test.ts` fails on a missing "Message Handling"
area in the spreadsheet corpus and a cache-timing assertion. Nothing in this
feature touches `lib/knowledge/`; the failures reproduce independently of these
changes.

## Caught by writing the tests

- **A prefix collision in the migration test's own helper.** `constraintClause`
  used `indexOf`, and `ck_conversation_root_causes_issue_type` is a prefix of
  `ck_conversation_root_causes_issue_type_needs_courier`. The vocabulary test
  was reading the wrong clause and passing. Now matched whole, and bounded at
  the end of the constraint rather than after a fixed number of characters —
  the fixed window had also run past the courier list into the issue-type list,
  and past that into a `COMMENT`.
- **A dead branch.** A check refusing an explanation that is just the word
  "OTHER" could never fire: the word is five characters and the text is trimmed
  before measuring, so the 30-character minimum always refuses it first. The
  branch was removed and the test rewritten to pin the outcome rather than the
  mechanism. An unreachable guard reads as a rule being enforced while proving
  nothing.
- **A redundant reset effect.** The selector cleared seven pieces of state on
  conversation change. React's own lint rejected it, and it was unnecessary: the
  panel keys the component by conversation id, so switching threads remounts it.
  The effect went; a guard now pins the key, because if the key goes the reset
  goes silently with it.
- **The missing `RESTRICT`.** `0020…down.sql` dropped its table without it,
  unlike 0011–0019. Added.

## NOT verified, and this is the gap

**Migration `0020` has not been applied.** Everything above is static: the tests
read the SQL as text and never connect, and the repository tests run against a
recording fake. So these remain unproven against a real database:

- that the migration applies at all;
- that the CHECKs really reject a courier outside the ten;
- that the foreign key really rejects an unknown conversation;
- that the rollback really removes only this table;
- that the panel really records and re-reads a selection end to end.

That list is the acceptance test for applying it — see
`validation/2026-09-29-root-cause-capture-validation.md`, which holds the
statements to run inside a transaction that is then rolled back.

**No live end-to-end run happened**, for the same reason. The read-only half of
the panel was verified live on all five marketplaces in the previous pass
(Shopify → `CUSTOMER_MISUSE`, eBay → `Wrong Address`, Amazon → `Wrong Address`,
B&Q → `OTHER`, Temu → `OUT OF STOCK`) and is unchanged by this work.
