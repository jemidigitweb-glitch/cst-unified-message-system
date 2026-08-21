import type { DraftUsage } from "@/lib/ai/provider";

/**
 * Records what a draft generation consumed.
 *
 * ACCOUNTING ONLY. No prompt, no reply, no rule text, no customer data ever
 * reaches this table — only counts, a model name and two ids. Nothing written
 * here should ever need redacting.
 *
 * WRITES cst_app.ai_usage_log AND NOTHING ELSE. It cannot alter a draft, a
 * conversation or a workflow state, and it never touches a marketplace source.
 *
 * NEVER FAILS A DRAFT. A recording error is logged and swallowed: losing an
 * accounting row is a nuisance, losing a draft the customer is waiting on
 * because the accounting row would not insert is not a trade worth making.
 */

export type Writable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * Price per MILLION tokens, in USD.
 *
 * A LOCAL ESTIMATE, not an invoice — the column is named `estimated_cost_usd`
 * for that reason. Published prices change and this table will drift; it exists
 * to make a runaway visible, not to reconcile a bill. An unknown model records
 * a NULL cost rather than a wrong one, because a plausible wrong number is
 * harder to catch than a missing one.
 *
 * Prefix matching, longest first, so `gpt-4.1-mini` does not price as `gpt-4.1`.
 */
const RATES: readonly { readonly prefix: string; readonly input: number; readonly output: number }[] = [
  { prefix: "gpt-4.1-nano", input: 0.1, output: 0.4 },
  { prefix: "gpt-4.1-mini", input: 0.4, output: 1.6 },
  { prefix: "gpt-4.1", input: 2.0, output: 8.0 },
  { prefix: "gpt-4o-mini", input: 0.15, output: 0.6 },
  { prefix: "gpt-4o", input: 2.5, output: 10.0 },
  { prefix: "gemini-3.6-flash", input: 0.3, output: 2.5 },
  { prefix: "gemini-2.5-flash", input: 0.3, output: 2.5 },
];

/** Estimated USD for one call, or null when the model is not in the table. */
export function estimateCost(
  model: string,
  usage: DraftUsage | undefined,
): number | null {
  if (usage === undefined) return null;
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === null && outputTokens === null) return null;

  const key = model.trim().toLowerCase();
  const rate = [...RATES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((entry) => key.startsWith(entry.prefix));
  if (rate === undefined) return null;

  const cost =
    ((inputTokens ?? 0) / 1_000_000) * rate.input +
    ((outputTokens ?? 0) / 1_000_000) * rate.output;
  // Six decimal places matches the column; a draft can genuinely cost less
  // than a tenth of a cent and rounding it to zero would hide the volume.
  return Number(cost.toFixed(6));
}

const INSERT_USAGE = `
INSERT INTO cst_app.ai_usage_log (
  provider, model, conversation_id, draft_revision_id,
  input_tokens, output_tokens, total_tokens, estimated_cost_usd, outcome
)
VALUES ($1, $2, $3::bigint, $4::bigint, $5::int, $6::int, $7::int, $8::numeric, $9)
RETURNING id`;

export type UsageRecord = {
  readonly provider: string;
  readonly model: string;
  readonly conversationId: string;
  /** Null when the call failed and produced no revision — still recorded. */
  readonly draftRevisionId: string | null;
  readonly usage: DraftUsage | undefined;
  /** 'ok', or a short reason. Never a provider message: those quote the request. */
  readonly outcome: string;
};

export async function recordUsage(
  client: Writable,
  record: UsageRecord,
): Promise<{ recorded: boolean }> {
  try {
    await client.query({
      text: INSERT_USAGE,
      values: [
        record.provider,
        record.model,
        record.conversationId,
        record.draftRevisionId,
        record.usage?.inputTokens ?? null,
        record.usage?.outputTokens ?? null,
        record.usage?.totalTokens ?? null,
        estimateCost(record.model, record.usage),
        record.outcome,
      ],
    });
    return { recorded: true };
  } catch (cause) {
    // Named, not silent. Most likely cause is migration 0006 not being applied,
    // and a draft must not fail because its accounting row could not be written.
    console.error("[usage] could not record AI usage", cause);
    return { recorded: false };
  }
}
