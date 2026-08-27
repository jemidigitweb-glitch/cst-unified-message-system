"use client";

import { useEffect, useState } from "react";

import { formatDuration } from "@/lib/domain/duration";
import type { ConversationDetail } from "@/lib/domain/inbox";
import { matchReasonOf } from "@/lib/knowledge/rule-evidence";

import { ConversationExportButton } from "./conversation-export-button";
import { SECTION_HEADING_CLASS } from "./context-panel";
import { NoRuleFlag } from "./no-rule-flag";

/**
 * What the draft cost, and which CST rules it was built from.
 *
 * Sits under the context panel, because both answer "can I trust this draft?"
 * — one from the conversation's side, one from the model's. The order is fixed
 * and marketplace-independent: Status, Context, AI usage, Matched CST rules.
 *
 * ONE PANEL FOR EVERY MARKETPLACE. There is no per-marketplace branch here and
 * there must not be one. What a source can prove differs between marketplaces
 * and is expressed by the capability flags in the panes above; what a draft
 * cost and which rules it cited are facts about the DRAFT, and a draft is
 * generated the same way whichever tab it was started from. A reviewer moving
 * between tabs should be reading different data in the same shape.
 *
 * NOTHING HERE IS COMPUTED. The token counts are read back from
 * `ai_usage_log`, written once at generation time, rather than counted a
 * second time; two counts would eventually be two different answers. The rules
 * are the citations the generator actually stored, resolved against the corpus
 * — a rule the model did not cite cannot appear, and one it invented was
 * already dropped before storage.
 *
 * EVERY CITED RULE IS SHOWN. No cap, no "top match", no truncation. A reply is
 * frequently governed by several areas at once — Admin and Message Handling and
 * Returns — and showing one of them would misrepresent what the draft was
 * written against.
 *
 * NO INTERNAL IDENTIFIERS. Refs like `RETREF-GFR-9`, workbook names, sheets and
 * rows are audit keys. They stay on the record and never reach the screen.
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

/** The shape the evidence endpoint returns. */
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
    duration_ms: number | null;
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

/** Shared so the loading state and the loaded state cannot drift apart. */
/** The same one colour every sidebar heading uses — see `SECTION_HEADING_CLASS`. */
function Heading({ children }: { children: string }) {
  return (
    <p
      className={`mb-1.5 text-[11px] font-medium tracking-wide uppercase ${SECTION_HEADING_CLASS}`}
    >
      {children}
    </p>
  );
}

export function DraftEvidencePanel({
  conversationId,
  detail,
}: {
  conversationId: string;
  /**
   * The loaded thread, for the no-rule export.
   *
   * Passed rather than fetched: the workspace already holds it and is already
   * rendering it, so a second request would ask the database for a thread that
   * is on screen.
   */
  detail: ConversationDetail;
}) {
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

  /**
   * The headings appear at once; only their values wait for the request.
   *
   * Rendering nothing while the fetch was in flight made the two sections look
   * like they arrived late, or not at all — a reviewer who looked at the
   * sidebar before the response landed saw an empty column and had no reason
   * to think anything was coming.
   */
  if (loading) {
    return (
      <div className="flex flex-col gap-4 border-t border-black/10 p-4 dark:border-white/15">
        <Heading>AI usage</Heading>
        <Heading>Matched CST rules</Heading>
        <p className="-mt-3 text-xs opacity-45">Loading…</p>
      </div>
    );
  }

  if (data === null || data.evidence === null) return null;

  const cited = data.evidence.cited;

  return (
    <div className="flex flex-col gap-4 border-t border-black/10 p-4 dark:border-white/15">
      {/*
       * A one-line answer to the first question a reviewer has before reading
       * anything else here: did this conversation actually get a draft? The
       * rest of the panel (tokens, cited rules) only renders once that is
       * already true — see the `data.evidence === null` early return above —
       * so this line states a fact already guaranteed, it does not compute one.
       */}
      <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
        <span aria-hidden className="mr-1">
          ✓
        </span>
        Draft generated
      </p>

      {data.usage !== null && (
        <section>
          <Heading>AI Usage</Heading>
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
            {/* The MEASURED wall-clock time of the whole generation --
                retrieval, the model call, validation and the save. Shown
                beside the tokens because both answer "what did this cost".
                A draft written before timing existed says so. */}
            <dt className="opacity-55">Generation time</dt>
            <dd className="text-right tabular-nums">
              {formatDuration(data.usage.duration_ms)}
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
        {/* Not "Matched CST rules" when none matched: a heading that promises
            matches above a flag saying there are none reads as a loading
            state. */}
        <Heading>{cited.length === 0 ? "CST rule coverage" : "CST Rules Used"}</Heading>
        {cited.length === 0 ? (
          /*
           * The ONLY place the export is offered. It belongs to this case and
           * to no other: the file exists so the team can write the rule that
           * was missing, which is a question only an unmatched conversation
           * raises.
           */
          <NoRuleFlag messages={detail.messages}>
            <ConversationExportButton detail={detail} />
          </NoRuleFlag>
        ) : (
          /*
           * Every cited rule, in citation order, with no export beside them.
           * `cited` is mapped whole — there is no slice and no cap, so several
           * areas governing one reply all appear.
           */
          <ul className="flex flex-col gap-2 text-xs">
            {cited.map((rule) => {
              const reason = matchReasonOf(rule);
              return (
                <li key={rule.ref}>
                  <p className="font-medium text-emerald-800 dark:text-emerald-200">
                    <span aria-hidden className="mr-1">
                      ✓
                    </span>
                    {rule.category ?? "CST rules"}
                  </p>
                  <p className="ml-4 opacity-80">{rule.displayTitle}</p>
                  {reason !== null && <p className="ml-4 mt-0.5 opacity-55">Matched: {reason}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
