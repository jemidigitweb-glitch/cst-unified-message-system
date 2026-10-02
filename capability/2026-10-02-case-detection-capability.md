# Case Detection Indicator — capability

**Date:** 2026-10-02

What the system can and cannot do, now that the indicator is live.

---

## Can

- **Tell a CST agent, on the conversation, that a marketplace case already
  exists** — before the reply is written, without opening the message
  application.
- **Match a case to the order the conversation resolved to**, on the same
  marketplace and storefront, by exact order reference.
- **Match a case to the same customer on their other orders**, by marketplace
  buyer handle, case-insensitively on both sides.
- **Keep those two answers apart.** The lists are disjoint by construction and
  separately headed.
- **Show, per case:** type, case reference, lifecycle, the marketplace's own
  status, the reason given, the recorded resolution, damage reported, confirmed
  replacement, escalation, the action owed by us and its due date, quantity,
  refund amount with currency, and the opened and closed dates — each only where
  the source recorded it.
- **Distinguish five answers** that all show no cases: lookup failed, never
  imported, nothing to search on, searched and empty, and found.
- **Report coverage per source store**, so a partially imported marketplace
  cannot read as a complete answer.
- **Report how old the snapshot is**, as the oldest covered store, and mark it
  when it is more than a day old.
- **Say when a list was capped** rather than implying it is everything.
- **Render nothing for a marketplace with no case source** (B&Q, Temu).

## Cannot — by design

- **Cannot write anything.** GET only. No control, no form, no button.
- **Cannot reach a customer.** No transport, no recipient, no template. The
  workflow still terminates at `reviewed`.
- **Cannot reach MySQL.** No driver, reader or importer module is reachable from
  `app/`, directly or transitively, and a guard sweeps for it on every run.
- **Cannot read an unpublished import.** Every statement joins the run ledger and
  filters on `published`.
- **Cannot resolve an order.** It reads the order the existing resolver already
  established and stored. No product name, SKU, customer name, date proximity or
  model output is ever used to associate a case with an order.
- **Cannot present an unverified order reference as an exact match.** Three of
  the four match methods carry a qualifying sentence.
- **Cannot present a Shopify refund as an open return**, a warehouse disposition
  as a case status, an unknown lifecycle as closed, or an available action as a
  dispatched replacement.
- **Cannot refresh itself.** The import is a manual command. Nothing schedules
  it, and no route, cron entry or worker can start one.

## Cannot — limitations, not design

- **A manually selected order does not drive the case lookup.** A reviewer who
  picks an order in the sidebar for a conversation that resolved to none still
  gets only the customer's own cases. The choice lives in the browser and is
  never stored.
- **A conversation with no stored context snapshot has no order to match on.**
  It falls back to the customer match, or to `no_search_key`.
- **FBA warehouse outcomes are under-reported.** Where an Amazon-fulfilled event
  row shares a return authorisation with a merchant-fulfilled one, the latter's
  status decides the case. Safe in the direction that matters — no disposition
  can reach a status field — but incomplete.
- **The snapshot is as current as the last manual import.** A case opened this
  morning is not there until somebody runs the importer.
- **B&Q and Temu have no case data at all**, and this feature does not change
  that.
- **No authentication**, here as everywhere in this application.
