"use client";

import { useEffect, useMemo, useState } from "react";

import {
  type ConversationRootCause,
  type ConversationRootCauseResponse,
  CST_ROOT_CAUSE_HEADING,
  readRootCauseSelection,
} from "@/lib/domain/root-cause-selection";
import {
  COURIER_ISSUE_TYPES,
  COURIERS,
  CUSTOM_ROOT_CAUSE_MAX_LENGTH,
  ISSUE_NOTE_MAX_LENGTH,
  canonicalRootCauseLabel,
  isOtherLabel,
  OTHER_LABEL,
  requiresCourierDetail,
  ROOT_CAUSE_LABELS,
  rootCauseChipText,
} from "@/lib/domain/root-cause-vocabulary";

/**
 * Where a CST agent records the root causes of a case.
 *
 * ---------------------------------------------------------------------------
 * ONE GROUP OF EQUAL CAPSULES
 * ---------------------------------------------------------------------------
 * There is a single ROOT CAUSE section. Every capsule in it is independently
 * selectable and every selected capsule is a peer — no primary, no secondary,
 * no second list. An agent picks `PARTS MISSING`, or `PARTS MISSING` and
 * `Delivery Issue` and `OTHER` together, and presses a capsule again to
 * deselect it.
 *
 * ---------------------------------------------------------------------------
 * ITS OWN FILE, AND THAT IS NOT TIDINESS
 * ---------------------------------------------------------------------------
 * `MessageAppRootCauseSection` in the context panel shows what the MESSAGE
 * APPLICATION recorded, and a standing guard slices that component out of the
 * panel and asserts it contains no button, no input and no save — because CST
 * cannot write there and a control would imply it could.
 *
 * That guard is still right, so this lives somewhere else entirely. Two values,
 * two systems, two components, side by side in the sidebar and each labelled
 * with whose it is. Neither one overwrites the other and neither can.
 *
 * ---------------------------------------------------------------------------
 * A CHIP GRID, BECAUSE THE OTHER SCREEN IS A CHIP GRID
 * ---------------------------------------------------------------------------
 * The message application presents its labels as a wall of small buttons an
 * agent hits in one click. That is copied deliberately: an agent moving between
 * the two screens all day should not have to learn a dropdown here for the same
 * decision they make with a button there.
 *
 * ---------------------------------------------------------------------------
 * THE RULES ARE NOT RE-IMPLEMENTED HERE
 * ---------------------------------------------------------------------------
 * `readRootCauseSelection` decides whether what is on screen amounts to a
 * record, and the same function runs again on the server. The button is disabled
 * when it refuses, and the refusal it returns is the sentence shown beneath —
 * so the reason the button is dead is always on screen, and the enabling rule
 * and the saving rule cannot drift into disagreeing.
 */

type Props = {
  readonly conversationId: string;
};

/** What the POST answers with, or the sentence to show instead. */
type Saving =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly error: string };

const IDLE: Saving = { kind: "idle" };

/**
 * What the OTHER SYSTEM suggests for this thread, reduced to something the
 * form can start from.
 *
 * ---------------------------------------------------------------------------
 * A STARTING POINT, NEVER A RECORDING
 * ---------------------------------------------------------------------------
 * The suggestion pre-selects capsules so an agent who agrees can press Confirm
 * once. It is not stored until they do. Nothing writes to that other system
 * either — CST holds no write privilege there — so agreeing records a CST row
 * and disagreeing records a different CST row.
 *
 * THREE SHAPES, because their column is not a controlled vocabulary:
 *
 *   label   their value matches one of our capsules, so that capsule is
 *           pre-selected
 *   prose   their value is free text from their own OTHER flow, or a label we
 *           do not offer. OTHER is pre-selected and their words go in the box,
 *           where the agent can edit them before confirming
 *   none    they hold nothing, or their own rows disagree with each other. The
 *           form starts empty — a suggestion assembled from conflicting values
 *           would be this application inventing an answer
 */
type Suggestion =
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "none" };

const NO_SUGGESTION: Suggestion = { kind: "none" };

export function readSuggestion(payload: {
  state?: string;
  value?: string | null;
}): Suggestion {
  // `ambiguous` and `unavailable` both mean "nothing to start from".
  if (payload.state !== "resolved") return NO_SUGGESTION;
  const value = payload.value ?? "";
  if (value.trim() === "") return NO_SUGGESTION;

  const label = canonicalRootCauseLabel(value);
  if (label !== null) return { kind: "label", label };
  return { kind: "prose", text: value.trim() };
}

/**
 * One capsule.
 *
 * `aria-pressed` rather than a checked input: this is a toggle button in a
 * group, which is what a screen reader should be told it is. `type="button"`
 * because an unmarked button inside a form submits it.
 */
function Chip({
  label,
  selected,
  disabled,
  onToggle,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
        selected
          ? "border-emerald-600/40 bg-emerald-600/15 text-emerald-800 dark:text-emerald-200"
          : "border-black/15 hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.05]"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * A row of capsules.
 *
 * `isSelected` RATHER THAN A SELECTED VALUE, so one component serves both the
 * multi-select root cause group and the single-choice courier groups without a
 * `multi` flag deciding two behaviours inside one body.
 */
function ChipGroup({
  legend,
  options,
  isSelected,
  disabled,
  onToggle,
  text = (option: string) => option,
}: {
  legend: string;
  options: readonly string[];
  isSelected: (option: string) => boolean;
  disabled: boolean;
  onToggle: (option: string) => void;
  text?: (option: string) => string;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-[11px] opacity-70">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Chip
            key={option}
            label={text(option)}
            selected={isSelected(option)}
            disabled={disabled}
            onToggle={() => onToggle(option)}
          />
        ))}
      </div>
    </fieldset>
  );
}

/**
 * What is currently recorded.
 *
 * EVERY SELECTED CAUSE IS SHOWN, as equals on one line. The typed OTHER wording
 * sits beneath them because it belongs to one of those capsules rather than
 * standing alongside; the courier detail and the note are separate lines again,
 * because they answer different questions.
 */
function Recorded({ current }: { current: ConversationRootCause }) {
  const detail = [current.courier, current.courierIssueType].filter((part) => part !== null);
  /*
    THE AGENT'S OWN WORDING STANDS IN FOR `OTHER`.

    Showing `OUT OF STOCK · OTHER` and repeating the typed text underneath made
    a reader look in two places to learn what the second cause was. Substituted
    in place, it reads as what they meant.

    Presentation only — the stored labels still include the literal `OTHER`,
    which is what a report groups on.
  */
  const causes = current.rootCauses.map((label) =>
    isOtherLabel(label) && current.customRootCause !== null
      ? current.customRootCause
      : rootCauseChipText(label),
  );
  return (
    <div className="flex flex-col gap-1">
      {/* Verbatim, wrapped not truncated. */}
      <p className="text-sm break-words whitespace-pre-wrap">{causes.join(" · ")}</p>
      {detail.length > 0 && <p className="text-xs opacity-70">{detail.join(" · ")}</p>}
      {current.issueNote !== null && (
        <p className="text-xs break-words whitespace-pre-wrap opacity-70">{current.issueNote}</p>
      )}
    </div>
  );
}

export function RootCauseSelector({ conversationId }: Props) {
  const [current, setCurrent] = useState<ConversationRootCause | null>(null);
  /** What the other system suggests, reduced by `readSuggestion`. */
  const [suggestion, setSuggestion] = useState<Suggestion>(NO_SUGGESTION);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<Saving>(IDLE);

  /** The selected capsules, in selection order — all equal members of one set. */
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [customRootCause, setCustomRootCause] = useState("");
  const [courier, setCourier] = useState<string | null>(null);
  const [issueType, setIssueType] = useState<string | null>(null);
  const [note, setNote] = useState("");

  /**
   * Whether what is on screen right now is the confirmed selection.
   *
   * ANY EDIT CLEARS IT — a capsule, the typed cause, the courier, the issue
   * type or the note. The moment one of them changes, the form no longer shows
   * what was confirmed, and leaving the tick lit would claim a confirmation for
   * a selection nobody confirmed.
   */
  const [confirmed, setConfirmed] = useState(false);

  /*
    EVERYTHING RESETS WHEN THE CONVERSATION CHANGES, AND THE KEY DOES IT.

    A half-filled selection following an agent to the next case — and being
    recorded against the wrong one — is the worst thing a panel shared by every
    conversation can do. The panel renders this keyed by conversation id, so
    switching threads unmounts and remounts it and every piece of state above
    starts empty.

    An effect that cleared them by hand was written first. It is not needed, and
    React's own lint rejects it: setting state synchronously in an effect
    cascades a render for something the key already guarantees.
  */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/root-cause`);
        if (!response.ok) throw new Error("request failed");
        /*
          ONE REQUEST FOR BOTH HALVES. The route returns what CST recorded and
          what the other system suggests together, so the form can never open
          with one half loaded and the other still in flight.
        */
        const payload = (await response.json()) as {
          cst?: ConversationRootCause | null;
          state?: string;
          value?: string | null;
        };
        if (cancelled) return;
        setCurrent(payload.cst ?? null);

        const suggested = readSuggestion(payload);
        setSuggestion(suggested);

        /*
          OPEN THE FORM WHEN THERE IS SOMETHING TO SHOW AND NOTHING RECORDED.

          The capsules are the point: an agent must SEE the suggested cause
          sitting selected among the unselected ones, decide in a glance
          whether it is right, and press Confirm — or change it first. Behind a
          closed panel that is two clicks and an act of faith.

          Applied here rather than in an effect body, because this is already
          an asynchronous callback: setting state synchronously inside an
          effect cascades a render, and React's own lint rejects it.

          THE TICK STAYS DARK. Nothing is recorded until Confirm is pressed.
        */
        if (payload.cst == null && suggested.kind !== "none") {
          if (suggested.kind === "label") {
            setSelected([suggested.label]);
          } else {
            setSelected([OTHER_LABEL]);
            setCustomRootCause(suggested.text);
          }
          setConfirmed(false);
          setOpen(true);
        }
      } catch {
        // A failed read is nothing recorded, never a guess at what might be.
        if (!cancelled) {
          setCurrent(null);
          setSuggestion(NO_SUGGESTION);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  /*
   * ANY SELECTED CAPSULE OPENS THE COURIER LEVELS. `PARTS MISSING` alone does
   * not; `PARTS MISSING` with `Delivery Issue` does. The courier describes the
   * case, and the case is delivery-related the moment one of its causes is —
   * there is no ranking among the capsules that could make one of them not
   * count.
   */
  const opensCourierLevels = selected.some(requiresCourierDetail);
  const opensCustomRootCause = selected.some(isOtherLabel);

  /*
    THE SAME FUNCTION THE SERVER RUNS. The button's enabled state and the
    sentence beneath it both come from this one call, so "why can I not
    confirm" always has an answer on screen and the two ends cannot disagree
    about what a valid selection is.
  */
  const checked = useMemo(
    () =>
      readRootCauseSelection({
        rootCauses: selected,
        // Gated on OTHER being selected, exactly as the courier levels are.
        // Belt and braces beside `toggleCause` clearing the box: if either
        // mechanism is removed, stale text still cannot reach the request.
        customRootCause: opensCustomRootCause ? customRootCause : null,
        courier: opensCourierLevels ? courier : null,
        courierIssueType: opensCourierLevels ? issueType : null,
        issueNote: note,
      }),
    [selected, customRootCause, courier, issueType, note, opensCourierLevels, opensCustomRootCause],
  );

  /** Any change to the selection un-ticks the button. See `confirmed`. */
  function edited() {
    setSaving(IDLE);
    setConfirmed(false);
  }

  /**
   * Select a capsule, or deselect one already selected.
   *
   * PRESSING A SELECTED CAPSULE AGAIN CLEARS IT. The capsules are toggle
   * buttons — `aria-pressed` says so — and a toggle that only ever turns on is
   * a control an agent cannot back out of.
   */
  function toggleCause(option: string) {
    edited();
    setSelected((chosen) => {
      const next = chosen.includes(option)
        ? chosen.filter((c) => c !== option)
        : [...chosen, option];

      /*
        Deselecting OTHER clears the typed cause with it. Without this, text
        typed under OTHER would sit invisibly in state behind a hidden field —
        the server refuses it, so the save would fail with a reason pointing at
        a box that is no longer on screen.
      */
      if (isOtherLabel(option) && !next.some(isOtherLabel)) setCustomRootCause("");

      /*
        And the courier levels go when nothing courier-shaped is left selected,
        for the same reason: a courier recorded against a selection that no
        longer involves one is refused by the server.
      */
      if (!next.some(requiresCourierDetail)) {
        setCourier(null);
        setIssueType(null);
      }
      return next;
    });
  }

  /**
   * Confirm the selection on screen.
   *
   * THE FORM IS NOT CLEARED AFTERWARDS. The selections stay exactly where they
   * are so the agent can see what they confirmed, take the confirmation back,
   * adjust it and confirm again — without re-picking everything.
   *
   * CONFIRMATION APPLIES TO THE WHOLE SET, never to one capsule. There is one
   * button and it records one revision containing every selected label.
   */
  async function confirm() {
    if (!checked.ok) return;
    setSaving({ kind: "saving" });
    try {
      const response = await fetch(`/api/conversations/${conversationId}/root-cause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rootCauses: selected,
          customRootCause: opensCustomRootCause ? customRootCause : null,
          courier,
          courierIssueType: issueType,
          issueNote: note,
        }),
      });
      const payload = (await response.json()) as ConversationRootCauseResponse & { error?: string };
      if (!response.ok) {
        // The server's own sentence, which is written for this agent.
        setSaving({ kind: "failed", error: payload.error ?? "That could not be confirmed." });
        return;
      }
      // What the database stored, not what was sent.
      setCurrent(payload.current);
      setConfirmed(true);
      setSaving(IDLE);
    } catch {
      setSaving({ kind: "failed", error: "That could not be confirmed." });
    }
  }

  /**
   * Take the confirmation back, keeping every selection on screen.
   *
   * WHAT THIS DOES AND DOES NOT DO. It reopens the selection for editing. It
   * does NOT erase the revision that was recorded — the table is append-only
   * and nothing deletes from it, so confirming again appends a further revision
   * and the newest one wins. The history therefore reads as what actually
   * happened: this was confirmed, then reconsidered.
   */
  function unconfirm() {
    setConfirmed(false);
    setSaving(IDLE);
  }

  /**
   * Open the form, PREFILLED with what is already recorded.
   *
   * Without this, pressing "Change" on a conversation that already has root
   * causes opened an empty form — so correcting one capsule meant re-picking
   * everything, and the tick started dark even though a confirmed selection
   * existed.
   */
  function toggleForm() {
    if (!open) {
      if (current !== null) {
        setSelected(current.rootCauses);
        setCustomRootCause(current.customRootCause ?? "");
        setCourier(current.courier);
        setIssueType(current.courierIssueType);
        setNote(current.issueNote ?? "");
        // What is on screen IS the recorded selection, so the tick is lit.
        setConfirmed(true);
      } else if (suggestion.kind === "label") {
        /*
          NOTHING RECORDED YET, SO START FROM THE SUGGESTION.

          The capsule is pre-selected and the tick is DARK: an agent who agrees
          presses Confirm once, and an agent who does not changes it first.
          Lighting the tick would claim a confirmation nobody made, and the row
          is not written until they press it.
        */
        setSelected([suggestion.label]);
        setCustomRootCause("");
        setConfirmed(false);
      } else if (suggestion.kind === "prose") {
        /*
          Their value is free text, or a label this application does not offer.
          OTHER carries it, which is exactly what OTHER is for — and the agent
          can edit the wording before confirming it as CST's own.
        */
        setSelected([OTHER_LABEL]);
        setCustomRootCause(suggestion.text);
        setConfirmed(false);
      }
      setSaving(IDLE);
    }
    setOpen((was) => !was);
  }

  const busy = saving.kind === "saving";

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-medium tracking-wide uppercase opacity-60">
          {CST_ROOT_CAUSE_HEADING}
        </h2>
        <div className="flex items-center gap-1.5">
          {/*
            DOWNLOAD, AND IT IS A PLAIN LINK RATHER THAN A FETCH.

            `download` on an anchor hands the file to the browser's own download
            machinery — no blob in memory, no object URL to revoke, and a
            right-click "save as" works. Fetching it into JavaScript first would
            buy nothing and would hold the whole CSV in the tab.

            It exports EVERY conversation's current root causes, not this one:
            the button lives here because this is where root causes are recorded,
            but the file is the report. An Excel workbook by default; the server
            names it and sets the
            disposition, so the date stamp cannot drift from what was exported.
          */}
          <a
            href="/api/root-causes/export"
            download
            className="rounded-full border border-black/15 px-2.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.05]"
            title="Download every recorded root cause as an Excel workbook, with the message app's value beside it"
          >
            Download
          </a>
          <button
            type="button"
            onClick={toggleForm}
            className="rounded-full border border-black/15 px-2.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-black/[0.03] dark:border-white/20 dark:hover:bg-white/[0.05]"
          >
            {/*
              "Change" rather than "Edit", because nothing is edited: confirming
              again appends a revision, and what was there stays readable.

              "Add" rather than "Record", so the only button on this panel saying
              anything like "confirm" is the one that actually confirms.
            */}
            {open ? "Close" : current === null ? "Add" : "Change"}
          </button>
        </div>
      </div>

      {current !== null && <Recorded current={current} />}

      {open && (
        <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-2.5 dark:border-white/15">
          {/*
            WHERE THE PRE-SELECTION CAME FROM, SAID PLAINLY.

            An agent opening this form and finding capsules already lit must
            know CST did not choose them — otherwise they confirm somebody
            else's answer believing it was their own. Shown only while nothing
            is recorded, which is the only time a pre-selection happened.

            It is a sentence, not a control: there is nothing to accept here.
            Accepting is pressing Confirm, which records a CST row.
          */}
          {current === null && suggestion.kind !== "none" && (
            <p className="text-[11px] opacity-70">
              Pre-selected from the system suggestion. Change it if it is wrong, then confirm.
            </p>
          )}

          {/*
            ONE SECTION, EVERY CAPSULE INDEPENDENTLY SELECTABLE. No primary and
            no additional group: the selected capsules are peers, and a report
            counts one case with three labels as one case and three mentions.
          */}
          <ChipGroup
            legend="Root cause"
            options={ROOT_CAUSE_LABELS}
            isSelected={(option) => selected.includes(option)}
            disabled={busy}
            onToggle={toggleCause}
            text={rootCauseChipText}
          />

          {/*
            SHOWN ONLY WHEN OTHER IS SELECTED, and it is a field for the CAUSE —
            not a note. "Enter Root Cause" rather than "What went wrong",
            because the two boxes on this form are easy to confuse and only one
            answers "what was the problem".

            ONE box, because there is only ever one OTHER in a selected set.

            No character counter: there is no minimum to count towards.
          */}
          {opensCustomRootCause && (
            <label className="flex flex-col gap-1 text-[11px] opacity-70">
              Enter Root Cause
              <textarea
                value={customRootCause}
                onChange={(event) => {
                  edited();
                  setCustomRootCause(event.target.value);
                }}
                disabled={busy}
                rows={2}
                maxLength={CUSTOM_ROOT_CAUSE_MAX_LENGTH}
                placeholder="What the problem actually was"
                className="rounded-md border border-black/15 bg-transparent p-2 text-sm dark:border-white/20"
              />
            </label>
          )}

          {opensCourierLevels && (
            <>
              <ChipGroup
                legend="Courier"
                options={COURIERS}
                isSelected={(option) => option === courier}
                disabled={busy}
                onToggle={(next) => {
                  edited();
                  setCourier(next);
                }}
              />
              {/*
                Issue type appears only once a courier is named, mirroring the
                rule the database enforces: an issue type describes a courier's
                conduct and cannot stand without one.
              */}
              {courier !== null && (
                <ChipGroup
                  legend="Issue type"
                  options={COURIER_ISSUE_TYPES}
                  isSelected={(option) => option === issueType}
                  disabled={busy}
                  onToggle={(next) => {
                    edited();
                    setIssueType(next);
                  }}
                />
              )}
            </>
          )}

          {selected.length > 0 && (
            <label className="flex flex-col gap-1 text-[11px] opacity-70">
              Note (optional)
              <textarea
                value={note}
                onChange={(event) => {
                  edited();
                  setNote(event.target.value);
                }}
                disabled={busy}
                rows={2}
                maxLength={ISSUE_NOTE_MAX_LENGTH}
                className="rounded-md border border-black/15 bg-transparent p-2 text-sm dark:border-white/20"
              />
            </label>
          )}

          <div className="flex items-center justify-between gap-2">
            {/*
              The reason the button is disabled, always on screen. An agent
              never has to guess which part of the form is incomplete.
            */}
            <p className="text-[11px] opacity-70">
              {saving.kind === "failed" ? saving.error : checked.ok ? "" : checked.error}
            </p>
            {/*
              ONE BUTTON, TWO STATES.

                Confirm      -> records the whole selected set
                ✓ Confirmed  -> pressing again takes the confirmation back

              The selections STAY either way. `aria-pressed` because this is a
              toggle, and that is what a screen reader needs to be told. The
              tick is decorative — the word beside it carries the meaning.
            */}
            <button
              type="button"
              aria-pressed={confirmed}
              onClick={() => (confirmed ? unconfirm() : void confirm())}
              disabled={(!checked.ok && !confirmed) || busy}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
                confirmed
                  ? "bg-emerald-600/25 text-emerald-800 hover:bg-emerald-600/35 dark:text-emerald-200"
                  : "bg-emerald-600/15 text-emerald-800 hover:bg-emerald-600/25 disabled:hover:bg-emerald-600/15 dark:text-emerald-200"
              }`}
            >
              {busy ? "Confirming…" : confirmed ? "✓ Confirmed" : "Confirm"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
