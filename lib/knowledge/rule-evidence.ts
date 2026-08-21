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

/** One cited rule, resolved to something a person can verify. */
export type RuleEvidence = {
  readonly ref: string;
  readonly title: string;
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
  const byRef = new Map(rules.map((rule) => [rule.ref, rule]));

  const cited: RuleEvidence[] = [];
  const unresolved: string[] = [];
  const legacy: string[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (seen.has(ref)) continue;
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
