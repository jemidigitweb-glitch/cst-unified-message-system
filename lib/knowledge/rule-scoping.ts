import type { CstRule } from "@/lib/domain/knowledge";

import type { ExtractedRule } from "./rule-extraction";

/**
 * Prepares the CST rule corpus for the model.
 *
 * THE WHOLE CORPUS GOES. All fourteen workbooks, every rule, every time — about
 * 149,000 tokens against a context window of roughly a million. The model reads
 * the documents and decides what applies, which is the same thing a person does
 * with the same files.
 *
 * There used to be a keyword-scored selection layer here that picked ~140
 * rules. It was written when the corpus looked bigger than it is, and it cost
 * more than it saved: a message about a cracked lampshade was sent 140
 * message-handling rules and zero damage rules; a request for cheaper postage
 * never reached the order-change rules at all, because the customer did not
 * happen to use the words the keyword list expected. Every draft was then
 * written against whichever slice of policy the keywords found, which is
 * exactly why they read as cautious and generic. Guessing which rules matter
 * before the model has read them is the wrong place to make that decision.
 *
 * WHAT IS STILL FILTERED, and only this: rules belonging to a marketplace this
 * conversation is not on. An eBay customer must not be sent Amazon's invoice
 * path — that is not relevance-guessing, it is a correctness boundary, and it
 * removes about 50 of 1,377 rules. Everything else the model sees in full.
 */

/**
 * Shopify, B&Q and Temu orders are all handled by the "Website & Email" sheet:
 * they are one channel to CST, not three.
 */
const WEBSITE_CHANNEL = new Set(["shopify", "bandq", "temu"]);

const PLATFORM_IN_TEXT: readonly (readonly [string, RegExp])[] = [
  ["ebay", /\bebay\b/i],
  ["amazon", /\bamazon\b|\bseller central\b|\ba-to-z\b|\basin\b/i],
  ["shopify", /\bshopify\b/i],
  ["bandq", /\bb&q\b|\bbandq\b|\bb and q\b/i],
  ["temu", /\btemu\b/i],
];

/** Which platform, if any, a whole sheet belongs to. */
function sheetPlatform(sheet: string): string | "website" | null {
  const name = sheet.toLowerCase();
  if (/\bebay\b/.test(name)) return "ebay";
  if (/\bamazon\b/.test(name)) return "amazon";
  if (/website|email/.test(name)) return "website";
  return null;
}

/** Platforms a rule names in its own text. */
export function platformsNamedIn(text: string): string[] {
  return PLATFORM_IN_TEXT.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export type Scope =
  | { readonly keep: false }
  | { readonly keep: true; readonly multiPlatform: boolean };

/**
 * Whether a rule belongs to this conversation's marketplace.
 *
 *   names no platform     global, keep
 *   names only others     another platform's process, drop
 *   names this one too    keep, and mark it so the prompt can say which branch
 *                         applies — dropping it would lose this platform's
 *                         instruction along with the other's
 */
export function scopeFor(rule: ExtractedRule, marketplace: string | null): Scope {
  const current = marketplace?.toLowerCase() ?? null;

  const sheet = sheetPlatform(rule.sourceSheet ?? "");
  if (sheet !== null && current !== null) {
    const matches = sheet === "website" ? WEBSITE_CHANNEL.has(current) : sheet === current;
    if (!matches) return { keep: false };
  }

  const named = platformsNamedIn(`${rule.ruleName} ${renderRuleText(rule)}`);
  if (named.length === 0) return { keep: true, multiPlatform: false };
  if (current === null) return { keep: true, multiPlatform: named.length > 1 };
  if (!named.includes(current)) return { keep: false };
  return { keep: true, multiPlatform: named.length > 1 };
}

/**
 * Whether two rule fields say the same thing.
 *
 * Compared on normalised text, not raw: the workbooks hold the same sentence
 * with a trailing space, a different capital, or a line break where the other
 * has a space, and a strict `!==` treats those as two different instructions.
 */
function sameText(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Renders one extracted rule as the policy text the model reads.
 *
 * Fields are labelled rather than concatenated: "NEVER SAY" and "DO" have to
 * survive the trip into the prompt as different kinds of instruction.
 *
 * REPEATED FIELDS ARE MERGED, NOT REPEATED. In these workbooks the same
 * sentence is very often entered in more than one column — 458 of 1,377 rules
 * have `keyRule` and `agentAction` byte-identical, and 140 repeat the
 * requirement in `keyRule`. Emitting each of them cost about 11,400 tokens per
 * request to say the same thing twice, and asking a model to read one
 * instruction as though it were two is a reason to weight it oddly, not a
 * reason to follow it better.
 *
 * Merging keeps BOTH labels — "KEY RULE / ACTION:" — because the labels do
 * carry meaning even when the text behind them does not differ. Only exact
 * repeats are merged: where one field merely contains the other, both are
 * printed in full, since deciding which one to drop is a judgement about rule
 * content and that is not this function's call to make.
 */
export function renderRuleText(rule: ExtractedRule): string {
  const parts: string[] = [];
  if (rule.ruleRequirement) parts.push(rule.ruleRequirement);

  const keyIsRequirement = sameText(rule.keyRule, rule.ruleRequirement);
  const keyIsAction = sameText(rule.keyRule, rule.agentAction);

  if (rule.keyRule && !keyIsRequirement && keyIsAction) {
    // One sentence, both labels, printed once.
    parts.push(`KEY RULE / ACTION: ${rule.keyRule}`);
  } else {
    if (rule.keyRule && !keyIsRequirement) parts.push(`KEY RULE: ${rule.keyRule}`);
    if (rule.agentAction && !sameText(rule.agentAction, rule.ruleRequirement)) {
      parts.push(`ACTION: ${rule.agentAction}`);
    }
  }

  if (rule.doInstruction) parts.push(`DO: ${rule.doInstruction}`);
  if (rule.dontInstruction) parts.push(`DO NOT: ${rule.dontInstruction}`);
  if (rule.bannedPhrase) parts.push(`NEVER SAY: ${rule.bannedPhrase}`);
  if (rule.replacementInstruction) parts.push(`SAY INSTEAD: ${rule.replacementInstruction}`);
  // "ESCALATE." rather than the full sentence it used to spell out. 276 rules
  // carry this marker, and repeating "ESCALATION REQUIRED: a human must handle
  // this." on each of them cost 2,553 tokens per request to say the same thing
  // 276 times. What it means is stated once in the model's instructions
  // instead — see ESCALATE_MEANING in `lib/ai/draft-generator.ts`, which must
  // stay in step with this marker.
  if (rule.escalationRequired) parts.push("ESCALATE.");
  return parts.join("\n");
}

/**
 * Stable, short, citable reference. Same rule, same ref, every run.
 *
 * Keyed on the rule's SOURCE identity — area, sheet, row — because that is what
 * is unique. Keying on area and row alone collided whenever two sheets in the
 * same area had a rule on the same row number, which for these documents is
 * most of them.
 */
function sheetCode(sheet: string): string {
  let hash = 0;
  for (let index = 0; index < sheet.length; index++) {
    hash = (hash * 31 + sheet.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36).toUpperCase().slice(-3).padStart(3, "0");
}

export function refFor(rule: ExtractedRule): string {
  const area = rule.categoryName
    .replace(/[^A-Za-z ]/g, "")
    .split(/\s+/)
    .map((word) => word.slice(0, 3).toUpperCase())
    .join("")
    .slice(0, 6);
  return `${area}-${sheetCode(rule.sourceSheet ?? "")}-${rule.sourceRow}`;
}

export type ScopedCorpus = {
  readonly rules: readonly CstRule[];
  /** Areas present, in document order. */
  readonly categories: readonly string[];
  /** Rules dropped as belonging to another marketplace. */
  readonly droppedForMarketplace: number;
  /** Rules covering several platforms, which carry the branch warning. */
  readonly multiPlatformCount: number;
};

/**
 * The corpus as the model receives it: everything, minus other marketplaces.
 *
 * Grouped by area and kept in document order so related rules stay together —
 * a model reading 1,300 rules benefits from the same structure a person would.
 */
export function scopeCorpus(
  all: readonly ExtractedRule[],
  marketplace: string | null,
): ScopedCorpus {
  const platform = marketplace?.toUpperCase() ?? null;
  const rules: CstRule[] = [];
  const categories: string[] = [];
  let dropped = 0;
  let multiPlatformCount = 0;

  const ordered = [...all].sort((a, b) => {
    if (a.categoryName !== b.categoryName) return a.categoryName < b.categoryName ? -1 : 1;
    if (a.sourceSheet !== b.sourceSheet) return (a.sourceSheet ?? "") < (b.sourceSheet ?? "") ? -1 : 1;
    return a.sourceRow - b.sourceRow;
  });

  for (const rule of ordered) {
    const scope = scopeFor(rule, marketplace);
    if (!scope.keep) {
      dropped += 1;
      continue;
    }
    if (scope.multiPlatform) multiPlatformCount += 1;
    if (!categories.includes(rule.categoryName)) categories.push(rule.categoryName);

    // The annotation is added CONTEXT, not edited rule content: the document's
    // own wording is passed through untouched and this is appended after it.
    const note =
      scope.multiPlatform && platform !== null
        ? `\nAPPLIES TO SEVERAL PLATFORMS: follow only the ${platform} steps in this rule. Ignore every other platform's steps, links and wording.`
        : "";

    rules.push({
      ref: refFor(rule),
      // The area is NOT repeated here. `renderRulesForPrompt` groups by area and
      // prints it once as a heading; carrying it on every title as well cost
      // 5,678 tokens per request and said nothing the heading does not.
      // `category` below still holds it, which is what the grouping reads.
      title: (rule.ruleName.trim() || rule.categoryName).slice(0, 160),
      text: `${renderRuleText(rule)}${note}`,
      category: rule.categoryName,
      // Carried through for audit, NOT for the prompt: the model never sees
      // these. They are what lets a reviewer open the workbook and read the
      // row a draft cited. See `lib/domain/knowledge.ts`.
      sourceFile: rule.sourceFile,
      sourceSheet: rule.sourceSheet,
      sourceRow: rule.sourceRow,
    });
  }

  return { rules, categories, droppedForMarketplace: dropped, multiPlatformCount };
}
