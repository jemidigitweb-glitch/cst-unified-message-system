import type { CstRule } from "@/lib/domain/knowledge";

/**
 * Resolving a draft's citations back to the documents behind them.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Be precise about this, because the
 * word "proof" invites more confidence than the mechanism earns.
 *
 * It DOES establish:
 *   - which rules were supplied to the model for this draft
 *   - which of those the model cited
 *   - the exact workbook, sheet and row each citation resolves to, and the
 *     rule text as written by the business
 *   - that every citation shown was checked against the corpus actually sent.
 *     A reference the model invented is dropped before it is ever stored, so a
 *     citation surviving here is a real row and not a plausible-looking string.
 *
 * It does NOT establish that the model's reasoning genuinely followed the rule
 * it named. No citation mechanism can: a model can quote a real row and still
 * write something the row does not support. This is an AUDIT TRAIL — it lets a
 * human check the claim in seconds instead of searching fourteen workbooks —
 * and the human check is what the workflow requires anyway.
 *
 * PURE. No files, no network, no database. Given a corpus and a set of refs it
 * returns the matching rules; loading is the caller's job.
 */

/**
 * Normalises a citation for lookup.
 *
 * The knowledge documents present each rule as `## [RETREF-GFR-9] EB4`, and the
 * instruction asks the model to quote the bracketed reference exactly — so it
 * returns `[RETREF-GFR-9]`, brackets included, while the corpus is keyed on
 * `RETREF-GFR-9`. Every citation therefore failed to resolve and was reported
 * as a rule that no longer exists. Stripping the brackets here means older
 * drafts, already stored with them, resolve too.
 */
export function normaliseRef(ref: string): string {
  return ref.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim();
}

/**
 * A title a CST user can read.
 *
 * The `ruleName` column in these workbooks is usually an internal code — `EB4`,
 * `R-WD12`, `SS5` — and 229 of 1,329 rules have nothing else in it. Those are
 * audit identifiers, not something to show a person deciding whether a reply is
 * right. The rule's own first line is the human sentence ("Customer claims
 * wrong colour received"), so it is preferred whenever the name is a bare code.
 *
 * The reference itself is never used as a display title. It stays on the record
 * for audit, and this is what a reviewer sees.
 */
function isCodeLike(title: string): boolean {
  return /^[A-Za-z]{1,6}[-_ ]?\d+[A-Za-z]?$/.test(title.trim());
}

const LABEL_PREFIX = /^(KEY RULE \/ ACTION|KEY RULE|ACTION|DO NOT|DO|NEVER SAY|SAY INSTEAD):\s*/i;

export function displayTitleOf(rule: {
  readonly title: string;
  readonly text: string;
  readonly category: string | null;
}): string {
  const title = rule.title.trim();
  if (title !== "" && !isCodeLike(title) && title.split(/\s+/).length >= 2) return title;

  const firstLine = (rule.text.split("\n")[0] ?? "").replace(LABEL_PREFIX, "").trim();
  if (firstLine !== "") {
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  }
  return title !== "" ? title : (rule.category ?? "CST rule");
}

/**
 * Why a rule applies, taken from the rule itself.
 *
 * Retrieval reports no reason, and inventing one would be exactly the
 * fabrication the grounding design exists to prevent. So the reason shown
 * beside a rule is the rule's OWN opening condition — "Customer claims wrong
 * colour received" — which is genuine retrieved text, and is what a person
 * would point at if asked why it matched.
 *
 * Returns null when the only candidate restates the title. The comparison
 * happens AFTER the label prefix is stripped: comparing before let
 * "KEY RULE: Always use official messaging" through as different from the
 * title, and stripping then made the two identical, so the panel printed the
 * same sentence twice. A reason that repeats the title is not a reason.
 */
export function matchReasonOf(rule: {
  readonly displayTitle: string;
  readonly text: string;
}): string | null {
  const title = rule.displayTitle.trim().replace(/…$/, "").toLowerCase();

  /**
   * A TRUNCATED title still restates itself, so this compares by prefix.
   *
   * Two different things truncate a title, and neither is detectable from the
   * string alone. `displayTitleOf` cuts a long first line at 120 characters and
   * appends an ellipsis; separately, some workbooks store an already-clipped
   * sentence in the name column with no marker at all — live Amazon rule
   * "Is every fact stated in this message ... verified from the l" is one. An
   * exact comparison called both of those different from the full sentence, so
   * the panel printed the long version directly beneath the short one.
   *
   * The 30-character floor is what keeps this honest. Without it a short area
   * title would swallow any line that happened to open with the same word; with
   * it, a prefix that long is the same sentence and not a coincidence. Below the
   * floor the comparison stays exact.
   */
  const MEANINGFUL_PREFIX = 30;
  const restatesTitle = (line: string) => {
    const candidate = line.toLowerCase();
    if (candidate === title) return true;
    const shorter = Math.min(candidate.length, title.length);
    if (shorter < MEANINGFUL_PREFIX) return false;
    return candidate.startsWith(title) || title.startsWith(candidate);
  };

  const candidate = rule.text
    .split("\n")
    .map((line) => line.trim().replace(LABEL_PREFIX, "").trim())
    .find((line) => line !== "" && !restatesTitle(line));

  if (candidate === undefined) return null;
  return candidate.length > 150 ? `${candidate.slice(0, 147)}…` : candidate;
}

/** One cited rule, resolved to something a person can verify. */
export type RuleEvidence = {
  readonly ref: string;
  /** The internal identifier. For audit only — never shown to a CST user. */
  readonly title: string;
  /** What a CST user reads. Derived by `displayTitleOf`. */
  readonly displayTitle: string;
  readonly category: string | null;
  /** The rule as written in the document. */
  readonly text: string;
  /** Workbook, sheet and row — null when the source recorded no address. */
  readonly sourceFile: string | null;
  readonly sourceSheet: string | null;
  readonly sourceRow: number | null;
};

/**
 * Whether a ref was written by the CURRENT reference scheme.
 *
 * Refs are `AREA-SHEETCODE-ROW`, so a current one always ends in `-<digits>`.
 * An earlier scheme was `AREA-ROW-NAMESLUG` — `MESHAN-43-VATINVOI` — and ended
 * in letters. It was replaced because it collided: keyed on area and row alone,
 * seven rules in one selection shared a ref, and a citation resolving to two
 * rules is worse than none.
 *
 * The distinction matters here because the two failures need opposite
 * responses. A current-format ref that does not resolve means the DOCUMENTS
 * changed — a real audit finding. A legacy ref means OUR reference scheme
 * changed while the rule sat where it always was. Reporting the second as the
 * first blames the business for our own migration, which is what the first
 * version of this did.
 */
function isLegacyRef(ref: string): boolean {
  return !/-\d+$/.test(ref);
}

export type EvidenceReport = {
  readonly cited: readonly RuleEvidence[];
  /**
   * Current-format refs that no longer resolve.
   *
   * NOT an error to hide. The workbooks are edited by the business, and a rule
   * that has since been moved or deleted is exactly what an auditor needs to
   * know: the draft was written against a version of the documents that no
   * longer exists. Silently omitting these would make an old draft look fully
   * grounded when it is not.
   */
  readonly unresolved: readonly string[];
  /**
   * Refs written before the reference scheme changed.
   *
   * These say nothing about the documents. The draft is simply too old to trace
   * automatically — the rule it cited is almost certainly still there under a
   * different key, and the stored label still names it.
   */
  readonly legacy: readonly string[];
  /** Rules supplied to the model for this draft, cited or not. */
  readonly rulesSupplied: number;
  /** Distinct documents the citations came from. */
  readonly documents: readonly string[];
};

/**
 * Matches stored citations against the corpus.
 *
 * Order follows the CITATIONS, not the corpus: the reviewer is checking a
 * specific draft, and the order the model relied on them is more useful than
 * document order.
 */
export function resolveEvidence(
  rules: readonly CstRule[],
  refs: readonly string[],
): EvidenceReport {
  const byRef = new Map(rules.map((rule) => [normaliseRef(rule.ref), rule]));

  const cited: RuleEvidence[] = [];
  const unresolved: string[] = [];
  const legacy: string[] = [];
  const seen = new Set<string>();

  for (const raw of refs) {
    const ref = normaliseRef(raw);
    if (ref === "" || seen.has(ref)) continue;
    seen.add(ref);

    const rule = byRef.get(ref);
    if (rule === undefined) {
      // Separated, because one of these is a finding about the documents and
      // the other is a finding about us.
      if (isLegacyRef(ref)) legacy.push(ref);
      else unresolved.push(ref);
      continue;
    }
    cited.push({
      ref: rule.ref,
      title: rule.title,
      displayTitle: displayTitleOf(rule),
      category: rule.category,
      text: rule.text,
      sourceFile: rule.sourceFile ?? null,
      sourceSheet: rule.sourceSheet ?? null,
      sourceRow: rule.sourceRow ?? null,
    });
  }

  const documents = [
    ...new Set(cited.map((rule) => rule.sourceFile).filter((file): file is string => file !== null)),
  ].sort();

  return { cited, unresolved, legacy, rulesSupplied: rules.length, documents };
}
