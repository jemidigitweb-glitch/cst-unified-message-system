"use client";

import {
  type CaseDetectionCase,
  type CaseDetectionResponse,
  caseEmptyStateText,
  caseFactsFor,
  caseLifecycleLabel,
  caseNeedsAttention,
  caseTypeLabel,
  orderMatchCaveat,
} from "@/lib/domain/marketplace-case-display";
import { formatSourceTimestamp } from "@/lib/domain/inbox";

import { FlagIcon } from "./icons";
import { SectionHeading } from "./sidebar-section";
import type { ConversationCasesState } from "./use-conversation-cases";

/**
 * The Case Detection Indicator: the marketplace cases already on record for
 * this conversation's order and customer.
 *
 * ------------------------------------------------------------------------
 * WHY IT EXISTS
 * ------------------------------------------------------------------------
 * A CST agent answering a return question had no way to know a return was
 * already open without leaving this application for the message application.
 * Every fact below was imported into this application's own database by a
 * manual, standalone run, so reading it costs one application query and never
 * touches the source account that import came from. (The schema is not named
 * here: `tests/guards/api-surface.test.ts` forbids an internal table or schema
 * name anywhere in browser-facing code, comments included, and that is the
 * right rule — a name in a comment is one copy-paste from a label.)
 *
 * ------------------------------------------------------------------------
 * IT REPORTS RECORDS. IT ASSERTS NOTHING THE SOURCE DOES NOT
 * ------------------------------------------------------------------------
 * Four mistakes are available to any panel built over this data, each of them
 * measured rather than imagined, and each is prevented here by construction
 * rather than by care:
 *
 *   A SHOPIFY REFUND IS NOT AN OPEN RETURN. 2,019 of these records hold a date,
 *   an order, an amount and a currency and nothing else. `caseTypeLabel` reads
 *   "Refund recorded" and the lifecycle reads "Status not recorded", so neither
 *   line can be read as a return request somebody has to action.
 *
 *   AN AMAZON WAREHOUSE OUTCOME IS NOT A CASE STATUS. It arrives in its own
 *   field and `caseFactsFor` labels it "Warehouse outcome (not a case status)".
 *   There is no code path that can put it on the status row.
 *
 *   AN UNKNOWN LIFECYCLE IS NOT A CLOSED ONE. 14,436 of 21,022 cases are
 *   `unknown`, overwhelmingly Amazon returns whose status reads `Approved` —
 *   the request was approved, and the store records no closure. They render as
 *   "Status not recorded" and sit in the PROMINENT list, not behind the closed
 *   disclosure.
 *
 *   AN AVAILABLE ACTION IS NOT A DISPATCHED REPLACEMENT. "Replacement:
 *   Confirmed by the marketplace" can only be reached from the one
 *   authoritative Amazon field; migration 0022 makes it unrepresentable for
 *   any other store, so the 54 eBay near-misses cannot arrive here.
 *
 * ------------------------------------------------------------------------
 * SILENT, OR EXPLICIT. NEVER AMBIGUOUS
 * ------------------------------------------------------------------------
 * The section renders NOTHING while the lookup is in flight, and nothing at all
 * for a marketplace that has no case source to read — a heading over a
 * permanent blank teaches an agent to ignore the heading.
 *
 * Everything else is said in a sentence, because the four ways of having no
 * cases on screen mean four different things and only ONE of them is evidence
 * that this customer has none. See `caseEmptyStateText`.
 *
 * ------------------------------------------------------------------------
 * IT IS NOT THE REPEAT-CUSTOMER WARNING, AND THEY CANNOT DOUBLE-COUNT
 * ------------------------------------------------------------------------
 * About 1,098 cases exist in both `marketplace_cases` and the warning's own
 * table, so the overlap is real and was measured. It cannot surface as a
 * duplicate on screen, because the two render disjoint things: the warning
 * renders COUNTS of records that existed before this conversation began and
 * names none of them, and this panel renders CASES on this order or this
 * customer's other orders and totals nothing. No screen sums the two, and
 * neither one is derived from the other.
 *
 * ------------------------------------------------------------------------
 * READ-ONLY, AND STRUCTURALLY SO
 * ------------------------------------------------------------------------
 * One GET. No form, no button, no control of any kind, nothing that writes and
 * nothing a customer could ever receive. An agent who wants to act on a case
 * does it in the system that owns the case; this panel exists so they know it
 * is there.
 */

export const CASES_HEADING = "Marketplace cases";

/** The heading for cases on the order this conversation resolved to. */
export const THIS_ORDER_HEADING = "On this order";

/**
 * The heading for the customer's cases on their OTHER orders.
 *
 * It names the distinction rather than implying it. A case about a different
 * purchase is useful context and is NOT the case the customer is writing about,
 * and an agent reading quickly must not be able to take one for the other —
 * the same reason the order section renames itself "Order for this message".
 */
export const OTHER_ORDERS_HEADING = "Other orders by this customer";

/**
 * The lifecycle marker beside a case.
 *
 * THREE STATES, THREE TREATMENTS, and the middle one is why this is not a
 * boolean: an amber "Status not recorded" has to look different from a green
 * "Open" and from a plain "Closed", or the largest population in the data —
 * cases whose state the source never settled — would borrow the appearance of
 * one of the two it is not.
 */
function LifecycleBadge({ lifecycle }: { lifecycle: CaseDetectionCase["lifecycle"] }) {
  const tone =
    lifecycle === "active"
      ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
      : lifecycle === "unknown"
        ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
        : "bg-current/10 opacity-70";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {caseLifecycleLabel(lifecycle)}
    </span>
  );
}

/**
 * One case.
 *
 * `orderLabel` is supplied only for a case on another order, so the order
 * reference appears exactly where it changes the meaning of what is above it.
 */
function CaseCard({
  caseRecord,
  showOrderRef,
}: {
  caseRecord: CaseDetectionCase;
  showOrderRef: boolean;
}) {
  const facts = caseFactsFor(caseRecord);
  const caveat = orderMatchCaveat(caseRecord.orderMatchMethod);
  const opened = formatSourceTimestamp(caseRecord.openedAt);
  const closed = caseRecord.closedAt === null ? null : formatSourceTimestamp(caseRecord.closedAt);
  const due =
    caseRecord.sellerActionDueAt === null
      ? null
      : formatSourceTimestamp(caseRecord.sellerActionDueAt);

  return (
    <li className="rounded border border-current/15 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{caseTypeLabel(caseRecord.caseType)}</span>
        <LifecycleBadge lifecycle={caseRecord.lifecycle} />
      </div>

      {/*
        The case reference, as text and never as a link. CST has no session on
        the system that owns the case, so a link would be an invitation to a
        login screen; the reference is what an agent copies into it.
      */}
      <p className="mt-0.5 text-xs break-all opacity-70">Case {caseRecord.caseRef}</p>

      {showOrderRef && caseRecord.orderRef !== null && (
        <p className="text-xs opacity-70">Order {caseRecord.orderRef}</p>
      )}

      <dl className="mt-1 flex flex-col gap-0.5">
        {facts.map((fact) => (
          <Row key={fact.label} label={fact.label} value={fact.value} />
        ))}
        <Row label="Opened" value={opened.date} />
        {closed !== null && <Row label="Closed" value={closed.date} />}
        {due !== null && <Row label="Action due" value={due.date} />}
      </dl>

      {/*
        WHERE THE CASE'S OWN ORDER REFERENCE IS NOT A VERIFIED ORDER, SAY SO.
        A marketplace-recorded reference that resolves to no order here, and an
        order this application derived from the item and transaction
        identifiers, are two different claims from a verified match — and
        presenting either as an exact match is the one association this feature
        must not invent.
      */}
      {caveat !== null && (
        <p className="mt-1 text-[11px] opacity-55">{caveat}</p>
      )}
    </li>
  );
}

function CaseGroup({
  heading,
  cases,
  showOrderRef,
}: {
  heading: string;
  cases: readonly CaseDetectionCase[];
  showOrderRef: boolean;
}) {
  if (cases.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-medium opacity-70">{heading}</h3>
      <ul className="flex flex-col gap-2">
        {cases.map((caseRecord) => (
          <CaseCard
            key={`${caseRecord.caseRef}-${caseRecord.openedAt}`}
            caseRecord={caseRecord}
            showOrderRef={showOrderRef}
          />
        ))}
      </ul>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs opacity-70">{label}</dt>
      <dd className="text-right text-sm break-words">{value}</dd>
    </div>
  );
}

/**
 * The provenance line, and it is not optional.
 *
 * Everything above is a SNAPSHOT taken by a manual import, not a live read, and
 * a case list with no date on it reads as current. The timestamp is the oldest
 * covered source, so it is a floor rather than a flattering maximum.
 */
function CaseProvenance({ data }: { data: CaseDetectionResponse }) {
  const asOf = data.coverage.asOf === null ? null : formatSourceTimestamp(data.coverage.asOf);

  return (
    <div className="flex flex-col gap-1">
      {asOf !== null && (
        <p className="text-[11px] opacity-55">
          Imported marketplace records, last updated {asOf.date} {asOf.time}.
        </p>
      )}
      {/*
        STALE IS SAID, NOT HIDDEN, AND THE CASES STILL SHOW. Nothing schedules
        the import, so an old snapshot is an ordinary state rather than a fault
        — but an agent reading a day-old list must know a case opened this
        morning would not be in it.
      */}
      {data.stale && (
        <p className="text-[11px] text-amber-800 dark:text-amber-300">
          This may not include a case opened since that time.
        </p>
      )}
      {/*
        PARTIAL COVERAGE IS A DIFFERENT CAVEAT FROM STALENESS, and conflating
        them would be the quieter mistake: a store that has never been imported
        is not old data, it is absent data, and no number of refreshes of the
        others would fill it in.
      */}
      {data.coverage.neverImported > 0 && (
        <p className="text-[11px] text-amber-800 dark:text-amber-300">
          {data.coverage.neverImported === 1
            ? "One case source has never been imported, so this list may be incomplete."
            : `${data.coverage.neverImported} case sources have never been imported, so this list may be incomplete.`}
        </p>
      )}
      {(data.orderCasesHasMore || data.customerCasesHasMore) && (
        <p className="text-[11px] opacity-55">
          More cases exist than are shown here.
        </p>
      )}
    </div>
  );
}

/**
 * THE FLAG ABOVE THE THREAD, and why the sidebar section was not enough.
 *
 * Measured on the running application rather than guessed: with the details
 * column scrolled to the top, the Marketplace cases section sat 1,305px down a
 * 2,174px scroller — below the internal notes, the root-cause chips, the
 * listing and the order. A reviewer answering a message never saw it, which
 * makes a correct panel useless. "There is already an open return on this
 * order" is the one fact that changes the reply, and it has to be visible
 * before the reply is written, not after four scrolls.
 *
 * So the detail stays in the sidebar, where it belongs beneath the order it
 * describes, and this strip carries the headline — the same split, and the same
 * mechanism, as the Repeat-Customer Warning: a `shrink-0` sibling of the
 * message scroller, so it cannot scroll away mid-thread.
 *
 * ---------------------------------------------------------------------------
 * ONLY LIVE CASES, AND "LIVE" INCLUDES "THE SOURCE DID NOT SAY"
 * ---------------------------------------------------------------------------
 * A closed case never raises this strip — it is history, and history lives in
 * the sidebar. An `unknown` case does raise it, because nothing in the source
 * says it is over; the chip says "Status not recorded" rather than implying it
 * is open, so the strip reports the uncertainty instead of resolving it.
 *
 * ---------------------------------------------------------------------------
 * SKY, NOT ROSE OR AMBER, AND THAT IS NOT DECORATION
 * ---------------------------------------------------------------------------
 * Three strips can stack above one thread. Rose with a rail is the
 * Repeat-Customer Warning, amber without a rail is a pinned internal note, and
 * this is sky with a rail. A reviewer has to be able to tell at a glance which
 * is a colleague's note, which is this customer's history, and which is a case
 * open right now at the marketplace, and a fourth amber box would make two of
 * the three indistinguishable.
 *
 * It states that records exist. It is not an alarm, and `role="note"` rather
 * than `role="alert"` for the same reason the warning is: this is context to
 * read before replying, not an interruption.
 */
export function ConversationCaseFlag({ cases }: { cases: ConversationCasesState }) {
  if (cases.state !== "ready") return null;

  const onThisOrder = cases.data.orderCases.filter((c) => caseNeedsAttention(c.lifecycle));
  const onOtherOrders = cases.data.customerCases.filter((c) => caseNeedsAttention(c.lifecycle));
  if (onThisOrder.length === 0 && onOtherOrders.length === 0) return null;

  const lines = [
    ...onThisOrder.map((c) => ({ caseRecord: c, where: "on this order" })),
    ...onOtherOrders.map((c) => ({
      caseRecord: c,
      where: c.orderRef === null ? "on another order" : `on order ${c.orderRef}`,
    })),
  ];

  return (
    <section
      role="note"
      aria-label="Existing marketplace case"
      data-testid="conversation-case-flag"
      className="max-h-32 shrink-0 overflow-y-auto border-b border-l-4 border-b-sky-300/40 border-l-sky-500 bg-sky-50 px-5 py-2.5 dark:border-b-sky-400/25 dark:border-l-sky-400/70 dark:bg-sky-500/[0.10]"
    >
      <h3 className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-sky-900 uppercase dark:text-sky-200">
        <FlagIcon />
        {onThisOrder.length > 0 && onOtherOrders.length === 0
          ? "Marketplace case already open on this order"
          : "Marketplace case already open"}
      </h3>
      <ul className="flex flex-col gap-1">
        {lines.map(({ caseRecord, where }) => (
          <li
            key={`${caseRecord.caseRef}-${caseRecord.openedAt}`}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-sky-950 dark:text-sky-100"
          >
            <span className="font-medium">{caseTypeLabel(caseRecord.caseType)}</span>
            <LifecycleBadge lifecycle={caseRecord.lifecycle} />
            <span className="opacity-80">{where}</span>
            <span className="opacity-60">
              opened {formatSourceTimestamp(caseRecord.openedAt).date}
            </span>
            {/*
              The escalation and the damage flag travel with the headline,
              because both change how the reply should be written and neither is
              visible anywhere else above the fold.
            */}
            {caseRecord.escalation === "escalated" && (
              <span className="opacity-80">· escalated</span>
            )}
            {caseRecord.damageReported && <span className="opacity-80">· damage reported</span>}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-sky-900/60 dark:text-sky-100/50">
        Full case detail is in the details column, under {CASES_HEADING}.
      </p>
    </section>
  );
}

export function ConversationCasesPanel({ cases }: { cases: ConversationCasesState }) {
  // Nothing is known yet. Not a list, not an all-clear, not a spinner that
  // would flip to the same sentence a moment later.
  if (cases.state === "loading") return null;

  if (cases.state === "unavailable") {
    return (
      <section data-testid="conversation-cases" className="flex flex-col gap-2">
        <SectionHeading>{CASES_HEADING}</SectionHeading>
        <p className="text-sm opacity-60">
          {caseEmptyStateText("unavailable", { hasNeverImportedStore: false })}
        </p>
      </section>
    );
  }

  const data = cases.data;

  /*
   * THIS MARKETPLACE HAS NO CASE SOURCE AT ALL — not an empty one, and not an
   * unimported one. Two of the five marketplaces are in that position, and a
   * section permanently reading "never imported" on their conversations would
   * be a standing caveat about data that is never going to arrive. Renders
   * nothing, which is the only honest rendering of "there is nothing to say".
   */
  if (data.coverage.covered === 0 && data.coverage.neverImported === 0) return null;

  const emptyText = caseEmptyStateText(data.state, {
    hasNeverImportedStore: data.coverage.neverImported > 0,
  });

  const openOrderCases = data.orderCases.filter((c) => caseNeedsAttention(c.lifecycle));
  const openCustomerCases = data.customerCases.filter((c) => caseNeedsAttention(c.lifecycle));
  const closedOrderCases = data.orderCases.filter((c) => !caseNeedsAttention(c.lifecycle));
  const closedCustomerCases = data.customerCases.filter((c) => !caseNeedsAttention(c.lifecycle));
  const closedCount = closedOrderCases.length + closedCustomerCases.length;

  return (
    /*
      ITS OWN FRAME, LIKE THE INTERNAL NOTES BLOCK AND UNLIKE THE PLAIN SECTIONS.
      The details column is a long run of unframed label/value sections, and a
      sixth one reading "Marketplace cases" disappeared into them — which is how
      a correct panel went unnoticed on a live screen. The sky tint and rail are
      the same vocabulary as the flag above the thread, so a reviewer who sees
      the flag knows exactly which block down here it belongs to.

      It frames only itself. No sibling section's markup, spacing or order
      changes because of it.
    */
    <section
      data-testid="conversation-cases"
      className="flex flex-col gap-2 rounded-lg border border-sky-500/30 border-l-4 border-l-sky-500 bg-sky-500/[0.05] p-3 dark:border-sky-300/25 dark:border-l-sky-400/70 dark:bg-sky-300/[0.05]"
    >
      <SectionHeading>{CASES_HEADING}</SectionHeading>

      {emptyText !== null && <p className="text-sm opacity-60">{emptyText}</p>}

      {/*
        THE LIVE ONES FIRST, AND THE SPLIT BETWEEN THEM IS THE POINT. A case on
        this order is about the message being answered; a case on another order
        is about the customer. Both are worth knowing and they are not the same
        fact, so they never share a list.
      */}
      {/*
        BOUNDED, AND IT SCROLLS INSIDE ITSELF.

        One buyer in the imported snapshot carries eight cases, and each renders
        as a block of up to ten labelled rows. Unbounded, that section alone
        would be longer than the whole rest of the column and would push the
        customer's reported details off the bottom — so the list takes a
        ceiling and its own scrollbar, exactly as the pinned note and the
        Repeat-Customer Warning do above the thread.

        `max-h-96` rather than a fixed height: a single case still renders at
        its natural size with no empty space and no scrollbar, and only a long
        list is capped.
      */}
      {(openOrderCases.length > 0 || openCustomerCases.length > 0) && (
        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          <CaseGroup heading={THIS_ORDER_HEADING} cases={openOrderCases} showOrderRef={false} />
          <CaseGroup heading={OTHER_ORDERS_HEADING} cases={openCustomerCases} showOrderRef />
        </div>
      )}

      {/*
        CLOSED CASES ARE KEPT, NOT DROPPED, AND KEPT OUT OF THE WAY. A finished
        return is context an agent sometimes needs and never needs first, and a
        buyer with eleven of them would otherwise push everything else off the
        panel. A plain <details>: the browser's own disclosure needs no state,
        no effect and no keyboard handling of ours.
      */}
      {closedCount > 0 && (
        <details className="mt-0.5">
          <summary className="cursor-pointer text-[11px] opacity-70 select-none">
            {closedCount === 1 ? "Show 1 closed case" : `Show ${closedCount} closed cases`}
          </summary>
          {/* Bounded for the same reason as the live list above, and
              separately: opening eight closed cases must not move the live ones
              off the screen a reviewer opened the disclosure from. */}
          <div className="mt-1.5 flex max-h-96 flex-col gap-2 overflow-y-auto">
            <CaseGroup
              heading={THIS_ORDER_HEADING}
              cases={closedOrderCases}
              showOrderRef={false}
            />
            <CaseGroup
              heading={OTHER_ORDERS_HEADING}
              cases={closedCustomerCases}
              showOrderRef
            />
          </div>
        </details>
      )}

      <CaseProvenance data={data} />
    </section>
  );
}
