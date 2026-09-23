# Response time and SLA — discovery, and the prepared policy import

**2026-09-23.** Covers both halves of this workstream: the read-only
investigation into why the Average Response Time and SLA Performance tiles are
blocked, and the migration + importer prepared in response.

**Current status:** migration `0019` is **written, NOT executed**. No row has
been imported. The dashboard is unchanged, `RESPONSE_SLA_MINUTES` is unchanged,
and no compliance percentage is computed anywhere.

No customer message text, buyer name, address or email appears in this document.

---

## 1. Summary

Two of the seven Customer Service Insights KPIs have been blocked since the
dashboard shipped. The investigation found:

- **Average response time was never actually blocked by the timestamp problem.**
  A response time is a subtraction between two timestamps on the same clock, and
  an unknown offset cancels. It is computable today for eBay and Amazon with no
  cast, no migration and no import.
- **SLA performance is blocked by a business decision, not by data.** The
  approved policy exists and maps cleanly. What is missing is an answer to
  *which* policy governs — two approved targets disagree by up to 30 percentage
  points on identical replies.
- **Both KPIs are declared per-agent and neither can ever be**, because the
  activity log stores a `date` with no time of day.
- **B&Q and Temu can never have either metric.** Both are inbound-only at
  source; CST holds zero outbound messages for them.

In response, 42 policy rows now have a table and an importer prepared, behind
review.

---

## 2. Timestamps: meaning, timezone, daylight saving

### What the columns are

`cst_app.conversation_messages.source_ts` is a naive `timestamp`, written
verbatim by each adapter:

| Marketplace | Source relation | Column |
| --- | --- | --- |
| eBay | `customer_service.ebay_message_headers` | `receive_date` |
| Amazon / Shopify / B&Q / Temu | `customer_service.<mk>_messages` | `date` |

All are `timestamp without time zone`, selected as `::text` so the driver cannot
coerce them through the process timezone. **Inbound and outbound for a given
marketplace come from the same column of the same table** — the fact the whole
design rests on.

```
messages 32,096 | inbound 23,836 | outbound 8,260
source_ts_utc  populated on 0
source_ts_zone populated on 0
source_ts  range 2026-06-20 01:46:27 .. 2026-09-23 11:14:30
```

### The zone: three independent tests, all agreeing

None is authority — `migrations/README.md` still forbids casting, and nothing
was written. They are recorded because §3 shows the calculation does not need
the answer, and because the ingestion owner should be shown measurements.

**Test A — ingest lag.** Minimum of `ingested_at − source_ts` under each
candidate zone, over 7 days of live traffic:

| Marketplace | Direction | n | as UTC | as Europe/London | as Europe/Berlin |
| --- | --- | --- | --- | --- | --- |
| amazon | inbound | 303 | **+0.3 min** | −60.3 | −120.3 |
| amazon | outbound | 154 | **+0.7** | −60.7 | −120.7 |
| bandq | inbound | 560 | **+2.2** | −62.2 | −122.2 |
| ebay | inbound | 701 | **+0.8** | −60.8 | −120.8 |
| ebay | outbound | 324 | **+0.6** | −60.6 | −120.6 |
| shopify | inbound | 1,313 | **+0.9** | −60.9 | −120.9 |
| shopify | outbound | 537 | **+0.4** | −60.4 | −120.4 |
| temu | inbound | 39 | **+7.0** | −67.0 | −127.0 |

Only UTC is non-negative. London and Berlin both require our sync to have
ingested a message an hour or two *before* it was sent, on all five marketplaces
in both directions.

**Test B — seasonal shift.** If the stored value is UTC, the stored hour-of-day
histogram must run an hour earlier in BST than GMT, because the customer's local
10:00 is stored as 09:00 in summer. eBay inbound, stored hours 05:00–21:59:

| Season | n | mean | p25 | median | p75 |
| --- | --- | --- | --- | --- | --- |
| BST (local = UTC+1) | 20,264 | 12.172 | 9.133 | 11.517 | 15.054 |
| GMT (local = UTC+0) | 13,907 | 12.852 | 9.717 | 12.267 | 15.950 |
| **shift** | | **−0.68 h** | **−0.58** | **−0.75** | **−0.90** |

All four statistics move as UTC predicts. Separately the overnight batch peak
sits at stored hour **00 in GMT** and **23 in BST** — a job fixed to a local
midnight, moving one hour in stored terms.

**Test C — DST invariance.** `ebay_message_headers` carries two timestamps per
row. Their median difference by month, across both the 2025-10-26 and 2026-03-29
transitions:

```
2025-09 1.953   2025-12 1.956   2026-03 1.956
2025-10 1.963   2026-01 1.962   2026-04 1.960
2025-11 1.959   2026-02 1.958   2026-05 1.958
```

Constant to within 10 seconds across seven months and two transitions.
**Neither column observes daylight saving.**

*A test that did NOT work, recorded so nobody repeats it:* the direct
spring-forward gap test. Overnight volume is 1–8 rows an hour, so the missing
01:00 bucket on 2026-03-29 is indistinguishable from a quiet hour.

### `response_date` is a trap — do not use it

`ebay_message_headers.response_date` is a `timestamp` in the source CST already
reads, named exactly like the field this work needs. It is not one:

- Populated on **100% of 106,467 rows**, both directions, never null.
- It is `receive_date + ~1.96 h` on every row.
- **299 rows carry `no_reply = 1, reply_status = 0`** — messages the business
  flags as never to be answered — and still have a "response" ~1.96 h after
  arrival. A response time cannot exist for a message nobody answered.
- It does not track DST, so it is not a zone restatement either.

Built on, it would have shown every conversation answered in under two hours,
every SLA met, on every marketplace — plausible enough to ship. What disproved
it was asking *which rows should be impossible under my hypothesis?*

---

## 3. Inbound → first reply is computable, and needs no zone

The pairing is `min(outbound.source_ts) >= inbound.source_ts` within a
conversation, over the existing `ix_conversation_messages_thread_order` index.
**Across all 32,096 messages: zero negative intervals, zero zero-length ones.**

| Marketplace | inbound | with a later reply | % | median h | p90 h |
| --- | --- | --- | --- | --- | --- |
| amazon | 1,324 | 980 | 74.0 | 13.05 | 21.74 |
| bandq | 5,103 | 0 | **0.0** | — | — |
| ebay | 5,228 | 3,779 | 72.3 | 15.20 | 39.84 |
| shopify | 11,869 | 1,626 | **13.7** | 18.25 | 50.09 |
| temu | 312 | 0 | **0.0** | — | — |

**Why no zone is needed.** `first_reply − burst_start` subtracts two values of
the same column of the same table. Whatever offset that clock carries appears in
both operands and cancels, and Test C shows no DST discontinuity for it to fall
over. The migration README's rule is not bent — it is not engaged.

A zone is required for exactly one thing: the weekday/weekend day boundary.

### The denominator decides whether the number is honest

| Marketplace | bursts | answered | never answered | over 48 h, unanswered |
| --- | --- | --- | --- | --- |
| ebay | 3,556 | 3,049 | **14.3%** | 459 |
| amazon | 1,188 | 858 | 27.8% | 280 |
| shopify | 11,687 | 1,488 | **87.3%** | 9,844 |
| bandq | 4,247 | 0 | 100% | 4,151 |
| temu | 312 | 0 | 100% | 301 |

**Shopify's 87.3% is not a backlog.** Its adapter establishes *direction* and
explicitly does not claim the sender is a customer — suppliers, couriers,
Wayfair purchase orders and cold sales mail all read as inbound. No Shopify
figure should ship until that traffic can be separated.

---

## 4. The SLA configuration

`message_app.sla_configs` holds **1,081 rows** and reading it as one thing is
the first mistake. It is two populations:

| `type` | Rows | What it is |
| --- | --- | --- |
| `response` | **42** | **The policy.** Two per account, `key_value` NULL on every one, all written 2026-04-15. 16 h week / 24 h weekend. |
| `urgent` | 1,039 | A **per-case escalation log**. `key_value` populated on every one with a marketplace message id (874 distinct). Written 2026-04-16, **stopped 2026-05-06**. `reason` quotes customer phrases. |

The "874 rows" quoted in `lib/domain/performance-metrics.ts` is the distinct key
count of the *urgent* rows, not the policy size.

The urgent rows state their own rule as **"HIGH = 4 active working hours"** — and
`information_schema` over all **55 `message_app` tables** returns **zero**
columns matching `%working%`, `%business_hour%`, `%holiday%`, `%shift%` or
`%timezone%`. There is no calendar behind it anywhere.

### Account coverage

| Marketplace | CST accounts | Covered | Uncovered |
| --- | --- | --- | --- |
| ebay | 14 | **14** (keyed by `sub_source`) | — |
| amazon | 1 | 1 (channel-wide) | — |
| shopify | 8 | 3 (104, 108, 112) | **109, 198, 233, 245, 248** |
| bandq | 1 | 0 | 104 — no config row of any type |
| temu | 1 | 0 | 248 — no config row of any type |

The five uncovered Shopify mailboxes were created **2026-04-21, six days after
the policy was written**.

`sub_source_id` is **not globally unique**: 104 is a Shopify account *and* a B&Q
one; 248 is Shopify *and* Temu. Every lookup must key on
`(marketplace, sub_source_id)`.

---

## 5. Decisions needing business approval

Stated, not taken. Each changes a published number.

**A1 — Which target governs? (blocking)**

| Marketplace | flat 24 h (CST) | 16/24 policy (weekday / weekend) |
| --- | --- | --- |
| amazon | **95.6%** | 77.6% / 87.7% |
| ebay | **80.1%** | 60.9% / 55.1% |
| shopify | **71.2%** | 45.0% / 48.9% |

Same replies, same code, **up to a 30-point swing**.

**A2 — Elapsed hours or working hours? (blocking)** No calendar exists. Elapsed
is the only computable reading today.

**A3 — Which timezone decides weekday from weekend?** Europe/Berlin (servers),
Asia/Colombo (what the timer displays), or Europe/London (customers). Affects
only which target applies, never a measured interval.

**A4 — Where does the clock start?** CST's rule says the customer's *newest*
message; the norm is the *first unanswered*. Worth up to 2.5 h on the mean.
Recommendation: first unanswered — a customer who writes three times has been
waiting since the first.

**A5 — Five Shopify accounts have no approved target.** Looks like an oversight
at source, not an exemption. Now visible as data rather than prose.

**A6 — B&Q and Temu can never have these metrics.** Decide whether replies
happen outside the recorded system, or whether the tiles say permanently
unavailable.

**A7 — The KPI scope is wrong and cannot be met.** `message_app_logs.date` is
MariaDB type **`date`** — read from `information_schema`, not inferred. No reply
can be placed within a day. `agent_activity.external_message_id` holds the id of
the message *replied to*, not of the reply. Both metrics are marketplace-scope
or they do not exist.

**A8 — The denominator.** eBay's and Amazon's unanswered work belongs *beside*
the mean, never folded into it. Shopify cannot ship at all yet.

---

## 6. What was built: migration 0019 and the importer

### Files

```
migrations/0019_response_sla_policy.up.sql      one table, two indexes, five CHECKs
migrations/0019_response_sla_policy.down.sql    DROP ... RESTRICT, nothing else
lib/domain/sla-policy.ts                        every mapping decision, pure
lib/db/message-app-source.ts                    +2 readers (appended)
lib/sync/sla-policy-writer.ts                   the upsert + coverage read
scripts/import-sla-policy.mjs                   dry-run default
tests/domain/sla-policy.test.ts                 52
tests/sync/sla-policy-writer.test.ts            30
tests/migrations/sla-policy-schema.test.ts      35
```

### The pipeline

```
sla_configs (1,081)  --WHERE type = ?  bound-->  42 rows
   + mails (18 rows)  --mapPolicyRow()-->  42 entries, 0 rejected
   --collapsePolicies()-->  38 policy rows
   --upsert ON CONFLICT (marketplace, coalesce(sub_source_id,-1), week_scope)-->
cst_app.response_sla_policy
```

### Column mapping

| CST column | Source | Notes |
| --- | --- | --- |
| `marketplace` | `sla_configs.channel` | ebay/amazon/shopify only; others rejected |
| `sub_source_id` | `sla_configs.sub_source`, or `mails.sub_source` via `mail_id` | NULL = whole channel |
| `week_scope` | `sla_configs.week_scope` | Verbatim; not renamed to `weekday` |
| `target_hours` | `sla_configs.hours` | Positive integer or rejected. **No DEFAULT.** |
| `source_pk` / `source_mail_id` / `source_rows` | provenance | `source_pk` is provenance, not identity |

**Never read:** `key_value` (a customer's message id), `reason` (quoted customer
wording), `situation` (one value — instead any non-`default` value is
*rejected*, because a situation-dependent target is a dimension CST has no
column for), and every `mails` credential/SMTP/address column.

### The three account shapes

| Shape | Rows | Resolution |
| --- | --- | --- |
| `sub_source` set | 30 (eBay) | Use it directly |
| `mail_id` → `mails` row with an account | 10 (Shopify) | `mails.sub_source` |
| `mail_id` → `mails` row, `sub_source` **NULL** | 2 (Amazon) | **NULL = whole channel.** Verified reading |
| `mail_id` → **no `mails` row** | 0 today | **REJECTED** |

The last two both produce "no account id" and must never be collapsed. A mailbox
that exists and records no account is the source saying the target is
channel-wide; one that does not exist is the source being broken. CST holds one
Amazon account (8), so writing 8 would probably be right — and would be a
fabricated join, indistinguishable from the 14 eBay rows where the source states
the account.

### The Shopify collapse

```
mail_id 2 (sales@), 3 (admin@), 8 (german@)  ->  sub_source 104
```

Six source rows describe two real scopes. Verified: all three agree on 16/24, so
the collapse loses nothing.

| Scope | Source rows | Kept | Target |
| --- | --- | --- | --- |
| `shopify/104/week` | 4, 6, 7 | **4** | 16 h |
| `shopify/104/weekend` | 38, 40, 41 | **38** | 24 h |

Lowest id wins, compared **numerically** — `source_pk` is text and `"10" < "9"`
under a string sort. Disagreement is **fatal, not a vote**: the importer refuses
the whole run before opening a transaction.

### Three design decisions a reviewer may reverse

- **D1 — Amazon stored channel-wide, not against account 8.** NULL stays correct
  if Amazon ever gets a second account; the concrete id silently would not.
- **D2 — No unique index on source identity**, a deliberate departure from
  0016–0018. The mapping is many-to-one, so a unique `source_pk` would assert a
  one-to-one relationship the data does not have. The scope key is the identity.
- **D3 — Disagreement aborts the whole run.** A partial import leaves some
  accounts with a target and their neighbours without one, which reads as a
  coverage gap rather than a failure.

### Duplication risks and what closes each

| Risk | Closed by |
| --- | --- |
| Re-running the importer | Upsert on the scope index. `created_at` never rewritten. |
| Shopify many-to-one collapse | `collapsePolicies` before the DB; unique index behind it |
| `sub_source_id` colliding across marketplaces | `marketplace` first in the index and in `scopeKey` |
| **Amazon's NULL inserting twice** | `coalesce(sub_source_id, -1)` — PostgreSQL treats NULLs as *distinct*, so a plain column list would append a pair on every run |
| A drifting second copy | Full provenance + `imported_at` refreshed on both paths |
| A truncated read | Guards that **throw**, not limits that silently bite |
| A partial import | One transaction; conflicts abort before it opens |

*Accepted, recorded:* there is no prune pass. A target withdrawn at source stays
until somebody removes it. `imported_at` is what makes a stale row detectable.

Not importing the 1,039 urgent rows also removes the largest duplication
surface: 1,039 rows on 874 distinct keys means **165 already duplicate a key at
source**.

---

## 7. Verification and evidence

### The database is untouched

```
policy_table_absent   : true      <- to_regclass('cst_app.response_sla_policy') IS NULL
cst_app_base_tables   : 30        <- unchanged; 0019 would make it 31
agent_activity        : 17,822    <- unchanged
agent_directory       :    234    <- unchanged
source_ts_utc populated:    0     <- unchanged
```

`conversation_messages` moved 32,096 → 32,116 during the work. **That was the
scheduled five-minute sync, not this task** — `latest_ingest` was minutes before
the read. Recorded because an unexplained row-count change in an evidence
document is worse than an explained one.

### Tests

```
$ npx vitest run
 Test Files  156 passed | 13 skipped (169)
      Tests  4479 passed | 35 skipped (4514)      0 failed
```

117 added. `tests/migrations/sla-policy-schema.test.ts` is a separate file
rather than an addition to `mysql-source-schema.test.ts`, because that suite
asserts `STATUS: APPLIED 2026-09-23` on every migration it covers and 0019 is
awaiting review.

`npx eslint` on all new files: no output. `npx tsc --noEmit` reports one
pre-existing error in a Next.js generated validator for a route absent from this
checkout; this work adds no route.

### The dry run

```
$ npm run import:sla-policy
source credential verified read-only (SELECT/USAGE only)

DRY RUN — nothing written
  mysql queries spent        : 3 (cap 100/hour, 1 connection of 50/hour)
  mails rows read            : 18
  sla_configs read           : 42  (type='response' only)
  mapped to entries          : 42
  policy rows after collapse : 38

  COLLAPSED (2):
    shopify/104/week:    3 rows agreed on 16h, kept sla_configs.id 4
    shopify/104/weekend: 3 rows agreed on 24h, kept sla_configs.id 38

  CST seller accounts: 25, covered 18, UNCOVERED 7
    bandq    account 104  — 4247 conversations, NO approved target
    shopify  account 109  —  211 conversations, NO approved target
    shopify  account 198  —  206 conversations, NO approved target
    shopify  account 233  —  182 conversations, NO approved target
    shopify  account 245  —  132 conversations, NO approved target
    shopify  account 248  —  327 conversations, NO approved target
    temu     account 248  —  312 conversations, NO approved target
```

42 in, 38 out, zero rejections. eBay account **25** is included although CST has
no traffic on it — the policy names it, and dropping a real target because
traffic has not arrived would invent a coverage decision.

### Query budget

`message-app-dev` carries `MAX_QUERIES_PER_HOUR 100` and
`MAX_CONNECTIONS_PER_HOUR 50`.

| Phase | Connections | Queries |
| --- | --- | --- |
| Discovery | 4 | 17 |
| Pre-coding verification | 1 | 4 |
| Dry runs (×2) | 2 | 6 |
| **Total** | **7** | **27** |

The importer costs **3 per run**: `SHOW GRANTS`, `mails`, `sla_configs`. Every
session aborts before its first read if the grant list contains any write
privilege; the account returned 58 lines, all SELECT/USAGE. MariaDB 10.4 has no
`transaction_read_only` to pin, so this is the only mechanism available.

### Key verification queries

```sql
-- Integrity of every assumption the mapper makes. Returned 42 and ten zeros.
SELECT COUNT(*) n, SUM(channel IS NULL), SUM(hours IS NULL), SUM(hours <= 0),
       SUM(week_scope NOT IN ('week','weekend')), SUM(situation <> 'default'),
       SUM(sub_source IS NOT NULL AND mail_id IS NOT NULL),
       SUM(sub_source IS NULL AND mail_id IS NULL),
       SUM(key_value IS NOT NULL), SUM(reason IS NOT NULL)
FROM sla_configs WHERE type = 'response';

-- Does anything collapse, and does it agree? Two rows, both distinct_hours = 1.
SELECT s.channel, COALESCE(s.sub_source, m.sub_source) resolved, s.week_scope,
       COUNT(*) rows_collapsing, COUNT(DISTINCT s.hours) distinct_hours
FROM sla_configs s LEFT JOIN mails m ON m.id = s.mail_id
WHERE s.type = 'response' GROUP BY 1,2,3 HAVING COUNT(*) > 1;
```

```sql
-- The interval, with no cast and no zone. Window frame over the existing index;
-- a correlated subquery expresses the same thing and does not return.
WITH w AS (
  SELECT c.marketplace, m.conversation_id AS conv, m.direction, m.source_ts,
         min(CASE WHEN m.direction='outbound' THEN m.source_ts END) OVER (
           PARTITION BY m.conversation_id ORDER BY m.source_ts, m.source_pk
           ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS reply_ts
  FROM cst_app.conversation_messages m
  JOIN cst_app.conversations c ON c.id = m.conversation_id
)
SELECT marketplace, conv, reply_ts, min(source_ts) AS first_in
FROM w WHERE direction = 'inbound' AND reply_ts IS NOT NULL
GROUP BY marketplace, conv, reply_ts;

-- response_date disproved: 299 rows nobody answers, each with a ~1.96h "response".
SELECT reply_status, no_reply, count(*),
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY extract(epoch FROM (response_date - receive_date))/3600.0)
FROM customer_service.ebay_message_headers WHERE folder_id = 0
GROUP BY 1,2;
```

---

## 8. Formulas, for when A1–A4 are answered

Not implemented. Specified so the decisions have something concrete to land on.

```
first_reply(i) = min{ o.ts : o.conv = i.conv AND o.dir='outbound' AND o.ts >= i.ts }

burst b        = the run of inbound messages sharing one first_reply
  b.start      = min(inbound.ts)        -- convention A, recommended
  b.newest     = max(inbound.ts)        -- convention B, CST's stated rule
  b.interval   = b.reply - b.start      -- an interval. No cast, no zone.

AverageResponseTime(m, [from,to)) = mean{ b.interval : answered, b.start in range }
  REPORTED ALWAYS WITH answered, unanswered, unansweredPct.

target(b) = policy(marketplace, sub_source_id, weekScope(b.start))
            weekScope needs <BUSINESS ZONE> — UNDECIDED, A3

SLAPerformance = met / (met + missed)
  REPORTED ALWAYS WITH met, missed, noPolicy, unanswered.
  noPolicy is NEVER counted as met and NEVER as missed.
```

Floor to whole minutes, matching `responseSlaStatus`. Landing exactly on the
target is **met, not missed**.

Tests to write, none of which assert a value: burst grouping (3 inbound + 1
reply = one burst); zone independence (shifting both operands by any offset
leaves the interval unchanged — *the property the design rests on*); exactly-on
-target is met; an unanswered burst is in neither numerator nor denominator but
is reported; `no_policy` never becomes `met`; B&Q and Temu return
`unsupported_marketplace`, not 0; weekend classification at all four day
boundaries; and a guard that no file computing an interval contains
`AT TIME ZONE`, `::timestamptz` or `new Date(source_ts)`.

---

## 9. Known limitations

- **The timezone conclusion is evidence, not authority.** Nothing was cast and
  `source_ts_utc` is still NULL. The finding that matters is that the *interval*
  does not depend on the answer.
- **The ~2 minute residual** in `response_date − receive_date` (1.956 h rather
  than a round 2.000 h) is unexplained. It changes nothing because the column is
  unusable regardless.
- **Ingest lag was measured over 7 days only.** Longer windows mix in the
  2026-08-19 backfill, where `ingested_at` is the import time.
- **No conclusion on Shopify's customer/non-customer split.** Identified as the
  blocker, not solved. It must be solved from stored fields or reported as
  unsolved — never by classifying message text. The before-shipment rule exists
  because reading wording to decide priority was wrong in three separate ways.
- **No prune pass on the policy table** (see §6).

### Two mistakes made and corrected during this work

- **`message_app.mails` has 18 rows, not 11.** Discovery read it with `LIMIT 11`
  on the strength of `information_schema.TABLES.TABLE_ROWS` — an **estimate**
  for InnoDB — and the limit made the estimate self-confirming. No mapping
  changed; every `mail_id` the policy references was inside the first eleven.
  `fetchMailAccounts` now reads the table whole and throws rather than carrying
  a limit that can bite silently. *Never size a read from `TABLE_ROWS`.*
- **The first dry run ended `coverage report unavailable`** — the coverage block
  re-connected an already-connected client. Found by running the thing rather
  than reading it. Fixed.

---

## 10. Next pending items

**Immediately actionable, decision-free:**

1. Review `0019_response_sla_policy.{up,down}.sql`, then apply to `varmen_db` /
   `cst_app` in its own transaction. Expect base tables 30 → 31.
2. `npm run import:sla-policy` — read the coverage table. 7 uncovered accounts
   is the expected result, not a failure.
3. `npm run import:sla-policy -- --apply` → expect 38 inserted, 0 updated.
4. Run it again → expect **0 inserted, 38 updated**. That is the idempotency
   check, worth doing on the live table rather than trusting the index.
5. Update the `STATUS:` header in the migration and the row in
   `migrations/README.md`. `sla-policy-schema.test.ts` asserts the header
   currently reads NOT EXECUTED and fails until updated deliberately — which is
   the point, and what 0007 lacked when its header read NOT EXECUTED while its
   column was live.

**Blocked on business decisions:**

6. Average response time, marketplace scope, eBay and Amazon only — needs A4 and
   A8. No import required; it computes from `conversation_messages` today.
7. SLA performance, marketplace scope — needs A1, A2, A3, and step 1 above.

**Not scheduled:** per-agent scope for either metric. Impossible from the
current source; it needs a record of which agent sent which reply at finer than
day granularity, which is a change at source.

**Corrections owed in existing files** (not applied — both tasks were scoped
away from dashboard-facing prose):

- `lib/domain/performance-metrics.ts` — the `sla_performance` blocker says
  "874 rows"; the table holds 1,081 of which 42 are policy.
- `lib/domain/performance-metrics.ts` — `ARRIVAL_TIMESTAMP` is attached to
  `average_response_time`, which does not need `source_ts_utc`. Its real
  blockers are A4, A7 and A8.
- `lib/domain/response-sla.ts` — quotes 23,412 inbound (now 23,836) and records
  the UTC evidence as a single-sided test; two further tests now agree, and the
  DST result is new information.

**Must not follow:** computing an SLA percentage while A1 is open; importing the
1,039 urgent rows; giving uncovered accounts a fallback target; populating
`source_ts_utc`; or using `ebay_message_headers.response_date`.
