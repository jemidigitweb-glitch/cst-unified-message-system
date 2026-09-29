/**
 * The root cause the PRODUCTION MESSAGE APP recorded for a thread, read only.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT THE CST CATEGORY, AND THE TWO MUST NEVER BE MERGED
 * ---------------------------------------------------------------------------
 * `lib/knowledge/message-category.ts` answers "what is this message about",
 * deterministically, from a phrase table CST owns, and stores nothing. This
 * answers a different question — "what, operationally, went wrong" — and CST
 * does not answer it at all: the value is typed or confirmed by an agent in the
 * message application, or written there by that application's own classifier,
 * and CST reads it.
 *
 * Nothing here imports the category classifier, and nothing here may. They
 * share no vocabulary, no storage and no code path, and the category baseline is
 * frozen.
 *
 * ---------------------------------------------------------------------------
 * READ ONLY, AND SEVERAL ROWS CAN CARRY A VALUE
 * ---------------------------------------------------------------------------
 * The message application stores the root cause ON MESSAGE ROWS, not on a
 * thread: its manual save writes one row, and its classifier writes the whole
 * buyer-thread slice it selected. A CST conversation groups many source rows, so
 * a conversation can legitimately present several stored values — the same label
 * repeated across a slice, or two different labels written at different times.
 *
 * So resolution has exactly three outcomes and no fourth:
 *
 *   resolved     every non-blank value on the thread is the same label, and the
 *                newest one is returned VERBATIM
 *   unavailable  no row carries a non-blank value
 *   ambiguous    two or more different labels are recorded, and none is returned
 *
 * `ambiguous` is the one that earns its place. The message application resolves
 * this case by taking the newest buyer row that has a value, which is a
 * reasonable thing for the screen that owns the write to do — it is about to be
 * overwritten by the next save anyway. It is NOT reasonable here: CST cannot
 * write, so picking one would put a label in front of a reviewer that the
 * owning application might not agree with, with nothing on screen to say a
 * second value existed. Ambiguity is surfaced, never resolved by the machine.
 *
 * ---------------------------------------------------------------------------
 * THE VALUE IS NOT A CONTROLLED VOCABULARY, AND FREE TEXT IS VALID DATA
 * ---------------------------------------------------------------------------
 * The message application offers a fixed label list, and one of its options is
 * `OTHER` — which it REFUSES to store. Choosing it opens a textarea, requires at
 * least 30 characters, and saves that prose AS the root cause. Live values of
 * that shape include sentences about what a customer is returning and which
 * decision a marketplace still has to make.
 *
 * Those are correct records, not corruption, and they are not rejected,
 * truncated, summarised or pattern-matched here. `character varying` on three of
 * the five source tables and `text` on the other two; up to 512 characters by
 * the writer's own cap.
 *
 * ---------------------------------------------------------------------------
 * CASE IS COMPARED, NEVER CORRECTED
 * ---------------------------------------------------------------------------
 * The stored data carries case variants of one label — `OUT OF STOCK` beside
 * `Out of stock`, `RETURN` beside `Return` — because the writer's validation is
 * case-insensitive (`strcasecmp`) while its storage is verbatim. Two such rows
 * are the SAME label and must not read as a conflict.
 *
 * `sameRootCauseLabel` therefore folds case for COMPARISON ONLY. No function
 * here returns a case-folded string, and the value handed to the panel is the
 * source's own bytes. Re-casing it would put a label on screen that a reviewer
 * could not find character-for-character in the owning application.
 *
 * PURE. No network, no database, no clock.
 */

/** One stored value, exactly as a source row holds it. */
export type MessageAppRootCauseCandidate = {
  /** The source column, unmodified. Null and blank are both "nothing stored". */
  readonly value: string | null;
};

/**
 * Which of the three outcomes above applies.
 *
 * Deliberately NOT a nullable string. A caller that receives `null` cannot tell
 * "nothing was ever recorded" from "several things were, and we will not choose"
 * — and those are different facts about the case that a reviewer reads
 * differently. The state makes the distinction impossible to drop by accident.
 */
export type MessageAppRootCauseState = "resolved" | "unavailable" | "ambiguous";

export type MessageAppRootCause = {
  readonly state: MessageAppRootCauseState;
  /** The verbatim source value, and non-null only when `state` is "resolved". */
  readonly value: string | null;
  /**
   * How many DISTINCT labels the thread carries, case folded.
   *
   * 0 for unavailable, 1 for resolved, 2+ for ambiguous — so the panel can say
   * how many values disagree rather than only that they do.
   */
  readonly distinctLabelCount: number;
};

/**
 * The comparison key for one label. Internal to comparison; never displayed.
 *
 * Trimmed as well as case folded, because the writer trims before saving but
 * older rows predate that and a leading space is not a different root cause.
 */
export function rootCauseLabelKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Whether two stored values name the same label, ignoring case and padding. */
export function sameRootCauseLabel(left: string, right: string): boolean {
  return rootCauseLabelKey(left) === rootCauseLabelKey(right);
}

/**
 * The one root cause a conversation's source rows establish, or a refusal.
 *
 * CANDIDATES MUST ARRIVE NEWEST FIRST, and the caller owns that ordering — it
 * comes from `conversation_messages` (source_ts DESC, source_pk DESC), which is
 * the same ordering the thread itself renders in reverse. The rule here is
 * "newest wins" only for CHOOSING WHICH SPELLING of an agreed label to show; it
 * never breaks a tie between two different labels.
 */
export function resolveMessageAppRootCause(
  candidates: readonly MessageAppRootCauseCandidate[],
): MessageAppRootCause {
  const stored: string[] = [];
  for (const candidate of candidates) {
    if (candidate.value === null) continue;
    // Blank-but-present is "nothing stored": the writer clears a root cause by
    // saving an empty string, which lands as NULL there but as '' on rows that
    // older code touched.
    if (candidate.value.trim() === "") continue;
    stored.push(candidate.value);
  }

  if (stored.length === 0) {
    return { state: "unavailable", value: null, distinctLabelCount: 0 };
  }

  const distinct = new Set(stored.map(rootCauseLabelKey));
  if (distinct.size > 1) {
    return { state: "ambiguous", value: null, distinctLabelCount: distinct.size };
  }

  // The newest spelling of the single agreed label, byte for byte.
  return { state: "resolved", value: stored[0]!, distinctLabelCount: 1 };
}

/**
 * The response of `GET /api/conversations/:id/root-cause`.
 *
 * `unreadableSourceRowCount` is here because degradation is reported, never
 * hidden. A conversation's rows are matched to source tables through a fixed
 * allowlist built from the marketplace adapters; a row whose source table is not
 * on it, or whose primary key is not a number, is COUNTED AND SKIPPED rather
 * than guessed at. A non-zero count with `state: "unavailable"` means "we could
 * not look", which is not the same claim as "nothing is recorded".
 */
export type MessageAppRootCauseResponse = {
  readonly conversationId: string;
  readonly state: MessageAppRootCauseState;
  readonly value: string | null;
  readonly distinctLabelCount: number;
  /** Source rows this conversation has, whether or not they were readable. */
  readonly sourceRowCount: number;
  /** Rows that could not be mapped to an allowlisted source table and key. */
  readonly unreadableSourceRowCount: number;
};
/**
 * The sidebar heading, named once so a guard test can pin it.
 *
 * ---------------------------------------------------------------------------
 * "SYSTEM SUGGESTION" RATHER THAN "MESSAGE APP ROOT CAUSE"
 * ---------------------------------------------------------------------------
 * Renamed on the business's instruction, and the name is defensible: most of
 * what appears here is written by the other application's own classifier,
 * automatically and with no user attached, so to a CST agent it reads as
 * something a machine proposed rather than something a colleague decided.
 *
 * ONE NUANCE THE NAME HIDES, recorded here because the screen cannot carry it:
 * not every value is machine-generated. Their agents type some of these by
 * hand, and this column cannot tell the two apart — the source stores no
 * authorship. So "suggestion" is how CST should TREAT it, not a claim about
 * where each value came from.
 *
 * What the name must never imply is that pressing something here accepts it.
 * CST cannot write to that system, the section has no control of any kind, and
 * a guard enforces both.
 */
export const MESSAGE_APP_ROOT_CAUSE_HEADING = "System Suggestion";

/**
 * What the panel says when the thread carries conflicting labels.
 *
 * It states the disagreement and shows NO label, because showing one would be
 * the arbitrary choice this whole module exists to refuse.
 *
 * "SUGGESTED" rather than "recorded in the message app", matching the heading:
 * an agent reading the notice should not have to know which other system it
 * came from to understand that nothing here is settled.
 */
export function ambiguousRootCauseNotice(distinctLabelCount: number): string {
  return `${distinctLabelCount} different root causes are suggested for this thread, so none is shown here.`;
}

/**
 * What the panel draws: a value, a sentence, or nothing at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROJECTION EXISTS RATHER THAN THE PANEL READING `state`
 * ---------------------------------------------------------------------------
 * `tests/guards/order-context-display.test.ts` forbids the words `ambiguous`,
 * `verification` and `deterministic` anywhere in `components/context-panel.tsx`,
 * and it is right to: the panel is the one file a CST agent reads through the
 * screen, and a resolution state rendered there describes this system's
 * bookkeeping rather than anything they can act on. A first version of this
 * feature branched on `state === "ambiguous"` in the component and failed that
 * guard.
 *
 * The fix is not a rename. The decision "is there something to show, and is it a
 * label or a sentence" is a RULE, so it belongs in this module where it is pure
 * and unit-tested — not spread across JSX conditionals. The panel receives three
 * cases it can render and no vocabulary it has to interpret.
 *
 * `hidden` folds together every reason there is nothing to draw: the request is
 * in flight, the request failed, or nothing is recorded. A reviewer reads all
 * three the same way, and none of them may render as a heading over a blank.
 */
export type MessageAppRootCauseView =
  | { readonly kind: "hidden" }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "notice"; readonly text: string };

const HIDDEN: MessageAppRootCauseView = { kind: "hidden" };

/** The view for a response, or for `null` while there is not one yet. */
export function messageAppRootCauseView(
  response: MessageAppRootCauseResponse | null,
): MessageAppRootCauseView {
  if (response === null) return HIDDEN;

  switch (response.state) {
    case "resolved":
      // Belt and braces: `resolved` carries a value by construction, and a
      // malformed payload from anywhere must still not render a blank label.
      return response.value === null || response.value.trim() === ""
        ? HIDDEN
        : { kind: "value", value: response.value };
    case "unavailable":
      return HIDDEN;
    default:
      return { kind: "notice", text: ambiguousRootCauseNotice(response.distinctLabelCount) };
  }
}
