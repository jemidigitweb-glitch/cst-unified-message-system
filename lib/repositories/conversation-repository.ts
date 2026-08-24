import "server-only";

import { attachmentsFrom } from "@/lib/domain/attachment";
import type {
  ConversationDetail,
  ConversationMessageView,
  InboxItem,
} from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";

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
const LIST_CONVERSATIONS = `
SELECT id::text                    AS id,
       marketplace,
       sub_source_id,
       counterparty_ref,
       listing_item_ref,
       workflow_state,
       needs_context,
       inbox_visibility,
       first_source_ts::text       AS first_source_ts,
       last_source_ts::text        AS last_source_ts,
       message_count,
       inbound_count
FROM cst_app.conversations
WHERE marketplace = $1
  AND ($2::text IS NULL OR inbox_visibility = $2::text)
ORDER BY last_source_ts DESC, id DESC
LIMIT $3`;

const GET_CONVERSATION = `
SELECT id::text                    AS id,
       marketplace,
       sub_source_id,
       counterparty_ref,
       listing_item_ref,
       workflow_state,
       needs_context,
       inbox_visibility,
       first_source_ts::text       AS first_source_ts,
       last_source_ts::text        AS last_source_ts,
       message_count,
       inbound_count
FROM cst_app.conversations
WHERE id = $1::bigint`;

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
