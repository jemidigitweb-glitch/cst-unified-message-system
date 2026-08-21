"use client";

import { useEffect, useState } from "react";

/**
 * What the draft cost, and which CST rules it was built from.
 *
 * Sits under the context panel, because both answer "can I trust this draft?"
 * — one from the conversation's side, one from the model's.
 *
 * NOTHING HERE IS COMPUTED. The token counts are read back from
 * `ai_usage_log`, written once at generation time, rather than counted a
 * second time; two counts would eventually be two different answers. The rules
 * are the citations the generator actually stored, resolved against the corpus
 * — a rule the model did not cite cannot appear, and one it invented was
 * already dropped before storage.
 *
 * NO INTERNAL IDENTIFIERS. Refs like `RETREF-GFR-9` and workbook names are
 * audit keys; they travel in the export, never onto the screen.
 */

type RuleEvidence = {
  ref: string;
  title: string;
  displayTitle: string;
  category: string | null;
  text: string;
  sourceFile: string | null;
  sourceSheet: string | null;
  sourceRow: number | null;
};

type Payload = {
  conversationId: string;
  marketplace: string | null;
  counterpartyRef: string | null;
  lastCustomerMessageAt: string | null;
  revision?: number;
  model?: string | null;
  rulesAvailable?: boolean;
  usage: {
    provider: string;
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    estimated_cost_usd: string | null;
  } | null;
  evidence: {
    cited: RuleEvidence[];
    unresolved: string[];
    legacy: string[];
    rulesSupplied: number;
    documents: string[];
  } | null;
};

const number = (value: number | null) =>
  value === null ? "not recorded" : value.toLocaleString("en-GB");

/**
 * Why a rule applies, taken from the rule itself.
 *
 * The retrieval step does not report a reason, and inventing one would be
 * exactly the fabrication the whole grounding design exists to prevent. So the
 * "reason" is the rule's own condition — the sentence the document opens with,
 * such as "Customer claims wrong colour received". That is genuine retrieved
 * evidence, and it is what a person would point at when asked why it matched.
 */
function conditionOf(rule: RuleEvidence): string | null {
  const lines = rule.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const condition = lines.find((line) => line !== rule.displayTitle);
  if (condition === undefined) return null;
  const cleaned = condition.replace(
    /^(KEY RULE \/ ACTION|KEY RULE|ACTION|DO NOT|DO|NEVER SAY|SAY INSTEAD):\s*/i,
    "",
  );
  return cleaned.length > 150 ? `${cleaned.slice(0, 147)}…` : cleaned;
}

export function DraftEvidencePanel({ conversationId }: { conversationId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * No synchronous reset here. The parent gives this component a `key` of the
   * conversation id, so switching conversations remounts it and the initial
   * state is already empty -- which is both cheaper than clearing state on
   * every render pass and free of the cascading render the lint rule guards
   * against. Every update below happens after an await.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/draft/evidence`);
        if (!response.ok) throw new Error("request failed");
        const payload = (await response.json()) as Payload;
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (loading || data === null || data.evidence === null) return null;

  const cited = data.evidence.cited;

  /** The audit keys travel here and only here. */
  const exportRules = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      conversationId: data.conversationId,
      marketplace: data.marketplace,
      customerReference: data.counterpartyRef,
      lastCustomerMessageAt: data.lastCustomerMessageAt,
      draftRevision: data.revision ?? null,
      model: data.usage?.model ?? data.model ?? null,
      provider: data.usage?.provider ?? null,
      usage: data.usage,
      rulesSupplied: data.evidence!.rulesSupplied,
      matchedRules: cited.map((rule) => ({
        area: rule.category,
        title: rule.displayTitle,
        condition: conditionOf(rule),
        ruleText: rule.text,
        reference: rule.ref,
        sourceDocument: rule.sourceFile,
        sourceSheet: rule.sourceSheet,
        sourceRow: rule.sourceRow,
      })),
      unresolvedReferences: data.evidence!.unresolved,
      // Stated explicitly rather than left as an empty array to interpret. A
      // draft that matched no rule is the one most worth exporting, and the
      // export should say so in as many words.
      noRulesMatched: cited.length === 0,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cst-rules-conversation-${data.conversationId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4 border-t border-black/10 p-4 dark:border-white/15">
      {data.usage !== null && (
        <section>
          <p className="mb-1.5 text-[11px] font-medium tracking-wide uppercase opacity-55">
            AI usage
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="opacity-55">Provider</dt>
            <dd className="text-right">{data.usage.provider}</dd>
            <dt className="opacity-55">Model</dt>
            <dd className="truncate text-right font-mono text-[11px]">{data.usage.model}</dd>
            <dt className="opacity-55">Input</dt>
            <dd className="text-right tabular-nums">{number(data.usage.input_tokens)}</dd>
            <dt className="opacity-55">Output</dt>
            <dd className="text-right tabular-nums">{number(data.usage.output_tokens)}</dd>
            <dt className="opacity-55">Total</dt>
            <dd className="text-right font-medium tabular-nums">
              {number(data.usage.total_tokens)}
            </dd>
            {/* Omitted rather than shown as $0 when the model has no local
                price: a confident zero is harder to notice than a gap. */}
            {data.usage.estimated_cost_usd !== null && (
              <>
                <dt className="opacity-55">Est. cost</dt>
                <dd className="text-right tabular-nums">
                  ${Number(data.usage.estimated_cost_usd).toFixed(4)}
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

      <section>
        <p className="mb-1.5 text-[11px] font-medium tracking-wide uppercase opacity-55">
          Matched CST rules
        </p>
        {cited.length === 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            No CST rule matched this draft. Export it and check the reply against the
            documents before use.
          </p>
        ) : (
          <>
          <ul className="flex flex-col gap-2 text-xs">
            {cited.map((rule) => {
              const condition = conditionOf(rule);
              return (
                <li key={rule.ref}>
                  <p className="font-medium text-emerald-800 dark:text-emerald-200">
                    <span aria-hidden className="mr-1">
                      ✓
                    </span>
                    {rule.category ?? "CST rules"}
                  </p>
                  <p className="ml-4 opacity-80">{rule.displayTitle}</p>
                  {condition !== null && (
                    <p className="ml-4 mt-0.5 opacity-55">Matched: {condition}</p>
                  )}
                </li>
              );
            })}
          </ul>

          </>
        )}

        {/* Outside the conditional above: an unmatched draft is precisely the
            one a reviewer needs to export for someone else to look at. */}
        <button
          type="button"
          onClick={exportRules}
          className="mt-3 rounded-full border border-black/15 px-3 py-1.5 text-xs font-medium transition-colors hover:border-emerald-600/40 hover:bg-emerald-600/[0.10] dark:border-white/20"
        >
          {cited.length === 0 ? "Export conversation (JSON)" : "Export rules (JSON)"}
        </button>
      </section>
    </div>
  );
}
