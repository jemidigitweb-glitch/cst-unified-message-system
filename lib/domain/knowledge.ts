import { z } from "zod";

/**
 * The CST knowledge corpus: rules maintained by the business in the workbooks
 * under `Knowledge-source/`. (An earlier version read them from a Google Sheet;
 * `sheetRef` below still carries that name, and now holds the folder the rules
 * were read from. Renaming it is a change to a stored contract, not a comment
 * fix, so it is left alone here.)
 *
 * The sheet is a KNOWLEDGE SOURCE ONLY. It is not a message source, not a
 * customer data source, and not an order source — nothing read from it may be
 * presented as a fact about a customer or a purchase. It supplies policy, and
 * policy alone.
 *
 * Each row becomes one citable rule. The draft names the rows it relied on, so
 * a reviewer can check a claim against the row that produced it rather than
 * taking the model's word for it.
 */

export const cstRuleSchema = z.object({
  /** Stable row identifier, so a citation survives the sheet being re-sorted. */
  ref: z.string().min(1),
  /** Short human label — what a reviewer sees on the citation chip. */
  title: z.string().min(1),
  /** The rule text as written by the business. Passed through verbatim. */
  text: z.string().min(1),
  /** Optional grouping, e.g. "Returns". Used for display only. */
  category: z.string().nullable(),

  /**
   * Where this rule physically lives, for audit.
   *
   * A citation of `DAM-XK4-6` proves nothing to anyone who has to check it —
   * the ref is a stable key, not an address. These three fields are the
   * address: workbook, sheet, row. They are what lets someone open the actual
   * document and read the rule the draft claims to have followed.
   *
   * Optional rather than required, because a rule source is not obliged to
   * have a physical address — the local workbooks do, an API-fed source would
   * not. A rule with no coordinates simply cannot be traced back, and the
   * evidence view says exactly that rather than inventing a location.
   */
  sourceFile: z.string().optional(),
  sourceSheet: z.string().nullable().optional(),
  sourceRow: z.number().int().optional(),
});

export type CstRule = z.infer<typeof cstRuleSchema>;

export const KNOWLEDGE_STATES = ["available", "not_configured"] as const;

export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

/**
 * The corpus as the generator sees it.
 *
 * `not_configured` is a first-class state, not an error. Without rules the
 * generator does not refuse outright — it drops into a restricted mode that may
 * acknowledge the customer and ask for what is needed, but may not state a
 * policy. See the generator for how that is enforced.
 */
export type KnowledgeSource =
  | { readonly state: "available"; readonly rules: readonly CstRule[]; readonly sheetRef: string }
  | { readonly state: "not_configured"; readonly reason: string };

export const KNOWLEDGE_NOT_CONFIGURED_REASON =
  "The CST rules sheet is not connected, so this draft states no policy. Check it before using." as const;

/** Builds a corpus from rows already read out of the sheet. */
export function knowledgeFromRules(
  rules: readonly CstRule[],
  sheetRef: string,
): KnowledgeSource {
  if (rules.length === 0) {
    return { state: "not_configured", reason: KNOWLEDGE_NOT_CONFIGURED_REASON };
  }
  return { state: "available", rules, sheetRef };
}

export function knowledgeNotConfigured(reason?: string): KnowledgeSource {
  return { state: "not_configured", reason: reason ?? KNOWLEDGE_NOT_CONFIGURED_REASON };
}

/**
 * Renders the corpus for the prompt, grouped by area.
 *
 * Each rule carries its `ref` inline so the model can cite it by identifier
 * rather than paraphrasing a title, which is what makes a citation checkable.
 *
 * THE AREA IS NAMED ONCE PER GROUP, not once per rule. It used to appear twice
 * on every single line — the caller builds the title as "Damage · Cracked
 * glass" and this function then appended "(Damage)" after it. Across 1,329
 * rules that measured 11,356 wasted tokens on every request, about 7.6% of the
 * prompt, for no information at all. A heading says it once and also reads
 * better: rules from one area now visibly cluster instead of being an
 * undifferentiated list.
 *
 * Callers pass rules already ordered by area (see `scopeCorpus`), and `Map`
 * preserves insertion order, so grouping here does not reorder anything.
 */
export function renderRulesForPrompt(rules: readonly CstRule[]): string {
  const areas = new Map<string, CstRule[]>();
  for (const rule of rules) {
    const area = rule.category ?? "General";
    const group = areas.get(area);
    if (group) group.push(rule);
    else areas.set(area, [rule]);
  }

  return [...areas]
    .map(([area, group]) => {
      const body = group.map((rule) => `[${rule.ref}] ${rule.title}\n${rule.text}`).join("\n\n");
      return `## ${area}\n\n${body}`;
    })
    .join("\n\n");
}
