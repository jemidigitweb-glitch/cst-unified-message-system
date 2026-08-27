"use client";

import { useCallback, useEffect, useState } from "react";

import type { DraftSource } from "@/lib/domain/draft";
import { workflowLabel } from "@/lib/domain/inbox";
import type { ConversationDetail } from "@/lib/domain/inbox";
import type { WorkflowState } from "@/lib/domain/workflow";

import { ConversationExportButton } from "./conversation-export-button";
import { NoRuleFlag } from "./no-rule-flag";

/**
 * Draft reply panel.
 *
 * Generate, edit, regenerate, save, mark reviewed — and then it stops. There is
 * deliberately no control that transmits a reply, copies one to a marketplace,
 * or hands off to anything: the workflow terminates at `reviewed`, and this
 * panel is the last thing in it.
 *
 * ONE THING AT A TIME. The panel previously opened on an empty textarea with
 * every control enabled, which asked the reviewer to decide what to do before
 * there was anything to decide about. Now there are three states and each shows
 * only what belongs to it:
 *
 *   empty       a single Generate Reply button
 *   generating  an indicator that something is happening
 *   draft       the draft as text, with the actions that apply to a draft
 *
 * Editing is a mode, not the default. The draft reads as prose until the
 * reviewer chooses to change it, because most drafts are read and accepted
 * rather than rewritten, and a textarea invites rewriting.
 *
 * PROVENANCE IS KEPT, BUT NOT IN THE WAY. Citations and gaps used to sit under
 * every draft. Reading a reply and reading an audit trail are different jobs,
 * and doing both at once made the panel about the machinery rather than the
 * reply. The trail now lives behind "Show the CST rules this used" — closed by
 * default, one click away, and fetched only when opened. Nothing is lost: the
 * citations are still validated against the corpus and still stored on every
 * revision.
 */

type RuleEvidence = {
  ref: string;
  /** Internal identifier. Audit only — must not be rendered. */
  title: string;
  /** What a CST user reads. */
  displayTitle: string;
  category: string | null;
  text: string;
  sourceFile: string | null;
  sourceSheet: string | null;
  sourceRow: number | null;
};

type EvidencePayload = {
  rulesAvailable?: boolean;
  evidence: {
    cited: RuleEvidence[];
    /** Current-format refs the documents no longer contain. An audit finding. */
    unresolved: string[];
    /** Refs from before the reference scheme changed. Says nothing about the documents. */
    legacy: string[];
    rulesSupplied: number;
    documents: string[];
  } | null;
};

type DraftRevision = {
  revision: number;
  origin: "generated" | "edited";
  bodyText: string;
  requiresReview: boolean;
  missingInformation: string[];
  model: string | null;
  createdAt: string;
  sources: DraftSource[];
};

type DraftPayload = {
  draft: { currentRevision: number; revisions: DraftRevision[] } | null;
  /**
   * The stored finding that the rule base could not ground a reply here.
   *
   * Read back with the draft so a refused conversation reads the same on reopen
   * as it did when it was refused. Without it, "we will not draft this" and
   * "nobody has tried yet" look identical, and the obvious next move is to
   * click Generate and buy the same refusal again.
   */
  ruleAnalysis?: { outcome: string; case_type: string | null } | null;
  storeReady?: boolean;
};

/**
 * What the panel says while it waits.
 *
 * The API is a single request, so these are advanced on a timer rather than
 * reported by the server. They are deliberately playful rather than a literal
 * progress report — the honest alternative would be one unchanging line, and a
 * fake percentage would be worse than either.
 *
 * They do still track the real order of work: the thread, then the rules, then
 * the order and product checks, then the draft itself.
 */
const STEPS = [
  "Locked in…",
  "Reading the room…",
  "Fact-checking, no cap…",
  "Finishing touches…",
] as const;

/** Roughly when each step starts, in milliseconds after the click. */
const STEP_AT = [0, 600, 1400, 2400] as const;

function GeneratingIndicator({ step }: { step: number }) {
  return (
    <div
      data-testid="draft-generating"
      className="flex animate-[fadeIn_.25s_ease-out] flex-col items-center gap-3 rounded-xl border border-emerald-600/20 bg-emerald-600/15 dark:bg-emerald-400/15 px-4 py-9"
    >
      <div className="flex items-center gap-2" aria-hidden>
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-2.5 w-2.5 animate-bounce rounded-full bg-emerald-700/60 dark:bg-emerald-300/70"
            style={{ animationDelay: `${index * 0.15}s` }}
          />
        ))}
      </div>
      <p
        data-testid="draft-generating-step"
        key={step}
        className="animate-[fadeIn_.3s_ease-out] text-sm font-semibold text-emerald-800 dark:text-emerald-200"
        role="status"
        aria-live="polite"
      >
        {STEPS[Math.min(step, STEPS.length - 1)]}
      </p>
    </div>
  );
}

/**
 * The generate request's query string.
 *
 * Built in one place so the two parameters cannot disagree about separators,
 * and so a null selection provably contributes nothing: with no pick and no
 * force this returns the empty string, exactly the URL used before selection
 * existed.
 */
function generateQuery(force: boolean, selectedOrderNumber: string | null): string {
  const params = new URLSearchParams();
  if (force) params.set("force", "1");
  if (selectedOrderNumber !== null) params.set("selectedOrder", selectedOrderNumber);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export function DraftPanel({
  conversationId,
  detail,
  workflowState,
  onWorkflowChange,
  onGenerated,
  selectedOrderNumber,
}: {
  conversationId: string;
  /**
   * The loaded thread.
   *
   * Read for two things only: naming the case type on a refused conversation,
   * and writing the export file. Neither needs a request of its own, because
   * the view above already holds this.
   */
  detail: ConversationDetail;
  workflowState: WorkflowState;
  onWorkflowChange: (state: WorkflowState) => void;
  /**
   * Fired after a draft is generated AND saved.
   *
   * The sidebar's usage figures and rule list describe the revision that just
   * landed, so it is told from this same successful flow — a reviewer should
   * never have to reload to see what the draft they are looking at cost.
   */
  onGenerated?: () => void;
  /**
   * The order a reviewer picked in the sidebar when several matched.
   *
   * Sent with the generate request and nowhere else: it grounds that one
   * generation and is re-validated server-side against the orders this
   * conversation actually matched. Null -- no pick, or only one order matched
   * -- sends nothing and leaves the request byte-identical to before.
   */
  selectedOrderNumber: string | null;
}) {
  const [revisions, setRevisions] = useState<DraftRevision[] | null>(null);
  const [bodyText, setBodyText] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "generating" | "saving" | "reviewing">(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidencePayload | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  /**
   * Display only — whether the "Based on CST rules" list is expanded.
   *
   * Starts closed, by request: a reviewer opens it when they want to check
   * the rules, rather than always seeing the full list before they have
   * asked for it. This only changes what is rendered on first paint — it
   * does not change when or how the rules are fetched, validated, or which
   * ones appear once opened.
   */
  const [rulesExpanded, setRulesExpanded] = useState(false);
  /**
   * Set when the server REFUSED to generate: no approved rule could ground a
   * reply, so it wrote none. Held here rather than derived from the absence of
   * a draft, because "never generated" and "refused" are different states and
   * only the second one has something to say.
   */
  const [noApplicableRule, setNoApplicableRule] = useState(false);

  /**
   * Reads the stored draft.
   *
   * `signal` lets the effect below drop a response that arrived after the
   * reviewer moved to another conversation. Without it, a slow request for the
   * old thread can overwrite the new thread's draft — rare, but it puts one
   * customer's draft under another's conversation, which is the worst version
   * of this bug.
   */
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/draft`, { signal });
        if (!response.ok) throw new Error("request failed");
        const data = (await response.json()) as DraftPayload;
        if (signal?.aborted) return;
        const list = data.draft?.revisions ?? [];
        setRevisions(list);
        setNoApplicableRule(data.ruleAnalysis?.outcome === "no_applicable_rule");
        setBodyText(list[0]?.bodyText ?? "");
        setDirty(false);
        setEditing(false);
      } catch (cause) {
        if (signal?.aborted || (cause as Error)?.name === "AbortError") return;
        setError("Could not load this draft. Refresh to try again.");
        setRevisions([]);
      }
    },
    [conversationId],
  );

  useEffect(() => {
    const controller = new AbortController();
    // Every state update inside `load` happens after an await, so none of them
    // runs during this effect's synchronous body — the cascading-render the
    // rule guards against cannot occur here. The rule follows the call
    // transitively and cannot see the awaits, so it is disabled for this line
    // only. Fetching on mount is what React's own guidance suggests an effect
    // is for, and the request is cancelled on unmount above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const current = revisions?.[0] ?? null;

  /**
   * The CST rules this draft cited.
   *
   * Read from the stored revision, not from the evidence endpoint, so whether a
   * draft is rule-based is known immediately — the warning for an ungrounded
   * draft must not depend on someone opening a disclosure. Verified facts are
   * excluded: they ground a value, not the policy.
   */
  const citedRefs =
    current?.sources.filter((source) => source.kind === "cst_document") ?? [];

  /**
   * Names for citations that predate the reference format.
   *
   * The ref cannot be looked up, but the label recorded alongside it at
   * generation time still names the rule — so the list degrades to "we know
   * which rule, we just cannot link it" rather than disappearing.
   */
  const legacyLabels = (evidence?.evidence?.legacy ?? [])
    .map((ref) => citedRefs.find((source) => source.ref === ref)?.label?.trim())
    .filter((label): label is string => label !== undefined && label !== "");

  const hasCitations = citedRefs.length > 0;

  /**
   * The cited rules, grouped by CST area.
   *
   * Grouped because that is how the team thinks about them and how the
   * knowledge base is organised — "Returns & Refunds" then "Message Handling"
   * reads as a reason for the reply, where a flat list of rule names reads as
   * debug output. Areas keep the order the model cited them in.
   */
  const rulesByArea: { area: string; titles: string[] }[] = [];
  for (const rule of evidence?.evidence?.cited ?? []) {
    const area = rule.category ?? "General";
    const group = rulesByArea.find((entry) => entry.area === area);
    // `displayTitle`, never `title` and never `ref`. `title` is the workbook's
    // internal code — "EB4", "R-WD12" — and the ref is an audit key. Neither
    // means anything to a CST user deciding whether a reply is right.
    if (group) group.titles.push(rule.displayTitle);
    else rulesByArea.push({ area, titles: [rule.displayTitle] });
  }

  /**
   * Reads the API's error.
   *
   * The route returns wording meant for a person plus a stable `code`; an
   * unexpected 500 has neither, and that is the only case that falls back to a
   * generic line. The detail goes to the console for whoever is debugging, not
   * to the reviewer.
   */
  const failureFrom = async (response: Response, fallback: string): Promise<string> => {
    try {
      const data = (await response.json()) as { error?: string; code?: string };
      if (data.code !== undefined || typeof data.error === "string") {
        console.error("[draft] request failed", response.status, data.code, data.error);
      }
      return data.error ?? fallback;
    } catch {
      return fallback;
    }
  };

  /**
   * Fetches the rules a draft used.
   *
   * Loaded automatically now rather than on a click. The rules are part of the
   * draft, not an audit trail filed behind it — a reviewer judging a reply
   * needs to see what it was written from at the same moment they read it, and
   * a disclosure meant they usually did not.
   *
   * Still a separate request from the draft itself: it re-reads the rule corpus
   * server-side, so folding it into the conversation load would slow down every
   * conversation, including the ones with no draft at all.
   */
  const loadEvidence = useCallback(async () => {
    setEvidenceBusy(true);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/draft/evidence`);
      if (!response.ok) throw new Error("request failed");
      setEvidence((await response.json()) as EvidencePayload);
    } catch {
      // Deliberately not an error banner. The draft is fine; only the list of
      // rule names is missing, and the card still states how many were cited.
      setEvidence(null);
    } finally {
      setEvidenceBusy(false);
    }
  }, [conversationId]);

  /**
   * Pulls the rule names as soon as there is a draft that cites any.
   *
   * Declared after `loadEvidence` rather than beside the other derived values,
   * because an effect that reads a callback declared below it captures a stale
   * binding — the lint rule catches exactly that.
   *
   * Guarded on `evidence === null` so it runs once per draft rather than on
   * every render, and skipped entirely when nothing was cited: there would be
   * nothing to fetch, and the card already says so in amber.
   */
  useEffect(() => {
    if (!hasCitations || evidence !== null || evidenceBusy) return;
    // `setEvidenceBusy(true)` is the one synchronous update, and it is what
    // makes this effect idempotent — the guard above reads it, so the fetch
    // fires once rather than on every render. The remaining updates happen
    // after an await. Same reasoning, and same scoped exemption, as the
    // conversation load effect above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadEvidence();
  }, [hasCitations, evidence, evidenceBusy, loadEvidence]);

  /**
   * The ONLY thing in this component that can spend a model call.
   *
   * Nothing calls it on mount, on render, or from an effect — it runs from a
   * button and from nothing else. `busy` is set synchronously as the first
   * statement, and every button that reaches here is disabled while `busy` is
   * non-null, so a double-click cannot start a second request.
   *
   * `force` distinguishes the two callers. Generate sends nothing and the
   * server may hand back an existing draft rather than pay for an identical
   * one; Regenerate sends `force=1` and always spends a call, because asking
   * again is the entire point of that button.
   */
  const generate = useCallback(
    async (force = false) => {
      setBusy("generating");
      setStep(0);
      setError(null);
      // A new draft cites new rules. Dropping the old list stops a regenerate
      // showing the previous revision's rules under the new reply.
      setEvidence(null);
      // Advance the visible step on a schedule; cleared in `finally` so a fast
      // failure does not leave a stale timer running.
      const timers = STEP_AT.slice(1).map((at, index) =>
        setTimeout(() => setStep(index + 1), at),
      );
      try {
        const response = await fetch(
          `/api/conversations/${conversationId}/draft${generateQuery(force, selectedOrderNumber)}`,
          { method: "POST" },
        );
        /**
         * REFUSED, not failed.
         *
         * 409 `no_applicable_rule` means the rule base cannot ground a reply
         * for this conversation, so the server wrote no draft — by design. It
         * is a finished, actionable state rather than an error to retry, so it
         * raises the flag instead of the red error line, and `load()` is
         * skipped because there is nothing new to load.
         */
        if (response.status === 409) {
          const body = (await response.json().catch(() => ({}))) as { code?: string };
          if (body.code === "no_applicable_rule") {
            setNoApplicableRule(true);
            return;
          }
        }
        if (!response.ok) {
          setError(await failureFrom(response, "The draft could not be written just now."));
          return;
        }
        setNoApplicableRule(false);
        await load();
        onWorkflowChange("drafting");
        // The sidebar's usage and rules describe the revision that just landed.
        // Told now, from this same successful flow, so neither needs a refresh.
        onGenerated?.();
      } catch {
        setError("The draft service could not be reached.");
      } finally {
        for (const timer of timers) clearTimeout(timer);
        setBusy(null);
      }
    },
    [conversationId, load, onGenerated, onWorkflowChange, selectedOrderNumber],
  );

  const save = useCallback(async () => {
    setBusy("saving");
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/draft`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bodyText }),
      });
      if (!response.ok) {
        setError(await failureFrom(response, "This draft could not be saved."));
        return;
      }
      await load();
    } catch {
      setError("This draft could not be saved.");
    } finally {
      setBusy(null);
    }
  }, [bodyText, conversationId, load]);

  const moveTo = useCallback(
    async (state: WorkflowState) => {
      setBusy("reviewing");
      setError(null);
      try {
        const response = await fetch(`/api/conversations/${conversationId}/workflow`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state }),
        });
        if (!response.ok) {
          setError(await failureFrom(response, "This conversation could not be updated."));
          return;
        }
        onWorkflowChange(state);
      } catch {
        setError("This conversation could not be updated.");
      } finally {
        setBusy(null);
      }
    },
    [conversationId, onWorkflowChange],
  );

  const reviewed = workflowState === "reviewed";
  const generating = busy === "generating";

  const action =
    "rounded-full border border-black/15 px-3 py-1.5 text-xs font-medium transition-all hover:-translate-y-px hover:border-emerald-600/40 hover:bg-emerald-600/[0.10] active:translate-y-0 disabled:translate-y-0 disabled:opacity-40 disabled:hover:bg-transparent dark:border-white/20";

  return (
    <section
      data-testid="draft-panel"
      // h-full + overflow-y-auto: the height itself is set by the wrapper in
      // ConversationView (a fixed pixel value the reviewer can drag), not by
      // this section. Without overflow-y-auto here, content taller than that
      // wrapper would spill out rather than scroll -- draft card + rules +
      // buttons pushing past the visible area with no way to reach them.
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium tracking-wide uppercase opacity-55">
          Draft reply{current ? ` · revision ${current.revision}` : ""}
        </h2>
        <span className="text-[11px] opacity-55">{workflowLabel(workflowState)}</span>
      </div>

      {error !== null && (
        <p
          data-testid="draft-error"
          className="rounded bg-amber-500/15 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200"
        >
          {error}
        </p>
      )}

      {revisions === null ? (
        <p className="text-sm opacity-60">Loading…</p>
      ) : generating ? (
        <GeneratingIndicator step={step} />
      ) : noApplicableRule ? (
        /*
         * REFUSED. The server found nothing in the current approved knowledge
         * that could ground a reply, so it wrote none — and there is therefore
         * no draft here to read, no revision number, and no Generate button
         * offering to try the same thing again.
         *
         * This branch sits ABOVE the empty state on purpose. "Nothing drafted
         * yet" and "we will not draft this" look the same from the absence of a
         * draft, and only the second has something to tell the reviewer.
         */
        <NoRuleFlag messages={detail.messages}>
          {/* The export lives INSIDE the flag, because it is the one action
              this state offers: the file is what the team reads to write the
              rule that was missing. Available on reopen too, since the flag
              itself is restored from storage. */}
          <ConversationExportButton detail={detail} />
        </NoRuleFlag>
      ) : current === null ? (
        /* Nothing drafted yet: one button, and nothing else to weigh up. */
        <div
          data-testid="draft-empty"
          className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-emerald-600/30 bg-emerald-600/[0.06] dark:bg-emerald-400/[0.06] px-4 py-9"
        >
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy !== null || reviewed}
            className="group rounded-full bg-emerald-600/15 px-5 py-2.5 text-sm font-semibold text-emerald-800 transition-all hover:-translate-y-0.5 hover:bg-emerald-600/25 active:translate-y-0 disabled:translate-y-0 disabled:opacity-40 disabled:hover:bg-emerald-600/15 dark:text-emerald-200"
          >
            <span className="inline-block transition-transform group-hover:scale-110 group-hover:rotate-12">
              ✨
            </span>{" "}
            Generate Reply
          </button>
          <p className="text-[11px] opacity-55">A human reviews every draft. Nothing is sent.</p>
        </div>
      ) : (
        <>
          {/*
           * Deliberately the strongest tint on the panel, and the reason is
           * hierarchy rather than taste. The three states share one emerald
           * ramp and have to be told apart at a glance:
           *
           *   empty       /06, dashed border — a placeholder
           *   generating  /15, solid         — work in progress
           *   draft       /25, solid         — the finished reply
           *
           * At /15 the draft card was tied with the generating state and only
           * one step off the empty one, so the panel looked much the same
           * whether or not there was anything to read. Dark mode uses /20
           * rather than /25 because emerald-400 on a dark ground reads heavier
           * than emerald-600 on a light one at the same alpha.
           */}
          <div
            data-testid="draft-card"
            className="animate-[fadeIn_.3s_ease-out] rounded-xl border border-emerald-600/35 bg-emerald-600/25 p-3.5 dark:border-emerald-400/30 dark:bg-emerald-400/20"
          >
            {editing ? (
              <textarea
                value={bodyText}
                onChange={(event) => {
                  setBodyText(event.target.value);
                  setDirty(true);
                }}
                autoFocus
                rows={8}
                // The field needs its own edge now that the card behind it is
                // tinted; at black/10 it disappeared into the deeper card.
                className="w-full resize-y rounded border border-black/20 bg-transparent px-2 py-1.5 text-sm dark:border-white/25"
              />
            ) : (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{bodyText}</p>
            )}
          </div>

          {current.requiresReview && (
            <p
              data-testid="requires-review"
              className="text-xs font-medium text-amber-700 dark:text-amber-300"
            >
              Needs a human check before this is used.
            </p>
          )}
          {/*
           * WHAT THE DRAFT WAS BASED ON — always visible, never behind a click.
           *
           * This used to be an accordion reading "Based on 4 CST rules". It was
           * the wrong shape: the rules a reply was written from are part of
           * judging the reply, not a footnote to it, and hiding them behind a
           * disclosure meant a reviewer usually approved a draft without ever
           * seeing them. Now they sit under the draft and cannot be missed.
           *
           * GROUPED BY AREA, TITLES ONLY. The workbook, sheet, row and full
           * rule text all come back from the evidence endpoint and are all
           * deliberately not shown — a reviewer wants to know WHICH rules
           * applied, not to read the rule book underneath the reply. The detail
           * stays on the API for an audit that needs it.
           *
           * A DRAFT MUST BE BASED ON AT LEAST ONE RULE. When none was cited
           * there is nothing to show and nothing to prove, so this says so
           * directly, in amber. That is the case that must not pass quietly.
           */}
          {current.origin === "generated" &&
            (citedRefs.length === 0 ? (
              /*
               * The full flag, not a one-line caution.
               *
               * This used to be a single amber sentence, which sat under a
               * fluent reply and read as a footnote to a successful draft. It
               * is not: nothing in the knowledge base covered this case, the
               * text above is ungrounded, and the useful next step is writing
               * the missing rule. The same component appears in the sidebar so
               * the two cannot say different things.
               */
              <div data-testid="not-rule-based">
                <NoRuleFlag messages={detail.messages} />
              </div>
            ) : (
              <div data-testid="rule-evidence" className="flex flex-col gap-1.5 text-xs">
                {/*
                 * UI-ONLY DISCLOSURE. Expanding or collapsing this never
                 * fetches, revalidates, or drops anything — `evidence` and
                 * `rulesByArea` are unchanged either way, this only decides
                 * whether the same list is rendered on screen right now.
                 */}
                <button
                  type="button"
                  onClick={() => setRulesExpanded((expanded) => !expanded)}
                  aria-expanded={rulesExpanded}
                  className="flex items-center gap-1 text-[11px] font-medium tracking-wide uppercase opacity-55"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    aria-hidden
                    className={`transition-transform ${rulesExpanded ? "rotate-90" : ""}`}
                  >
                    <path
                      d="M3 1.5 7 5l-4 3.5"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Based on CST rules
                </button>

                {rulesExpanded && (
                  <>
                    {/*
                     * The count is shown while the names load, so the section
                     * never flashes empty and a reviewer can already see the
                     * draft was grounded even on a slow request.
                     */}
                    {rulesByArea.length === 0 && (
                      <p className="opacity-60">
                        {evidenceBusy
                          ? `Loading ${citedRefs.length} cited rule${citedRefs.length === 1 ? "" : "s"}…`
                          : `${citedRefs.length} cited rule${citedRefs.length === 1 ? "" : "s"}`}
                      </p>
                    )}

                    {rulesByArea.map((group) => (
                      <div key={group.area} className="flex flex-col">
                        <p className="font-medium text-emerald-800 dark:text-emerald-200">
                          <span aria-hidden className="mr-1.5">
                            ✓
                          </span>
                          {group.area}
                        </p>
                        <ul className="ml-4 flex flex-col gap-0.5 opacity-75">
                          {group.titles.map((title, index) => (
                            <li key={`${group.area}-${index}`}>{title}</li>
                          ))}
                        </ul>
                      </div>
                    ))}

                    {/*
                     * The "N cited rules no longer exist in the current documents"
                     * line used to sit here, and has been removed from the screen
                     * by request — deliberately with nothing in its place.
                     *
                     * THE VALIDATION BEHIND IT IS UNCHANGED. An unresolvable
                     * citation is still separated from a resolvable one, still
                     * excluded from the rules shown here, and still returned by the
                     * evidence endpoint for an audit. It now also blocks
                     * generation: a draft grounded only in citations that no longer
                     * resolve is not saved at all, so the state this sentence
                     * warned about can no longer reach a reviewer.
                     */}

                    {/*
                     * Older drafts cite refs from before the reference format
                     * changed. That says nothing about the documents, so it is
                     * stated neutrally — and with the rule NAME recorded at the
                     * time, never the reference itself. Falling back to printing
                     * the raw refs, as this once did, is exactly the internal-id
                     * leak the panel is supposed to prevent.
                     */}
                    {(evidence?.evidence?.legacy.length ?? 0) > 0 && (
                      <p className="opacity-55">
                        {evidence!.evidence!.legacy.length} rule
                        {evidence!.evidence!.legacy.length === 1 ? "" : "s"} cited before the
                        reference format changed
                        {legacyLabels.length > 0 ? `: ${legacyLabels.join("; ")}` : ""}
                      </p>
                    )}
                  </>
                )}
              </div>
            ))}

          <div className="flex flex-wrap items-center gap-2">
            {!reviewed &&
              (editing ? (
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy !== null || !dirty || bodyText.trim() === ""}
                  className={action}
                >
                  {busy === "saving" ? "Saving…" : "Save draft"}
                </button>
              ) : (
                <button type="button" onClick={() => setEditing(true)} disabled={busy !== null} className={action}>
                  Edit
                </button>
              ))}

            {editing && (
              <button
                type="button"
                onClick={() => {
                  setBodyText(current.bodyText);
                  setDirty(false);
                  setEditing(false);
                }}
                disabled={busy !== null}
                className={action}
              >
                Cancel
              </button>
            )}

            {/* force: asking again IS the point of this button, so it must
                never be answered with the draft that already exists. */}
            {!reviewed && !editing && (
              <button
                type="button"
                onClick={() => void generate(true)}
                disabled={busy !== null}
                className={action}
              >
                Regenerate
              </button>
            )}

            {workflowState === "drafting" && !editing && (
              <button type="button" onClick={() => void moveTo("pending_review")} disabled={busy !== null} className={action}>
                {/* Deliberately not "Send for review": nothing in this phase
                    sends, and the word would suggest otherwise. */}
                Ready for review
              </button>
            )}

            {workflowState === "pending_review" && !editing && (
              <button
                type="button"
                onClick={() => void moveTo("reviewed")}
                disabled={busy !== null}
                className="rounded-full bg-emerald-600/15 px-3.5 py-1.5 text-xs font-semibold text-emerald-800 transition-all hover:-translate-y-px hover:bg-emerald-600/25 active:translate-y-0 disabled:translate-y-0 disabled:opacity-40 dark:text-emerald-200"
              >
                Mark reviewed
              </button>
            )}
          </div>

          {reviewed && (
            <p data-testid="workflow-terminal" className="text-xs opacity-55">
              Reviewed. This phase ends here — there is no capability to reply to the customer
              from this application.
            </p>
          )}
        </>
      )}
    </section>
  );
}
