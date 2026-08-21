"use client";

import { useEffect, useState } from "react";

/**
 * AI token usage.
 *
 * Accounting only — counts, models and an estimated cost. No prompt, no reply
 * and no customer text reaches this panel, so nothing on it is sensitive.
 *
 * The cost is the application's OWN estimate from a local rate table, not a
 * provider invoice, and the panel says so. A model absent from that table is
 * counted but not priced, and the unpriced count is shown rather than folded
 * into the total — a confident wrong number is harder to spot than a gap.
 */

type Summary = {
  calls: number;
  input_tokens: string;
  output_tokens: string;
  total_tokens: string;
  estimated_cost_usd: string;
  calls_without_price: number;
  calls_today: number;
  last_call_at: string | null;
};

type ByModel = {
  provider: string;
  model: string;
  calls: number;
  total_tokens: string;
  estimated_cost_usd: string;
};

const number = (value: string | number) => Number(value ?? 0).toLocaleString("en-GB");
const money = (value: string) => `$${Number(value ?? 0).toFixed(4)}`;

export function UsagePanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [byModel, setByModel] = useState<ByModel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/ai-usage");
        const data = (await response.json()) as { summary: Summary | null; byModel: ByModel[] };
        if (cancelled) return;
        setSummary(data.summary);
        setByModel(data.byModel ?? []);
      } catch {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="p-5 text-sm opacity-60">Reading usage…</p>;
  }

  if (summary === null || summary.calls === 0) {
    return (
      <div className="p-5">
        <p className="text-sm opacity-70">No AI usage recorded yet.</p>
        <p className="mt-1 text-xs opacity-55">
          A row is written each time a draft is generated.
        </p>
      </div>
    );
  }

  const cells: [string, string][] = [
    ["Drafts generated", number(summary.calls)],
    ["Last 24 hours", number(summary.calls_today)],
    ["Input tokens", number(summary.input_tokens)],
    ["Output tokens", number(summary.output_tokens)],
    ["Total tokens", number(summary.total_tokens)],
    ["Estimated cost", money(summary.estimated_cost_usd)],
  ];

  return (
    <div className="flex flex-col gap-5 p-5">
      <div>
        <h2 className="text-sm font-semibold">AI token usage</h2>
        <p className="mt-0.5 text-xs opacity-55">
          One record per draft generation. Counts only — no message content is stored here.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {cells.map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-emerald-600/20 bg-emerald-600/[0.08] px-3 py-2.5 dark:border-emerald-400/20 dark:bg-emerald-400/[0.08]"
          >
            <dt className="text-[11px] tracking-wide uppercase opacity-55">{label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {summary.calls_without_price > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {summary.calls_without_price} of {summary.calls} draft
          {summary.calls_without_price === 1 ? "" : "s"} used a model with no price in the local
          rate table, so its cost is not included in the total above.
        </p>
      )}

      <div>
        <p className="mb-1.5 text-[11px] font-medium tracking-wide uppercase opacity-55">
          By model
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left opacity-55">
              <tr>
                <th className="py-1 pr-3 font-medium">Provider</th>
                <th className="py-1 pr-3 font-medium">Model</th>
                <th className="py-1 pr-3 text-right font-medium">Drafts</th>
                <th className="py-1 pr-3 text-right font-medium">Tokens</th>
                <th className="py-1 text-right font-medium">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((row) => (
                <tr key={`${row.provider}:${row.model}`} className="border-t border-black/5 dark:border-white/10">
                  <td className="py-1.5 pr-3">{row.provider}</td>
                  <td className="py-1.5 pr-3 font-mono text-[11px]">{row.model}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{number(row.calls)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{number(row.total_tokens)}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(row.estimated_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] opacity-50">
        Cost is this application&rsquo;s estimate from a local rate table, not a provider invoice.
        {summary.last_call_at !== null && ` Last draft: ${summary.last_call_at.slice(0, 16).replace("T", " ")}.`}
      </p>
    </div>
  );
}
