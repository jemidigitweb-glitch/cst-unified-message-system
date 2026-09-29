/**
 * Standing guard on the system suggestion and CST's own root cause.
 *
 * Asserted against source, matching how the rest of this suite guards the
 * interface: no DOM environment is configured, and what matters here is
 * structural. The resolution rule is unit-tested in
 * `tests/domain/message-app-root-cause.test.ts` and the lookup in
 * `tests/repositories/root-cause-repository.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARDS CHANGED, TWICE, AND WHAT NEVER DID
 * ---------------------------------------------------------------------------
 * It first guarded that the whole feature was a DISPLAY: a read-only section
 * showing the other system's value, with no control anywhere and no write. CST
 * then gained its own recording, and now the read-only section is gone
 * entirely — the suggestion PRE-SELECTS capsules in CST's form instead, so an
 * agent who agrees confirms in one press and an agent who does not changes it
 * first.
 *
 * Both of those are real changes to what the feature does, and a guard that
 * pretended otherwise would fail for a reason nobody could act on.
 *
 * WHAT HAS NEVER CHANGED, and is what this file actually protects:
 *
 *   * The other system's value is READ and never written. CST holds no write
 *     privilege there — measured, not assumed — and nothing on this path may
 *     acquire one, in either database.
 *   * A suggestion is a STARTING POINT, never a recording. Pre-selecting a
 *     capsule stores nothing; only Confirm does, and it writes a CST row.
 *   * The read lookup and the CST writer stay separate modules, so the thing
 *     that can write is not the thing that can reach the source.
 *   * Root cause and the frozen CST category remain different systems.
 *
 * The writer behind the POST is pinned in `api-surface.test.ts`, which is where
 * every mutable route in this application answers for itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";


/**
 * Standing guard on the read-only Message App root cause section.
 *
 * Asserted against source, matching how the rest of this suite guards the
 * interface: no DOM environment is configured, and what matters here is
 * structural. The resolution rule is unit-tested in
 * `tests/domain/message-app-root-cause.test.ts` and the lookup in
 * `tests/repositories/root-cause-repository.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARDS CHANGED, AND WHAT IT DID NOT
 * ---------------------------------------------------------------------------
 * It used to guard that the whole feature was a DISPLAY: no control anywhere,
 * no write anywhere, GET and nothing else. CST now records its own root cause,
 * so the second half of that is no longer true and pretending otherwise would
 * mean a guard that fails for a reason nobody can act on.
 *
 * WHAT IT STILL GUARDS IS THE PART THAT MATTERS, and it is not weaker for being
 * narrower:
 *
 *   * The MESSAGE APPLICATION'S value is read and never written. CST holds no
 *     write privilege there — measured, not assumed — and nothing on this path
 *     may acquire one, in either database.
 *   * The section that DISPLAYS it still has nothing to operate: no button, no
 *     input, no confirm, no save. A control there would say CST can change the
 *     other system's value, and it cannot.
 *   * CST's own selector is a SEPARATE COMPONENT in a separate file, so the two
 *     values stay separately labelled and neither reads as the other.
 *   * Root cause and the frozen CST category remain different systems.
 *
 * The writer behind the new POST is pinned in `api-surface.test.ts`, which is
 * where every mutable route in this application answers for itself.
 */

const ROOT = join(__dirname, "..", "..");

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8");
}

/** Source with comments removed, so prose explaining a rule cannot satisfy it. */
function code(...segments: string[]): string {
  return read(...segments)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const PANEL = ["components", "context-panel.tsx"] as const;
const DOMAIN = ["lib", "domain", "message-app-root-cause.ts"] as const;
const REPOSITORY = ["lib", "repositories", "root-cause-repository.ts"] as const;
const ROUTE = [
  "app",
  "api",
  "conversations",
  "[conversationId]",
  "root-cause",
  "route.ts",
] as const;

/** Every file this feature added or touched. */
const FEATURE_FILES = [DOMAIN, REPOSITORY, ROUTE, PANEL] as const;

const panel = code(...PANEL);
const route = code(...ROUTE);

describe("the suggestion is a starting point, not a recording", () => {
  const selector = code("components", "root-cause-selector.tsx");

  /**
   * THE READ-ONLY SECTION IS GONE, and its absence is asserted rather than
   * assumed. Leaving a second place that renders the other system's value
   * would put two answers on one screen again — which is the thing removing it
   * was meant to stop.
   */
  it("no longer renders a separate section for the other system's value", () => {
    expect(panel).not.toContain("MessageAppRootCauseSection");
    expect(panel).not.toContain("messageAppRootCauseView");
    expect(panel).not.toContain("MESSAGE_APP_ROOT_CAUSE_HEADING");
  });

  /** CST's selector is the one place a root cause is shown or chosen. */
  it("renders the CST selector once, keyed by conversation", () => {
    const uses = panel.match(/<RootCauseSelector\b/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(panel).toMatch(/<RootCauseSelector\s+key=\{`cst-root-cause-\$\{conversation\.id\}`\}/);
  });

  /**
   * A SUGGESTION PRE-SELECTS; IT NEVER CONFIRMS.
   *
   * The distinction is the whole safety of this design. A pre-selected capsule
   * with a lit tick would claim a confirmation nobody made, and the row would
   * look like a CST decision when no agent had made one. So the prefill sets
   * `confirmed` FALSE, and only the Confirm handler posts.
   */
  it("pre-selects without confirming, and posts only from Confirm", () => {
    expect(selector).toMatch(/setSelected\(\[suggestion\.label\]\)/);
    expect(selector).toMatch(/setSelected\(\[OTHER_LABEL\]\)/);

    // Every prefill branch leaves the tick dark.
    const prefill = /} else if \([^)]*suggestion\.kind === "label"\) \{[\s\S]*?setSaving\(IDLE\);/.exec(
      selector,
    )?.[0];
    expect(prefill).toBeDefined();
    expect(prefill).toContain("setConfirmed(false)");
    expect(prefill).not.toContain("setConfirmed(true)");

    // One POST in the file, and it is the Confirm handler's.
    expect((selector.match(/method: "POST"/g) ?? []).length).toBe(1);
    expect(selector).toMatch(/async function confirm\(\)/);
  });

  /**
   * A RECORDED SELECTION WINS OVER A SUGGESTION. Once CST has decided, the
   * other system's opinion must not overwrite what an agent chose — the
   * suggestion branch is reachable only when nothing is recorded.
   */
  it("prefers what CST recorded over the suggestion", () => {
    expect(selector).toMatch(/if \(current !== null\) \{[\s\S]*?\} else if \([^)]*suggestion\.kind/);
  });

  /**
   * AND THE AGENT WINS A RACE WITH THE SUGGESTION. This is a fix for a real
   * defect, pinned so it cannot come back.
   *
   * The request is in flight while the panel is already interactive, so an
   * agent can press a capsule before it lands. The arriving suggestion used to
   * overwrite that press — clicking OTHER and ending up with PARTS MISSING,
   * observed in the running app. A machine silently undoing somebody's click
   * is worse than a slow suggestion.
   *
   * EVERY path that pre-fills must therefore check `touched` first, and
   * `edited()` must set it — which is what makes one flag cover the capsules,
   * the typed cause, the courier, the issue type and the note alike.
   */
  it("never lets a late suggestion overwrite what the agent already chose", () => {
    // The flag is a ref: readable by the in-flight callback without a stale copy.
    expect(selector).toMatch(/const touched = useRef\(false\)/);
    expect(selector).toMatch(/function edited\(\) \{\s*(\/\/[^\n]*\n\s*)*touched\.current = true;/);

    // Every prefill is guarded by it — the fetch callback and the reopen path.
    const guards = selector.match(/!touched\.current/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);

    // Every prefill ENTRY POINT is guarded: the fetch callback, and the two
    // reopen branches. Checked by name rather than by scanning every branch
    // that mentions a suggestion — an inner branch inside an already-guarded
    // block is not an unguarded prefill, and flagging it taught nothing.
    expect(selector).toMatch(
      /if \(!touched\.current && payload\.cst == null && suggested\.kind !== "none"\)/,
    );
    expect(selector).toMatch(/} else if \(!touched\.current && suggestion\.kind === "label"\)/);
    expect(selector).toMatch(/} else if \(!touched\.current && suggestion\.kind === "prose"\)/);
  });

  /**
   * AND THE AGENT IS TOLD WHERE A PRE-SELECTION CAME FROM. Finding capsules
   * already lit without being told CST did not choose them is how somebody
   * confirms another system's answer believing it was their own.
   */
  it("says on screen that a pre-selection came from the suggestion", () => {
    expect(selector).toMatch(/current === null && suggestion\.kind !== "none"/);
    expect(selector).toContain("system suggestion");
  });

  /**
   * CONFLICTING OR ABSENT VALUES SUGGEST NOTHING. Assembling a starting point
   * out of values that disagree would be this application inventing an answer,
   * which is exactly what the resolution rule exists to refuse.
   */
  it("suggests nothing when the other system is unresolved", () => {
    expect(selector).toMatch(/payload\.state !== "resolved"/);
    expect(selector).toMatch(/return NO_SUGGESTION/);
  });

  /**
   * FREE TEXT LANDS IN OTHER, WHICH IS WHAT OTHER IS FOR. Their column is not
   * a controlled vocabulary, so a value this application does not offer cannot
   * become a capsule — and must not be silently dropped either.
   */
  it("carries an unrecognised suggestion into the typed-cause box", () => {
    expect(selector).toMatch(/canonicalRootCauseLabel\(value\)/);
    expect(selector).toMatch(/kind: "prose"/);
    expect(selector).toMatch(/setCustomRootCause\(suggestion\.text\)/);
  });
});

describe("the route reads the message app value and records only CST's", () => {
  /**
   * GET AND POST, AND NOTHING THAT COULD REWRITE HISTORY.
   *
   * PATCH and DELETE are absent by design, not by omission: the CST table is
   * append-only, so changing a root cause records another row and what was
   * there before stays readable. A PATCH here would quietly turn that table
   * into the overwriting one the message application uses — which is the single
   * behaviour of theirs this feature exists not to copy.
   */
  it("exports GET and POST, and nothing that could overwrite a record", () => {
    expect(route).toMatch(/export\s+async\s+function\s+GET\b/);
    expect(route).toMatch(/export\s+async\s+function\s+POST\b/);
    for (const method of ["PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      expect(route).not.toMatch(
        new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${method}\\b`),
      );
    }
  });

  /**
   * THE WRITE AND THE SOURCE MUST NEVER MEET. This is the only route in the
   * application that both reads the live marketplace source and writes, so the
   * writer it reaches for is named here: `recordRootCause`, which touches one
   * table in the APPLICATION database. No writer that could reach the source
   * exists anywhere behind this route, and the source session would refuse one
   * regardless.
   */
  it("writes through one application writer and never through the source", () => {
    expect(route).toContain("recordRootCause");
    expect(route).toContain("conversation-root-cause-repository");
    // The read-only lookup keeps its own module, and keeps being the only thing
    // that touches the marketplace tables.
    expect(route).toContain("loadMessageAppRootCause");

    const writer = code("lib", "repositories", "conversation-root-cause-repository.ts");
    expect(writer).not.toContain("getSourcePool");
    expect(writer).not.toContain("customer_service");
    /*
     * Its only writing statements, and both name a CST table. Two, because one
     * recorded decision is a revision header plus its selected labels — and
     * INSERT-only, because the record is append-only.
     */
    expect(writer.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+\S+/g)).toEqual([
      "INSERT INTO cst_app.conversation_root_causes",
      "INSERT INTO cst_app.conversation_root_cause_labels",
    ]);
  });

  /** A CST selection is validated before anything is written, by the pure rule. */
  it("validates a posted selection through the domain rule", () => {
    expect(route).toContain("readRootCauseSelection");
    expect(route).toMatch(/if \(!selection\.ok\)/);
  });

  it("answers 404 for an unknown conversation rather than an empty result", () => {
    // Otherwise "this id does not exist" and "nothing is recorded" would render
    // identically, and they are different facts.
    expect(route).toContain("Conversation not found");
    expect(route).toContain("getConversation");
  });

  it("uses the read-only source pool and the app pool, and no other client", () => {
    expect(route).toContain("getSourcePool()");
    expect(route).toContain("getAppPool()");
    expect(route).not.toContain("new Pool");
  });
});

describe("the message application's own value is never written", () => {
  /**
   * SQL-SHAPED, NOT SINGLE KEYWORDS, and the reason is a real false positive.
   *
   * A bare /\bTRUNCATE\b/i matched `className="truncate"` — Tailwind's
   * one-line-clamp utility — in the panel. A guard that fires on a CSS class
   * teaches a reader to ignore it, so each pattern here needs the verb AND the
   * clause that makes it a statement.
   */
  const WRITE_STATEMENTS = [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bCREATE\s+(TABLE|INDEX|VIEW|SCHEMA)\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bDROP\s+(TABLE|INDEX|VIEW|SCHEMA)\b/i,
    /\bTRUNCATE\s+TABLE\b/i,
    /\bFOR\s+UPDATE\b/i,
    /\bBEGIN\s*;/i,
    /\bCOMMIT\s*;/i,
  ];

  it("keeps marketplace source logic out of the React component", () => {
    const selector = code("components", "root-cause-selector.tsx");
    for (const leak of [
      "customer_service",
      "ebay_message_headers",
      "shopify_messages",
      "amazon_messages",
      "bandq_messages",
      "temu_messages",
      "SELECT",
    ]) {
      expect(selector).not.toContain(leak);
    }
  });

  /**
   * The SELECTOR holds no SQL either. The panel-slice version of this check
   * went with the section it sliced; this asserts the same property about
   * the component that actually renders root causes now.
   */
  it("issues no write statement in the CST selector", () => {
    const selector = code("components", "root-cause-selector.tsx");
    for (const pattern of WRITE_STATEMENTS) {
      expect(selector).not.toMatch(pattern);
    }
  });

  it("never checks a client out of a pool, so it cannot open a transaction", () => {
    for (const file of [REPOSITORY, ROUTE]) {
      expect(code(...file)).not.toContain(".connect(");
    }
  });

  it("does not import a writer", () => {
    for (const file of FEATURE_FILES) {
      expect(code(...file)).not.toMatch(/from "@\/lib\/sync\//);
    }
  });

  /**
   * THE READ PATH KEEPS ITS OWN MODULES. `root-cause-repository.ts` is the only
   * thing in this application that touches the marketplace tables for a root
   * cause, and it must not acquire the CST writer — a single module holding
   * both would be one edit away from writing what it read.
   */
  it("keeps the source lookup and the CST writer in separate modules", () => {
    const lookup = code(...REPOSITORY);
    expect(lookup).not.toContain("recordRootCause");
    expect(lookup).not.toContain("conversation_root_causes");
  });
});

describe("the two values stay two values", () => {
  /**
   * SEPARATE COMPONENTS, SEPARATELY LABELLED. The display of the message
   * application's value and the CST selector are different files under
   * different headings, so neither can be read as the other — and the guard
   * above, which asserts the display has nothing to operate, keeps meaning
   * something once a selector exists elsewhere in the sidebar.
   */
  /**
   * THE SELECTOR IS ITS OWN FILE, and stays one. Folding it back into the
   * 1,400-line panel would put a control that writes inside the component
   * every other sidebar feature also edits.
   */
  it("keeps the CST selector in its own component", () => {
    const selector = code("components", "root-cause-selector.tsx");
    expect(selector).toContain("CST_ROOT_CAUSE_HEADING");
    expect(selector).toContain("RootCauseSelector");
    expect(panel).toContain('from "./root-cause-selector"');
  });


  /**
   * THE KEY IS LOAD-BEARING, not decoration.
   *
   * The selector holds seven pieces of draft state — the chosen cause, the
   * explanation, the courier, the issue type, the note. Keyed by conversation,
   * switching threads remounts it and all of that starts empty. WITHOUT the
   * key, a half-filled selection would follow the agent to the next case and be
   * recorded against the wrong one.
   *
   * The component relies on this instead of clearing each field in an effect,
   * so if the key goes, the reset goes silently with it. Pinned here.
   */
  it("keys the selector by conversation, which is what clears a half-filled one", () => {
    expect(panel).toMatch(/<RootCauseSelector\s+key=\{`cst-root-cause-\$\{conversation\.id\}`\}/);
    const selector = code("components", "root-cause-selector.tsx");
    // No hand-rolled reset effect; the remount is the mechanism.
    expect(selector).not.toMatch(/useEffect\(\(\) => \{\s*setOpen\(false\)/);
  });

  /**
   * The CST selector NEVER SENDS the message application's value back. A POST
   * body assembled from what was read there would record their conclusion as
   * CST's own, and the whole point of showing both is that they can differ.
   */
  /**
   * THE SCREEN RENDERS THE SHARED VOCABULARY, NEVER A COPY OF IT.
   *
   * The three lists are the stored values AND the database's CHECK vocabulary.
   * A literal list in the component would be a fourth copy that nothing
   * compares against the other three — and the first symptom would be a chip an
   * agent can press producing a save the database rejects, in production, for
   * the one value somebody re-typed.
   */
  it("renders the shared vocabulary rather than a duplicate list", () => {
    const selector = code("components", "root-cause-selector.tsx");

    expect(selector).toContain("root-cause-vocabulary");
    for (const shared of ["ROOT_CAUSE_LABELS", "COURIERS", "COURIER_ISSUE_TYPES"]) {
      expect(selector, `selector must render ${shared}`).toContain(shared);
    }

    // No hand-typed option anywhere: every approved value appears only by
    // reference. A literal would show up as a quoted string in the component.
    for (const value of [
      "Lost parcel",
      "transit damage",
      "false/incorrect delivery scan",
      "collection/drop-off issue",
      "Royal Mail",
      "Amazon Shipping",
      "Smart Track",
    ]) {
      expect(selector, `selector must not hard-code ${value}`).not.toContain(value);
    }
  });

  /**
   * REVEALED BY OTHER BEING SELECTED, AND BY NOTHING ELSE.
   *
   * Asserted structurally, because no DOM environment is configured here and
   * what matters is which condition gates the field. `opensCustomRootCause` is
   * "OTHER is among the selected capsules" and nothing else, so the box cannot
   * appear for a selection without it — and cannot fail to appear for one with
   * it, whatever else is selected alongside.
   */
  it("reveals Enter Root Cause whenever OTHER is among the selected causes", () => {
    const selector = code("components", "root-cause-selector.tsx");

    expect(selector).toMatch(/const opensCustomRootCause = selected\.some\(isOtherLabel\)/);
    expect(selector).toMatch(/\{opensCustomRootCause && \(/);
    expect(selector).toContain("Enter Root Cause");
  });

  /**
   * AND STALE TEXT CANNOT BE PERSISTED, by two independent mechanisms.
   *
   * Deselecting OTHER clears the box, AND the value handed to the validator is
   * gated on the same condition that shows it. Either alone would do; both
   * means removing one does not silently reopen the hole. The server refuses
   * such text outright, so a leak would surface as a save failing for a reason
   * pointing at a field no longer on screen.
   */
  it("clears and gates the typed cause when OTHER is deselected", () => {
    const selector = code("components", "root-cause-selector.tsx");

    expect(selector).toMatch(/if \(isOtherLabel\(option\) && !next\.some\(isOtherLabel\)\) setCustomRootCause\(""\)/);
    const gated = selector.match(/customRootCause: opensCustomRootCause \? customRootCause : null/g) ?? [];
    expect(gated.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * ANY SELECTED CAPSULE OPENS THE COURIER LEVELS, and OTHER is not one of the
   * three that do. The courier block is gated on `opensCourierLevels`, which
   * asks whether ANY selected label requires courier detail — a different
   * condition entirely from the OTHER one, and the two are never conflated.
   */
  it("opens the courier levels from any courier-shaped capsule, and not from OTHER", () => {
    const selector = code("components", "root-cause-selector.tsx");
    expect(selector).toMatch(/const opensCourierLevels = selected\.some\(requiresCourierDetail\)/);
    expect(selector).toMatch(/\{opensCourierLevels && \(/);
    expect(selector).not.toMatch(/opensCustomRootCause \|\| opensCourierLevels/);
    expect(selector).not.toMatch(/opensCourierLevels \|\| opensCustomRootCause/);
  });

  /**
   * BOTH COURIER GROUPS APPEAR TOGETHER, and neither waits for the other.
   *
   * The issue type was once gated on a courier having been chosen, mirroring
   * the database rule that an issue type cannot stand without one. That kept
   * the save honest and made the form misleading — an agent could not see what
   * they would be asked for next.
   *
   * VISIBILITY AND VALIDITY ARE DIFFERENT QUESTIONS, and this pins the split:
   * both groups render on the same condition, while the SAVE rule that a
   * courier is required is asserted separately in the domain tests. Restoring
   * the gate would fail here rather than quietly hiding the options again.
   */
  it("shows Courier Service and Courier Issue Type together", () => {
    const selector = code("components", "root-cause-selector.tsx");

    expect(selector).toContain('legend="Courier Service"');
    expect(selector).toContain('legend="Courier Issue Type"');

    // Neither group is gated on a courier having been picked.
    expect(selector).not.toMatch(/\{courier !== null && \(/);

    // Both sit inside the one courier-shaped-cause condition.
    const block = /\{opensCourierLevels && \([\s\S]*?\n {10}\)\}/.exec(selector)?.[0] ?? "";
    expect(block).toContain('legend="Courier Service"');
    expect(block).toContain('legend="Courier Issue Type"');
    expect(block.indexOf('legend="Courier Service"')).toBeLessThan(
      block.indexOf('legend="Courier Issue Type"'),
    );
  });

  /**
   * ONE GROUP, AND NO TRACE OF THE ABANDONED PRIMARY/ADDITIONAL DESIGN. A
   * second group would reintroduce a rank the business rule does not have.
   */
  it("renders exactly one root cause group, multi-select", () => {
    const selector = code("components", "root-cause-selector.tsx");

    expect(selector).toContain('legend="Root cause"');
    for (const gone of [
      "Primary root cause",
      "Additional root causes",
      "additionalRootCauses",
      "primaryRootCause",
    ]) {
      expect(selector, "selector must not mention " + gone).not.toContain(gone);
    }
    // Multi-select: membership of a set, never equality with one value.
    expect(selector).toMatch(/isSelected=\{\(option\) => selected\.includes\(option\)\}/);
  });

  /**
   * THE TYPED CAUSE AND THE ISSUE NOTE ARE TWO CONTROLS, NOT ONE. They are
   * stored in different columns and answer different questions, and a form that
   * showed one box would force an agent to put the cause in the note — where no
   * report could ever group or count it.
   */
  it("renders the typed cause and the issue note as separate controls", () => {
    const selector = code("components", "root-cause-selector.tsx");

    expect(selector).toContain("Enter Root Cause");
    expect(selector).toContain("Note (optional)");
    expect(selector).toContain("maxLength={CUSTOM_ROOT_CAUSE_MAX_LENGTH}");
    expect(selector).toContain("maxLength={ISSUE_NOTE_MAX_LENGTH}");

    // Two distinct pieces of state, and neither is derived from the other.
    expect(selector).toMatch(/const \[customRootCause, setCustomRootCause\] = useState\(""\)/);
    expect(selector).toMatch(/const \[note, setNote\] = useState\(""\)/);
    expect(selector).not.toMatch(/issueNote: customRootCause/);
    expect(selector).not.toMatch(/customRootCause: note\b/);
  });

  it("never posts the message application's value as a CST selection", () => {
    const selector = code("components", "root-cause-selector.tsx");
    expect(selector).not.toContain("MessageAppRootCauseResponse");
    expect(selector).not.toContain("messageAppRootCauseView");
    expect(selector).not.toContain("distinctLabelCount");
  });
});

describe("root cause and the CST category stay separate systems", () => {
  it("does not import or mention the frozen category classifier", () => {
    for (const file of [DOMAIN, REPOSITORY, ROUTE]) {
      const source = code(...file);
      expect(source).not.toContain("message-category");
      expect(source).not.toContain("MESSAGE_CATEGORIES");
      expect(source).not.toContain("classifyConversationCategory");
      expect(source).not.toContain("categoryFor");
    }
  });

  it("does not reach the category corpus or its evidence tables", () => {
    for (const file of FEATURE_FILES) {
      const source = code(...file);
      expect(source).not.toContain("cst-category-corpus");
      expect(source).not.toContain("cst-category-evidence");
      expect(source).not.toContain("conversation_rule_analysis");
    }
  });

  it("leaves the category classifier file untouched by this feature", () => {
    // Read rather than asserted from git, so the check holds after a commit.
    // Nothing in the classifier may know that a root cause exists.
    const classifier = read("lib", "knowledge", "message-category.ts");
    expect(classifier).not.toContain("root_cause");
    expect(classifier).not.toContain("rootCause");
    expect(classifier).not.toContain("message-app-root-cause");
  });

  /** Root cause and the frozen CST category stay different systems. */
  it("keeps the category chip and the root cause selector separate", () => {
    const selector = code("components", "root-cause-selector.tsx");
    expect(selector).not.toContain("CategoryTag");
    expect(selector).not.toContain("category");
  });
});

describe("no second threading system", () => {
  it("resolves the conversation's rows from conversation_messages alone", () => {
    const repository = code(...REPOSITORY);
    expect(repository).toContain("cst_app.conversation_messages");
    // The message application rebuilds a thread per marketplace at read time.
    // Reimplementing that here would be a second grouping that could disagree
    // with the one on screen.
    for (const column of ["sender_id", "receiver_id", "folder_id", "mail_id", "subject"]) {
      expect(repository).not.toContain(column);
    }
  });

  it("takes its source tables from the marketplace adapters", () => {
    const repository = code(...REPOSITORY);
    for (const adapter of ["ebay", "amazon", "shopify", "bandq", "temu"]) {
      expect(repository).toContain(`@/lib/marketplaces/${adapter}/adapter`);
    }
  });

});
