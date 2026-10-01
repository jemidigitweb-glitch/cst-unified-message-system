"use client";

import type { CustomerHistoryState } from "./use-customer-history";

/**
 * The Repeat-Customer Warning, on the conversation it describes.
 *
 * ------------------------------------------------------------------------
 * IT NAMES RECORDS. IT NEVER CHARACTERISES A PERSON
 * ------------------------------------------------------------------------
 * Every line this renders is a count of verified records with the record type
 * named: "Previous conversations: 3". There is no risk score, no severity, no
 * colour-coded band and no adjective about the customer anywhere in this file.
 *
 * The words "high risk", "fraud", "abusive", "blacklisted" and "risk score"
 * are deliberately absent, and `tests/guards/repeat-customer-warning.test.ts`
 * fails the build if any of them appears here. A customer who returned two
 * faulty lamps and one who is acting in bad faith produce the same rows in
 * this data — so the interface must not let an agent read the second from it.
 *
 * `role="note"`, not `role="alert"`. An alert interrupts and demands action;
 * this is context an agent reads before handling the message, which is also
 * why it does not steal focus.
 *
 * ------------------------------------------------------------------------
 * ONLY TRIGGERED REASONS APPEAR. NOTHING RENDERS AS ZERO
 * ------------------------------------------------------------------------
 * The server sends only the signals that crossed their threshold, and this
 * renders exactly those. A customer with one previous conversation and two
 * refunds shows the refunds line and no conversations line — not
 * "Previous conversations: 1", which would read as a reason when it is not
 * one, and not "Previous conversations: 0", which would be a claim about a
 * signal nobody asked about.
 *
 * ------------------------------------------------------------------------
 * SILENT UNLESS THERE IS SOMETHING VERIFIED TO SAY
 * ------------------------------------------------------------------------
 * Returns null while loading, when the lookup was unavailable, and when the
 * answer is a genuine no. All three render nothing — but they are different
 * states upstream and must stay different, because "we could not check" must
 * never be drawn as "we checked and it was clean". The absence of a badge is
 * not a statement that a customer has no history.
 */

/**
 * The agent-facing wording for each reason type.
 *
 * A fixed map, not a formatter: the server sends a type name and this decides
 * the words, so a new reason type that nobody has written copy for renders as
 * nothing rather than as a raw identifier like `previous_payment_dispute`.
 */
export const REASON_LABELS: Readonly<Record<string, string>> = {
  previous_contacts: "Previous conversations",
  previous_refunded_orders: "Previous refunded orders",
  previous_formal_case: "Previous formal cases",
  previous_payment_dispute: "Previous payment disputes",
  previous_escalation: "Previously escalated cases",
};

export type WarningLine = { readonly label: string; readonly count: number };

/**
 * What the card should show, or null for "show nothing".
 *
 * EXPORTED AND PURE so the rendering decision is testable in this repository's
 * test environment, which is `node` with no DOM — see `vitest.config.mts`.
 * Every branch that decides whether an agent sees a warning lives in this
 * function rather than inside JSX, so a test can assert the behaviour directly
 * instead of asserting the shape of markup.
 *
 * Returns null for three different upstream states — loading, unavailable, and
 * a genuine no — and that is correct: all three mean "say nothing". They stay
 * distinct in `CustomerHistoryState` because only the third one means the
 * customer has no qualifying history, and nothing downstream may conflate them.
 */
export function repeatCustomerWarningLines(
  history: CustomerHistoryState,
): readonly WarningLine[] | null {
  if (history.state !== "ready" || !history.warning) return null;

  const lines = history.reasons
    .map((reason) => ({ label: REASON_LABELS[reason.type], count: reason.count }))
    .filter((line): line is WarningLine => line.label !== undefined);

  /*
   * A warning with no renderable reason is not shown at all. It can only
   * happen if the server triggers on a reason type this build has no copy for,
   * and a bare heading with nothing under it tells an agent less than nothing.
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
       * Amber, matching the existing customer-note card. Not red: red is for
       * something wrong, and a customer having contacted before is not.
       */
      className="shrink-0 border-b border-amber-500/30 bg-amber-500/[0.07] px-5 py-2.5"
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-wide opacity-70">
        Repeat-Customer Warning
      </h3>
      {/*
        * The factual reasons, which are the whole point: a badge an agent
        * cannot interrogate is a label, and a label about a customer with no
        * evidence attached is the thing this feature must not become.
        */}
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
        {lines.map((line) => (
          <li key={line.label} className="text-xs opacity-80">
            {line.label}: <span className="font-medium">{line.count}</span>
          </li>
        ))}
      </ul>
      {/*
        * DEGRADATION IS REPORTED, NOT HIDDEN. When a signal could not be read,
        * the agent is told the picture is partial rather than being left to
        * assume these counts are everything. It never says which signal or why
        * — that is server detail — only that there is more that could not be
        * checked.
        */}
      {degraded && (
        <p className="mt-1 text-[11px] opacity-55">
          Some history could not be checked, so this may be incomplete.
        </p>
      )}
      {/*
        * WHAT THE COUNTS MEAN, in one line, because the boundary is not
        * obvious and an agent acting on the number deserves to know it: these
        * are records that existed before this conversation started, on this
        * storefront only.
        */}
      <p className="mt-1 text-[11px] opacity-55">
        Records on this storefront from before this conversation began.
      </p>
    </section>
  );
}
