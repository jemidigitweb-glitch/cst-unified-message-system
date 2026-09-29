import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INTERNAL_NOTE_MAX_LENGTH } from "@/lib/domain/internal-note";
import { rootCauseLabelKey } from "@/lib/domain/message-app-root-cause";
import {
  canonicalCourier,
  canonicalCourierIssueType,
  canonicalRootCauseLabel,
  COURIER_DETAIL_LABELS,
  COURIER_ISSUE_TYPES,
  COURIERS,
  CUSTOM_ROOT_CAUSE_MAX_LENGTH,
  ISSUE_NOTE_MAX_LENGTH,
  isOtherLabel,
  OTHER_LABEL,
  requiresCourierDetail,
  ROOT_CAUSE_LABELS,
  ROOT_CAUSE_VOCABULARY_VERSION,
  rootCauseChipText,
} from "@/lib/domain/root-cause-vocabulary";

/**
 * The three lists an agent chooses from.
 *
 * PURE. No database, no network, no clock — except the one test that reads
 * migration 0020 as TEXT, which is the whole point of it: the courier lists here
 * and the CHECK constraints there have to be the same list, and the only way to
 * prove that is to compare them.
 */

const UP_SQL = readFileSync(
  join(__dirname, "..", "..", "migrations", "0020_conversation_root_cause.up.sql"),
  "utf8",
);

/**
 * The labels inside one named CHECK, in order.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The migration's prose
 * explains why the approved casing is irregular, and saying so in English means
 * writing apostrophes — `the business's`, `wrote 'or' for '/'`. To a regex
 * looking for quoted literals those are indistinguishable from values, and this
 * helper read four of them as couriers. Only executable SQL is searched.
 */
function checkedLabels(name: string): string[] {
  const sql = UP_SQL.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const at = new RegExp(`CONSTRAINT\\s+${name}(?![\\w])`).exec(sql)?.index;
  if (at === undefined) return [];
  const clause = sql.slice(at).split(/\n\s*CONSTRAINT\b|\)\s*\);/)[0] ?? "";
  return [...clause.matchAll(/'([^']+)'/g)].map(([, label]) => label);
}

describe("the root cause labels", () => {
  /**
   * EIGHTEEN, AND EVERY ONE MEASURED. The list was taken from what the message
   * application has actually stored across all five marketplace tables, not from
   * anybody's idea of what the categories ought to be. Adding an invented label
   * here would put a chip on screen that no report of the existing 40,000-odd
   * rows could ever match.
   */
  it("offers the eighteen labels the message application actually records", () => {
    expect(ROOT_CAUSE_LABELS).toEqual([
      "OUT OF STOCK",
      "LISTING_CONTENT",
      "RETURN",
      "CUSTOMER_MISUSE",
      "Charge Back",
      "Delivery Issue",
      "INVOICE",
      "PRODUCT_QUALITY",
      "Wrong Address",
      "FULFILMENT_WAREHOUSE",
      "FULFILMENT_CARRIER",
      "MARKETPLACE_ADMIN",
      "PRE_SALES_QUERY",
      "PARTS MISSING",
      "DISCOUNT",
      "EBAY_RECALL",
      "TRANSFORMER_ISSUE",
      "OTHER",
    ]);
  });

  /** One chip per label; a repeat would be a silently unreachable option. */
  it("lists no label twice, in any casing", () => {
    const keys = ROOT_CAUSE_LABELS.map(rootCauseLabelKey);
    expect(new Set(keys).size).toBe(ROOT_CAUSE_LABELS.length);
  });

  /**
   * THE ESCAPE HATCH GOES LAST, and it is the only label out of frequency
   * order. OTHER is the second most recorded value in the source; placed where
   * frequency would put it, it sits beside the answer as the easy way out of
   * thinking of one.
   */
  it("puts OTHER at the end, where an escape hatch belongs", () => {
    expect(ROOT_CAUSE_LABELS.at(-1)).toBe(OTHER_LABEL);
    expect(ROOT_CAUSE_LABELS.indexOf(OTHER_LABEL)).toBe(ROOT_CAUSE_LABELS.length - 1);
  });

  it("recognises a label whatever casing it arrives in, and returns ours", () => {
    expect(canonicalRootCauseLabel("out of stock")).toBe("OUT OF STOCK");
    expect(canonicalRootCauseLabel("  Out Of Stock  ")).toBe("OUT OF STOCK");
    expect(canonicalRootCauseLabel("delivery issue")).toBe("Delivery Issue");
    expect(canonicalRootCauseLabel("fulfilment_carrier")).toBe("FULFILMENT_CARRIER");
  });

  /**
   * The source really holds `Out of stock` beside `OUT OF STOCK` and `Return`
   * beside `RETURN`, because the writer validates case-insensitively and stores
   * verbatim. Those are the same label and must fold to one chip.
   */
  it("folds the case variants the source actually contains", () => {
    expect(canonicalRootCauseLabel("Out of stock")).toBe("OUT OF STOCK");
    expect(canonicalRootCauseLabel("Return")).toBe("RETURN");
  });

  it("refuses a label nobody offers", () => {
    expect(canonicalRootCauseLabel("Courier Issue")).toBeNull();
    expect(canonicalRootCauseLabel("")).toBeNull();
    expect(canonicalRootCauseLabel("DROP TABLE")).toBeNull();
  });

  it("knows the escape hatch in any casing", () => {
    expect(isOtherLabel("OTHER")).toBe(true);
    expect(isOtherLabel("other")).toBe(true);
    expect(isOtherLabel(" Other ")).toBe(true);
    expect(isOtherLabel("RETURN")).toBe(false);
  });

  /**
   * OTHER IS NOW A STORED LABEL, and the 30-character minimum that used to
   * guard its free text is gone with the field it belonged to.
   *
   * That rule was the message application's, and it made sense there: choosing
   * OTHER overwrote the root cause with prose, so a two-word answer left a case
   * effectively uncategorised. Here the category IS recorded — `root_cause`
   * holds `OTHER` — and `custom_root_cause` supplies the detail beside it.
   */
  it("no longer carries the message application's explanation minimum", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "domain", "root-cause-vocabulary.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/OTHER_EXPLANATION_MIN_LENGTH/);
    expect(source).not.toMatch(/export const \w*MIN_LENGTH/);
  });
});

describe("the labels that open the courier levels", () => {
  /**
   * THESE ARE EXISTING LABELS, NOT NEW ONES. The four-level hierarchy hangs off
   * the vocabulary the message application already uses, so a CST recording
   * stays comparable with a message-app one. A fresh level-1 label would make
   * every CST row unmatchable against the rows already filed under these.
   */
  it("uses three labels the message application already records", () => {
    expect(COURIER_DETAIL_LABELS).toEqual([
      "Delivery Issue",
      "FULFILMENT_CARRIER",
      "FULFILMENT_WAREHOUSE",
    ]);
    for (const label of COURIER_DETAIL_LABELS) {
      expect(ROOT_CAUSE_LABELS).toContain(label);
    }
  });

  it("opens the levels for exactly those three, and for nothing else", () => {
    const opening = ROOT_CAUSE_LABELS.filter(requiresCourierDetail);
    expect([...opening].sort()).toEqual([...COURIER_DETAIL_LABELS].sort());
  });

  it("decides on the label, not on its casing", () => {
    expect(requiresCourierDetail("delivery issue")).toBe(true);
    expect(requiresCourierDetail(" FULFILMENT_CARRIER ")).toBe(true);
    expect(requiresCourierDetail("Wrong Address")).toBe(false);
  });
});

describe("the courier lists and the database agree", () => {
  /**
   * THE POINT OF THIS FILE'S EXISTENCE, IN TWO TESTS.
   *
   * These lists are rendered as chips AND enforced by a CHECK. If they drift, a
   * chip an agent can press becomes a save the database rejects — a bug that
   * appears only in production, only for the one label somebody edited, and
   * looks like a server fault rather than a typo.
   */
  it("offers exactly the couriers the CHECK admits, in the same order", () => {
    expect([...COURIERS]).toEqual(checkedLabels("ck_conversation_root_causes_courier"));
  });

  /**
   * THE APPROVED TEN, CHARACTER FOR CHARACTER AND IN ORDER.
   *
   * Written out as literals rather than compared only against the migration,
   * because comparing two lists to each other proves they agree and not that
   * either is right. An earlier version of this file tidied the casing and
   * replaced the two slashes with "or", and the migration agreed with it — both
   * were wrong together and every test passed.
   */
  it("offers exactly the ten approved issue types, verbatim and in order", () => {
    expect([...COURIER_ISSUE_TYPES]).toEqual([
      "Lost parcel",
      "transit damage",
      "parcel damaged by courier",
      "delivered to wrong address",
      "false/incorrect delivery scan",
      "delayed delivery",
      "no tracking update",
      "returned to sender",
      "collection/drop-off issue",
      "other",
    ]);
  });

  it("offers exactly the issue types the CHECK admits, in the same order", () => {
    expect([...COURIER_ISSUE_TYPES]).toEqual(
      checkedLabels("ck_conversation_root_causes_issue_type"),
    );
  });

  /**
   * The irregular casing is the specification, not a mistake to normalise.
   * Item 1 is capitalised; items 2-10 are not. Pinned on its own so a
   * well-meant "consistency" edit fails with a message that says why.
   */
  it("keeps the approved casing, irregular as it is", () => {
    expect(COURIER_ISSUE_TYPES[0]).toBe("Lost parcel");
    for (const value of COURIER_ISSUE_TYPES.slice(1)) {
      expect(value, `${value} must not be re-capitalised`).toBe(value.toLowerCase());
    }
  });

  /** And the two slashes, which a tidy-up turned into the word "or". */
  it("keeps the slash in the two values that carry one", () => {
    expect(COURIER_ISSUE_TYPES).toContain("false/incorrect delivery scan");
    expect(COURIER_ISSUE_TYPES).toContain("collection/drop-off issue");
    for (const value of COURIER_ISSUE_TYPES) {
      expect(value).not.toContain(" or ");
    }
  });

  /** Every approved value is storable; none is refused by its own list. */
  it("accepts all ten approved issue types", () => {
    for (const approved of COURIER_ISSUE_TYPES) {
      expect(canonicalCourierIssueType(approved), `${approved} must be accepted`).toBe(approved);
    }
  });

  /**
   * AND REFUSES A VARIANT RATHER THAN REPAIRING IT.
   *
   * This is the one vocabulary matched exactly. The root cause list is folded,
   * because the source genuinely holds `Out of stock` beside `OUT OF STOCK` and
   * those ARE one label. This list has no upstream system and no historical
   * rows — it was specified for this feature — so there is no variant that is
   * legitimately the same value. Accepting one would mean the approved list and
   * the storable list had quietly stopped being the same list.
   */
  it("refuses a case or punctuation variant that is not on the approved list", () => {
    for (const variant of [
      "Transit damage",
      "TRANSIT DAMAGE",
      "Parcel damaged by courier",
      "Delivered to wrong address",
      "false or incorrect delivery scan",
      "False/incorrect delivery scan",
      "collection or drop-off issue",
      "Collection/drop-off issue",
      "Other",
      "lost parcel",
    ]) {
      expect(canonicalCourierIssueType(variant), `${variant} must be refused`).toBeNull();
    }
  });

  /** Surrounding whitespace is a transport artefact, not a different answer. */
  it("trims surrounding whitespace and forgives nothing else", () => {
    expect(canonicalCourierIssueType("  transit damage  ")).toBe("transit damage");
    expect(canonicalCourierIssueType("transit  damage")).toBeNull();
  });

  it("names ten of each", () => {
    expect(COURIERS).toHaveLength(10);
    expect(COURIER_ISSUE_TYPES).toHaveLength(10);
  });

  it("lists no courier or issue type twice", () => {
    expect(new Set(COURIERS.map(rootCauseLabelKey)).size).toBe(COURIERS.length);
    expect(new Set(COURIER_ISSUE_TYPES.map(rootCauseLabelKey)).size).toBe(
      COURIER_ISSUE_TYPES.length,
    );
  });

  it("canonicalises a courier and refuses the rest", () => {
    expect(canonicalCourier("evri")).toBe("EVRI");
    expect(canonicalCourier("royal mail")).toBe("Royal Mail");
    expect(canonicalCourier("Yodel")).toBeNull();
  });

  it("refuses an issue type nobody approved", () => {
    expect(canonicalCourierIssueType("Left in bin")).toBeNull();
    expect(canonicalCourierIssueType("")).toBeNull();
  });

  /**
   * ALL THREE LISTS CARRY AN ESCAPE HATCH, AND ALL THREE ARE STORED.
   *
   * `OTHER` is an ordinary selectable cause: it may be chosen alongside any
   * other label, and it is written to the label table like the rest. What
   * distinguishes it is an obligation rather than a prohibition — selecting it
   * requires the agent's own wording in `custom_root_cause`.
   *
   * THAT OBLIGATION IS NOT IN THE SCHEMA, and this pins its absence so nobody
   * reads the SQL and assumes the database is checking. The labels live in the
   * child table and the explanation on the parent, so the rule spans two tables
   * — expressible only with a trigger, which 0020 deliberately does not add.
   * `readRootCauseSelection` enforces it before any write.
   */
  it("stores every escape hatch, and leaves the OTHER obligation to the domain", () => {
    expect(COURIERS).toContain("Other");
    expect(COURIER_ISSUE_TYPES).toContain("other");
    expect(ROOT_CAUSE_LABELS).toContain(OTHER_LABEL);

    // Nothing in the schema forbids OTHER, and nothing there pairs it either.
    expect(UP_SQL).not.toMatch(/root_cause\s*\)\s*\)\s*<>\s*'OTHER'/);
    expect(UP_SQL).not.toContain("ck_conversation_root_causes_other_pair");
    expect(UP_SQL).not.toMatch(/CREATE\s+TRIGGER/i);

    // The rule lives here, and the migration says where.
    expect(UP_SQL).toMatch(/root-cause-selection\.ts/);
  });

  /**
   * THE COURIER LIST IS UNCHANGED, and this pins it byte for byte.
   *
   * The Level-3 correction touched the issue types alone. Level 2 was verified
   * as exact and must stay that way — a list "fixed" in sympathy with its
   * neighbour would be a regression introduced by a correction.
   */
  it("leaves the courier list byte for byte as approved", () => {
    expect([...COURIERS]).toEqual([
      "Royal Mail",
      "EVRI",
      "DHL",
      "DPD",
      "GLS",
      "Amazon Shipping",
      "USPS",
      "Intelcom",
      "Smart Track",
      "Other",
    ]);
  });
});

describe("the issue note is free text with no business rule", () => {
  /**
   * NO MINIMUM, AND THIS IS THE POINT OF THE TEST.
   *
   * The requirement asks for "a short free-text note explaining the exact
   * problem" and says nothing about length. An agent must never be made to pad
   * a note to reach a number — a padded note is worse than a short one, because
   * it reads as detail somebody supplied.
   *
   * NEITHER free-text field carries one now. The 30-character rule that once
   * guarded the OTHER flow was the message application's and belonged to a
   * field whose prose BECAME the root cause; it went when that stopped being
   * how OTHER is stored. Both fields require non-blank text and nothing more.
   */
  it("declares no minimum length of any kind, in either free-text field", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "domain", "root-cause-vocabulary.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/ISSUE_NOTE_MIN/);
    expect(source).not.toMatch(/CUSTOM_ROOT_CAUSE_MIN/);

    const rule = readFileSync(
      join(__dirname, "..", "..", "lib", "domain", "root-cause-selection.ts"),
      "utf8",
    );
    expect(rule.match(/\w*MIN_LENGTH\b/g) ?? []).toEqual([]);
    // And no hand-rolled length floor in its place.
    expect(rule).not.toMatch(/\.length\s*<\s*\d+/);
  });

  /**
   * THE TYPED ROOT CAUSE SHARES THE SAME TECHNICAL CEILING, for the same
   * reason: `custom_root_cause` is `text`, which PostgreSQL does not
   * constrain, so the application bounds a pathological payload and nothing
   * else. One number across every CST free-text field.
   */
  it("caps the typed root cause on the same technical terms as the note", () => {
    expect(CUSTOM_ROOT_CAUSE_MAX_LENGTH).toBe(2_000);
    expect(CUSTOM_ROOT_CAUSE_MAX_LENGTH).toBe(ISSUE_NOTE_MAX_LENGTH);
    expect(CUSTOM_ROOT_CAUSE_MAX_LENGTH).toBe(INTERNAL_NOTE_MAX_LENGTH);

    const ui = readFileSync(
      join(__dirname, "..", "..", "components", "root-cause-selector.tsx"),
      "utf8",
    );
    expect(ui).toContain("maxLength={CUSTOM_ROOT_CAUSE_MAX_LENGTH}");

    // No length CHECK in SQL: the ceiling is the application's, so raising it
    // is not a migration.
    expect(UP_SQL).not.toMatch(/length\s*\(\s*btrim\s*\(\s*custom_root_cause\s*\)\s*\)\s*<=/);
  });

  /**
   * A TECHNICAL CEILING, NOT A BUSINESS RULE. `issue_note` is `text`, which
   * PostgreSQL does not constrain, so without one an accidental paste stores a
   * megabyte in a sidebar field.
   *
   * 2,000 is the number this project ALREADY uses for an agent's own words
   * about a case — `INTERNAL_NOTE_MAX_LENGTH`. Matching it means CST has one
   * answer to "how long may a note be" rather than two that drift apart.
   */
  it("keeps one generous technical ceiling, shared with the internal note", () => {
    expect(ISSUE_NOTE_MAX_LENGTH).toBe(2_000);
    expect(ISSUE_NOTE_MAX_LENGTH).toBe(INTERNAL_NOTE_MAX_LENGTH);
    // Generous enough that a normal short note never meets it.
    expect(ISSUE_NOTE_MAX_LENGTH).toBeGreaterThan(500);
  });

  /**
   * ONE CONSTANT, READ BY EVERY LAYER. The UI's `maxLength`, the domain rule and
   * the API all reference `ISSUE_NOTE_MAX_LENGTH` rather than restating a
   * number, so the three cannot disagree. The database deliberately states no
   * length at all — a CHECK there would turn a raised ceiling into a migration.
   */
  it("is stated once and never duplicated as a literal", () => {
    const ui = readFileSync(
      join(__dirname, "..", "..", "components", "root-cause-selector.tsx"),
      "utf8",
    );
    expect(ui).toContain("maxLength={ISSUE_NOTE_MAX_LENGTH}");
    expect(ui).not.toMatch(/maxLength=\{\s*\d+\s*\}/);

    const rule = readFileSync(
      join(__dirname, "..", "..", "lib", "domain", "root-cause-selection.ts"),
      "utf8",
    );
    expect(rule).toContain("ISSUE_NOTE_MAX_LENGTH");

    // No length constraint on the column: the ceiling is the application's.
    expect(UP_SQL).not.toMatch(/length\s*\(\s*btrim\s*\(\s*issue_note\s*\)\s*\)\s*<=/);
    expect(UP_SQL).toMatch(/issue_note\s+text\s*,/);
  });
});

describe("what a chip says", () => {
  /**
   * DISPLAY ONLY. Nothing consumes this as data — the stored value is always the
   * entry from `ROOT_CAUSE_LABELS` — so softening a machine spelling costs
   * nothing and reading `FULFILMENT_CARRIER` forty times a day costs something.
   */
  it("softens the screaming-snake labels", () => {
    expect(rootCauseChipText("FULFILMENT_CARRIER")).toBe("FULFILMENT carrier");
    expect(rootCauseChipText("PRE_SALES_QUERY")).toBe("PRE sales query");
  });

  /**
   * And leaves alone the ones that are already readable. `PARTS MISSING` and
   * `OUT OF STOCK` are not re-cased: a reviewer may be eyeballing this against
   * the other application's screen, and a re-spelled label is one they cannot
   * find there.
   */
  it("leaves a label that is already words exactly as it is stored", () => {
    for (const label of ["OUT OF STOCK", "PARTS MISSING", "Charge Back", "Delivery Issue", "OTHER"]) {
      expect(rootCauseChipText(label)).toBe(label);
    }
  });

  it("never returns an empty chip for any offered label", () => {
    for (const label of ROOT_CAUSE_LABELS) {
      expect(rootCauseChipText(label).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("the version", () => {
  /**
   * BUMPED WHENEVER A LIST CHANGES, never reused. A row stamped with a version
   * can be read against the list that produced it, which is the only way a label
   * removed next year still means what it meant when somebody chose it.
   */
  it("is a whole number at or above one", () => {
    expect(Number.isInteger(ROOT_CAUSE_VOCABULARY_VERSION)).toBe(true);
    expect(ROOT_CAUSE_VOCABULARY_VERSION).toBeGreaterThanOrEqual(1);
  });
});
