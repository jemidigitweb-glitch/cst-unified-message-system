import "server-only";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { type KnowledgeSource, knowledgeFromRules, knowledgeNotConfigured } from "@/lib/domain/knowledge";

import { type ExtractedRule, extractWorkbook } from "./rule-extraction";
import { type ScopedCorpus, scopeCorpus } from "./rule-scoping";
import { readWorkbook } from "./workbook-reader";

/**
 * The CST rule corpus, read from the workbooks in `Knowledge-source/`.
 *
 * READ-ONLY, and local. This is the MVP source: the documents on disk are the
 * authority, and there is no database and no import step between them and a
 * draft. Editing a spreadsheet changes the next draft, which is the behaviour
 * the business already expects from these files.
 *
 * ALL OF IT GOES TO THE MODEL. There is no filtering step between the workbooks
 * and the prompt beyond dropping other marketplaces' rules — the model reads the
 * documents and works out what applies, the same way a person handed the same
 * folder would. See `rule-scoping.ts` for why the keyword layer was removed.
 *
 * CACHED ON FILE IDENTITY, not on time. Parsing fourteen workbooks takes a
 * couple of seconds, which is too slow to repeat per generation and too
 * dangerous to cache blindly — a stale policy is worse than a slow one. The
 * cache key is every file's size and modification time, so an edited workbook
 * invalidates itself on the next read and an untouched one costs nothing.
 *
 * DEGRADES, NEVER THROWS. A missing folder or an unreadable workbook returns
 * `not_configured` with a reason. The generator then drops into its restricted
 * mode — acknowledge the customer, ask what is needed, state no policy — rather
 * than the feature disappearing.
 */

const DEFAULT_DIRECTORY = "Knowledge-source";

/**
 * Read per call, not captured at import.
 *
 * Lazy config is the pattern the rest of this project uses (`lib/config/env.ts`
 * memoises but still reads on first use), and a value frozen at module load is
 * one a test cannot vary and a deployment cannot override.
 */
function sourceDirectory(): string {
  return process.env.CST_RULES_DIR?.trim() || DEFAULT_DIRECTORY;
}

function directory(): string {
  return join(process.cwd(), sourceDirectory());
}

type Cache = { key: string; rules: readonly ExtractedRule[] };

let cache: Cache | undefined;

/** Identity of the folder's contents: name, size and mtime of every workbook. */
function fingerprint(path: string, files: readonly string[]): string {
  return files
    .map((file) => {
      const stats = statSync(join(path, file));
      return `${file}:${stats.size}:${stats.mtimeMs}`;
    })
    .join("|");
}

function workbookNames(path: string): string[] {
  return readdirSync(path)
    .filter((name) => name.endsWith(".xlsx") && !name.startsWith("~$"))
    .sort();
}

export type CorpusLoad = {
  readonly rules: readonly ExtractedRule[];
  readonly files: number;
  readonly cached: boolean;
};

/**
 * Parses every workbook, or returns the cached parse.
 *
 * Throws only if the folder itself cannot be listed; a single unreadable
 * workbook is skipped and logged, because eleven areas of policy are better
 * than none.
 */
export function loadCorpus(): CorpusLoad {
  const path = directory();
  const files = workbookNames(path);
  const key = fingerprint(path, files);

  if (cache?.key === key) return { rules: cache.rules, files: files.length, cached: true };

  const rules: ExtractedRule[] = [];
  for (const file of files) {
    try {
      rules.push(...extractWorkbook(file, readWorkbook(readFileSync(join(path, file)))).rules);
    } catch (cause) {
      // Named, not silenced: a workbook that stopped parsing is a real problem,
      // but not one worth taking the other thirteen down for.
      console.error(`[cst-rules] could not read ${file}`, cause);
    }
  }

  cache = { key, rules };
  return { rules, files: files.length, cached: false };
}

/** Test seam: forces the next load to re-read the workbooks. */
export function resetCorpusCacheForTests(): void {
  cache = undefined;
}

export type LoadedRules = {
  readonly knowledge: KnowledgeSource;
  readonly corpus: ScopedCorpus | undefined;
};

/**
 * Loads the rules for one conversation: all of them.
 *
 * The conversation text is not read here and does not narrow anything. The only
 * thing that varies by conversation is the marketplace, and that removes another
 * platform's rules rather than choosing a topic — see `rule-scoping.ts`.
 */
export function loadRulesForConversation(
  marketplace: string | null,
): LoadedRules {
  let loaded: CorpusLoad;
  try {
    loaded = loadCorpus();
  } catch (cause) {
    console.error("[cst-rules] rule folder unreadable", cause);
    return {
      knowledge: knowledgeNotConfigured(
        `The CST rule files could not be read from ${sourceDirectory()}, so this draft states no policy. Check it before using.`,
      ),
      corpus: undefined,
    };
  }

  if (loaded.rules.length === 0) {
    return {
      knowledge: knowledgeNotConfigured(
        `No CST rules were found in ${sourceDirectory()}, so this draft states no policy. Check it before using.`,
      ),
      corpus: undefined,
    };
  }

  const corpus = scopeCorpus(loaded.rules, marketplace);

  if (corpus.rules.length === 0) {
    return {
      knowledge: knowledgeNotConfigured(
        `No CST rule applies to ${marketplace ?? "this marketplace"}, so this draft states no policy. Check it before using.`,
      ),
      corpus,
    };
  }

  // The "sheet reference" recorded against the draft is the folder these came
  // from — local files, not a spreadsheet id.
  return {
    knowledge: knowledgeFromRules(corpus.rules, `${sourceDirectory()} (${loaded.files} workbooks)`),
    corpus,
  };
}
