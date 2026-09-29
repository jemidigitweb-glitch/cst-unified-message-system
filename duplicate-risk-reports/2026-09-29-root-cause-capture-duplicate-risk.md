# Root cause capture — duplicate risk

**2026-09-29.**

## The headline

**Duplicate rows are expected and correct here, and that inverts the usual
report in this folder.** `conversation_root_causes` is append-only: changing a
root cause inserts a second row for the same conversation, and a third, and the
newest is current. There is no unique constraint on `conversation_id` and there
must never be one — it would make correcting a mistake impossible.

So the risk is not that duplicates exist. It is that **somebody counts them as
if they were separate cases.**

## The real risk: double counting in the report

Every naive `count(*)` over this table counts ROWS. A conversation whose root
cause was corrected twice contributes three rows and would appear as three
cases. With a percentage on top, that inflates both the numerator and the
denominator by an amount that varies per courier — so the comparison the feature
exists to produce comes out wrong in a way that looks plausible.

**Mitigation, and it is not built yet.** The report must choose deliberately
between two questions and say which it answered:

- *How many cases involved EVRI* — count the CURRENT value per conversation
  (`DISTINCT ON (conversation_id) … ORDER BY conversation_id, recorded_at DESC, id DESC`).
- *How often did somebody record an EVRI problem* — count rows.

Both queries are written out in
`query-packs/2026-09-29-root-cause-query-pack.md`. A percentage whose
denominator is undocumented is a number nobody can act on.

## Accidental double recording from the screen

Low, and bounded. The Record button disables while a request is in flight
(`busy`), and on success the form clears and closes. A double click therefore
cannot produce two rows.

A determined double submission — two tabs, or a retried request — **would**
record two identical rows. That is deliberately not prevented:

- There is no idempotency key, because two identical selections a minute apart
  are not obviously a mistake. An agent re-confirming a cause is a real thing.
- Deduplicating on write would mean the second record silently did nothing,
  which is the failure mode this table exists to avoid.

Two identical adjacent rows read as what they are, and the current-value query
returns the same answer either way.

## Drift between the two recorded values

**This is a designed divergence, not a duplicate to reconcile.** The message
application holds its own `root_cause` on the message rows, and its classifier
rewrites those every five minutes with no user and no log. CST's value is
recorded by a CST agent and that application will never see it.

The two **will** disagree, routinely. The panel shows both, separately
labelled, rather than letting one stand in for the other. Nothing in this
application tries to reconcile them, and nothing should: CST cannot write there,
so a "sync" could only ever be CST silently adopting a value it did not choose.

Anyone reading a report off this table must understand it counts **CST's**
decisions and not the message application's. Stated in the migration header, the
overview and the query pack.

## Vocabulary drift

The eighteen labels were measured from the source on 2026-09-29 and are a
snapshot. The message application's agents and classifier will add labels
without telling us.

- A new label there does **not** appear here until the measurement query is
  re-run and the list updated.
- A label removed there stays here until the same.
- `vocabulary_version` is stamped on every row, so a stored label can always be
  read against the list that offered it. **Bump it when the list changes.**

The one thing this cannot drift into is a failed save: `root_cause` carries no
CHECK, deliberately, so an unrecognised label is a row an operator can see
rather than a 500.

## No risk of duplicating an existing CST concept

Checked, and the separation is enforced by a standing guard: root cause and the
frozen CST message category are different systems with no shared vocabulary,
storage or code path. `tests/guards/message-app-root-cause-panel.test.ts` asserts
that the classifier does not know a root cause exists, and that no file in this
feature imports it. The category baseline is paused and this work did not touch
it.

## No risk to the sync

This feature writes one CST table and reads five source tables with SELECT. It
adds no sync state, no watermark, no reconciliation pass and no worker. Nothing
about message ingestion, threading or late-arrival reconciliation is affected.
