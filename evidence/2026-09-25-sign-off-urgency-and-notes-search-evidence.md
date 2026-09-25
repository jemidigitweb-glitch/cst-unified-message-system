# Sign-off urgency and the customer-notes search — evidence

**2026-09-25.** Two changes, checked together. **Customer names and order
references seen during the live run are masked here**, the same rule the test
suite keeps — only counts and shapes are reproduced.

## 1. A thank-you no longer raises URGENT

Found on screen: eBay `david_tuck_ward` kept the red URGENT badge under a
running SLA after CST had answered and the customer replied with nothing but
thanks. The closure path already existed
(`customerAcknowledgedOnly` → `thread_resolved`); the wording test behind it
did not recognise the message.

Three things in that sentence are in no vocabulary and never can be — the
agent's name, the customer's own name, and "that is much appreciated". So
`isPleasantryOnly` now removes the two positional name slots and tests what is
left against `SIGN_OFF_ONLY`.

The direction that matters is the other one, and it is pinned:

```
$ npx vitest run tests/guards/before-shipment-urgency.test.ts
 Test Files  1 passed (1)
      Tests  173 passed (173)
```

Ten of those are cancellations wrapped in thanks — "Many thanks, please cancel
my order", "Thanks, Cancel my order", "Thanks.\nCancel." — every one asserted
NOT to read as closure. A wrong sign-off costs a badge; a wrong cancellation
drops the most time-critical message in the inbox while its window closes.

**The category classifier did not move.** `PLEASANTRY_ONLY` still matches
exactly what it matched, and is still the only pattern the thread reading
consults. The frozen baseline is untouched.

## 2. The customer-notes panel can be searched

Requested by CST: find a note by order id or name. The panel holds one bounded
page of notes (116 loaded at the time of this run); the box narrows what is
loaded and issues no request.

Driven headless against the running app — `node .claude/skills/browser-automation/browser.mjs`:

```
rowsBefore        34            (the eBay tab)
tabsBefore        eBay 34 · Amazon 4 · Shopify 61 · B&Q 1 · Temu 0 · Other 16   = 116
firstRow          <reference> · <name>            (masked)

search "<surname>"          → 1 row, tabs read  eBay 1 · Amazon 0 · Shopify 0 · B&Q 0 · Temu 0
search "<bare reference>"   → 1 row   — punctuation stripped from both sides, so the
                                        digits alone find a hyphenated eBay reference
search "zzzz-no-such-order" → "No customer notes match that order or name."
same search, Amazon tab     → "No matches on this marketplace. 1 on another marketplace."
clear the box               → 34 rows, exactly as before

console errors/warnings  0
requests failed          0
```

The last two lines are the design: the search runs across every marketplace and
the tab counts are its result, so an agent holding an order number finds it
without already knowing which marketplace it was bought on.

## Full run

```
$ npx vitest run
 Test Files  156 passed | 13 skipped (169)
      Tests  4599 passed | 35 skipped (4634)

$ npx tsc --noEmit
(no output)

$ npx eslint .
(no output)
```
