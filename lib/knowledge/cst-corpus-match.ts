import { CST_CATEGORY_CORPUS, type CorpusRule, type RuleRole } from "./cst-category-corpus";

/**
 * Matching a customer message against the whole CST category corpus.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT REFUSES TO BE
 * ------------------------------------------------------------------------
 * `cst-category-corpus.ts` holds 730 rows from eleven workbooks and 7,825
 * phrases of real customer language. This finds the rows whose language appears
 * in a message. That is ALL it does — it does not choose a category, and on its
 * own it must not be allowed to, because a phrase table with 7,825 entries and a
 * vote is exactly the blind keyword classifier this system exists to avoid.
 *
 * Three things keep it honest, and each one removes a way of being wrong:
 *
 *   ROLE            Only PRIMARY_ISSUE rows may propose a category. "Please
 *                   refund me" matches rows in six workbooks and none of them is
 *                   a reason to file it under any of the six. See `RuleRole`.
 *
 *   SHARED PHRASES  A phrase claimed by three or more categories is not evidence
 *                   for any of them and is dropped from matching entirely. It
 *                   stays in the corpus, because a reviewer needs to see that
 *                   "not what I ordered" appears in four books; it just cannot
 *                   decide anything. This is measured from the corpus itself
 *                   rather than listed by hand, so it stays true as the
 *                   workbooks change.
 *
 *   THE CALLER      Nothing here reaches a category. `message-category.ts` takes
 *                   these matches, checks each proposal against what the whole
 *                   message actually says, and resolves ownership. A match is a
 *                   candidate and never a verdict.
 *
 * ------------------------------------------------------------------------
 * SPEED
 * ------------------------------------------------------------------------
 * Every conversation in the inbox is classified on read, so this has to be
 * cheap. Testing 7,825 phrases per message is not. Instead each phrase is
 * indexed under its RAREST word, the message is reduced to its set of words, and
 * only phrases whose rare word is present are ever compared. A typical message
 * checks a few dozen phrases rather than several thousand.
 */

export type { CorpusRule, RuleRole };
export { CST_CATEGORY_CORPUS };

/**
 * One rule matched, and the phrase that matched it.
 *
 * The phrase is the workbook's own wording, not the customer's, so this is safe
 * to log — see `explainMessageCategory`.
 */
export type CorpusMatch = {
  readonly rule: CorpusRule;
  readonly phrase: string;
};

/* ------------------------------------------------------------------------- *
 * NORMALISATION
 * ------------------------------------------------------------------------- */

/**
 * A string reduced to space-separated lower-case words, padded at both ends.
 *
 * The padding is what lets a phrase be matched with `includes` and still respect
 * word boundaries: " shade " cannot match inside "lampshades". Everything that
 * is not a letter, digit or apostrophe becomes a space, which folds punctuation,
 * line breaks, HTML entities that survived decoding, and emoji into separators
 * in one pass. That is also what makes the classification stable under the
 * metamorphic tests — removing a question mark or a comma cannot change it.
 */
export function normaliseForCorpus(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9'’äöüßàâçéèêëîïôûùüÿñæœ]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** Placeholders the workbooks use where a real message has a value. */
const PLACEHOLDER = /\[[^\]]*\]/;

/**
 * Words too common to index a phrase by. Not a stop list for matching — the
 * whole phrase is still compared — only for choosing which word to look up.
 */
const COMMON = new Set([
  "the", "a", "an", "i", "it", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on",
  "for", "and", "or", "but", "my", "me", "you", "your", "we", "us", "this", "that", "these",
  "those", "have", "has", "had", "do", "does", "did", "not", "no", "with", "at", "as", "if",
  "can", "could", "will", "would", "please", "just", "so", "up", "out", "get", "got", "am",
]);

/* ------------------------------------------------------------------------- *
 * THE INDEX
 * ------------------------------------------------------------------------- */

type IndexedPhrase = {
  /** The phrase, normalised and padded, ready for `includes`. */
  readonly needle: string;
  /** The workbook's own wording, for the explanation. */
  readonly phrase: string;
  readonly rule: CorpusRule;
};

type Index = {
  readonly byWord: ReadonlyMap<string, readonly IndexedPhrase[]>;
  /** Phrases dropped because three or more categories claim them. */
  readonly shared: ReadonlyMap<string, readonly string[]>;
  readonly indexed: number;
};

/** A phrase claimed by this many distinct categories decides nothing. */
const SHARED_BY_CATEGORIES = 3;

/**
 * A single-word phrase has to carry its own weight.
 *
 * "Amazon", "eBay", "urgent" and "recall" all appear as standalone triggers, and
 * a single common word is a category vote rather than evidence. Two words is the
 * floor; a lone word is admitted only when it is long enough to be a specific
 * thing rather than a mood.
 */
const MIN_SINGLE_WORD_LENGTH = 7;

/** Single words that name a platform or a feeling rather than a case. */
const NOT_ON_ITS_OWN = new Set([
  "amazon", "ebay", "urgent", "asap", "recall", "recalled", "invoice", "receipt", "warranty",
  "refund", "damaged", "broken", "faulty", "defective", "missing", "incomplete", "compensation",
  "exchange", "swap", "cancel", "collect", "wholesale", "duplicate", "delivered", "tracking",
]);

function buildIndex(): Index {
  // Which categories claim each normalised phrase.
  const claimants = new Map<string, Set<string>>();
  for (const rule of CST_CATEGORY_CORPUS) {
    for (const phrase of rule.phrases) {
      if (PLACEHOLDER.test(phrase)) continue;
      const needle = normaliseForCorpus(phrase);
      if (needle.trim() === "") continue;
      (claimants.get(needle) ?? claimants.set(needle, new Set()).get(needle)!).add(rule.category);
    }
  }

  const shared = new Map<string, string[]>();
  const byWord = new Map<string, IndexedPhrase[]>();
  let indexed = 0;

  for (const rule of CST_CATEGORY_CORPUS) {
    for (const phrase of rule.phrases) {
      if (PLACEHOLDER.test(phrase)) continue;
      const needle = normaliseForCorpus(phrase);
      const words = needle.trim().split(" ").filter((word) => word !== "");
      if (words.length === 0) continue;

      if (words.length === 1) {
        const word = words[0]!;
        if (word.length < MIN_SINGLE_WORD_LENGTH || NOT_ON_ITS_OWN.has(word)) continue;
      }

      const owners = claimants.get(needle);
      if (owners !== undefined && owners.size >= SHARED_BY_CATEGORIES) {
        shared.set(needle.trim(), [...owners].sort());
        continue;
      }

      // Index under the rarest word, so a message pays for the words it uses
      // rather than for the size of the corpus.
      let anchor = words[0]!;
      let best = Number.POSITIVE_INFINITY;
      for (const word of words) {
        if (COMMON.has(word) || word.length < 3) continue;
        const size = byWord.get(word)?.length ?? 0;
        if (size < best) {
          best = size;
          anchor = word;
        }
      }

      const bucket = byWord.get(anchor);
      const entry: IndexedPhrase = { needle, phrase, rule };
      if (bucket === undefined) byWord.set(anchor, [entry]);
      else (bucket as IndexedPhrase[]).push(entry);
      indexed += 1;
    }
  }

  return { byWord, shared, indexed };
}

const INDEX = buildIndex();

/** How many phrases are actually matchable, and how many were set aside. */
export const CORPUS_INDEX_STATS = {
  rules: CST_CATEGORY_CORPUS.length,
  phrases: CST_CATEGORY_CORPUS.reduce((total, rule) => total + rule.phrases.length, 0),
  indexedPhrases: INDEX.indexed,
  sharedPhrases: INDEX.shared.size,
} as const;

/** The phrases dropped for being claimed by three or more categories. */
export function sharedPhrases(): ReadonlyMap<string, readonly string[]> {
  return INDEX.shared;
}

/* ------------------------------------------------------------------------- *
 * MATCHING
 * ------------------------------------------------------------------------- */

/**
 * Every corpus rule whose approved customer language appears in this message.
 *
 * One match per rule — the first phrase that hit — because a rule matching twice
 * is not twice the evidence, and counting is the thing this design refuses to
 * do.
 */
export function corpusMatches(text: string): CorpusMatch[] {
  const haystack = normaliseForCorpus(text);
  if (haystack.trim() === "") return [];

  const words = new Set(haystack.trim().split(" "));
  const seen = new Set<CorpusRule>();
  const matches: CorpusMatch[] = [];

  for (const word of words) {
    const bucket = INDEX.byWord.get(word);
    if (bucket === undefined) continue;
    for (const candidate of bucket) {
      if (seen.has(candidate.rule)) continue;
      if (!haystack.includes(candidate.needle)) continue;
      seen.add(candidate.rule);
      matches.push({ rule: candidate.rule, phrase: candidate.phrase });
    }
  }
  return matches;
}

/** The matched rules that are allowed to propose a category. */
export function primaryMatches(text: string): CorpusMatch[] {
  return corpusMatches(text).filter((match) => match.rule.role === "PRIMARY_ISSUE");
}

// The first call compiles the index's lookups and warms V8's string paths.
// Doing it at module load keeps the cost off the first conversation read.
void corpusMatches("warm up the corpus index");
