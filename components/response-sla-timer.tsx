import {
  type ResponseSlaStatus,
  SLA_NOT_CONFIGURED_TEXT,
  SLA_UNKNOWN_START_TEXT,
  formatDuration,
  formatSlaDueAt,
  isSlaCritical,
} from "@/lib/domain/response-sla";

/**
 * The RESPONSE SLA panel: due time, time left, and the escalation banner.
 *
 * ------------------------------------------------------------------------
 * FOUR STATES, AND EVERY ONE OF THEM SAYS SOMETHING TRUE
 * ------------------------------------------------------------------------
 *   not_configured         no approved duration exists. Says so, in words,
 *                          rather than showing a zero or a dash that a reader
 *                          would take for "no time left".
 *   unknown_received_time  a duration exists but the arrival instant does not.
 *                          Also said in words, and also NOT red.
 *   within                 due time + time left.
 *   expired                due time + time expired + CRITICAL / ESCALATE.
 *
 * AN ABSENCE IS NEVER RED. Colouring "we do not have a target" as a breach
 * would put an escalation banner on every urgent conversation the day this
 * ships, and a warning everything wears is a warning nobody reads. Only
 * `expired` is critical — see `isSlaCritical`.
 *
 * IT IS A DISPLAY. No button, no handler, no href: a timer running out is a
 * reason for an agent to act in the systems that can act, and nothing here can
 * cancel an order, hold a dispatch or message anybody.
 *
 * `now` IS A PROP, not a clock read. This component is a pure function of what
 * it is given, so its overdue state can be tested without freezing time, and so
 * a server render and a client render of the same moment agree.
 */

const PANEL_CLASS =
  "flex flex-col gap-1 rounded-md border px-2.5 py-2 text-[11px] leading-tight";

const HEADING_CLASS = "text-[10px] font-bold tracking-widest uppercase opacity-70";

/** One "label / value" line. */
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className="opacity-70">{label}</span>
      <span className={`tabular-nums ${strong ? "font-bold" : "font-medium"}`}>{value}</span>
    </span>
  );
}

export function ResponseSlaTimer({ status }: { status: ResponseSlaStatus }) {
  const critical = isSlaCritical(status);

  /*
   * Red only for a real breach; a quiet neutral frame otherwise. The border and
   * the text move together so the panel reads as one object in both themes.
   */
  const toneClass = critical
    ? "border-red-600 bg-red-600/10 text-red-800 dark:border-red-500 dark:bg-red-500/15 dark:text-red-200"
    : "border-black/10 bg-black/[0.03] dark:border-white/15 dark:bg-white/[0.06]";

  return (
    <div className={`${PANEL_CLASS} ${toneClass}`} role="group" aria-label="Response SLA">
      <span className={HEADING_CLASS}>Response SLA</span>

      {status.state === "not_configured" && (
        <span className="opacity-80">{SLA_NOT_CONFIGURED_TEXT}</span>
      )}

      {status.state === "unknown_received_time" && (
        <span className="opacity-80">{SLA_UNKNOWN_START_TEXT}</span>
      )}

      {status.state === "within" && (
        <>
          <Row label="Due" value={formatSlaDueAt(status.dueAt)} />
          <Row label="Time left" value={formatDuration(status.minutesLeft)} strong />
        </>
      )}

      {status.state === "expired" && (
        <>
          <Row label="Due" value={formatSlaDueAt(status.dueAt)} />
          <Row label="Time expired" value={formatDuration(status.minutesOver)} strong />
          {/*
           * The escalation banner. It states the overdue duration a SECOND time
           * on purpose: the row above is a field a reader scans, and this is the
           * sentence they act on — an agent who reads only the red bar still
           * learns how late it is.
           */}
          <span className="mt-0.5 inline-flex items-center gap-1.5 rounded-sm bg-red-600 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase dark:bg-red-500">
            Critical · Escalate
            <span className="font-semibold normal-case opacity-90">
              {formatDuration(status.minutesOver)} overdue
            </span>
          </span>
        </>
      )}
    </div>
  );
}
