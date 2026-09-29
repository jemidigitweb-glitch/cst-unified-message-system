import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRootCauseSelection } from "@/lib/domain/root-cause-selection";

import {
  canonicalRootCauseLabel,
  COURIER_ISSUE_TYPES,
  CUSTOM_ROOT_CAUSE_MAX_LENGTH,
  ISSUE_NOTE_MAX_LENGTH,
  ROOT_CAUSE_LABELS,
  ROOT_CAUSE_VOCABULARY_VERSION,
} from "@/lib/domain/root-cause-vocabulary";

/**
 * What an agent pressed, turned into a row or a refusal.
 *
 * PURE. No database, no network, no clock. Every value here is synthetic and
 * every root cause is a business classification, never customer content.
 */

/** The record, or a failure whose message names what actually went wrong. */
function record(input: Parameters<typeof readRootCauseSelection>[0]) {
  const result = readRootCauseSelection(input);
  if (!result.ok) throw new Error(`expected a record, refused with: ${result.error}`);
  return result.record;
}

/** The refusal message, or a failure if it was accepted. */
function refusal(input: Parameters<typeof readRootCauseSelection>[0]): string {
  const result = readRootCauseSelection(input);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

describe("choosing a cause", () => {
  it("records a plain label with no courier levels", () => {
    expect(record({ rootCauses: ["OUT OF STOCK"] })).toEqual({
      rootCauses: ["OUT OF STOCK"],
      customRootCause: null,
      courier: null,
      courierIssueType: null,
      issueNote: null,
      vocabularyVersion: ROOT_CAUSE_VOCABULARY_VERSION,
    });
  });

  /** What gets stored is OUR spelling, never whatever casing a request carried. */
  it("stores the canonical spelling of whatever casing arrived", () => {
    expect(record({ rootCauses: ["  out of stock "] }).rootCauses[0]).toBe("OUT OF STOCK");
    expect(record({ rootCauses: ["wrong address"] }).rootCauses[0]).toBe("Wrong Address");
  });

  it("asks for a cause when none was chosen", () => {
    expect(refusal({})).toBe("Choose a root cause.");
    expect(refusal({ rootCauses: ["   "] })).toBe("Choose a root cause.");
    expect(refusal({ rootCauses: [42] })).toBe("Choose a root cause.");
    expect(refusal({ rootCauses: [null] })).toBe("Choose a root cause.");
  });

  it("refuses a label that is not offered", () => {
    expect(refusal({ rootCauses: ["Courier Issue"] })).toBe("That root cause is not one of the options.");
  });

  /**
   * A REFUSAL IS WRITTEN FOR THE AGENT READING IT. It is rendered beside the
   * control they were using, so it says what to do — never which constraint,
   * column or table disagreed.
   */
  it("never names a constraint, column or table in a refusal", () => {
    const messages = [
      refusal({}),
      refusal({ rootCauses: ["nonsense"] }),
      refusal({ rootCauses: ["OTHER"] }),
      refusal({ rootCauses: ["Delivery Issue"] }),
      refusal({ rootCauses: ["Delivery Issue"], courier: "Yodel" }),
      refusal({ rootCauses: ["OUT OF STOCK"], courier: "DPD" }),
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/ck_|cst_app|conversation_root_causes|CHECK|null/i);
      // A sentence, not a code.
      expect(message).toMatch(/[.!]$/);
    }
  });
});

describe("selecting one or many causes", () => {
  /**
   * ONE SET OF EQUAL LABELS, AND NO PRIMARY.
   *
   * An earlier, unshipped design had a primary cause plus a separate list of
   * additional ones. It was removed rather than kept alongside: a rank nothing
   * in the business rule asks for is a rank a report would have to invent a
   * meaning for, and dead compatibility code for a design never deployed is
   * worse than no code.
   */
  it("records a single selected cause", () => {
    expect(record({ rootCauses: ["PARTS MISSING"] }).rootCauses).toEqual(["PARTS MISSING"]);
  });

  it("records several, in the order they were selected", () => {
    expect(
      record({ rootCauses: ["PARTS MISSING", "PRODUCT_QUALITY"] }).rootCauses,
    ).toEqual(["PARTS MISSING", "PRODUCT_QUALITY"]);
  });

  /** The worked example from the requirement. */
  it("records three causes including OTHER, with its wording and a note", () => {
    const stored = record({
      rootCauses: ["PARTS MISSING", "Delivery Issue", "OTHER"],
      customRootCause: "Incorrect mounting bracket supplied",
      courier: "EVRI",
      courierIssueType: "transit damage",
      issueNote: "Parcel was also damaged during delivery.",
    });
    expect(stored.rootCauses).toEqual(["PARTS MISSING", "Delivery Issue", "OTHER"]);
    expect(stored.customRootCause).toBe("Incorrect mounting bracket supplied");
    expect(stored.courier).toBe("EVRI");
    expect(stored.courierIssueType).toBe("transit damage");
    expect(stored.issueNote).toBe("Parcel was also damaged during delivery.");
  });

  /** At least one. A revision with no causes records nothing. */
  it("requires at least one cause", () => {
    for (const nothing of [{}, { rootCauses: [] }, { rootCauses: null }, { rootCauses: ["", "  "] }]) {
      expect(refusal(nothing)).toBe("Choose a root cause.");
    }
  });

  it("refuses a value that is not a list", () => {
    expect(refusal({ rootCauses: "PARTS MISSING" })).toBe("Root causes must be a list.");
  });

  /**
   * A duplicate would double that label's mention count against a case that
   * named it once. The unique constraint would reject it too, but as an opaque
   * 500 rather than a sentence.
   */
  it("refuses the same cause twice, in any casing", () => {
    expect(refusal({ rootCauses: ["RETURN", "RETURN"] })).toBe(
      "That root cause is already selected.",
    );
    expect(refusal({ rootCauses: ["RETURN", "return"] })).toBe(
      "That root cause is already selected.",
    );
  });

  it("refuses an unknown or free-text label", () => {
    for (const bad of ["Courier Issue", "customer was rude", "'; DROP TABLE x; --"]) {
      expect(refusal({ rootCauses: [bad] })).toBe("That root cause is not one of the options.");
    }
  });

  it("stores the canonical spelling, not the casing that arrived", () => {
    expect(record({ rootCauses: ["out of stock", "wrong address"] }).rootCauses).toEqual([
      "OUT OF STOCK",
      "Wrong Address",
    ]);
  });

  it("never promotes a selection into the offered vocabulary", () => {
    const before = [...ROOT_CAUSE_LABELS];
    record({ rootCauses: ["INVOICE", "DISCOUNT"] });
    expect([...ROOT_CAUSE_LABELS]).toEqual(before);
  });

  /**
   * NO PRIMARY/ADDITIONAL SEMANTICS SURVIVE ANYWHERE. Asserted against the
   * source so a partially-reverted refactor cannot leave the old concept
   * lingering in a type, a field name or a comment that future readers would
   * take for current design.
   */
  it("leaves no trace of the abandoned primary/additional model", () => {
    for (const file of [
      "lib/domain/root-cause-selection.ts",
      "lib/repositories/conversation-root-cause-repository.ts",
      "components/root-cause-selector.tsx",
      "migrations/0020_conversation_root_cause.up.sql",
    ]) {
      /*
       * Comments stripped first. The migration's prose explains that there is
       * deliberately NO `is_primary` column — saying so is the opposite of
       * having one, and a raw text search cannot tell the two apart.
       */
      const source = readFileSync(join(__dirname, "..", "..", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*(\/\/|--).*$/gm, " ")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
      for (const gone of [
        "additionalRootCauses",
        "primaryRootCause",
        "is_primary",
        "isPrimary",
        "conversation_root_cause_additional_labels",
        "Additional root causes",
      ]) {
        expect(source, `${file} still mentions ${gone}`).not.toContain(gone);
      }
    }
  });
});

describe("the OTHER flow — a staff-entered root cause", () => {
  const TYPED = "Customer requested an unusual packaging change after dispatch";

  /**
   * TWO FIELDS, BOTH KEPT, AND THIS IS A REVERSAL OF THE FIRST DESIGN.
   *
   * The first version copied the message application: the prose OVERWROTE
   * `root_cause` and the word OTHER was never stored. That lost the fact that
   * OTHER had been chosen — every such case became its own one-off category —
   * and made "how often does nothing fit" unanswerable.
   *
   * Now the label and the typed cause are separate columns, so a report can
   * count the group AND read each case.
   */
  it("keeps the predefined OTHER and the typed cause as separate fields", () => {
    const stored = record({ rootCauses: ["OTHER"], customRootCause: TYPED });
    expect(stored.rootCauses[0]).toBe("OTHER");
    expect(stored.customRootCause).toBe(TYPED);
  });

  /** The agent's actual wording, not re-cased, reworded or truncated. */
  it("preserves the exact staff wording", () => {
    const awkward = "Customer's  SECOND request — re-pack w/ bubble wrap (urgent!)";
    const stored = record({ rootCauses: ["OTHER"], customRootCause: awkward });
    expect(stored.customRootCause).toBe(awkward);
  });

  it("trims the typed cause at the ends and nowhere else", () => {
    expect(record({ rootCauses: ["OTHER"], customRootCause: `  ${TYPED}  ` }).customRootCause).toBe(
      TYPED,
    );
  });

  it("requires a typed cause when OTHER is chosen", () => {
    expect(refusal({ rootCauses: ["OTHER"] })).toBe("Enter the root cause.");
  });

  /** Whitespace is nothing, and nothing is not a root cause. */
  it("refuses a whitespace-only typed cause", () => {
    for (const blank of ["   ", "\t", "\n  \n", ""]) {
      expect(refusal({ rootCauses: ["OTHER"], customRootCause: blank })).toBe("Enter the root cause.");
    }
  });

  /**
   * NO MINIMUM BEYOND NON-BLANK, and this is a deliberate departure from the
   * message application's 30-character rule. That rule belonged to a different
   * field: there the prose BECAME the root cause, so a two-word answer left a
   * case effectively uncategorised. Here the category is already recorded — it
   * is OTHER — and this column supplies the detail.
   */
  it("imposes no minimum length on the typed cause", () => {
    expect(record({ rootCauses: ["OTHER"], customRootCause: "Lost" }).customRootCause).toBe("Lost");
    expect(
      record({ rootCauses: ["OTHER"], customRootCause: "Packaging change" }).customRootCause,
    ).toBe("Packaging change");
  });

  it("keeps one generous technical ceiling", () => {
    const long = "x".repeat(CUSTOM_ROOT_CAUSE_MAX_LENGTH + 1);
    expect(refusal({ rootCauses: ["OTHER"], customRootCause: long })).toContain(
      String(CUSTOM_ROOT_CAUSE_MAX_LENGTH),
    );
    expect(
      record({ rootCauses: ["OTHER"], customRootCause: "y".repeat(CUSTOM_ROOT_CAUSE_MAX_LENGTH) })
        .customRootCause,
    ).toHaveLength(CUSTOM_ROOT_CAUSE_MAX_LENGTH);
  });

  /**
   * STALE TEXT IS REFUSED, NOT QUIETLY DROPPED — the same reasoning as a
   * courier on a non-courier cause. The screen clears the box when the agent
   * moves off OTHER, so text arriving with another label means a caller has
   * gone out of step with the form. Discarding it silently would tell an agent
   * their own words were saved when nothing will ever show them.
   */
  it("refuses a typed cause supplied alongside a predefined label", () => {
    expect(refusal({ rootCauses: ["RETURN"], customRootCause: TYPED })).toBe(
      "A typed root cause only applies when OTHER is selected.",
    );
  });

  /** And a predefined label never carries one. */
  it("leaves the typed cause null for every predefined label", () => {
    for (const label of ["OUT OF STOCK", "RETURN", "Delivery Issue"]) {
      const stored = record(
        label === "Delivery Issue"
          ? { rootCauses: [label], courier: "DPD" }
          : { rootCauses: [label] },
      );
      expect(stored.customRootCause).toBeNull();
    }
  });

  /**
   * THE TYPED CAUSE NEVER JOINS THE OFFERED VOCABULARY. The chip list is
   * measured from the message application and changing it is a deliberate act
   * with a version bump — not a side effect of somebody typing a sentence.
   */
  it("does not promote a typed cause into the predefined options", () => {
    const before = [...ROOT_CAUSE_LABELS];
    record({ rootCauses: ["OTHER"], customRootCause: TYPED });
    expect([...ROOT_CAUSE_LABELS]).toEqual(before);
    expect(ROOT_CAUSE_LABELS).not.toContain(TYPED);
    expect(canonicalRootCauseLabel(TYPED)).toBeNull();
  });

  /**
   * THE TWO FREE-TEXT FIELDS ARE NOT THE SAME FIELD, and never collapse into
   * one. The typed cause says what the problem IS; the note says what else a
   * reader should know. A case whose cause lived in the note column could never
   * be grouped or counted.
   */
  it("keeps the typed cause and the issue note separate", () => {
    const note = "Customer contacted us after the warehouse had already packed the order.";
    const stored = record({ rootCauses: ["OTHER"], customRootCause: TYPED, issueNote: note });
    expect(stored.rootCauses[0]).toBe("OTHER");
    expect(stored.customRootCause).toBe(TYPED);
    expect(stored.issueNote).toBe(note);
    expect(stored.customRootCause).not.toBe(stored.issueNote);
  });

  /** A note alone is not a cause: OTHER still needs its own field filled. */
  it("does not accept an issue note in place of the typed cause", () => {
    expect(refusal({ rootCauses: ["OTHER"], issueNote: "Some supporting detail." })).toBe(
      "Enter the root cause.",
    );
  });

  /**
   * OTHER DOES NOT OPEN THE COURIER LEVELS. Only the three approved Level-1
   * triggers do, and OTHER is not one of them.
   */
  it("does not open the courier hierarchy", () => {
    const stored = record({ rootCauses: ["OTHER"], customRootCause: TYPED });
    expect(stored.courier).toBeNull();
    expect(stored.courierIssueType).toBeNull();
    // And supplying one is refused, exactly as for any other non-courier cause.
    expect(refusal({ rootCauses: ["OTHER"], customRootCause: TYPED, courier: "DPD" })).toBe(
      "Courier details only apply to a delivery, fulfilment or carrier root cause.",
    );
  });
});

describe("the courier levels", () => {
  it("records all four levels for a delivery cause", () => {
    expect(
      record({
        rootCauses: ["Delivery Issue"],
        courier: "EVRI",
        courierIssueType: "Lost parcel",
        issueNote: "Scanned as delivered, customer has nothing.",
      }),
    ).toEqual({
      rootCauses: ["Delivery Issue"],
      customRootCause: null,
      courier: "EVRI",
      courierIssueType: "Lost parcel",
      issueNote: "Scanned as delivered, customer has nothing.",
      vocabularyVersion: ROOT_CAUSE_VOCABULARY_VERSION,
    });
  });

  /**
   * THE CAUSE AND THE COURIER ARE FOLDED; THE ISSUE TYPE IS NOT.
   *
   * The root cause list folds because the source genuinely holds `Out of stock`
   * beside `OUT OF STOCK` — the message application validates case-insensitively
   * and stores verbatim, so those ARE one label. The issue type list has no
   * upstream system and no historical rows; it was specified for this feature,
   * character for character, so there is no variant that is legitimately the
   * same value.
   */
  it("canonicalises the cause and the courier, and takes the issue type as given", () => {
    const stored = record({
      rootCauses: ["fulfilment_carrier"],
      courier: "evri",
      courierIssueType: "transit damage",
    });
    expect(stored.rootCauses[0]).toBe("FULFILMENT_CARRIER");
    expect(stored.courier).toBe("EVRI");
    expect(stored.courierIssueType).toBe("transit damage");
  });

  /** Every approved issue type is recordable through the selection rule. */
  it("records each of the ten approved issue types", () => {
    for (const approved of COURIER_ISSUE_TYPES) {
      const stored = record({
        rootCauses: ["Delivery Issue"],
        courier: "DPD",
        courierIssueType: approved,
      });
      expect(stored.courierIssueType).toBe(approved);
    }
  });

  /** And a variant is refused here too, not just by the vocabulary module. */
  it("refuses a case or punctuation variant of an approved issue type", () => {
    for (const variant of [
      "Transit damage",
      "false or incorrect delivery scan",
      "collection or drop-off issue",
      "Other",
    ]) {
      expect(
        refusal({ rootCauses: ["Delivery Issue"], courier: "DPD", courierIssueType: variant }),
        `${variant} must be refused`,
      ).toBe("That issue type is not one of the options.");
    }
  });

  /**
   * REQUIRED, AND THIS IS THE ONE PLACE STRICTER THAN THE DATABASE. The column
   * is nullable there; here it is not, because this feature exists to answer
   * "which courier causes the most problems" and an optional field on the one
   * screen that feeds the report is a field that comes back empty. `Other` is on
   * the list for the case where the courier genuinely is not one of the nine.
   */
  it("requires a courier once a courier-shaped cause is chosen", () => {
    for (const label of ["Delivery Issue", "FULFILMENT_CARRIER", "FULFILMENT_WAREHOUSE"]) {
      expect(refusal({ rootCauses: [label] })).toBe("Choose the courier.");
    }
  });

  it("accepts Other as an honest courier", () => {
    expect(record({ rootCauses: ["Delivery Issue"], courier: "Other" }).courier).toBe("Other");
  });

  it("refuses a courier nobody offers", () => {
    expect(refusal({ rootCauses: ["Delivery Issue"], courier: "Yodel" })).toBe(
      "That courier is not one of the options.",
    );
  });

  /**
   * THE ISSUE TYPE STAYS OPTIONAL, matching
   * `ck_conversation_root_causes_issue_type_needs_courier`. Which courier
   * carried a parcel is a fact an agent has in front of them; what the courier
   * did wrong is often still being established, and forcing a choice would buy a
   * filled-in field at the price of a guessed one.
   */
  it("lets a courier be recorded before the kind of problem is known", () => {
    const stored = record({ rootCauses: ["Delivery Issue"], courier: "DPD" });
    expect(stored.courier).toBe("DPD");
    expect(stored.courierIssueType).toBeNull();
  });

  it("refuses an issue type nobody offers", () => {
    expect(
      refusal({ rootCauses: ["Delivery Issue"], courier: "DPD", courierIssueType: "Left in bin" }),
    ).toBe("That issue type is not one of the options.");
  });

  /**
   * REFUSED, NOT QUIETLY DROPPED. The screen only offers these levels for the
   * three labels that open them, so a courier arriving with any other cause
   * means a caller has gone out of step with the form — and silently discarding
   * it would tell an agent their answer was saved when the report will never
   * show it.
   */
  it("refuses courier detail attached to a cause that does not open it", () => {
    const expected = "Courier details only apply to a delivery, fulfilment or carrier root cause.";
    expect(refusal({ rootCauses: ["OUT OF STOCK"], courier: "DPD" })).toBe(expected);
    expect(refusal({ rootCauses: ["RETURN"], courierIssueType: "Lost parcel" })).toBe(expected);
  });

  /** Blank is absent, so an untouched control on a hidden section is harmless. */
  it("treats blank courier fields on a non-courier cause as untouched", () => {
    expect(record({ rootCauses: ["OUT OF STOCK"], courier: "  ", courierIssueType: "" })).toEqual({
      rootCauses: ["OUT OF STOCK"],
      customRootCause: null,
      courier: null,
      courierIssueType: null,
      issueNote: null,
      vocabularyVersion: ROOT_CAUSE_VOCABULARY_VERSION,
    });
  });

  /** An issue type alone can never reach the row; the database says so too. */
  it("never produces an issue type without a courier", () => {
    const accepted = [
      { rootCauses: ["Delivery Issue"], courier: "DPD", courierIssueType: "Lost parcel" },
      { rootCauses: ["Delivery Issue"], courier: "DPD" },
      { rootCauses: ["OUT OF STOCK"] },
    ];
    for (const input of accepted) {
      const stored = record(input);
      if (stored.courierIssueType !== null) expect(stored.courier).not.toBeNull();
    }
  });
});

describe("the note", () => {
  it("keeps an agent's own account of what happened", () => {
    expect(
      record({ rootCauses: ["Delivery Issue"], courier: "GLS", issueNote: "  Driver left it next door.  " })
        .issueNote,
    ).toBe("Driver left it next door.");
  });

  /** Blank is no note; absent is the honest way to record "none given". */
  it("treats a blank note as no note", () => {
    expect(record({ rootCauses: ["RETURN"], issueNote: "   " }).issueNote).toBeNull();
    expect(record({ rootCauses: ["RETURN"], issueNote: 7 }).issueNote).toBeNull();
  });

  it("refuses a note longer than the cap", () => {
    expect(
      refusal({ rootCauses: ["RETURN"], issueNote: "x".repeat(ISSUE_NOTE_MAX_LENGTH + 1) }),
    ).toContain(String(ISSUE_NOTE_MAX_LENGTH));
  });

  it("accepts a note of exactly the cap", () => {
    expect(
      record({ rootCauses: ["RETURN"], issueNote: "x".repeat(ISSUE_NOTE_MAX_LENGTH) }).issueNote,
    ).toHaveLength(ISSUE_NOTE_MAX_LENGTH);
  });

  /** A note is optional at every level; it is level four of four. */
  it("is never required", () => {
    expect(record({ rootCauses: ["RETURN"] }).issueNote).toBeNull();
    expect(record({ rootCauses: ["Delivery Issue"], courier: "DHL" }).issueNote).toBeNull();
  });

  /**
   * NORMAL SHORT SUPPORT NOTES ARE ACCEPTED — the whole point of the field.
   * A one-word note is as valid as a paragraph; "the exact problem" is
   * sometimes three words long.
   */
  it("accepts ordinary notes of every ordinary length", () => {
    for (const note of [
      "Lost.",
      "Driver left it next door.",
      "Tracking stopped at the depot on the 14th and has not moved since; customer has called twice.",
      "Scanned as delivered at 11:04 but the customer was at the address all day and nothing arrived. Neighbours have nothing either.",
    ]) {
      expect(record({ rootCauses: ["Delivery Issue"], courier: "GLS", issueNote: note }).issueNote).toBe(
        note,
      );
    }
  });

  /**
   * NO MINIMUM LENGTH, AND NO PADDING.
   *
   * The requirement asks for a short free-text note and says nothing about
   * length, so nothing here decides how long a note ought to be. A single
   * character is accepted.
   *
   * NEITHER free-text field carries a minimum now. The 30-character rule that
   * once guarded the OTHER flow was the message application's, belonged to a
   * field whose prose BECAME the root cause, and went when that stopped being
   * how OTHER is stored.
   */
  it("imposes no minimum length", () => {
    expect(record({ rootCauses: ["RETURN"], issueNote: "x" }).issueNote).toBe("x");
    expect(record({ rootCauses: ["RETURN"], issueNote: "x".repeat(29) }).issueNote).toHaveLength(29);
  });
});

describe("the stamped version", () => {
  /**
   * STAMPED AT WRITE TIME, never resolved later, so changing the list tomorrow
   * does not silently rewrite today's provenance — the same reasoning
   * `automation_items` uses for `template_version`.
   */
  it("stamps every record with the version that produced its labels", () => {
    for (const input of [
      { rootCauses: ["OUT OF STOCK"] },
      { rootCauses: ["Delivery Issue"], courier: "USPS" },
      { rootCauses: ["OTHER"], customRootCause: "Packaging change after dispatch" },
    ]) {
      expect(record(input).vocabularyVersion).toBe(ROOT_CAUSE_VOCABULARY_VERSION);
    }
  });
});

describe("hostile input", () => {
  /**
   * The body arrives from a browser and is `unknown` until proven otherwise.
   * Nothing here may throw on a shape it did not expect — a malformed request is
   * a 400, never a 500.
   */
  it("refuses rather than throwing on anything at all", () => {
    const nasty: unknown[] = [
      { rootCauses: [{ toString: () => "RETURN" }] },
      { rootCauses: [["RETURN"]] },
      { rootCauses: ["RETURN"], issueNote: { length: 5 } },
      { rootCauses: ["Delivery Issue"], courier: true },
      { rootCauses: ["OTHER"], customRootCause: ["x".repeat(40)] },
      { rootCauses: ["OTHER"], customRootCause: { toString: () => "typed" } },
      { rootCauses: ["RETURN"], courier: 1, courierIssueType: 2 },
    ];
    for (const input of nasty) {
      expect(() => readRootCauseSelection(input as never)).not.toThrow();
    }
  });

  /** A SQL-shaped string is just a label that is not offered. */
  it("treats an injection attempt as an unknown label", () => {
    expect(refusal({ rootCauses: ["'; DROP TABLE conversations; --"] })).toBe(
      "That root cause is not one of the options.",
    );
  });
});
