/**
 * The common search: one box, four kinds of thing CST actually has to hand.
 *
 * ------------------------------------------------------------------------
 * ONE FIELD, NOT FOUR
 * ------------------------------------------------------------------------
 * An agent reading a customer's email has a name, an order number, a handle or
 * a message id in front of them — and no reason to know which of four boxes
 * this application would have wanted it in. So there is one box, every path is
 * tried, and each result SAYS which one matched. The label matters: "matched an
 * order number" and "matched a customer name" are different degrees of
 * certainty, and an interface that presented them identically would be
 * inviting the agent to trust the weaker one as much as the stronger.
 *
 * ------------------------------------------------------------------------
 * IT FINDS CONVERSATIONS. IT DOES NOTHING TO THEM.
 * ------------------------------------------------------------------------
 * Every path is a read. Nothing here opens, drafts, replies, completes or
 * sends; the result is a conversation id the existing selection path then
 * opens, exactly as a notification row does.
 *
 * PURE. No database, no clock, no network.
 */

/** Which path matched, most specific first. The order IS the ranking. */
export const SEARCH_MATCH_KINDS = [
  "conversation_id",
  "message_id",
  "order_number",
  "handle",
  "customer_name",
] as const;
export type SearchMatchKind = (typeof SEARCH_MATCH_KINDS)[number];

/**
 * What each match means, in the agent's terms.
 *
 * `customer_name` says "verified order record" because that is exactly where it
 * comes from — the source's own `customers.customer_info`, never a name parsed
 * out of message text, which would be a guess wearing a person's name.
 */
export const SEARCH_MATCH_LABEL: Readonly<Record<SearchMatchKind, string>> = {
  conversation_id: "Conversation ID",
  message_id: "Message ID",
  order_number: "Order number",
  handle: "Marketplace handle",
  customer_name: "Customer name (order record)",
};

export type ConversationSearchResult = {
  readonly conversationId: string;
  readonly marketplace: string;
  readonly counterpartyRef: string;
  readonly matchKind: SearchMatchKind;
  /** What actually matched — the order number, the handle, the name. */
  readonly matchedOn: string;
  readonly lastSourceTimestamp: string | null;
  readonly messageCount: number;
};

export type ConversationSearchFeed = {
  readonly query: string;
  readonly results: ConversationSearchResult[];
  /** True when the cap was reached, so a short list is not read as "all of it". */
  readonly capped: boolean;
  /**
   * Whether the name path ran. False when the source pool was unavailable —
   * which must be SAID, because "no results" and "we could not look" are
   * different answers and only one of them means the customer is not there.
   */
  readonly nameSearchAvailable: boolean;
};

/**
 * Shortest query worth running.
 *
 * TWO CHARACTERS. One letter matches most of the table and would return a page
 * of noise that takes longer to read than typing the second letter.
 */
export const MIN_SEARCH_LENGTH = 2;

/** How many results come back. Enough to find the right one, few enough to scan. */
export const SEARCH_RESULT_LIMIT = 20;

/**
 * Normalises what was typed.
 *
 * Trimmed, and inner whitespace collapsed so "Liz  Wharton" and "Liz Wharton"
 * are the same search. Nothing else is stripped: an order number's punctuation
 * is part of it.
 */
export function normalizeSearchQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Whether this is worth sending to the server at all. */
export function isSearchable(raw: string): boolean {
  return normalizeSearchQuery(raw).length >= MIN_SEARCH_LENGTH;
}

/**
 * Whether the query could be a bare database id.
 *
 * Used to decide whether the id paths are worth running, not to reject
 * anything: an all-digit query is still tried as an order number and a handle,
 * because plenty of both are all digits.
 */
export function looksLikeId(query: string): boolean {
  return /^\d+$/.test(query);
}

/**
 * Keeps the strongest match per conversation.
 *
 * A search for an order number can hit the same conversation twice — once on
 * the verified snapshot and once on the thread key — and showing it twice would
 * make one result look like two customers. The most specific kind wins, by the
 * order in `SEARCH_MATCH_KINDS`.
 */
export function dedupeByStrongestMatch(
  results: readonly ConversationSearchResult[],
): ConversationSearchResult[] {
  const rank = new Map(SEARCH_MATCH_KINDS.map((kind, index) => [kind, index]));
  const best = new Map<string, ConversationSearchResult>();
  for (const result of results) {
    const held = best.get(result.conversationId);
    if (
      held === undefined ||
      (rank.get(result.matchKind) ?? 99) < (rank.get(held.matchKind) ?? 99)
    ) {
      best.set(result.conversationId, result);
    }
  }
  return [...best.values()].sort(
    (a, b) =>
      (rank.get(a.matchKind) ?? 99) - (rank.get(b.matchKind) ?? 99) ||
      (b.lastSourceTimestamp ?? "").localeCompare(a.lastSourceTimestamp ?? ""),
  );
}
