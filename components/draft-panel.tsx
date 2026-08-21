"use client";

import { useCallback, useEffect, useState } from "react";

import type { DraftSource } from "@/lib/domain/draft";
import { workflowLabel } from "@/lib/domain/inbox";
import type { WorkflowState } from "@/lib/domain/workflow";

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
  title: string;
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

export function DraftPanel({
  conversationId,
  workflowState,
  onWorkflowChange,
}: {
  conversationId: string;
  workflowState: WorkflowState;
  onWorkflowChange: (state: WorkflowState) => void;
}) {
  const [revisions, setRevisions] = useState<DraftRevision[] | null>(null);
  const [bodyText, setBodyText] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "generating" | "saving" | "reviewing">(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidencePayload | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceBusy, setEvidenceBusy] = useState(false);

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
   * generation time still names the rule — so the trail degrades to "we know
   * which rule, we just cannot link it" rather than disappearing.
   */
  const legacyLabels = (evidence?.evidence?.legacy ?? [])
    .map((ref) => citedRefs.find((source) => source.ref === ref)?.label?.trim())
    .filter((label): label is string => label !== undefined && label !== "");

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
   * Fetches the audit trail, once, on first open.
   *
   * Not loaded with the draft: it re-reads the rule corpus server-side, and
   * most drafts are read without anyone needing to check where they came from.
   * Paying that on every conversation to serve the occasional audit would be
   * the wrong trade.
   */
  const openEvidence = useCallback(async () => {
    setEvidenceOpen((open) => !open);
    if (evidence !== null || evidenceBusy) return;
    setEvidenceBusy(true);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/draft/evidence`);
      if (!response.ok) throw new Error("request failed");
      setEvidence((await response.json()) as EvidencePayload);
    } catch {
      setError("The rule trail could not be loaded.");
    } finally {
      setEvidenceBusy(false);
    }
  }, [conversationId, evidence, evidenceBusy]);

  const generate = useCallback(async () => {
    setBusy("generating");
    setStep(0);
    setError(null);
    // A new draft has a new trail. Dropping the old one stops a regenerate
    // showing the previous revision's citations under the new reply.
    setEvidence(null);
    setEvidenceOpen(false);
    // Advance the visible step on a schedule; cleared in `finally` so a fast
    // failure does not leave a stale timer running.
    const timers = STEP_AT.slice(1).map((at, index) =>
      setTimeout(() => setStep(index + 1), at),
    );
    try {
      const response = await fetch(`/api/conversations/${conversationId}/draft`, {
        method: "POST",
      });
      if (!response.ok) {
        setError(await failureFrom(response, "The draft could not be written just now."));
        return;
      }
      await load();
      onWorkflowChange("drafting");
    } catch {
      setError("The draft service could not be reached.");
    } finally {
      for (const timer of timers) clearTimeout(timer);
      setBusy(null);
    }
  }, [conversationId, load, onWorkflowChange]);

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
      className="flex min-h-0 flex-col gap-3 border-t border-black/10 px-5 py-4 dark:border-white/15"
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
           * WHAT THE DRAFT WAS BASED ON.
           *
           * Titles only. The workbook, sheet, row and full rule text are all
           * returned by the evidence endpoint and are all deliberately not
           * shown: a reviewer checking a reply wants to know WHICH rules it
           * followed, not to read the rule book underneath it. The detail stays
           * available on the API for an audit that needs it.
           *
           * A DRAFT MUST BE BASED ON AT LEAST ONE RULE. When none was cited
           * there is nothing to disclose and nothing to prove, so instead of an
           * empty list this says so directly, in amber, without needing to be
           * opened. That case is the one that must not be quietly passed over.
           */}
          {current.origin === "generated" &&
            (citedRefs.length === 0 ? (
              <p
                data-testid="not-rule-based"
                className="text-xs font-medium text-amber-700 dark:text-amber-300"
              >
                Not based on any CST rule — do not use without checking it against the documents.
              </p>
            ) : (
              <div data-testid="rule-evidence" className="text-xs">
                <button
                  type="button"
                  onClick={() => void openEvidence()}
                  aria-expanded={evidenceOpen}
                  className="flex items-center gap-1.5 rounded px-1 py-0.5 font-medium opacity-60 transition-opacity hover:opacity-100"
                >
                  <span
                    aria-hidden
                    className={`inline-block transition-transform ${evidenceOpen ? "rotate-90" : ""}`}
                  >
                    ›
                  </span>
                  Based on {citedRefs.length} CST rule{citedRefs.length === 1 ? "" : "s"}
                </button>

                {evidenceOpen && (
                  <ul className="mt-1.5 flex list-disc flex-col gap-0.5 border-l-2 border-emerald-600/30 pl-6 opacity-80 dark:border-emerald-400/30">
                    {evidenceBusy && <li className="list-none opacity-60">Reading the rule files…</li>}

                    {!evidenceBusy &&
                      evidence?.evidence?.cited.map((rule) => (
                        <li key={rule.ref}>
                          {rule.title}
                          {rule.category !== null && (
                            <span className="ml-1.5 opacity-55">{rule.category}</span>
                          )}
                        </li>
                      ))}

                    {/*
                     * Two different failures, two different sentences.
                     *
                     * `unresolved` means the DOCUMENTS changed — a genuine
                     * audit finding, so it is amber.
                     *
                     * `legacy` means OUR reference scheme changed while the
                     * rule stayed exactly where it was. An earlier version
                     * reported both as "no longer exists in the current
                     * documents", which blamed the business for our own
                     * migration and was alarming on every pre-existing draft.
                     * It is stated neutrally, and the rule name we stored at
                     * the time is shown so the trail is not actually lost.
                     */}
                    {!evidenceBusy && (evidence?.evidence?.unresolved.length ?? 0) > 0 && (
                      <li className="list-none text-amber-700 dark:text-amber-300">
                        {evidence!.evidence!.unresolved.length} cited rule
                        {evidence!.evidence!.unresolved.length === 1 ? "" : "s"} no longer exist in
                        the current documents.
                      </li>
                    )}

                    {!evidenceBusy && (evidence?.evidence?.legacy.length ?? 0) > 0 && (
                      <li className="list-none opacity-55">
                        Drafted before the rule reference format changed, so{" "}
                        {evidence!.evidence!.legacy.length} citation
                        {evidence!.evidence!.legacy.length === 1 ? "" : "s"} cannot be linked
                        automatically. Recorded at the time as:{" "}
                        {legacyLabels.join("; ") || evidence!.evidence!.legacy.join(", ")}
                      </li>
                    )}
                  </ul>
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

            {!reviewed && !editing && (
              <button type="button" onClick={() => void generate()} disabled={busy !== null} className={action}>
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
