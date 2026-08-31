import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CATEGORY_SOURCES,
  CST_CATEGORY_CORPUS,
  NOT_CATEGORY_SOURCES,
  type RuleRole,
} from "@/lib/knowledge/cst-category-corpus";
import { CORPUS_INDEX_STATS, corpusMatches, sharedPhrases } from "@/lib/knowledge/cst-corpus-match";
import {
  MESSAGE_CATEGORIES,
  classifyMessageCategoryWithFallback,
  readCorpus,
} from "@/lib/knowledge/message-category";

/**
 * THE CORPUS, AND WHAT IT IS AND IS NOT ALLOWED TO DO.
 *
 * These tests are about the SOURCE rather than about any one message: that the
 * eleven approved workbooks are all present and nothing else is, that every row
 * carries usable provenance, that a rule which is not about the problem cannot
 * choose a category, and that every family the business wrote down is reachable
 * by something a customer might actually send.
 *
 * They are deliberately coverage-shaped. A hand-picked list of examples proves
 * the examples work; this fails when a whole CST family stops being reachable,
 * which is the failure that kept recurring.
 */

const SOURCE_DIR = join(process.cwd(), "Knowledge-source");

describe("the corpus comes from the eleven approved category workbooks", () => {
  it("reads exactly the eleven, and names the category each one owns", () => {
    expect(CATEGORY_SOURCES).toHaveLength(11);
    for (const [, category] of CATEGORY_SOURCES) {
      expect(MESSAGE_CATEGORIES).toContain(category);
    }
    // Every category except none is represented: eleven books, eleven categories.
    expect(new Set(CATEGORY_SOURCES.map(([, c]) => c)).size).toBe(11);
    expect([...MESSAGE_CATEGORIES].sort()).toEqual(CATEGORY_SOURCES.map(([, c]) => c).sort());
  });

  it("never reads the B2B customer list, the handling rules or the index", () => {
    const excluded = NOT_CATEGORY_SOURCES.map(([file]) => file);
    expect(excluded).toContain("B2B  customers .xlsx");
    expect(excluded).toContain("MESSAGE HANDLING RULES .xlsx");
    expect(excluded).toContain("Message rules final.xlsx");

    const read = new Set(CST_CATEGORY_CORPUS.map((rule) => rule.file));
    for (const file of excluded) expect(read.has(file)).toBe(false);
    expect(read.size).toBe(11);
  });

  /**
   * The workbooks are the authority, so a file that disappears or is renamed has
   * to fail here rather than quietly shrink the corpus.
   */
  it("every source file it claims to have read is still on disk", () => {
    const present = new Set(readdirSync(SOURCE_DIR));
    for (const [file] of CATEGORY_SOURCES) expect(present.has(file)).toBe(true);
  });

  it("carries the whole corpus, not a hand-picked selection", () => {
    expect(CST_CATEGORY_CORPUS.length).toBeGreaterThanOrEqual(700);
    expect(CORPUS_INDEX_STATS.phrases).toBeGreaterThanOrEqual(7000);

    // Every category has a substantial number of its own rows behind it.
    for (const category of MESSAGE_CATEGORIES) {
      const rows = CST_CATEGORY_CORPUS.filter((rule) => rule.category === category);
      expect(rows.length, category).toBeGreaterThanOrEqual(25);
    }
  });

  it("gives every row provenance a reviewer can follow back to the sheet", () => {
    for (const rule of CST_CATEGORY_CORPUS) {
      expect(rule.id, JSON.stringify(rule)).not.toBe("");
      expect(rule.file).not.toBe("");
      expect(rule.sheet).not.toBe("");
      expect(rule.row).toBeGreaterThan(0);
      expect(rule.roleReason, `${rule.id} has no reason for its role`).not.toBe("");
    }
  });

  /**
   * THE GENERATED FILE MUST MATCH THE WORKBOOKS ON DISK.
   *
   * Not by re-parsing them here — that would make every test run pay for eleven
   * spreadsheets — but by pinning the counts the build step reported. Editing a
   * workbook without re-running `node scripts/build-category-corpus.mjs --write`
   * changes those counts and fails here, which is the whole point of committing
   * a generated corpus rather than parsing at runtime.
   */
  it("matches the counts the build step last reported", () => {
    expect(CST_CATEGORY_CORPUS.length).toBe(730);
    expect(CORPUS_INDEX_STATS.phrases).toBe(7825);
  });
});

describe("only a rule about the problem may choose a category", () => {
  const roleOf = (role: RuleRole) => CST_CATEGORY_CORPUS.filter((rule) => rule.role === role);

  it("assigns every row exactly one of the seven roles", () => {
    const roles: RuleRole[] = [
      "PRIMARY_ISSUE",
      "SECONDARY_REMEDY",
      "SECONDARY_CONTEXT",
      "INTERNAL_SCENARIO",
      "RESOLUTION_CONFIRMATION",
      "INTERNAL_ONLY",
      "AMBIGUOUS_CATCHALL",
    ];
    for (const rule of CST_CATEGORY_CORPUS) expect(roles).toContain(rule.role);
    expect(roleOf("PRIMARY_ISSUE").length).toBeGreaterThan(400);
    // Every non-primary role is actually used, or the distinction is decorative.
    for (const role of roles) expect(roleOf(role).length, role).toBeGreaterThan(0);
  });

  /**
   * THE FINDING THIS PINS. "Please refund me" is a trigger in six workbooks and
   * a reason to file under none of them. Each of these is a real corpus phrase
   * from a non-primary row, and none may reach `readCorpus`'s proposal.
   */
  const CANNOT_PROPOSE: readonly (readonly [string, string])[] = [
    ["a remedy", "I want a full refund"],
    ["a remedy", "please arrange replacement"],
    ["a remedy", "yes I'll take the discount"],
    ["evidence", "please see attached photo"],
    ["evidence", "I won't send photos"],
    ["context", "my electrician is coming"],
    ["context", "I threw away the packaging"],
    ["context", "already installed"],
    ["a catch-all", "there is a problem"],
    ["a catch-all", "something is wrong"],
    ["a catch-all", "I need help"],
    ["a resolution", "all sorted now"],
  ];

  it.each(CANNOT_PROPOSE)("does not let %s (%j) propose a category", (_kind, text) => {
    const reading = readCorpus(text);
    expect(
      reading.admitted.map((candidate) => `${candidate.id} ${candidate.category}`),
      `${text} was proposed by a non-primary row`,
    ).toEqual([]);
  });

  it("still records those rows as signals, so the explanation shows them", () => {
    const reading = readCorpus("Please see the attached photo, and I want a full refund.");
    expect(reading.signals.length).toBeGreaterThan(0);
    expect(reading.signals.every((signal) => signal.role !== "PRIMARY_ISSUE")).toBe(true);
  });

  /**
   * The internal rows are the ones with no customer in them at all — timers,
   * pick-list records, statutory tables. They must never match anything.
   */
  it("keeps internal-only rows out of matching entirely", () => {
    for (const rule of CST_CATEGORY_CORPUS.filter((r) => r.role === "INTERNAL_ONLY")) {
      for (const phrase of rule.phrases) {
        if (!/INTERNAL|timer|triggered by/i.test(phrase)) continue;
        expect(readCorpus(phrase).admitted, phrase).toEqual([]);
      }
    }
  });
});

describe("a phrase claimed by many workbooks decides nothing", () => {
  /**
   * OVERLAP IS EXPECTED AND IS NOT AN ERROR — every book is right about its own
   * vocabulary. What must never happen is a category winning because more books
   * happened to list the same words. Phrases claimed by three or more categories
   * are measured from the corpus and set aside; this pins that they exist, that
   * they are recorded for review, and that they cannot propose.
   */
  it("sets aside the phrases three or more categories claim", () => {
    const shared = sharedPhrases();
    expect(shared.size).toBeGreaterThan(20);
    for (const [phrase, claimants] of shared) {
      expect(claimants.length, phrase).toBeGreaterThanOrEqual(3);
      expect(corpusMatches(phrase).map((m) => m.phrase), phrase).not.toContain(phrase);
    }
  });

  it("keeps the worst offenders out: they name every category and so name none", () => {
    const shared = new Set(sharedPhrases().keys());
    for (const phrase of ["wrong item", "wrong colour", "not delivered", "where is my refund"]) {
      expect(shared.has(phrase), phrase).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * COVERAGE: EVERY PRIMARY FAMILY IS REACHABLE
 * ------------------------------------------------------------------------- */

/**
 * The families whose approved wording, on its own, still reaches nothing better
 * than the admin fallback — with the reason, because an unexplained allowance
 * list is just a way of hiding a failure.
 *
 * Each is a row whose trigger phrases are bare nouns or fragments that carry no
 * claim by themselves: "prohibited item", "too short", "it was a gift". A real
 * message containing them says more, and those messages are pinned separately in
 * `message-category.test.ts`. The list is a ceiling, not a target: if it grows,
 * a CST family has stopped being reachable and that is a defect.
 */
const UNREACHED_FROM_BARE_PHRASES: readonly string[] = [
  "8.8", // Delivery — "prohibited item", "banned item". No parcel in the phrase.
  "🔗 Fabric  Cables row 8", // Damage — "too short". Wrong item owns a size claim.
  "LSK02", // Parts missing — "instruction shows a part". States no absence.
  "INT-WD06", // Wrong description — "black inner not white". See the report: CST
  // files this colour contrast under Wrong description and the same wording
  // under Wrong item INT-WI09. Left for a human ruling rather than forced.
  "SP1", // Returns — "it was a gift". A gift is not a return until one is asked
  "INT27", // for; "it was a gift and I would like to return it" does reach it.
];

describe("every CST primary family is reachable by real customer wording", () => {
  it("no primary family falls to the admin catch-all except the documented few", () => {
    const stranded: string[] = [];

    for (const rule of CST_CATEGORY_CORPUS) {
      if (rule.role !== "PRIMARY_ISSUE") continue;
      // Admin's own families reaching Admin is the right answer, not a fallback.
      if (rule.category === "Admin related issues") continue;
      const usable = rule.phrases.filter((phrase) => !phrase.includes("[") && phrase.length >= 6);
      if (usable.length === 0) continue;

      const reached = usable.some((phrase) => {
        const category = classifyMessageCategoryWithFallback(`Hi, ${phrase}. Thanks.`);
        return category !== null && category !== "Admin related issues";
      });
      if (!reached) stranded.push(rule.id);
    }

    expect(stranded.sort()).toEqual([...UNREACHED_FROM_BARE_PHRASES].sort());
  });

  /**
   * Reachable is not the same as right, so this is the stronger claim: for most
   * families the wording reaches the category its own workbook owns. The
   * remainder are genuine cross-category resolutions — "shade smashed" is listed
   * in the Defective book and is a Damage case — and they are what the ownership
   * rules are for.
   */
  it("most families reach the category their own workbook owns", () => {
    let own = 0;
    let total = 0;
    for (const rule of CST_CATEGORY_CORPUS) {
      if (rule.role !== "PRIMARY_ISSUE") continue;
      const usable = rule.phrases.filter((phrase) => !phrase.includes("[") && phrase.length >= 6);
      if (usable.length === 0) continue;
      total += 1;
      if (
        usable.some((phrase) => classifyMessageCategoryWithFallback(`Hi, ${phrase}. Thanks.`) === rule.category)
      ) {
        own += 1;
      }
    }
    expect(own / total).toBeGreaterThan(0.8);
  });
});

/* ------------------------------------------------------------------------- *
 * THE GENERATOR AND ITS OUTPUT
 * ------------------------------------------------------------------------- */

describe("the corpus is generated, and says so", () => {
  it("is marked generated so nobody edits it by hand", () => {
    const source = readFileSync(join(process.cwd(), "lib/knowledge/cst-category-corpus.ts"), "utf8");
    expect(source).toContain("GENERATED. DO NOT EDIT BY HAND");
    expect(source).toContain("scripts/build-category-corpus.mjs --write");
  });

  it("contains no customer data", () => {
    const source = readFileSync(join(process.cwd(), "lib/knowledge/cst-category-corpus.ts"), "utf8");
    expect(source).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(source).not.toMatch(/\b\d{2}-\d{5}-\d{5}\b/);
    expect(source).not.toMatch(/\b\d{3}-\d{7}-\d{7}\b/);
  });
});
