import "server-only";

import { attachmentsFrom } from "@/lib/domain/attachment";
import type {
  ConversationDetail,
  ConversationMessageView,
  InboxItem,
  NoRuleConversationItem,
} from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";
import { classifyCaseType } from "@/lib/knowledge/case-type";

/**
 * Read-only conversation repository over cst_app.
 *
 * SELECT only — this module issues no write of any kind. It reads application
 * state that the ingestion layer already persisted; it never reaches a live
 * marketplace source.
 *
 * Every query is parameterised. The client is injected so the module is testable
 * without a database; API routes pass `getAppPool()`.
 */

export type Queryable = {
  query: (config: { text: string; values?: unknown[] }) => Promise<{ rows: unknown[] }>;
};

export const MAX_INBOX_LIMIT = 200;
export const DEFAULT_INBOX_LIMIT = 100;

/**
 * Inbox projection.
 *
 * EVERY conversation is returned, whatever its inbox placement.
 *
 * This used to filter to `inbox_visibility = 'reply_inbox'`, which hid 3,046
 * conversations: 2,073 Shopify ones classified as non-customer contact, plus
 * 973 outbound-only groups across Shopify, Amazon and eBay. The intent was a
 * clean work queue, and the cost was that a message could be in the database,
 * correctly stored, and impossible for anyone to find — which is how a German
 * order notification for a real SKU became invisible.
 *
 * The placement is still computed, still stored, and still returned on every
 * item as `inboxPlacement`, so the interface can label or group by it. What it
 * no longer does is decide what exists.
 *
 * Ordered newest-first: the most recent activity belongs at the top.
 */
/**
 * Direction of the thread's most recent message, by the same (source_ts,
 * source_pk) ordering `GET_MESSAGES` below uses — a correlated subquery
 * rather than a stored column, so it can never drift from the messages it
 * describes. Null only for a conversation with no messages landed yet.
 */
const LAST_DIRECTION = `(
  SELECT cm.direction
  FROM cst_app.conversation_messages cm
  WHERE cm.conversation_id = c.id
  ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
  LIMIT 1
)`;

const LIST_CONVERSATIONS = `
SELECT c.id::text                  AS id,
       c.marketplace,
       c.sub_source_id,
       c.counterparty_ref,
       c.listing_item_ref,
       c.workflow_state,
       c.needs_context,
       c.inbox_visibility,
       c.first_source_ts::text     AS first_source_ts,
       c.last_source_ts::text      AS last_source_ts,
       c.message_count,
       c.inbound_count,
       ${LAST_DIRECTION}           AS last_direction
FROM cst_app.conversations c
WHERE c.marketplace = $1
  AND ($2::text IS NULL OR c.inbox_visibility = $2::text)
ORDER BY c.last_source_ts DESC, c.id DESC
LIMIT $3`;

/**
 * The No Rule list, source 1 of 2: conversations refused before generation
 * ever ran, because the marketplace's whole approved corpus was empty.
 *
 * Writing the finding is entirely `lib/sync/rule-analysis-writer.ts`'s
 * business, unchanged by this query — `recordNoApplicableRule` (a refused
 * Generate) and `clearRuleAnalysis` (a grounded draft landing) are the only
 * two places a row here is created or removed. This only reads what is
 * already there, joined to the conversation it describes.
 *
 * Newest finding first: a conversation flagged five minutes ago is more
 * likely to need attention than one flagged three weeks ago.
 */
const LIST_NO_RULE_CONVERSATIONS = `
SELECT c.id::text                  AS id,
       c.marketplace,
       c.sub_source_id,
       c.counterparty_ref,
       c.listing_item_ref,
       c.workflow_state,
       c.needs_context,
       c.inbox_visibility,
       c.first_source_ts::text     AS first_source_ts,
       c.last_source_ts::text      AS last_source_ts,
       c.message_count,
       c.inbound_count,
       ${LAST_DIRECTION}           AS last_direction,
       ra.case_type,
       ra.analysed_at::text        AS analysed_at,
       'no_corpus'::text           AS reason
FROM cst_app.conversation_rule_analysis ra
JOIN cst_app.conversations c ON c.id = ra.conversation_id
WHERE c.marketplace = $1
  AND ra.outcome = 'no_applicable_rule'
ORDER BY ra.analysed_at DESC, c.id DESC
LIMIT $2`;

/**
 * The No Rule list, source 2 of 2: conversations where generation DID run —
 * the marketplace had a corpus — but this conversation's newest generated
 * reply cited none of it.
 *
 * Nothing here decides applicability or re-runs any check the generator
 * already made. `latest_generated` picks each conversation's newest revision
 * with `origin = 'generated'` (an edit carries no citations of its own and is
 * not this question); the outer query reads whether ANY row for that exact
 * revision names a `cst_document` source — precisely the citation list
 * `DraftPanel` already reads to decide whether to show the same flag.
 *
 * Excludes a conversation already covered by the no_corpus source above: a
 * grounded-or-not generation only happens once a corpus exists, and saving
 * any generated revision clears that finding in the same transaction (see
 * `lib/sync/draft-writer.ts` / the draft route), so the two are not expected
 * to overlap — this is defence in depth against showing one conversation
 * twice, not a case this schema can actually produce today.
 */
const LIST_UNGROUNDED_DRAFT_CONVERSATIONS = `
WITH latest_generated AS (
  SELECT DISTINCT ON (dr.conversation_id)
         dr.conversation_id,
         r.id         AS revision_id,
         r.created_at AS created_at
  FROM cst_app.draft_replies dr
  JOIN cst_app.draft_revisions r ON r.draft_reply_id = dr.id
  WHERE r.origin = 'generated'
  ORDER BY dr.conversation_id, r.revision DESC
)
SELECT c.id::text                  AS id,
       c.marketplace,
       c.sub_source_id,
       c.counterparty_ref,
       c.listing_item_ref,
       c.workflow_state,
       c.needs_context,
       c.inbox_visibility,
       c.first_source_ts::text     AS first_source_ts,
       c.last_source_ts::text      AS last_source_ts,
       c.message_count,
       c.inbound_count,
       ${LAST_DIRECTION}           AS last_direction,
       lg.created_at::text         AS analysed_at,
       'no_citation'::text         AS reason
FROM latest_generated lg
JOIN cst_app.conversations c ON c.id = lg.conversation_id
WHERE c.marketplace = $1
  AND NOT EXISTS (
    SELECT 1 FROM cst_app.draft_revision_sources s
    WHERE s.draft_revision_id = lg.revision_id AND s.source_kind = 'cst_document'
  )
  AND NOT EXISTS (
    SELECT 1 FROM cst_app.conversation_rule_analysis ra WHERE ra.conversation_id = c.id
  )
ORDER BY lg.created_at DESC, c.id DESC
LIMIT $2`;

const GET_CONVERSATION = `
SELECT c.id::text                  AS id,
       c.marketplace,
       c.sub_source_id,
       c.counterparty_ref,
       c.listing_item_ref,
       c.workflow_state,
       c.needs_context,
       c.inbox_visibility,
       c.first_source_ts::text     AS first_source_ts,
       c.last_source_ts::text      AS last_source_ts,
       c.message_count,
       c.inbound_count,
       ${LAST_DIRECTION}           AS last_direction
FROM cst_app.conversations c
WHERE c.id = $1::bigint`;

/**
 * Thread messages.
 *
 * `source_ts::text` keeps the stored naive timestamp exactly as recorded — the
 * driver would otherwise build a Date through the process timezone, and the
 * authoritative source zone is still unconfirmed.
 *
 * Ordered oldest-first with the source PK as a stable tiebreaker, matching the
 * shared ordering intent.
 */
const GET_MESSAGES = `
SELECT id::text            AS id,
       direction,
       source_ts::text     AS source_ts,
       body_text,
       body_decode_status,
       attachments
FROM cst_app.conversation_messages
WHERE conversation_id = $1::bigint
ORDER BY source_ts ASC, source_pk::bigint ASC`;

type ConversationRow = {
  id: string;
  marketplace: string;
  sub_source_id: number | null;
  counterparty_ref: string;
  listing_item_ref: string | null;
  workflow_state: string;
  needs_context: boolean;
  inbox_visibility: string;
  first_source_ts: string;
  last_source_ts: string;
  message_count: number;
  inbound_count: number;
  last_direction: string | null;
};

type NoRuleConversationRow = ConversationRow & {
  case_type: string | null;
  analysed_at: string;
  reason: string;
};

/** The `no_citation` query's row: same shape, minus the case type it doesn't have yet. */
type UngroundedDraftRow = ConversationRow & {
  analysed_at: string;
  reason: string;
};

type MessageRow = {
  id: string;
  direction: string;
  source_ts: string;
  body_text: string | null;
  body_decode_status: string;
  attachments: unknown;
};

function toInboxItem(row: ConversationRow): InboxItem {
  return {
    id: row.id,
    marketplace: row.marketplace as InboxItem["marketplace"],
    // The column is NOT NULL, but a row read through an older projection would
    // arrive undefined, and `undefined` in a JSON response is a dropped field
    // rather than a stated absence.
    subSourceId: row.sub_source_id ?? null,
    counterpartyRef: row.counterparty_ref,
    listingItemRef: row.listing_item_ref,
    workflowState: row.workflow_state as InboxItem["workflowState"],
    needsContext: row.needs_context,
    inboxPlacement: row.inbox_visibility as InboxItem["inboxPlacement"],
    firstSourceTimestamp: row.first_source_ts,
    lastSourceTimestamp: row.last_source_ts,
    messageCount: Number(row.message_count),
    inboundCount: Number(row.inbound_count),
    lastDirection: row.last_direction as InboxItem["lastDirection"],
  };
}

function toNoRuleItem(row: NoRuleConversationRow): NoRuleConversationItem {
  return {
    ...toInboxItem(row),
    caseType: row.case_type,
    analysedAt: row.analysed_at,
    reason: row.reason as NoRuleConversationItem["reason"],
  };
}

function toMessageView(row: MessageRow): ConversationMessageView {
  return {
    id: row.id,
    direction: row.direction as ConversationMessageView["direction"],
    sourceTimestamp: row.source_ts,
    bodyText: row.body_text,
    bodyDecodeStatus: row.body_decode_status as ConversationMessageView["bodyDecodeStatus"],
    // Filtered here rather than in the view: what is safe to render is a
    // domain decision, and the browser should never receive a URL the
    // application would not itself be willing to load.
    attachments: attachmentsFrom(row.attachments),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_INBOX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_INBOX_LIMIT;
  return Math.min(limit, MAX_INBOX_LIMIT);
}

/**
 * Lists one marketplace's customer-reply inbox, newest activity first.
 *
 * The marketplace is required, not optional: a mixed default inbox would put
 * conversations from different sources — with different direction guarantees —
 * side by side, which is exactly what the tabbed workspace exists to prevent.
 * Callers pass a value already validated against the capability allowlist.
 */
export async function listConversations(
  client: Queryable,
  options: {
    readonly marketplace: Marketplace;
    readonly limit?: number;
    /**
     * Narrow to one placement. Omit to list everything, which is the default:
     * hiding a stored conversation from every view is how one becomes
     * impossible to find.
     */
    readonly placement?: InboxItem["inboxPlacement"] | null;
  },
): Promise<InboxItem[]> {
  const { rows } = await client.query({
    text: LIST_CONVERSATIONS,
    values: [options.marketplace, options.placement ?? null, clampLimit(options.limit)],
  });
  return (rows as ConversationRow[]).map(toInboxItem);
}

/**
 * Lists one marketplace's No Rule conversations, most recently flagged first.
 *
 * The marketplace is required for the same reason it is on `listConversations`:
 * a mixed list would put findings from different sources side by side, which
 * is exactly what the tabbed workspace exists to prevent.
 *
 * TWO SOURCES, MERGED. `no_corpus` (the marketplace had nothing to generate
 * from) and `no_citation` (generation ran but this conversation's newest
 * reply cited nothing) are read separately — see the two queries above — and
 * combined here into one newest-first list, because both leave a reviewer
 * with the same next action.
 *
 * `no_citation` rows do not carry a stored case type, so it is produced the
 * same way `NoRuleFlag` produces it for an open conversation: read that
 * conversation's messages and call the SAME classifier. This is the one place
 * that costs an extra query per row, and it is bounded by `limit` rather than
 * by how large the marketplace is.
 */
export async function listNoRuleConversations(
  client: Queryable,
  options: {
    readonly marketplace: Marketplace;
    readonly limit?: number;
  },
): Promise<NoRuleConversationItem[]> {
  const limit = clampLimit(options.limit);

  const [corpusResult, citationResult] = await Promise.all([
    client.query({ text: LIST_NO_RULE_CONVERSATIONS, values: [options.marketplace, limit] }),
    client.query({
      text: LIST_UNGROUNDED_DRAFT_CONVERSATIONS,
      values: [options.marketplace, limit],
    }),
  ]);

  const corpusItems = (corpusResult.rows as NoRuleConversationRow[]).map(toNoRuleItem);

  const citationRows = citationResult.rows as UngroundedDraftRow[];
  const citationItems = await Promise.all(
    citationRows.map(async (row): Promise<NoRuleConversationItem> => {
      const { rows: messageRows } = await client.query({
        text: GET_MESSAGES,
        values: [row.id],
      });
      const caseType = classifyCaseType((messageRows as MessageRow[]).map(toMessageView)).label;
      return {
        ...toInboxItem(row),
        caseType,
        analysedAt: row.analysed_at,
        reason: row.reason as NoRuleConversationItem["reason"],
      };
    }),
  );

  return [...corpusItems, ...citationItems]
    .sort((a, b) => (a.analysedAt < b.analysedAt ? 1 : a.analysedAt > b.analysedAt ? -1 : 0))
    .slice(0, limit);
}

/** A conversation id as it arrives from a URL, before it is trusted. */
export function parseConversationId(raw: string): string | null {
  return /^[1-9][0-9]{0,18}$/.test(raw) ? raw : null;
}

/**
 * Loads one conversation with its ordered messages.
 *
 * Returns null when the id does not exist, so callers can answer 404 cleanly.
 * When `expectedMarketplace` is supplied and the stored conversation belongs to
 * a different one, this also returns null rather than the row: a stale or
 * hand-edited URL must not be able to surface another marketplace's thread
 * inside the wrong tab.
 */
export async function getConversation(
  client: Queryable,
  conversationId: string,
  options: { readonly expectedMarketplace?: Marketplace } = {},
): Promise<ConversationDetail | null> {
  const conversationResult = await client.query({
    text: GET_CONVERSATION,
    values: [conversationId],
  });
  const row = (conversationResult.rows as ConversationRow[])[0];
  if (row === undefined) return null;
  if (
    options.expectedMarketplace !== undefined &&
    row.marketplace !== options.expectedMarketplace
  ) {
    return null;
  }

  const messageResult = await client.query({
    text: GET_MESSAGES,
    values: [conversationId],
  });

  return {
    conversation: toInboxItem(row),
    messages: (messageResult.rows as MessageRow[]).map(toMessageView),
  };
}
