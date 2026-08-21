// TYPE-ONLY, deliberately. This module is loaded directly by
// `scripts/sync-knowledge-vector-store.mjs` through Node's type stripping,
// which erases type imports but cannot resolve an extensionless runtime one.
// Taking already-rendered `CstRule`s rather than raw `ExtractedRule`s keeps
// this file free of runtime imports, and means the text uploaded to the vector
// store is rendered by exactly the same code that renders it for a prompt.
import type { CstRule } from "@/lib/domain/knowledge";

/**
 * Which CST documents may leave this machine, and in what form.
 *
 * AN ALLOWLIST, NOT AN EXCLUSION LIST. This is the difference between "we
 * remembered to skip the customer file" and "nothing goes unless it is named
 * here". `Knowledge-source/` holds `B2B  customers .xlsx`, which carries
 * customer contact data; an exclusion list fails open the day someone drops a
 * new file in the folder, and uploading to a third-party vector store is not a
 * mistake you can take back.
 *
 * WHY THE WORKBOOKS ARE NOT UPLOADED AS-IS. Two reasons, and either alone would
 * be enough:
 *
 *   1. `.xlsx` is not a file type File Search can index.
 *   2. Even if it were, a spreadsheet chunks badly — a rule's condition and its
 *      action can land in different chunks, which is how a model ends up
 *      confidently applying half a rule.
 *
 * So each workbook is rendered to Markdown here, one document per CST area,
 * with every rule kept whole and carrying its `[REF]`. That ref is the same one
 * `rule-evidence.ts` resolves, so a citation from the vector store still traces
 * back to a workbook, sheet and row.
 */

/**
 * The twelve approved rule workbooks.
 *
 * Named in full and matched exactly (case-insensitively, after trimming) so a
 * renamed or newly added file is silently NOT uploaded rather than silently
 * uploaded. Two files in the folder are deliberately absent:
 *
 *   "B2B  customers .xlsx"   customer contact data. Must never be uploaded.
 *   "Message rules final.xlsx"  an index/duplicate of MESSAGE HANDLING RULES.
 */
export const APPROVED_KNOWLEDGE_FILES: readonly string[] = [
  "ADMIN.xlsx",
  "DAMAGE DECISION GUIDE.xlsx",
  "DEFECTIVE .xlsx",
  "Delivery_Master_Rules final.xlsx",
  "MESSAGE HANDLING RULES .xlsx",
  "missing parts query .xlsx",
  "ORDER BEFORRE SHIPPING And cancelation .xlsx",
  "PRE-SALES QUERIES.xlsx",
  "RETURNS & REFUNDS — COMPLETE CASE HANDLING MASTER SHEET    final.xlsx",
  "WRONG DESCRIPTION.xlsx",
  "Wrong item sent  final.xlsx",
  "wrong quantity.xlsx",
];

/** Files present in the folder that must NEVER be uploaded, named for clarity. */
export const FORBIDDEN_KNOWLEDGE_FILES: readonly string[] = ["B2B  customers .xlsx"];

const normalise = (name: string) => name.trim().toLowerCase();

const APPROVED = new Set(APPROVED_KNOWLEDGE_FILES.map(normalise));
const FORBIDDEN = new Set(FORBIDDEN_KNOWLEDGE_FILES.map(normalise));

/**
 * Whether a file may be uploaded.
 *
 * The forbidden check runs first and independently. It is redundant while the
 * allowlist is correct, and that is the point: two independent reasons the
 * customer file cannot be uploaded, so one editing mistake is not enough.
 */
export function isApprovedForUpload(fileName: string): boolean {
  const key = normalise(fileName);
  if (FORBIDDEN.has(key)) return false;
  return APPROVED.has(key);
}

export type KnowledgeDocument = {
  /** Upload filename. Area-based, so a citation names the area it came from. */
  readonly name: string;
  readonly area: string;
  readonly ruleCount: number;
  readonly markdown: string;
};

/**
 * Renders extracted rules into per-area Markdown documents for the vector store.
 *
 * GROUPED BY AREA, NOT BY WORKBOOK. Retrieval works on what a rule is about,
 * and a citation reading "Damage.md" tells a reviewer more than a workbook
 * filename with a stray double space in it.
 *
 * EACH RULE IS ONE HEADED SECTION so a chunker has an obvious boundary and a
 * rule's condition stays attached to its action. The `[REF]` is in the heading
 * because headings survive chunking strategies that drop surrounding context.
 */
export function renderKnowledgeDocuments(rules: readonly CstRule[]): KnowledgeDocument[] {
  const byArea = new Map<string, CstRule[]>();
  for (const rule of rules) {
    // Belt and braces: the caller should already have filtered, but a rule
    // whose workbook is not on the allowlist must not reach an upload no
    // matter which path it arrived by.
    if (!isApprovedForUpload(rule.sourceFile ?? "")) continue;
    const area = rule.category ?? "General";
    const group = byArea.get(area);
    if (group) group.push(rule);
    else byArea.set(area, [rule]);
  }

  const documents: KnowledgeDocument[] = [];
  for (const [area, group] of [...byArea].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ordered = [...group].sort((a, b) => {
      const sheetA = a.sourceSheet ?? "";
      const sheetB = b.sourceSheet ?? "";
      if (sheetA !== sheetB) return sheetA < sheetB ? -1 : 1;
      return (a.sourceRow ?? 0) - (b.sourceRow ?? 0);
    });

    const body = ordered
      .map((rule) => {
        // Source coordinates travel with the rule so provenance survives the
        // trip through the vector store and back out as a citation.
        const origin = `_Source: ${rule.sourceFile ?? "unknown"}${
          rule.sourceSheet ? ` › ${rule.sourceSheet}` : ""
        }${rule.sourceRow === undefined ? "" : ` › row ${rule.sourceRow}`}_`;
        return `## [${rule.ref}] ${rule.title}\n\n${origin}\n\n${rule.text}`;
      })
      .join("\n\n");

    documents.push({
      name: `${area.replace(/[^A-Za-z0-9 &-]/g, "").trim().replace(/\s+/g, "-")}.md`,
      area,
      ruleCount: ordered.length,
      markdown: `# CST rules — ${area}\n\nApproved CST knowledge. ${ordered.length} rules.\n\n${body}\n`,
    });
  }

  return documents;
}
