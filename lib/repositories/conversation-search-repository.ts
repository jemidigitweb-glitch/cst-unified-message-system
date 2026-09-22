import "server-only";

import {
  type ConversationSearchResult,
  SEARCH_RESULT_LIMIT,
  type SearchMatchKind,
  dedupeByStrongestMatch,
  looksLikeId,
} from "@/lib/domain/conversation-search";

/**
 * Finding a conversation from whatever the agent has in front of them.
 *
 * ------------------------------------------------------------------------
 * TWO DATABASES, AND THE SPLIT IS THE POINT
 * ------------------------------------------------------------------------
 * Ids, order numbers and marketplace handles all live in `cst_app`, so those
 * are one query against the application database.
 *
 * CUSTOMER NAMES DO NOT LIVE HERE AT ALL. `cst_app` deliberately stores no
 * customer identity — `counterparty_ref` is an opaque handle or an order
 * reference and nothing else. A name therefore has to be resolved in the
 * SOURCE, read-only, exactly as `customer-note-repository.ts` already does:
 * name -> order numbers and eBay buyer ids -> back to conversations. It is a
 * second round trip and it is optional; without the source pool the other
 * three paths still work and the caller is told the name path did not run.
 *
 * EVERY STATEMENT IS A SELECT. Nothing here writes to either database, and the
 * source pool pins `default_transaction_read_only=on` besides.
 *
 * Every value is parameterised. The `%` wrapping for a prefix/contains match is
 * applied to the BOUND VALUE, never by building the pattern into the SQL.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

/** Postgres `undefined_table` — the schema is not there. */
const UNDEFINED_TABLE = "42P01";

export function isSearchStoreMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === UNDEFINED_TABLE
  );
}

/**
 * The three paths that live in the application database, as one statement.
 *
 * A UNION rather than three round trips, and each arm carries its own
 * `match_kind` so the interface can say WHY a row is in the list. The id arm is
 * gated on `$2` — a non-numeric query must not be cast to bigint, which would
 * error rather than simply not match.
 */
const SEARCH_APP = `
WITH hits AS (
  -- Exact conversation id. Only attempted when the query is all digits.
  SELECT c.id, 'conversation_id'::text AS match_kind, c.id::text AS matched_on
    FROM cst_app.conversations c
   WHERE $2::boolean AND c.id = $3::bigint

  UNION ALL
  -- A marketplace message id, either the external one or the source row's key.
  SELECT m.conversation_id, 'message_id', $1
    FROM cst_app.conversation_messages m
   WHERE m.external_message_id = $1 OR m.source_pk = $1

  UNION ALL
  -- A verified order, from the resolver's own snapshot.
  SELECT s.conversation_id, 'order_number', s.order_number
    FROM cst_app.context_snapshots s
   WHERE s.resolution = 'single_order' AND s.order_number ILIKE $1

  UNION ALL
  /*
   * The thread's own key. On Shopify, Amazon, B&Q and Temu this IS the order
   * number, which is why an exact match here is reported as an order number and
   * a partial one as a handle: the same column carries both facts depending on
   * the marketplace, and saying "handle" for an exact order number would be
   * wrong on four marketplaces out of five.
   */
  SELECT c.id,
         CASE WHEN lower(c.counterparty_ref) = lower($1) AND c.marketplace <> 'ebay'
              THEN 'order_number' ELSE 'handle' END,
         c.counterparty_ref
    FROM cst_app.conversations c
   WHERE c.counterparty_ref ILIKE $4
     AND c.counterparty_ref NOT LIKE 'unresolved:%'
)
SELECT h.match_kind,
       h.matched_on,
       c.id::text                AS conversation_id,
       c.marketplace,
       c.counterparty_ref,
       c.last_source_ts::text    AS last_source_ts,
       c.message_count
  FROM hits h
  JOIN cst_app.conversations c ON c.id = h.id
 ORDER BY c.last_source_ts DESC
 LIMIT $5`;

/**
 * Name -> the order references that name owns, in the SOURCE.
 *
 * `first_name || ' ' || last_name` so "Liz Wharton" matches across the two
 * columns rather than only within one of them. Bounded hard: a common surname
 * has a lot of orders, and this is a lookup key for the next query rather than
 * a list anybody reads.
 *
 * ORDERED BY ORDER DATE, NEWEST FIRST, AND THAT IS NOT COSMETIC. It was
 * `ORDER BY o.order_id DESC` first, which sorts order references as TEXT — so
 * `LSFR…` and `LED…` filled the whole cap and eBay's numeric references were
 * cut off the bottom. A live search for "Wharton" returned zero conversations
 * while the matching eBay order sat just past row 50. Recency is also the right
 * answer on its own terms: somebody searching a name usually wants the order
 * they are currently dealing with.
 */
const SEARCH_SOURCE_NAMES = `
SELECT DISTINCT o.order_id,
       ci.ebay_buyer_id,
       o.order_date,
       btrim(coalesce(ci.first_name, '') || ' ' || coalesce(ci.last_name, '')) AS full_name
  FROM customers.customer_info ci
  JOIN order_management.orders o ON o.id = ci.order_id
 WHERE coalesce(ci.first_name, '') || ' ' || coalesce(ci.last_name, '') ILIKE $1
 ORDER BY o.order_date DESC
 LIMIT $2`;

/** Those references, mapped back to conversations in the application database. */
const CONVERSATIONS_FOR_REFS = `
SELECT c.id::text             AS conversation_id,
       c.marketplace,
       c.counterparty_ref,
       c.last_source_ts::text AS last_source_ts,
       c.message_count
  FROM cst_app.conversations c
 WHERE c.counterparty_ref = ANY($1::text[])
    OR EXISTS (
      SELECT 1 FROM cst_app.context_snapshots s
       WHERE s.conversation_id = c.id
         AND s.resolution = 'single_order'
         AND s.order_number = ANY($1::text[])
    )
 ORDER BY c.last_source_ts DESC
 LIMIT $2`;

type HitRow = {
  match_kind: string;
  matched_on: string | null;
  conversation_id: string;
  marketplace: string;
  counterparty_ref: string;
  last_source_ts: string | null;
  message_count: number | string;
};

function toResult(row: HitRow, kind?: SearchMatchKind, matchedOn?: string): ConversationSearchResult {
  return {
    conversationId: row.conversation_id,
    marketplace: row.marketplace,
    counterpartyRef: row.counterparty_ref,
    matchKind: kind ?? (row.match_kind as SearchMatchKind),
    matchedOn: matchedOn ?? row.matched_on ?? row.counterparty_ref,
    lastSourceTimestamp: row.last_source_ts,
    messageCount: Number(row.message_count),
  };
}

/** How many order references one name lookup may feed into the second query. */
const MAX_NAME_REFS = 50;

/**
 * Searches conversations by id, message id, order number, handle or customer
 * name.
 *
 * `source` is OPTIONAL and its absence is safe: the name path is skipped, the
 * other three still answer, and `nameSearchAvailable` reports which happened so
 * an empty list is never read as "that customer does not exist".
 *
 * A source failure is caught rather than thrown for the same reason — the
 * source is a shared production database this application only borrows, and it
 * being slow or unavailable must degrade the search rather than break it.
 */
export async function searchConversations(
  app: Queryable,
  options: { readonly query: string; readonly limit?: number },
  source?: Queryable | null,
): Promise<{ results: ConversationSearchResult[]; capped: boolean; nameSearchAvailable: boolean }> {
  const query = options.query;
  const limit = Math.min(options.limit ?? SEARCH_RESULT_LIMIT, SEARCH_RESULT_LIMIT);
  const numeric = looksLikeId(query);

  const { rows } = await app.query({
    text: SEARCH_APP,
    values: [
      query,
      numeric,
      // Never cast a non-numeric query to bigint; the gate above short-circuits
      // first, and this keeps the parameter type valid either way.
      numeric ? query : "0",
      `%${query}%`,
      limit + 1,
    ],
  });
  const collected = (rows as HitRow[]).map((row) => toResult(row));

  let nameSearchAvailable = false;
  if (source) {
    try {
      const { rows: named } = await source.query({
        text: SEARCH_SOURCE_NAMES,
        values: [`%${query}%`, MAX_NAME_REFS],
      });
      nameSearchAvailable = true;
      const refs = new Set<string>();
      const nameFor = new Map<string, string>();
      for (const row of named as {
        order_id: string | null;
        ebay_buyer_id: string | null;
        full_name: string;
      }[]) {
        for (const ref of [row.order_id, row.ebay_buyer_id]) {
          if (ref !== null && ref !== "") {
            refs.add(ref);
            nameFor.set(ref, row.full_name);
          }
        }
      }
      if (refs.size > 0) {
        const { rows: matched } = await app.query({
          text: CONVERSATIONS_FOR_REFS,
          values: [[...refs], limit + 1],
        });
        for (const row of matched as HitRow[]) {
          collected.push(
            toResult(row, "customer_name", nameFor.get(row.counterparty_ref) ?? query),
          );
        }
      }
    } catch {
      // Searching by name is the one path that leaves this application's own
      // database. It failing is not a reason to fail the search.
      nameSearchAvailable = false;
    }
  }

  const deduped = dedupeByStrongestMatch(collected);
  return {
    results: deduped.slice(0, limit),
    capped: deduped.length > limit,
    nameSearchAvailable,
  };
}
