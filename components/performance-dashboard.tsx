"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  Blocker,
  FilterDefinition,
  KpiDefinition,
} from "@/lib/domain/performance-metrics";

/**
 * Customer Service Insights.
 *
 * ------------------------------------------------------------------------
 * THE EMPTY TILES SAY WHY THEY ARE EMPTY
 * ------------------------------------------------------------------------
 * Three KPIs compute from verified data: messages handled, customer feedback
 * and unresolved cases. The rest are on the page anyway, each naming the
 * dependency that blocks it. A tile left off the page makes a requirement look
 * unrequested; a `0%` makes a missing measurement look like a measured absence,
 * and nobody chases a number that already appears to exist.
 *
 * The detail behind each absence lives once, in the collapsed limitations
 * section, rather than on seven card faces.
 *
 * ------------------------------------------------------------------------
 * MARKETPLACE-WIDE FIGURES ARE KEPT AWAY FROM PER-AGENT ONES
 * ------------------------------------------------------------------------
 * Contact rate, dissatisfaction and customer feedback are properties of a
 * marketplace over a period: no agent owns an order, and no feedback row
 * carries an agent. Placed in the same grid as a per-agent figure they read as
 * that agent's feedback. They get their own section, under their own heading,
 * saying so in words.
 */

type Availability =
  | { state: "available" }
  | { state: "unavailable"; blockers: readonly Blocker[] };

type AgentOption = { sourceUserId: number; displayName: string; active: boolean };

type Row = {
  sourceUserId: number | null;
  displayName: string | null;
  active: boolean | null;
  attributable: boolean;
  messagesHandled: number;
  conversations: number;
};

type FeedbackCounts = {
  positive: number;
  neutral: number;
  negative: number;
  total: number;
};

type Summary = {
  unresolvedCases: {
    supported: boolean;
    reason: string | null;
    counts: { total: number; resolved: number; reopened: number; withActivity: number };
    breakdown: {
      noRecordedResolution: number;
      observedUnresolved: number;
      noActivityRecord: number;
      coveragePercent: number | null;
    };
    marketplacesCovered: string[];
  };
  customerFeedback: {
    supported: boolean;
    reason: string | null;
    counts: FeedbackCounts;
    negativeSharePercent: number | null;
    denominator: string | null;
    marketplacesCovered: string[];
  };
  filters: { from: string; to: string; marketplace: string | null; agent: number | null };
  options: { marketplaces: string[]; agents: AgentOption[] };
  coverage: {
    marketplaces: string[];
    earliestDate: string | null;
    latestDate: string | null;
    agents: number;
  };
  readiness: { available: number; total: number };
  kpis: KpiDefinition[];
  filterDefinitions: FilterDefinition[];
  messagesHandled: {
    total: number;
    attributed: number;
    unattributed: number;
    rows: Row[];
  };
};

const PANEL =
  "rounded-lg border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-white/5";
const HEADING = "text-xs font-semibold uppercase tracking-wide opacity-60";
const FIELD =
  "rounded border border-black/15 bg-white px-2 py-1.5 text-sm dark:border-white/20 dark:bg-white/10";

const BLOCKER_LABEL: Record<Blocker["kind"], string> = {
  missing_data: "Missing data",
  not_imported: "Not yet imported",
  missing_definition: "Definition needed",
};

/**
 * The three blocker kinds are coloured apart because they mean different work.
 * "Not yet imported" is engineering that can start today; "definition needed"
 * cannot start at all; "missing data" is not an engineering task.
 */
const BLOCKER_TONE: Record<Blocker["kind"], string> = {
  missing_data: "bg-red-500/10 text-red-700 dark:text-red-300",
  not_imported: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  missing_definition: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

function BlockerNote({ blocker }: { blocker: Blocker }) {
  return (
    <li className="space-y-1">
      <span
        className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${BLOCKER_TONE[blocker.kind]}`}
      >
        {BLOCKER_LABEL[blocker.kind]}
      </span>
      <p className="text-xs leading-relaxed opacity-80">{blocker.detail}</p>
      {blocker.evidence ? (
        <p className="text-[11px] leading-relaxed opacity-55">{blocker.evidence}</p>
      ) : null}
    </li>
  );
}

/**
 * A KPI that cannot be computed.
 *
 * NO NUMBER AT ALL — not a zero, not a dash. And no explanation on the face
 * either: a short status says it is waiting, and the detail lives once, at the
 * bottom of the page, where it can be read deliberately instead of being
 * skimmed past seven times.
 */
function UnavailableTile({ kpi }: { kpi: KpiDefinition }) {
  return (
    <div className={`${PANEL} space-y-2`}>
      <h3 className="text-sm font-semibold">{kpi.label}</h3>
      <p className="text-sm opacity-50">Not available</p>
      {kpi.shortStatus ? (
        <p className="text-xs opacity-65">{kpi.shortStatus}</p>
      ) : null}
    </div>
  );
}

/**
 * Unresolved cases, as "no recorded resolution".
 *
 * THE HEADLINE IS NOT CALLED UNRESOLVED, and that is the point. Only eBay
 * records resolution activity, and even there 403 of 1,870 conversations carry
 * no activity at all — so the absence of a resolution is sometimes a backlog
 * and sometimes simply nothing observed. The split below says which is which
 * instead of presenting one figure as if it were the first.
 */
function UnresolvedTile({ unresolved }: { unresolved: Summary["unresolvedCases"] }) {
  if (!unresolved.supported) {
    return (
      <div className={`${PANEL} space-y-2`}>
        <h3 className="text-sm font-semibold">Unresolved cases</h3>
        <p className="text-sm opacity-50">Not available</p>
        <p className="text-xs opacity-65">{unresolved.reason}</p>
      </div>
    );
  }

  const { counts, breakdown } = unresolved;
  return (
    <div className={`${PANEL} space-y-3`}>
      <h3 className="text-sm font-semibold">Unresolved cases</h3>
      {counts.total === 0 ? (
        <p className="text-sm opacity-50">No conversations in this period</p>
      ) : (
        <>
          <p className="text-3xl font-semibold tabular-nums">
            {breakdown.noRecordedResolution.toLocaleString()}
          </p>
          <p className="text-xs opacity-70">
            no recorded resolution, of {counts.total.toLocaleString()} conversations
          </p>
          <div className="space-y-1 border-t border-black/5 pt-2 text-xs dark:border-white/10">
            <p className="opacity-80">
              {breakdown.observedUnresolved.toLocaleString()} observed and unresolved
            </p>
            <p className="opacity-60">
              {breakdown.noActivityRecord.toLocaleString()} with no activity recorded
            </p>
            <p className="opacity-60">
              {counts.resolved.toLocaleString()} resolved
              {counts.reopened > 0 ? ` · ${counts.reopened.toLocaleString()} reopened` : ""}
            </p>
          </div>
        </>
      )}
      <p className="text-[11px] opacity-55">
        eBay only
        {breakdown.coveragePercent === null
          ? ""
          : ` · ${breakdown.coveragePercent}% of conversations have any activity recorded`}
      </p>
    </div>
  );
}

/**
 * Customer feedback, from the marketplace source.
 *
 * THE SHARE IS LABELLED WITH ITS DENOMINATOR. "0.4% negative" invites the
 * reader to assume it is a share of orders, which it is not — most buyers never
 * leave feedback, so this denominator is far smaller and the percentage far
 * larger than a dissatisfaction rate would be. The counts are shown beside it.
 */
function FeedbackTile({ feedback }: { feedback: Summary["customerFeedback"] }) {
  if (!feedback.supported) {
    return (
      <div className={`${PANEL} space-y-2`}>
        <h3 className="text-sm font-semibold">Customer feedback</h3>
        <p className="text-sm opacity-50">Not available</p>
        <p className="text-xs opacity-65">{feedback.reason}</p>
      </div>
    );
  }

  const { counts, negativeSharePercent: share } = feedback;
  return (
    <div className={`${PANEL} space-y-3`}>
      <h3 className="text-sm font-semibold">Customer feedback</h3>
      {counts.total === 0 ? (
        /* No feedback is not zero negative feedback. */
        <p className="text-sm opacity-50">None received in this period</p>
      ) : (
        <>
          <p className="text-3xl font-semibold tabular-nums">
            {counts.total.toLocaleString()}
          </p>
          <div className="flex gap-3 text-xs">
            <span className="text-emerald-700 dark:text-emerald-300">
              {counts.positive.toLocaleString()} positive
            </span>
            <span className="opacity-70">{counts.neutral.toLocaleString()} neutral</span>
            <span className="text-red-700 dark:text-red-300">
              {counts.negative.toLocaleString()} negative
            </span>
          </div>
          <div className="border-t border-black/5 pt-2 dark:border-white/10">
            <p className="text-sm font-medium">
              {share === null ? "—" : `${share}% negative`}
            </p>
            <p className="text-[11px] opacity-55">{feedback.denominator}</p>
          </div>
        </>
      )}
      <p className="text-[11px] opacity-55">
        eBay only. Never attributed to an individual agent.
      </p>
    </div>
  );
}

function MessagesHandledTile({ summary }: { summary: Summary }) {
  const { total, attributed, unattributed } = summary.messagesHandled;
  return (
    <div className={`${PANEL} space-y-3`}>
      <div>
        <h3 className="text-sm font-semibold">Messages handled</h3>
        <p className="mt-1 text-xs opacity-60">
          Replies sent, by the agent who sent them.
        </p>
      </div>
      <p className="text-3xl font-semibold tabular-nums">{total.toLocaleString()}</p>
      <p className="text-xs opacity-70">
        {attributed.toLocaleString()} attributed to a named agent
        {unattributed > 0 ? (
          <>
            {" · "}
            <span className="opacity-90">
              {unattributed.toLocaleString()} unattributed
            </span>
          </>
        ) : null}
      </p>
      {/*
        A total from one marketplace under a filter offering five would read as
        the whole business. The coverage line is not a footnote; it is what makes
        the number true.
      */}
      <p className="border-t border-black/5 pt-3 text-[11px] leading-relaxed opacity-55 dark:border-white/10">
        Agent activity is recorded for {summary.coverage.marketplaces.join(", ") || "no marketplace"}{" "}
        only, {summary.coverage.earliestDate ?? "—"} to {summary.coverage.latestDate ?? "—"},
        across {summary.coverage.agents} agent ids. Amazon, B&Q and Temu record no agent
        activity at source.
      </p>
    </div>
  );
}

function AgentTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm opacity-60">No recorded activity in this period.</p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-black/10 text-left dark:border-white/15">
          <th className="py-2 font-medium">Agent</th>
          <th className="py-2 text-right font-medium">Messages handled</th>
          <th className="py-2 text-right font-medium">Conversations</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.sourceUserId ?? "none"}
            className="border-b border-black/5 last:border-0 dark:border-white/10"
          >
            <td className="py-2">
              {row.attributable ? (
                <>
                  <span>{row.displayName}</span>
                  {row.active === false ? (
                    <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-[11px] opacity-70 dark:bg-white/10">
                      inactive
                    </span>
                  ) : null}
                </>
              ) : (
                /*
                 * A shared login is not a person and is never given a name here.
                 * The id stays visible: the work happened, and an operator needs
                 * to know which account recorded it.
                 */
                <span className="opacity-70">
                  Unattributed
                  {row.sourceUserId !== null ? ` (account ${row.sourceUserId})` : ""}
                </span>
              )}
            </td>
            <td className="py-2 text-right tabular-nums">
              {row.messagesHandled.toLocaleString()}
            </td>
            <td className="py-2 text-right tabular-nums">
              {row.conversations.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Filters({
  summary,
  onChange,
  busy,
}: {
  summary: Summary;
  onChange: (next: Partial<Summary["filters"]>) => void;
  busy: boolean;
}) {
  const unavailable = summary.filterDefinitions.filter(
    (f) => (f.availability as Availability).state === "unavailable",
  );

  return (
    <div className={`${PANEL} space-y-4`}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className={HEADING}>From</span>
          <input
            type="date"
            className={`block ${FIELD}`}
            value={summary.filters.from}
            max={summary.filters.to}
            disabled={busy}
            onChange={(event) => onChange({ from: event.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className={HEADING}>To</span>
          <input
            type="date"
            className={`block ${FIELD}`}
            value={summary.filters.to}
            min={summary.filters.from}
            disabled={busy}
            onChange={(event) => onChange({ to: event.target.value })}
          />
        </label>
        <label className="space-y-1">
          <span className={HEADING}>Marketplace</span>
          <select
            className={`block ${FIELD}`}
            value={summary.filters.marketplace ?? ""}
            disabled={busy}
            onChange={(event) => onChange({ marketplace: event.target.value || null })}
          >
            <option value="">All with activity</option>
            {summary.options.marketplaces.map((marketplace) => (
              <option key={marketplace} value={marketplace}>
                {marketplace}
                {summary.coverage.marketplaces.includes(marketplace) ? "" : " — no agent data"}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className={HEADING}>Agent</span>
          <select
            className={`block ${FIELD}`}
            value={summary.filters.agent ?? ""}
            disabled={busy}
            onChange={(event) =>
              onChange({ agent: event.target.value ? Number(event.target.value) : null })
            }
          >
            <option value="">All agents</option>
            {summary.options.agents.map((agent) => (
              <option key={agent.sourceUserId} value={agent.sourceUserId}>
                {agent.displayName}
                {agent.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/*
        One line, not a wall. This used to end "see limitations below" and point
        at the `Limitations` panel; that panel is commented out at the bottom of
        this file for the demonstration, so the pointer is dropped rather than
        left aimed at nothing. Restore both together.
      */}
      {unavailable.length > 0 ? (
        <p className="border-t border-black/5 pt-3 text-xs opacity-60 dark:border-white/10">
          Not available: {unavailable.map((f) => f.label).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Every unresolved dependency, in one place, closed by default.
 *
 * It was previously spread across seven cards and a filter panel, which made
 * the page unreadable and buried the numbers that do work. Collapsing it is not
 * hiding it: a reader who wants to know why a tile is empty gets the full
 * measured reason, and a reader who wants the figures is no longer wading past
 * row counts to reach them.
 *
 * CURRENTLY PARKED, NOT DEAD. The render call is commented out at the bottom of
 * this file, with the reasoning beside it; the panel is kept whole so turning it
 * back on is uncommenting one line rather than rewriting it. The disable below
 * says that in the one place a reader checking the lint output will look —
 * deleting the component to silence the warning would throw away working code.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- parked, see above
function Limitations({ summary }: { summary: Summary }) {
  const blocked = [
    ...summary.kpis
      .filter((k) => (k.availability as Availability).state === "unavailable")
      .map((k) => ({ label: k.label, availability: k.availability as Availability })),
    ...summary.filterDefinitions
      .filter((f) => (f.availability as Availability).state === "unavailable")
      .map((f) => ({ label: `${f.label} filter`, availability: f.availability as Availability })),
  ];

  const notes = summary.filterDefinitions.filter((f) => f.coverageNote);

  return (
    <details className={PANEL}>
      <summary className="cursor-pointer text-sm font-medium">
        Limitations and unresolved dependencies ({blocked.length})
      </summary>
      <div className="mt-4 space-y-5">
        {blocked.map((entry) => (
          <div key={entry.label} className="space-y-2">
            <p className="text-sm font-medium">{entry.label}</p>
            <ul className="space-y-2">
              {entry.availability.state === "unavailable"
                ? entry.availability.blockers.map((blocker, index) => (
                    <BlockerNote key={index} blocker={blocker} />
                  ))
                : null}
            </ul>
          </div>
        ))}

        <div className="space-y-2 border-t border-black/5 pt-4 dark:border-white/10">
          <p className={HEADING}>Coverage of what does work</p>
          <ul className="space-y-1.5">
            {notes.map((filter) => (
              <li key={filter.key} className="text-xs leading-relaxed opacity-70">
                <span className="font-medium opacity-90">{filter.label}:</span>{" "}
                {filter.coverageNote}
              </li>
            ))}
            <li className="text-xs leading-relaxed opacity-70">
              <span className="font-medium opacity-90">Unresolved cases:</span> eBay only —
              no other marketplace records resolution activity. Measured on the latest
              recorded state, so a reopened conversation counts as unresolved. &quot;Not
              replied&quot; is not treated as a resolution, which makes the figure the larger
              one. Conversations with no activity recorded are shown separately rather than
              counted as a backlog.
            </li>
            <li className="text-xs leading-relaxed opacity-70">
              <span className="font-medium opacity-90">Customer feedback:</span> eBay only.
              Amazon records ratings 1–3 with no positive rating stored, so a sentiment
              breakdown there would misreport. Feedback carries no agent and is never
              attributed to one.
            </li>
          </ul>
        </div>
      </div>
    </details>
  );
}

export function PerformanceDashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [filters, setFilters] = useState<Partial<Summary["filters"]>>({});

  /**
   * No synchronous setState in here.
   *
   * `react-hooks/set-state-in-effect` rejects a state update in an effect's own
   * call stack, and it is right to: the busy flag used to be set here, which
   * made every filter change a cascading render. The flag is now raised by the
   * handler that changes the filters — the moment the user actually acts — and
   * lowered here once the request settles. Every update below happens after an
   * await, so the effect body itself sets nothing.
   */
  const load = useCallback(async (next: Partial<Summary["filters"]>) => {
    try {
      const query = new URLSearchParams();
      if (next.from) query.set("from", next.from);
      if (next.to) query.set("to", next.to);
      if (next.marketplace) query.set("marketplace", next.marketplace);
      if (next.agent != null) query.set("agent", String(next.agent));

      const response = await fetch(`/api/performance/summary?${query.toString()}`);
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "This dashboard is not available in this environment."
            : "Unable to load performance data.",
        );
      }
      setSummary((await response.json()) as Summary);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load performance data.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads from the API; state is set in the response handler
    void load(filters);
  }, [load, filters]);

  /** Raises the busy flag where the user acts, then lets the effect refetch. */
  const changeFilters = useCallback((next: Partial<Summary["filters"]>) => {
    setBusy(true);
    setError(null);
    setFilters((current) => ({ ...current, ...next }));
  }, []);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-6xl p-6">
        <p className="text-sm opacity-70">{error}</p>
      </main>
    );
  }
  if (!summary) {
    return (
      <main className="mx-auto w-full max-w-6xl p-6">
        <p className="text-sm opacity-60">Loading…</p>
      </main>
    );
  }

  const agentKpis = summary.kpis.filter((kpi) => kpi.scope === "agent");
  const marketplaceKpis = summary.kpis.filter((kpi) => kpi.scope === "marketplace");

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold">Customer Service Insights</h1>
        <p className="text-sm opacity-70">
          {summary.readiness.available} of {summary.readiness.total} KPIs use verified data.
          The rest name the dependency blocking them and show no figure.
        </p>
      </header>

      <Filters summary={summary} onChange={changeFilters} busy={busy} />

      <section className="space-y-3">
        <h2 className={HEADING}>Agent-attributed</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MessagesHandledTile summary={summary} />
          {agentKpis
            .filter((kpi) => kpi.key !== "messages_handled")
            .map((kpi) => (
              <UnavailableTile key={kpi.key} kpi={kpi} />
            ))}
        </div>
      </section>

      <section className={`${PANEL} space-y-3`}>
        <h2 className={HEADING}>Messages handled by agent</h2>
        <AgentTable rows={summary.messagesHandled.rows} />
      </section>

      <section className="space-y-3">
        <h2 className={HEADING}>Marketplace-wide</h2>
        <p className="text-xs opacity-60">
          These describe a marketplace over a period, never an individual. No agent owns an
          order, and no feedback record carries an agent.
        </p>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <FeedbackTile feedback={summary.customerFeedback} />
          <UnresolvedTile unresolved={summary.unresolvedCases} />
          {marketplaceKpis
            .filter((kpi) => kpi.key !== "customer_feedback" && kpi.key !== "unresolved_cases")
            .map((kpi) => (
              <UnavailableTile key={kpi.key} kpi={kpi} />
            ))}
        </div>
        {/*
          Said once, here, because the two are easily confused and the
          confusion flatters nobody: negative feedback share divides by
          feedback received, dissatisfaction would divide by orders placed.
        */}
        <p className="text-[11px] opacity-55">
          Negative feedback share is a share of feedback received, not of orders — it is not
          the buyer dissatisfaction rate.
        </p>
      </section>

      {/*
        HIDDEN FOR THE DEMONSTRATION, NOT DELETED.

        `Limitations` renders every unresolved dependency behind a collapsed
        `<details>`. It is commented out rather than removed so it comes back by
        deleting four lines, and so the reasons it carries are not quietly lost:
        six KPIs still cannot be computed, and the panel is where the page says
        so in full. The one-line "Not available:" summary above the filters is
        left in place, so the page still names what is missing — it just no
        longer offers the long explanation underneath.
      */}
      {/* <Limitations summary={summary} /> */}
    </main>
  );
}
