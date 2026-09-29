/**
 * Turning what an agent pressed into the revision that gets stored, or a
 * refusal.
 *
 * ---------------------------------------------------------------------------
 * ONE SET OF EQUAL LABELS
 * ---------------------------------------------------------------------------
 * An agent selects as many causes as apply — `PARTS MISSING`, or
 * `PARTS MISSING` and `Delivery Issue` and `OTHER` together. THERE IS NO
 * PRIMARY CAUSE. Nothing in the business rule ranks them, so nothing here
 * ranks them: the record carries one `rootCauses` set whose members are peers,
 * and the courier levels open if ANY member is a courier-shaped label.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT CHECKS INSIDE THE ROUTE
 * ---------------------------------------------------------------------------
 * Every rule here is a rule about the RECORD, not about HTTP: which labels are
 * offered, that `OTHER` obliges an explanation, which labels open the courier
 * levels, whether an issue type can stand without a courier. Put in the handler
 * they would be untestable without a request, and the screen would have to
 * re-implement them to decide when to enable a button — two copies of one rule,
 * drifting.
 *
 * So the route parses a body and this decides what it means. The component
 * imports the same functions to decide what to show. There is one statement of
 * the rules and both ends read it.
 *
 * ---------------------------------------------------------------------------
 * IT RETURNS A REFUSAL, IT DOES NOT THROW
 * ---------------------------------------------------------------------------
 * A rejected selection is an ordinary outcome — an agent left the courier
 * blank — not an exception. The refusal carries a sentence written FOR THAT
 * AGENT, because it is rendered next to the control they were using: it says
 * what to do, never which constraint or column disagreed.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER RULE LIVES HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 *   labels contain OTHER   <->   customRootCause is present
 *
 * is a condition across two tables once stored, and migration 0020
 * deliberately adds no trigger to enforce it — a trigger firing on every label
 * insert is a fragile thing to own for a rule the writer already guarantees.
 * This module refuses either half before a write happens, and the repository
 * writes both tables in ONE transaction so no partial state is observable.
 *
 * That makes the two checks below load-bearing rather than belt-and-braces.
 * They are tested directly for exactly that reason.
 *
 * PURE. No network, no database, no clock.
 */

import {
  type MessageAppRootCauseResponse,
  rootCauseLabelKey,
} from "@/lib/domain/message-app-root-cause";
import {
  canonicalCourier,
  canonicalCourierIssueType,
  canonicalRootCauseLabel,
  CUSTOM_ROOT_CAUSE_MAX_LENGTH,
  ISSUE_NOTE_MAX_LENGTH,
  isOtherLabel,
  requiresCourierDetail,
  ROOT_CAUSE_VOCABULARY_VERSION,
} from "@/lib/domain/root-cause-vocabulary";

/** What arrives from the browser, before anything is known about it. */
export type RootCauseSelectionInput = {
  /** The selected capsules. At least one is required. */
  readonly rootCauses?: unknown;
  /**
   * The agent's own statement of what the root cause IS, when `OTHER` is among
   * the selected labels. Required then, forbidden otherwise.
   *
   * NOT THE SAME FIELD AS `issueNote`, and they must never be merged. This one
   * answers "what was the problem"; the note answers "what else should someone
   * reading this know". A case whose cause was filed in the note column could
   * never be grouped or counted.
   *
   * There is only ONE of these because there is only ever one `OTHER` in a
   * selected set.
   */
  readonly customRootCause?: unknown;
  readonly courier?: unknown;
  readonly courierIssueType?: unknown;
  readonly issueNote?: unknown;
};

/** The revision, once it is known to be one. */
export type RootCauseRecord = {
  /**
   * The selected labels, canonical and deduplicated, in selection order.
   * Never empty. All members are equal — there is no primary.
   */
  readonly rootCauses: readonly string[];
  /** Non-null if and only if `rootCauses` contains `OTHER`. */
  readonly customRootCause: string | null;
  readonly courier: string | null;
  readonly courierIssueType: string | null;
  readonly issueNote: string | null;
  readonly vocabularyVersion: number;
};

export type RootCauseSelection =
  | { readonly ok: true; readonly record: RootCauseRecord }
  | { readonly ok: false; readonly error: string };

/** A field that was not filled in. Blank and absent are the same thing. */
function optionalText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function refuse(error: string): RootCauseSelection {
  return { ok: false, error };
}

/**
 * The revision an agent's selection amounts to, or the sentence to show them.
 *
 * ORDER OF CHECKS IS THE ORDER OF THE FORM. An agent who has chosen nothing is
 * told to choose a cause, not that their courier is missing — the first thing
 * reported is the first thing they would fix.
 */
export function readRootCauseSelection(input: RootCauseSelectionInput): RootCauseSelection {
  /* ---- The selected causes ----------------------------------------------- */

  const raw = input.rootCauses;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    return refuse("Root causes must be a list.");
  }

  const rootCauses: string[] = [];
  const seen = new Set<string>();

  for (const entry of (raw ?? []) as unknown[]) {
    const text = optionalText(entry);
    // A blank entry is a control that was never filled, not a refusal.
    if (text === null) continue;

    const label = canonicalRootCauseLabel(text);
    if (label === null) return refuse("That root cause is not one of the options.");

    /*
     * A CASE IS NOT `PARTS MISSING` TWICE. A duplicate would double that
     * label's mention count against a case that named it once, and the unique
     * constraint on the label table would reject the write anyway — but as an
     * opaque 500 rather than a sentence the agent can act on.
     */
    const key = rootCauseLabelKey(label);
    if (seen.has(key)) return refuse("That root cause is already selected.");
    seen.add(key);

    // The canonical spelling, never whatever casing the request carried.
    rootCauses.push(label);
  }

  // AT LEAST ONE. A revision with no causes records nothing, and the label
  // table would hold a parent with no children — the one state the atomic write
  // exists to prevent.
  if (rootCauses.length === 0) return refuse("Choose a root cause.");

  /* ---- OTHER, and the wording that must accompany it --------------------- */

  const customRootCause = optionalText(input.customRootCause);
  const choseOther = rootCauses.some(isOtherLabel);

  if (choseOther) {
    if (customRootCause === null) {
      // Blank and whitespace-only arrive here as null; `optionalText` trims.
      return refuse("Enter the root cause.");
    }
    if (customRootCause.length > CUSTOM_ROOT_CAUSE_MAX_LENGTH) {
      return refuse(`Keep the root cause under ${CUSTOM_ROOT_CAUSE_MAX_LENGTH} characters.`);
    }
  } else if (customRootCause !== null) {
    /*
     * STALE TEXT IS REFUSED, NOT QUIETLY DROPPED. The screen clears the box
     * when OTHER is deselected, so text arriving without OTHER means a caller
     * has gone out of step with the form. Silently discarding it would tell an
     * agent their own words were saved when nothing will ever show them.
     */
    return refuse("A typed root cause only applies when OTHER is selected.");
  }

  /* ---- The courier and the kind of problem -------------------------------- */

  const courierRaw = optionalText(input.courier);
  const issueTypeRaw = optionalText(input.courierIssueType);

  /*
   * ANY SELECTED LABEL OPENS THESE. `PARTS MISSING` alone does not; `PARTS
   * MISSING` with `Delivery Issue` does. The courier detail describes the case,
   * and the case is delivery-related the moment one of its causes is — there is
   * no ranking among the labels that could make one of them not count.
   */
  const opensCourierLevels = rootCauses.some(requiresCourierDetail);

  /*
   * A COURIER RECORDED AGAINST A SELECTION THAT DOES NOT INVOLVE ONE IS
   * REFUSED, not quietly dropped. The screen only offers these levels when a
   * courier-shaped label is selected, so a courier arriving otherwise means a
   * caller has gone out of step with the form — and silently discarding it
   * would tell an agent their answer was saved when the report will never show
   * it.
   */
  if (!opensCourierLevels && (courierRaw !== null || issueTypeRaw !== null)) {
    return refuse("Courier details only apply to a delivery, fulfilment or carrier root cause.");
  }

  let courier: string | null = null;
  let courierIssueType: string | null = null;

  if (opensCourierLevels) {
    /*
     * REQUIRED, and this is the one place stricter than the database.
     *
     * The column is nullable because a row written by some later import may
     * legitimately not know; but this feature exists to answer "which courier
     * causes the most problems", and an optional field on the one screen that
     * feeds that report is a field that comes back empty. `Other` is on the
     * list for the case where the courier genuinely is not one of the nine.
     */
    if (courierRaw === null) return refuse("Choose the courier.");

    courier = canonicalCourier(courierRaw);
    if (courier === null) return refuse("That courier is not one of the options.");

    /*
     * The issue type stays OPTIONAL, matching
     * `ck_conversation_root_causes_issue_type_needs_courier`. Which courier
     * carried a parcel is a fact an agent has in front of them; what the
     * courier did wrong is often still being established, and forcing a choice
     * there would buy a filled-in field at the price of a guessed one.
     */
    if (issueTypeRaw !== null) {
      courierIssueType = canonicalCourierIssueType(issueTypeRaw);
      if (courierIssueType === null) return refuse("That issue type is not one of the options.");
    }
  }

  /* ---- What actually happened -------------------------------------------- */

  const issueNote = optionalText(input.issueNote);
  if (issueNote !== null && issueNote.length > ISSUE_NOTE_MAX_LENGTH) {
    return refuse(`Keep the note under ${ISSUE_NOTE_MAX_LENGTH} characters.`);
  }

  return {
    ok: true,
    record: {
      rootCauses,
      customRootCause,
      courier,
      courierIssueType,
      issueNote,
      // Stamped from the list that produced these labels, never resolved later.
      vocabularyVersion: ROOT_CAUSE_VOCABULARY_VERSION,
    },
  };
}

/**
 * The CST selection currently recorded for a conversation, for the panel.
 *
 * SEPARATE FROM `MessageAppRootCauseResponse` AND IT MUST STAY SEPARATE. That
 * one carries the message application's value; this one carries CST's. The
 * panel shows both, each labelled with whose it is, because they are recorded
 * by different people in different systems and either can be the one that is
 * out of date. A single merged field would have to pick a winner, and neither
 * application has the standing to be it.
 */
export type ConversationRootCause = {
  /** The revision id. */
  readonly id: string;
  /**
   * The labels recorded with THIS revision, in the order they were written.
   *
   * Belonging to the revision and not to the conversation is what makes a
   * deselected label actually disappear: the next revision brings its own set,
   * and historical sets are never merged into the current answer.
   */
  readonly rootCauses: readonly string[];
  /** The agent's own wording; non-null only when `OTHER` is among the labels. */
  readonly customRootCause: string | null;
  readonly courier: string | null;
  readonly courierIssueType: string | null;
  readonly issueNote: string | null;
  readonly vocabularyVersion: number;
  readonly recordedAt: string;
};

/** The response of `POST`: what the database now holds, never what was sent. */
export type ConversationRootCauseResponse = {
  readonly conversationId: string;
  /** Null when this conversation has no CST selection yet. */
  readonly current: ConversationRootCause | null;
};

/**
 * The response of `GET`: BOTH values, side by side and separately labelled.
 *
 * The message application's half keeps the shape it already had — the panel and
 * its guard test were written against it and neither needed to change — and
 * CST's own selection arrives beside it under `cst`, which is null until an
 * agent records one.
 *
 * ONE REQUEST FOR BOTH, because they are read together and rendered together;
 * two requests would let the sidebar show one half while the other was still in
 * flight, which reads as a disagreement that is really just latency.
 */
export type RootCausePanelResponse = MessageAppRootCauseResponse & {
  readonly cst: ConversationRootCause | null;
};

/** The sidebar heading for CST's own selection, named once so a guard can pin it. */
export const CST_ROOT_CAUSE_HEADING = "CST Root Cause";
