import "server-only";

import { SHARED_ACCOUNT_SOURCE_USER_IDS } from "@/lib/domain/agent-activity";
import { MESSAGES_HANDLED_ACTIONS } from "@/lib/domain/performance-metrics";
import {
  REOPEN_ACTION,
  RESOLUTION_ACTIONS,
  RESOLVED_ACTION,
  type UnresolvedCounts,
} from "@/lib/domain/unresolved-cases";

/**
 * Read-only reads for the Customer Service Insights dashboard.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT, against `cst_app` only. The
 * dashboard reads no MySQL and no source database at request time: everything
 * it needs was imported and is kept current by `npm run sync:mysql`.
 *
 * NO ROLLUP TABLE. 17,822 activity rows aggregate in milliseconds, and a stored
 * summary would be a second copy of a number that can drift from the first.
 * Aggregate at query time until measurement says otherwise.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export type MessagesHandledRow = {
  readonly sourceUserId: number | null;
  /** Null when the id is not in the directory, or when it must not be named. */
  readonly displayName: string | null;
  readonly active: boolean | null;
  readonly attributable: boolean;
  readonly messagesHandled: number;
  readonly conversations: number;
};

export type MessagesHandledFilters = {
  readonly from: string;
  readonly to: string;
  /** Null means every marketplace that has activity. */
  readonly marketplace: string | null;
  readonly sourceUserId: number | null;
};

/**
 * Messages handled per agent.
 *
 * LEFT JOIN, not JOIN: an agent id absent from the directory must still be
 * counted. Dropping the row would quietly reduce the team's total to make a
 * join tidy, and the id is exactly what an operator needs in order to go and
 * fix the directory.
 *
 * `action_date` is a DATE — the source has no time — so the bounds are whole
 * days and BETWEEN is correct rather than a half-open range.
 */
const MESSAGES_HANDLED = `
SELECT a.source_user_id                       AS source_user_id,
       d.display_name                         AS display_name,
       d.active                               AS active,
       count(*)::int                          AS messages_handled,
       count(DISTINCT a.conversation_id)::int AS conversations
FROM cst_app.agent_activity a
LEFT JOIN cst_app.agent_directory d
  ON d.source_user_id = a.source_user_id
 AND d.source_system = 'order_management'
WHERE a.action = ANY($1::text[])
  AND a.action_date BETWEEN $2::date AND $3::date
  AND ($4::text IS NULL OR a.marketplace = $4::text)
  AND ($5::bigint IS NULL OR a.source_user_id = $5::bigint)
GROUP BY 1, 2, 3
ORDER BY messages_handled DESC, source_user_id`;

export const MESSAGES_HANDLED_SQL = MESSAGES_HANDLED;

type MessagesHandledQueryRow = {
  source_user_id: string | number | null;
  display_name: string | null;
  active: boolean | null;
  messages_handled: number;
  conversations: number;
};

/**
 * A shared login is not a person, so it is never named.
 *
 * `source_user_id` 86 is an account literally called `admin`. The row stays —
 * the work happened and an operator must see it — but the name is withheld and
 * `attributable` is false, so the interface can render it as unattributed
 * rather than crediting one person with whoever was holding the password.
 *
 * The same applies to an id the directory does not know and to activity with no
 * recorded user: the work is real, the person is not established.
 */
function toRow(row: MessagesHandledQueryRow): MessagesHandledRow {
  const sourceUserId = row.source_user_id === null ? null : Number(row.source_user_id);
  const shared = sourceUserId !== null && SHARED_ACCOUNT_SOURCE_USER_IDS.has(sourceUserId);
  const attributable = sourceUserId !== null && !shared && row.display_name !== null;

  return {
    sourceUserId,
    displayName: attributable ? row.display_name : null,
    active: attributable ? row.active : null,
    attributable,
    messagesHandled: Number(row.messages_handled),
    conversations: Number(row.conversations),
  };
}

export async function messagesHandledByAgent(
  app: Queryable,
  filters: MessagesHandledFilters,
): Promise<readonly MessagesHandledRow[]> {
  const { rows } = await app.query({
    text: MESSAGES_HANDLED,
    values: [
      [...MESSAGES_HANDLED_ACTIONS],
      filters.from,
      filters.to,
      filters.marketplace,
      filters.sourceUserId,
    ],
  });
  return (rows as MessagesHandledQueryRow[]).map(toRow);
}

export type ActivityCoverage = {
  readonly marketplaces: readonly string[];
  readonly earliestDate: string | null;
  readonly latestDate: string | null;
  readonly agents: number;
};

/**
 * What the data actually covers, so the page can say so.
 *
 * A dashboard that silently reports eBay while a marketplace filter offers five
 * options is not wrong about eBay — it is wrong about everything else, and the
 * reader has no way to tell. This is what makes that visible.
 */
const COVERAGE = `
SELECT array_agg(DISTINCT marketplace ORDER BY marketplace)
         FILTER (WHERE marketplace IS NOT NULL) AS marketplaces,
       min(action_date)::text                   AS earliest_date,
       max(action_date)::text                   AS latest_date,
       count(DISTINCT source_user_id)::int      AS agents
FROM cst_app.agent_activity`;

export const COVERAGE_SQL = COVERAGE;

export async function activityCoverage(app: Queryable): Promise<ActivityCoverage> {
  const { rows } = await app.query({ text: COVERAGE });
  const row = rows[0] as {
    marketplaces: string[] | null;
    earliest_date: string | null;
    latest_date: string | null;
    agents: number;
  };
  return {
    marketplaces: row.marketplaces ?? [],
    earliestDate: row.earliest_date,
    latestDate: row.latest_date,
    agents: Number(row.agents ?? 0),
  };
}

/**
 * Conversations in scope, and how many are currently resolved.
 *
 * ONE SCOPE, BOTH COUNTS. `scoped` is evaluated once and everything else joins
 * to it, so the total and the resolved count cannot drift apart — which they
 * would the moment resolution was filtered by the ACTION's date instead. A
 * conversation from June resolved in September would then land in September's
 * resolved count and June's total, and the subtraction would be nonsense.
 *
 * The scope is the conversation's own activity window (`last_source_ts`), which
 * is what "conversations in this period" means to a reader.
 *
 * `DISTINCT ON` takes the LATEST state-changing action per conversation —
 * reopening is real, so the presence of a resolution somewhere in the history
 * is not the question. `action_date` is a DATE with no time, so `source_pk`
 * (the source log's auto-increment id) breaks same-day ties; it is the only
 * ordering the source offers within a day.
 *
 * Half-open upper bound: `last_source_ts` is a timestamp, so an inclusive
 * bound would drop everything after midnight on the closing day.
 */
const UNRESOLVED = `
WITH scoped AS (
  SELECT c.id
  FROM cst_app.conversations c
  WHERE c.last_source_ts >= $1::date
    AND c.last_source_ts < ($2::date + 1)
    AND ($3::text IS NULL OR c.marketplace = $3::text)
),
latest AS (
  SELECT DISTINCT ON (a.conversation_id) a.conversation_id, a.action
  FROM cst_app.agent_activity a
  JOIN scoped s ON s.id = a.conversation_id
  WHERE a.action = ANY($4::text[])
  ORDER BY a.conversation_id, a.action_date DESC, a.source_pk::bigint DESC
)
SELECT (SELECT count(*)::int FROM scoped)                                        AS total,
       (SELECT count(*)::int FROM latest WHERE action = $5::text)                AS resolved,
       (SELECT count(*)::int FROM latest WHERE action = $6::text)                AS reopened,
       (SELECT count(DISTINCT a2.conversation_id)::int
          FROM cst_app.agent_activity a2
          JOIN scoped s2 ON s2.id = a2.conversation_id)                          AS with_activity`;

export const UNRESOLVED_SQL = UNRESOLVED;

export async function unresolvedCaseCounts(
  app: Queryable,
  filters: { readonly from: string; readonly to: string; readonly marketplace: string | null },
): Promise<UnresolvedCounts> {
  const { rows } = await app.query({
    text: UNRESOLVED,
    values: [
      filters.from,
      filters.to,
      filters.marketplace,
      [...RESOLUTION_ACTIONS],
      RESOLVED_ACTION,
      REOPEN_ACTION,
    ],
  });
  const row = rows[0] as
    | { total: number; resolved: number; reopened: number; with_activity: number }
    | undefined;
  return {
    total: Number(row?.total ?? 0),
    resolved: Number(row?.resolved ?? 0),
    reopened: Number(row?.reopened ?? 0),
    withActivity: Number(row?.with_activity ?? 0),
  };
}

/**
 * eBay seller feedback for a period, counted by sentiment.
 *
 * READS THE READ-ONLY SOURCE POOL. This is the one dashboard read that does not
 * come from `cst_app`: feedback lives in the marketplace source, CST already
 * holds a session-level read-only connection to it, and copying 322,696 rows to
 * count three of them would be a second store to keep in step for no gain.
 *
 * `role = 'Seller'` is stated even though every row currently carries it. The
 * column exists to distinguish feedback left FOR us from feedback left BY us,
 * and relying on a table that happens to hold only one value today is how a
 * buyer's own rating ends up counted as our score tomorrow.
 *
 * `type` is the sentiment. `rating_star` is NOT — it is eBay's seller-badge
 * colour (Red, Turquoise, Purple), and grouping by it produces a breakdown that
 * looks plausible and means nothing.
 */
const EBAY_FEEDBACK = `
SELECT count(*) FILTER (WHERE type = 'Positive')::int AS positive,
       count(*) FILTER (WHERE type = 'Neutral')::int  AS neutral,
       count(*) FILTER (WHERE type = 'Negative')::int AS negative
FROM customer_service.ebay_orders_customer_feedbacks
WHERE role = 'Seller'
  AND date >= $1::date
  AND date < ($2::date + 1)`;

export const EBAY_FEEDBACK_SQL = EBAY_FEEDBACK;

/**
 * Half-open on the upper bound.
 *
 * `date` is a timestamp, so `BETWEEN $1 AND $2` would silently exclude
 * everything after midnight on the closing day — a whole day's feedback missing
 * from every period that ends today. `< to + 1` includes it.
 */
export async function ebayFeedbackCounts(
  source: Queryable,
  range: { readonly from: string; readonly to: string },
): Promise<{ positive: number; neutral: number; negative: number }> {
  const { rows } = await source.query({
    text: EBAY_FEEDBACK,
    values: [range.from, range.to],
  });
  const row = rows[0] as { positive: number; neutral: number; negative: number } | undefined;
  return {
    positive: Number(row?.positive ?? 0),
    neutral: Number(row?.neutral ?? 0),
    negative: Number(row?.negative ?? 0),
  };
}

export type AgentOption = {
  readonly sourceUserId: number;
  readonly displayName: string;
  readonly active: boolean;
};

/**
 * The agents the filter may offer: those with recorded activity, named.
 *
 * Deliberately not the whole 234-row directory. A filter listing 224 people who
 * have never appeared in this data invites the reader to conclude they did
 * nothing, when the truth is that nothing about them was ever recorded here.
 *
 * Shared and unknown ids are excluded from the OPTIONS but never from the
 * RESULTS — see `toRow`. They cannot be selected by name because they have none.
 */
const AGENT_OPTIONS = `
SELECT DISTINCT d.source_user_id::bigint AS source_user_id,
       d.display_name                    AS display_name,
       d.active                          AS active
FROM cst_app.agent_activity a
JOIN cst_app.agent_directory d
  ON d.source_user_id = a.source_user_id
 AND d.source_system = 'order_management'
WHERE a.action = ANY($1::text[])
  AND NOT (d.source_user_id = ANY($2::bigint[]))
ORDER BY display_name`;

export const AGENT_OPTIONS_SQL = AGENT_OPTIONS;

export async function agentOptions(app: Queryable): Promise<readonly AgentOption[]> {
  const { rows } = await app.query({
    text: AGENT_OPTIONS,
    values: [[...MESSAGES_HANDLED_ACTIONS], [...SHARED_ACCOUNT_SOURCE_USER_IDS]],
  });
  return (rows as Array<{ source_user_id: string | number; display_name: string; active: boolean }>).map(
    (r) => ({
      sourceUserId: Number(r.source_user_id),
      displayName: r.display_name,
      active: r.active,
    }),
  );
}
