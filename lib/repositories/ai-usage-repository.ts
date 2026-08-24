import "server-only";

/**
 * Read-only view of what the draft model has consumed.
 *
 * SELECT only. Accounting figures — counts, models, an estimated cost — and
 * nothing else: no prompt, no reply, no rule text and no customer data is
 * stored in `ai_usage_log`, so nothing read here needs redacting.
 *
 * The SQL lives in this repository rather than in the route because that is
 * where every other query in this project lives; a guard test fails the build
 * if a handler embeds one.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/**
 * Totals are returned as text.
 *
 * `sum()` over a bigint column yields a numeric, and node-postgres hands
 * numerics back as strings to avoid losing precision through a JS number. They
 * are passed through as text rather than coerced here, so the boundary does not
 * quietly round a total the caller may want exactly.
 */
const SUMMARY = `
SELECT count(*)::int                                           AS calls,
       coalesce(sum(input_tokens), 0)::bigint::text            AS input_tokens,
       coalesce(sum(output_tokens), 0)::bigint::text           AS output_tokens,
       coalesce(sum(total_tokens), 0)::bigint::text            AS total_tokens,
       coalesce(sum(estimated_cost_usd), 0)::text              AS estimated_cost_usd,
       count(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS calls_without_price,
       count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS calls_today,
       max(created_at)::text                                   AS last_call_at
FROM cst_app.ai_usage_log`;

const BY_MODEL = `
SELECT provider,
       model,
       count(*)::int                                 AS calls,
       coalesce(sum(total_tokens), 0)::bigint::text  AS total_tokens,
       coalesce(sum(estimated_cost_usd), 0)::text    AS estimated_cost_usd
FROM cst_app.ai_usage_log
GROUP BY provider, model
ORDER BY count(*) DESC`;

export type UsageSummary = {
  calls: number;
  input_tokens: string;
  output_tokens: string;
  total_tokens: string;
  estimated_cost_usd: string;
  calls_without_price: number;
  calls_today: number;
  last_call_at: string | null;
};

export type UsageByModel = {
  provider: string;
  model: string;
  calls: number;
  total_tokens: string;
  estimated_cost_usd: string;
};

/**
 * The usage recorded for one draft revision.
 *
 * Keyed on the revision rather than the conversation: a conversation may have
 * been regenerated several times, and the panel is describing the draft on
 * screen, not the conversation's lifetime spend.
 *
 * Returns null when no row exists — a draft written before usage logging
 * existed, or one whose accounting row failed to write. The panel says nothing
 * rather than showing zeros, because zero tokens is a claim and "not recorded"
 * is the truth.
 */
const USAGE_FOR_REVISION = `
SELECT provider,
       model,
       input_tokens,
       output_tokens,
       total_tokens,
       estimated_cost_usd::text AS estimated_cost_usd,
       duration_ms,
       created_at::text         AS created_at
FROM cst_app.ai_usage_log
WHERE draft_revision_id = $1::bigint
  -- Successful runs only. A failed generation produces no revision, so it
  -- could not match anyway — this states the intent rather than relying on
  -- that, so a future failure row that did carry a revision id could never be
  -- read back as the draft's own timing.
  AND outcome = 'ok'
ORDER BY created_at DESC
LIMIT 1`;

export type RevisionUsage = {
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: string | null;
  /**
   * Measured wall-clock milliseconds for the generation.
   *
   * Null for a draft written before timing existed, and for one whose
   * accounting row was written without it. The panel prints "not recorded"
   * rather than a zero, because zero milliseconds is a claim.
   */
  duration_ms: number | null;
  created_at: string;
};

export async function readUsageForRevision(
  client: Queryable,
  draftRevisionId: string,
): Promise<RevisionUsage | null> {
  const { rows } = await client.query({
    text: USAGE_FOR_REVISION,
    values: [draftRevisionId],
  });
  return (rows as RevisionUsage[])[0] ?? null;
}

export async function readAiUsage(
  client: Queryable,
): Promise<{ summary: UsageSummary | null; byModel: UsageByModel[] }> {
  const [summary, byModel] = await Promise.all([
    client.query({ text: SUMMARY }),
    client.query({ text: BY_MODEL }),
  ]);
  return {
    summary: (summary.rows as UsageSummary[])[0] ?? null,
    byModel: byModel.rows as UsageByModel[],
  };
}
