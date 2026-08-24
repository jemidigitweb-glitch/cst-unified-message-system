/**
 * Records that the rule base could not answer a conversation.
 *
 * IDEMPOTENT BY CONSTRUCTION. One row per conversation, upserted, so
 * re-analysing the same conversation ten times leaves one row with the newest
 * timestamp. There is nothing to accumulate and nothing to deduplicate later.
 *
 * PAIRED WITH ITS OWN DELETE. When a conversation later DOES produce a
 * grounded draft — the corpus was fixed, a rule was written, the marketplace
 * scoping changed — the finding is cleared in the same transaction that saves
 * the draft. A stale "no rule available" sitting beside a real draft would be
 * the exact contradiction this whole mechanism exists to remove.
 *
 * WRITES cst_app.conversation_rule_analysis AND NOTHING ELSE. No customer text,
 * no rule text, no marketplace source.
 */

export type Writable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

const UPSERT = `
INSERT INTO cst_app.conversation_rule_analysis (
  conversation_id, outcome, case_type, rules_available, analysed_at
)
VALUES ($1::bigint, 'no_applicable_rule', $2, $3::int, now())
ON CONFLICT (conversation_id) DO UPDATE
SET outcome         = EXCLUDED.outcome,
    case_type       = EXCLUDED.case_type,
    rules_available = EXCLUDED.rules_available,
    analysed_at     = EXCLUDED.analysed_at`;

const CLEAR = `
DELETE FROM cst_app.conversation_rule_analysis
WHERE conversation_id = $1::bigint`;

const READ = `
SELECT outcome,
       case_type,
       rules_available,
       analysed_at::text AS analysed_at
FROM cst_app.conversation_rule_analysis
WHERE conversation_id = $1::bigint`;

export type RuleAnalysis = {
  outcome: string;
  case_type: string | null;
  rules_available: number;
  analysed_at: string;
};

/**
 * Never fails the request.
 *
 * The reviewer's answer — "nothing here can ground a reply" — is correct
 * whether or not it was written down. Losing the note is a nuisance; failing
 * the request because the note would not insert is worse, and migration 0009
 * not being applied yet is the likeliest reason it would.
 */
export async function recordNoApplicableRule(
  client: Writable,
  record: {
    readonly conversationId: string;
    readonly caseType: string | null;
    readonly rulesAvailable: number;
  },
): Promise<{ recorded: boolean }> {
  try {
    await client.query({
      text: UPSERT,
      values: [record.conversationId, record.caseType, record.rulesAvailable],
    });
    return { recorded: true };
  } catch (cause) {
    console.error("[rule-analysis] could not record the no-rule finding", cause);
    return { recorded: false };
  }
}

/** Clears the finding once a grounded draft exists. Safe when there is none. */
export async function clearRuleAnalysis(
  client: Writable,
  conversationId: string,
): Promise<void> {
  try {
    await client.query({ text: CLEAR, values: [conversationId] });
  } catch (cause) {
    console.error("[rule-analysis] could not clear the no-rule finding", cause);
  }
}

/** The stored finding, or null. Null when the table is absent, too. */
export async function readRuleAnalysis(
  client: Writable,
  conversationId: string,
): Promise<RuleAnalysis | null> {
  try {
    const { rows } = await client.query({ text: READ, values: [conversationId] });
    return (rows as RuleAnalysis[])[0] ?? null;
  } catch {
    return null;
  }
}
