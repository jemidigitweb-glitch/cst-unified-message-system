# Case Detection Indicator — workflows

**Date:** 2026-10-02

What a person does, step by step.

---

## A. A CST agent answering a message

Nothing to do. The lookup runs when the conversation opens.

1. Open a conversation.
2. **If a case is live on it**, a sky-tinted strip appears directly under the
   conversation header, above the thread:

   > ⚑ MARKETPLACE CASE ALREADY OPEN ON THIS ORDER
   > Return · `Open` · on this order · opened 2026-10-01 · escalated
   > Full case detail is in the details column, under Marketplace cases.

   It cannot scroll away while reading the thread.
3. **For the detail**, read *Marketplace cases* in the details column — the
   sky-framed block directly beneath *Order for this message*. It lists every
   case, live ones first, closed ones behind **Show N closed cases**.
4. **To act on a case**, use the system that owns it. This panel is read-only;
   the case reference is shown as text to copy.

### Reading the status words

| On screen | Means |
| --- | --- |
| `Open` | the marketplace says the case is open |
| `Status not recorded` | **the source does not say.** Not closed. Common on Amazon returns reading `Approved` |
| `Closed` | the marketplace says the case is closed |
| *Refund recorded* | money went back. **Not** a return request |
| *Warehouse outcome (not a case status)* | what happened to the goods in a warehouse. Says nothing about the customer's case |
| *Escalated at the marketplace* | an escalation was recorded. A closed case can carry this |
| *Replacement: Confirmed by the marketplace* | the marketplace's own resolution field says so. **Not** that one was dispatched |

### When no cases are shown

Read the sentence — the four are different answers:

| Sentence | Means |
| --- | --- |
| "No marketplace cases recorded for this order or customer." | searched, and there are none |
| "...Some case sources have never been imported, so this is not a complete answer." | searched, none found, but coverage is partial |
| "Marketplace case records have not been imported for this marketplace yet." | nothing has ever been imported. **Not** "no cases" |
| "No verified order or customer reference, so case records could not be matched." | there was nothing to search on |
| "Case records could not be checked." | the lookup failed. **Not** "no cases" |

No section at all on a B&Q or Temu conversation is correct: those marketplaces
have no case source.

### When the data is old

> *This may not include a case opened since that time.*

appears when the snapshot is more than 24 hours old. The cases still show — a
day-old list is better evidence than none — but a case opened this morning will
not be in it. Ask for a refresh (§B).

---

## B. Refreshing the snapshot — the manual import

**This is the only thing in this feature that touches MySQL.** It is run by a
person, deliberately, and nothing schedules it.

### Before you start

The `message_app` MySQL account allows **100 queries and 50 connections per
hour**, shared with every other consumer including the message sync. A full
import costs **one connection and twelve queries**. Do not assume the whole
hourly allowance is free.

### Step 1 — rehearse

```bash
npm run import:marketplace-cases
```

A rehearsal **writes no row anywhere** — not even a ledger row. There is no mode
flag and no dry-run branch: the rehearsal simply never calls `openImportRun`, so
"a dry run changes no database" is structural rather than a branch somebody could
get wrong.

Read the output. It reports, per store: rows read, cases after collapse,
rejections by reason, the storefront allowlist it resolved, and the order
resolutions.

**If the rehearsal fails, or reports a schema, storefront or relationship
surprise, STOP.** Do not apply. An unmapped lifecycle value is a signal that the
source has changed shape and is meant to stop the run.

### Step 2 — apply

```bash
npm run import:marketplace-cases -- --apply
```

The protocol is three transactions:

1. record the attempt as `in_progress` and commit at once, so a run that dies is
   still on record;
2. every case upsert **and** the publish statement, in ONE transaction — either
   all the cases land and the run is published with them, or neither happens;
3. on failure only, mark the run `failed`, after transaction 2 has rolled back.

At most one run may be in progress at a time; a second concurrent attempt fails
at its first statement rather than part-way through the data.

### Step 3 — verify

Run `sql/2026-10-02-case-detection-verification.sql` and check:

- exactly one `published` row per refresh, with counts;
- every `failed` run owns **zero** rows;
- zero duplicate identities;
- `customer_case_history` row count unchanged;
- no warehouse disposition in `source_status`.

Then open a conversation known to have a case and confirm the strip appears.

### If it fails

A failed run must be **repeated from the beginning**, not resumed —
resumability was traded for atomicity deliberately, and it is affordable because
the whole extraction costs twelve queries. The previously published snapshot is
untouched and keeps serving CST throughout.

---

## C. What nobody should do

- Do not add a cron entry, scheduled task or worker for the import. MySQL access
  is manual by design, and a guard fails the build on `cron`, `setInterval`,
  `watermark` or `feed_key` appearing in the importer.
- Do not add a route that triggers an import.
- Do not read `marketplace_cases` without joining `case_import_runs` and
  filtering on `published`.
- Do not weaken a guard to make a change pass. A guard failure is a design
  question.
