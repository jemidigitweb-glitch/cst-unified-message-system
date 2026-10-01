"use client";

import { PinIcon } from "./icons";
import type { CustomerHistoryState } from "./use-customer-history";

/**
 * The Repeat-Customer Warning, on the conversation it describes.
 *
 * ------------------------------------------------------------------------
 * IT NAMES RECORDS. IT NEVER CHARACTERISES A PERSON
 * ------------------------------------------------------------------------
 * Every sentence this renders states a count of verified records and what kind
 * of record it was. There is no risk score, no severity, no colour-coded band
 * and no adjective about the customer anywhere in this file.
 *
 * The words "high risk", "fraud", "abusive", "blacklisted" and "risk score"
 * are deliberately absent, and `tests/guards/repeat-customer-warning.test.ts`
 * fails the build if any of them appears in this file's code. A customer who
 * returned two faulty lamps and one who is acting in bad faith produce the
 * same rows in this data — so the interface must not let an agent read the
 * second from it.
 *
 * `role="note"`, not `role="alert"`. An alert interrupts and demands action;
 * this is context an agent reads before handling the message, which is also
 * why it does not steal focus.
 *
 * ------------------------------------------------------------------------
 * THE WORDING SAYS WHAT HAPPENED, AND NOTHING ABOUT WHY
 * ------------------------------------------------------------------------
 * This card used to print `Previously escalated cases: 1`, which is true and
 * tells an agent almost nothing. It now describes the record in service
 * language — "A previous item-not-received inquiry was escalated before this
 * conversation began."
 *
 * EVERY WORD IS DERIVED FROM A STORED FIELD. The count comes from
 * `count(DISTINCT source_case_id)`; the issue phrase comes from the stored
 * `event_type`, which migration 0021 CHECK-constrains to exactly
 * ITEM_NOT_RECEIVED / RETURN / PAYMENT_DISPUTE. There is no model, no
 * inference and no free text anywhere in the path.
 *
 * WHAT IS DELIBERATELY NOT SAID, because the data does not contain it: why a
 * refund happened, what a dispute was about, how any case was resolved,
 * whether anybody was at fault, or what the customer intended. An escalation
 * means the source recorded an escalation — not that the customer behaved
 * badly, and not that CST did.
 *
 * WHEN THE ISSUE TYPE IS NOT KNOWN the general sentence is used. An absent
 * type is never filled in with the most likely one.
 *
 * ------------------------------------------------------------------------
 * ONE SENTENCE PER TRIGGERED CONDITION, AND NO CASE COUNTED TWICE
 * ------------------------------------------------------------------------
 * Only the signals that crossed their threshold are sent, and each renders
 * once. The same case cannot appear under two sentences: a `cases` or
 * `payment_disputes` row always carries `escalation = 'not_recorded'` and only
 * an `inquiries` row can be `'escalated'`, so the record sets behind the
 * escalation, formal-case and dispute sentences are disjoint by construction.
 * Verified live: 0 rows are both escalated and from a formal-case table.
 *
 * ------------------------------------------------------------------------
 * SILENT UNLESS THERE IS SOMETHING VERIFIED TO SAY
 * ------------------------------------------------------------------------
 * Returns null while loading, when the lookup was unavailable, and when the
 * answer is a genuine no. All three render nothing — but they are different
 * states upstream and must stay different, because "we could not check" must
 * never be drawn as "we checked and it was clean". The absence of a card is
 * not a statement that a customer has no history.
 */

/** A rendered explanation: a short heading and the factual sentence under it. */
export type WarningLine = {
  readonly key: string;
  readonly heading: string;
  readonly sentence: string;
};

/**
 * The service-language phrase for a stored `event_type`.
 *
 * A fixed map, so a type nobody has written wording for falls through to the
 * general sentence rather than printing a raw identifier like
 * `ITEM_NOT_RECEIVED` at an agent. Measured live: escalated cases carry only
 * ITEM_NOT_RECEIVED (422) and RETURN (129), so both are covered — the fallback
 * exists for a future vocabulary change, not for today's data.
 */
const ISSUE_PHRASE: Readonly<Record<string, string>> = {
  ITEM_NOT_RECEIVED: "item-not-received",
  RETURN: "return",
};

/**
 * The one issue phrase shared by every record behind a reason, or null.
 *
 * Null when the source recorded no type, when a type has no wording, OR when
 * the records disagree — two escalations of different kinds cannot honestly be
 * described as one kind, and picking either would be a guess. The caller then
 * uses the general sentence, which is true of both.
 */
function sharedIssuePhrase(eventTypes: readonly string[] | undefined): string | null {
  if (eventTypes === undefined || eventTypes.length === 0) return null;
  const phrases = new Set(eventTypes.map((type) => ISSUE_PHRASE[type]));
  if (phrases.size !== 1) return null;
  const [only] = [...phrases];
  return only ?? null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Builds the explanation for one triggered reason, or null for a reason type
 * this build has no wording for.
 *
 * EXPORTED AND PURE so every branch is testable in this repository's test
 * environment, which is `node` with no DOM (see `vitest.config.mts`).
 */
export function explainReason(reason: {
  readonly type: string;
  readonly count: number;
  readonly eventTypes?: readonly string[];
}): WarningLine | null {
  const n = reason.count;

  switch (reason.type) {
    case "previous_contacts":
      return {
        key: reason.type,
        heading: "Earlier contact from this customer",
        sentence: `This customer has contacted CST in ${n} earlier ${plural(n, "conversation", "conversations")}.`,
      };

    case "previous_refunded_orders":
      return {
        key: reason.type,
        heading: "Earlier refunds recorded",
        // That a refund was recorded. Never why, and never that it was
        // unjustified — the data says neither.
        sentence: `${n} earlier ${plural(n, "order was", "orders were")} recorded as refunded.`,
      };

    case "previous_payment_dispute":
      return {
        key: reason.type,
        heading: "Previous payment dispute",
        sentence:
          n === 1
            ? "A previous payment dispute was recorded for this customer."
            : `${n} previous payment disputes were recorded for this customer.`,
      };

    case "previous_formal_case":
      return {
        key: reason.type,
        heading: "Previous formal case",
        sentence:
          n === 1
            ? "A previous formal marketplace case was recorded for this customer."
            : `${n} previous formal marketplace cases were recorded for this customer.`,
      };

    case "previous_escalation": {
      const issue = sharedIssuePhrase(reason.eventTypes);
      return {
        key: reason.type,
        heading: "Previous escalation recorded",
        sentence:
          issue === null
            ? // The general fallback: true whatever the issue was. Used when the
              // type is absent, unmapped, or mixed across the records.
              n === 1
              ? "This customer previously had a marketplace inquiry escalated before this conversation began."
              : `This customer previously had ${n} marketplace inquiries escalated before this conversation began.`
            : n === 1
              ? `A previous ${issue} inquiry was escalated before this conversation began.`
              : `${n} previous ${issue} inquiries were escalated before this conversation began.`,
      };
    }

    default:
      // A reason type this build has no wording for shows nothing, rather than
      // leaking an internal identifier into the interface.
      return null;
  }
}

/**
 * What the card should show, or null for "show nothing".
 *
 * Returns null for three different upstream states — loading, unavailable, and
 * a genuine no. All three mean "say nothing". They stay distinct in
 * `CustomerHistoryState` because only the third means the customer has no
 * qualifying history, and nothing downstream may conflate them.
 */
export function repeatCustomerWarningLines(
  history: CustomerHistoryState,
): readonly WarningLine[] | null {
  if (history.state !== "ready" || !history.warning) return null;

  const lines = history.reasons
    .map((reason) => explainReason(reason))
    .filter((line): line is WarningLine => line !== null);

  /*
   * A warning with no renderable explanation is not shown at all. It can only
   * happen if the server triggers on a reason type this build has no wording
   * for, and a bare heading with nothing under it tells an agent less than
   * nothing.
   */
  return lines.length === 0 ? null : lines;
}

export function RepeatCustomerWarning({ history }: { history: CustomerHistoryState }) {
  const lines = repeatCustomerWarningLines(history);
  if (lines === null) return null;

  const degraded = history.state === "ready" && history.unavailableSignals.length > 0;

  return (
    <section
      role="note"
      aria-label="Repeat-Customer Warning"
      data-testid="repeat-customer-warning"
      /*
       * `shrink-0`, as a sibling of the message scroller rather than a child of
       * it — the same position and the same reasoning as `PinnedInternalNotes`.
       * Inside the scroller it would be the first thing in the message list and
       * would scroll away the moment an agent moved down the thread, which is
       * exactly when the history is worth having.
       *
       * ------------------------------------------------------------------
       * PINNED, WITH A LEFT RAIL, AND DELIBERATELY NOT AMBER
       * ------------------------------------------------------------------
       * This was amber and sat directly above the amber pinned internal note,
       * so the two read as one block and an agent could not tell at a glance
       * which was a colleague's note and which was marketplace history.
       *
       * `border-l-4` is the fix: a left rail marks it as a pinned strip and
       * distinguishes it from the pinned note, which carries no rail. The tint
       * is a PASTEL rose rather than a saturated red — the card reports that
       * records exist, not that anything is wrong, and a strong red would make
       * a customer's second conversation look like an alarm.
       *
       * `max-h-32 overflow-y-auto` for the same reason the pinned note is
       * bounded: several triggered conditions must scroll inside this strip
       * rather than push the conversation off screen.
       */
      className="max-h-32 shrink-0 overflow-y-auto border-b border-l-4 border-b-rose-300/40 border-l-rose-300 bg-rose-50 px-5 py-2.5 dark:border-b-rose-400/25 dark:border-l-rose-400/70 dark:bg-rose-500/[0.08]"
    >
      {/*
        * The pin and the rail together say "this is pinned context", matching
        * the vocabulary the pinned internal note already established — same
        * icon, same uppercase label shape, different colour and a rail so the
        * two are never confused.
        */}
      <h3 className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase text-rose-900 dark:text-rose-200">
        <PinIcon />
        Repeat-Customer Warning
      </h3>
      {/*
        * ONE EXPLANATION PER TRIGGERED CONDITION. A badge an agent cannot
        * interrogate is a label, and a label about a customer with no evidence
        * attached is the thing this feature must not become.
        */}
      <dl className="space-y-1">
        {lines.map((line) => (
          <div key={line.key}>
            <dt className="text-xs font-medium text-rose-950 dark:text-rose-100">{line.heading}</dt>
            <dd className="text-xs text-rose-900/80 dark:text-rose-100/70">{line.sentence}</dd>
          </div>
        ))}
      </dl>
      {/*
        * DEGRADATION IS REPORTED, NOT HIDDEN. When a signal could not be read,
        * the agent is told the picture is partial rather than being left to
        * assume these records are everything. It never says which signal or
        * why — that is server detail — only that there is more that could not
        * be checked.
        */}
      {degraded && (
        <p className="mt-1.5 text-[11px] text-rose-900/60 dark:text-rose-100/50">
          Some history could not be checked, so this may be incomplete.
        </p>
      )}
      {/*
        * THE SCOPE, stated once rather than repeated in every sentence: these
        * are records from this storefront only. The "before this conversation"
        * half is carried by the sentences themselves.
        */}
      <p className="mt-1.5 text-[11px] opacity-55">
        Verified marketplace records from this storefront only.
      </p>
    </section>
  );
}
