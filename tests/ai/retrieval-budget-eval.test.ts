import { appendFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateDraftAccuracy } from "@/lib/ai/draft-validation";
import { MAX_SEARCH_RESULTS_VAR } from "@/lib/ai/openai-client";
import { getOpenAiProvider } from "@/lib/ai/openai-client";
import type { DraftOutcome, DraftRequest } from "@/lib/ai/provider";
import { closeAllPools, getAppPool } from "@/lib/db/pools";
import type { VerifiedFact } from "@/lib/domain/draft";
import type { ConversationMessageView } from "@/lib/domain/inbox";
import {
  type MessageCategory,
  classifyConversationCategory,
} from "@/lib/knowledge/message-category";
import { loadEnvFile } from "@/tests/support/load-env";

/**
 * How many File Search results a CST draft actually needs.
 *
 * OPT-IN, and it must stay that way: this spends real tokens against the real
 * vector store. `RUN_RETRIEVAL_EVAL=1 npx vitest run tests/ai/retrieval-budget-eval.test.ts`
 *
 * READ-ONLY, DELIBERATELY AND CHECKABLY.
 *
 *   - Conversations are SELECTed from cst_app and never written back.
 *   - The provider is called DIRECTLY, not through the route, so no draft
 *     revision, no workflow transition and no usage row is written.
 *   - `resolveEbayOrderContext` is NOT called, because resolving an order
 *     WRITES a context snapshot. Facts are supplied per scenario instead, which
 *     also makes "before dispatch" and "after dispatch" mean what they say
 *     rather than whatever the picked conversation happened to be.
 *   - The accuracy gate's wrapper is bypassed on purpose. Regeneration is
 *     MEASURED (would this draft have bought a second call?) rather than
 *     performed, so the evaluation costs one call per cell instead of two.
 *
 * NO CUSTOMER TEXT IS COMMITTED. Conversations are fetched at run time and only
 * their ids and categories are reported.
 */

loadEnvFile();

const ENABLED = process.env.RUN_RETRIEVAL_EVAL === "1";

/** The retrieval budgets under test, current first so it becomes the baseline. */
const SETTINGS = (process.env.EVAL_SETTINGS ?? "20,15,10,8,5")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);

/** Repeats of the baseline, to size run-to-run noise before reading any gap. */
const BASELINE_REPEATS = Number.parseInt(process.env.EVAL_BASELINE_REPEATS ?? "1", 10);

const OUT = process.env.EVAL_OUT ?? "retrieval-eval.tsv";

/**
 * The scenarios asked for, and the verified facts that make each one itself.
 *
 * `category` picks a real conversation whose customer text the deterministic
 * classifier assigns to that category. `german` picks on language instead.
 */
type Scenario = {
  readonly name: string;
  readonly category: MessageCategory;
  readonly german?: boolean;
  readonly facts: VerifiedFact[];
};

const ORDER = "AA-11111-11111";

const ALL_SCENARIOS: readonly Scenario[] = [
  {
    name: "cancellation before dispatch",
    category: "Order change, before shipping queries",
    facts: [
      { name: "order_number", value: ORDER },
      { name: "order_status", value: "New" },
      { name: "order_date", value: "2026-07-30" },
    ],
  },
  {
    name: "cancellation after dispatch",
    category: "Return and refunds",
    facts: [
      { name: "order_number", value: ORDER },
      { name: "order_status", value: "Completed" },
      { name: "order_date", value: "2026-07-20" },
      { name: "tracking_number", value: "AB123456789GB" },
      { name: "delivery_courier", value: "Royal Mail" },
    ],
  },
  {
    name: "missing parts",
    category: "Parts missing queries",
    facts: [
      { name: "order_number", value: ORDER },
      { name: "order_status", value: "Completed" },
      { name: "tracking_number", value: "AB123456789GB" },
    ],
  },
  {
    name: "wrong item",
    category: "Wrong item sent messages",
    facts: [
      { name: "order_number", value: ORDER },
      { name: "order_status", value: "Completed" },
      { name: "tracking_number", value: "AB123456789GB" },
    ],
  },
  {
    name: "damage",
    category: "Damage queries",
    facts: [
      { name: "order_number", value: ORDER },
      { name: "order_status", value: "Completed" },
      { name: "tracking_number", value: "AB123456789GB" },
    ],
  },
  {
    name: "german message",
    category: "Delivery queries",
    german: true,
    facts: [
      { name: "order_number", value: ORDER },
      { name: "order_status", value: "Completed" },
      { name: "tracking_number", value: "AB123456789GB" },
      { name: "delivery_courier", value: "Royal Mail" },
    ],
  },
  {
    name: "pre-sales question",
    category: "Pre sales queries",
    facts: [],
  },
  {
    name: "delivery query",
    category: "Delivery queries",
    facts: [
      { name: "order_number", value: ORDER },
      { name: "order_status", value: "Completed" },
      { name: "tracking_number", value: "AB123456789GB" },
      { name: "delivery_courier", value: "Royal Mail" },
    ],
  },
];

/**
 * Which scenarios this run covers.
 *
 * `EVAL_SCENARIOS` narrows to a named subset so a quick check costs a handful
 * of calls instead of the full grid. Unset runs everything.
 */
const SCENARIOS: readonly Scenario[] =
  process.env.EVAL_SCENARIOS === undefined
    ? ALL_SCENARIOS
    : process.env.EVAL_SCENARIOS.split(",")
        .map((name) => name.trim())
        .map((name) => ALL_SCENARIOS.find((scenario) => scenario.name === name))
        .filter((scenario): scenario is Scenario => scenario !== undefined);

/** Wording that only appears in German, for the language scenario. */
const GERMAN = /\b(?:ich|nicht|bitte|bestellung|lieferung|habe|wurde|sendung|artikel|leider)\b/i;

type Candidate = {
  readonly id: string;
  readonly listingItemRef: string | null;
  readonly texts: string[];
  readonly category: MessageCategory | null;
};

/** Every short eBay conversation, classified. Read-only. */
async function loadCandidates(): Promise<Candidate[]> {
  const { rows } = await getAppPool().query<{
    id: string;
    listing_item_ref: string | null;
    texts: string[] | null;
  }>(
    `SELECT c.id::text AS id,
            c.listing_item_ref,
            array_agg(m.body_text ORDER BY m.source_ts, m.source_pk)
              FILTER (WHERE m.direction = 'inbound'
                        AND m.body_decode_status = 'decoded'
                        AND m.body_text IS NOT NULL) AS texts
       FROM cst_app.conversations c
       JOIN cst_app.conversation_messages m ON m.conversation_id = c.id
      WHERE c.marketplace = 'ebay'
        AND c.inbound_count BETWEEN 1 AND 2
      GROUP BY c.id, c.listing_item_ref
      LIMIT 1500`,
  );

  return rows
    .filter((row) => row.texts !== null && row.texts.length > 0)
    .map((row) => ({
      id: row.id,
      listingItemRef: row.listing_item_ref,
      texts: row.texts!,
      category: classifyConversationCategory(row.texts!),
    }));
}

/** One real conversation per scenario, each used once. */
function assign(candidates: readonly Candidate[]): Map<string, Candidate> {
  const chosen = new Map<string, Candidate>();
  const taken = new Set<string>();

  for (const scenario of SCENARIOS) {
    const match = candidates.find((candidate) => {
      if (taken.has(candidate.id)) return false;
      if (candidate.category !== scenario.category) return false;
      const joined = candidate.texts.join(" ");
      // Long enough to be a real case, short enough to keep the variable under
      // test the retrieval budget rather than the conversation length.
      if (joined.length < 60 || joined.length > 1_200) return false;
      return scenario.german === true ? GERMAN.test(joined) : !GERMAN.test(joined);
    });
    if (match !== undefined) {
      chosen.set(scenario.name, match);
      taken.add(match.id);
    }
  }
  return chosen;
}

function toMessages(texts: readonly string[]): ConversationMessageView[] {
  return texts.map((text, index) => ({
    id: String(index + 1),
    direction: "inbound" as const,
    sourceTimestamp: "2026-08-01 09:00:00",
    bodyText: text,
    bodyDecodeStatus: "decoded" as const,
    attachments: [],
  }));
}

type Cell = {
  scenario: string;
  conversationId: string;
  setting: number;
  run: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
  refs: string[];
  criticalFindings: number;
  minorFindings: number;
  regenerate: boolean;
  issues: string;
  replyChars: number;
  error: string;
};

describe.skipIf(!ENABLED)("retrieval budget", () => {
  it(
    "measures accuracy and cost across File Search limits",
    async () => {
      const provider = getOpenAiProvider();
      expect(provider, "OpenAI must be configured for this evaluation").toBeDefined();

      const candidates = await loadCandidates();
      const chosen = assign(candidates);

      const header = [
        "scenario", "conversation", "setting", "run",
        "input", "output", "total", "ms",
        "refs", "refList", "critical", "minor", "regenerate", "issues", "replyChars", "error",
      ].join("\t");
      writeFileSync(OUT, header + "\n", "utf8");

      const cells: Cell[] = [];

      for (const scenario of SCENARIOS) {
        const conversation = chosen.get(scenario.name);
        if (conversation === undefined) {
          appendFileSync(OUT, `${scenario.name}\t(no matching conversation)\n`, "utf8");
          continue;
        }

        const request: DraftRequest = {
          messages: toMessages(conversation.texts),
          marketplace: "ebay",
          listingItemRef: conversation.listingItemRef,
          facts: scenario.facts,
        };

        for (const setting of SETTINGS) {
          const runs = setting === SETTINGS[0] ? BASELINE_REPEATS : 1;
          for (let run = 1; run <= runs; run += 1) {
            process.env[MAX_SEARCH_RESULTS_VAR] = String(setting);

            const started = performance.now();
            let outcome: DraftOutcome | undefined;
            let error = "";
            try {
              outcome = await provider!.generate(request);
            } catch (cause) {
              error = (cause as Error).message.slice(0, 80);
            }
            const durationMs = Math.round(performance.now() - started);

            const check =
              outcome === undefined
                ? undefined
                : validateDraftAccuracy({
                    reply: outcome.result.draft_reply,
                    facts: request.facts,
                    messages: request.messages,
                    knowledgeAvailable: outcome.knowledgeAvailable,
                  });

            const refs = (outcome?.result.sources_used ?? [])
              .filter((source) => source.kind === "cst_document")
              .map((source) => source.ref)
              .sort();

            const cell: Cell = {
              scenario: scenario.name,
              conversationId: conversation.id,
              setting,
              run,
              inputTokens: outcome?.usage?.inputTokens ?? null,
              outputTokens: outcome?.usage?.outputTokens ?? null,
              totalTokens: outcome?.usage?.totalTokens ?? null,
              durationMs,
              refs,
              criticalFindings:
                check?.findings.filter((f) => f.severity === "critical").length ?? -1,
              minorFindings: check?.findings.filter((f) => f.severity === "minor").length ?? -1,
              regenerate: check?.regenerationWarranted ?? false,
              issues: [...new Set(check?.findings.map((f) => f.issue) ?? [])].join("|"),
              replyChars: outcome?.result.draft_reply.length ?? 0,
              error,
            };
            cells.push(cell);

            // Appended as it goes, so a run that dies part-way still leaves the
            // measurements it already paid for.
            appendFileSync(
              OUT,
              [
                cell.scenario, cell.conversationId, cell.setting, cell.run,
                cell.inputTokens, cell.outputTokens, cell.totalTokens, cell.durationMs,
                refs.length, refs.join(","), cell.criticalFindings, cell.minorFindings,
                cell.regenerate ? "YES" : "no", cell.issues, cell.replyChars, cell.error,
              ].join("\t") + "\n",
              "utf8",
            );
          }
        }
      }

      delete process.env[MAX_SEARCH_RESULTS_VAR];
      await closeAllPools();
      expect(cells.length).toBeGreaterThan(0);
    },
    60 * 60_000,
  );
});
