import "server-only";

import { attachmentsFrom } from "@/lib/domain/attachment";
import type {
  AwaitingResponseConversationItem,
  ConversationDetail,
  ConversationMessageView,
  InboxItem,
  NoRuleConversationItem,
} from "@/lib/domain/inbox";
import { previewOf } from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";
import { classifyCaseType } from "@/lib/knowledge/case-type";
import { type LoadedRules, loadRulesForConversation } from "@/lib/knowledge/cst-rules-files";
import {
  type MessageCategory,
  UNREADABLE_CONTENT_CATEGORY,
  classifyConversationCategory,
  classifyMessageCategoryWithFallback,
} from "@/lib/knowledge/message-category";
import {
  type MessagePriority,
  classifyConversationPriority,
} from "@/lib/knowledge/message-priority";
import { resolveEvidence } from "@/lib/knowledge/rule-evidence";

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

/**
 * Every inbound message's text, concatenated, for `classifyMessageCategory`.
 *
 * Same correlated-subquery shape as `LAST_DIRECTION` above, bounded by the
 * same page size — not a per-row round trip, one query. Read once here rather
 * than fetching each conversation's full message list back into the
 * application just to rebuild the same string `customerText()` already knows
 * how to assemble.
 */
const INBOUND_TEXT = `(
  SELECT string_agg(cm.body_text, ' ')
  FROM cst_app.conversation_messages cm
  WHERE cm.conversation_id = c.id AND cm.direction = 'inbound'
)`;

/**
 * The same messages, kept SEPARATE and IN ORDER, for `classifyConversationCategory`.
 *
 * WHY BOTH. `INBOUND_TEXT` above concatenates, and concatenation loses two
 * things the classifier wants. It merges signals that were never in the same
 * message — a missing part in the first and a damaged box in the third read as
 * one sentence containing both — and `string_agg` has no ordering, so there was
 * no way to tell which problem the customer arrived with. Reading the messages
 * separately and in order is what lets a closing "found it, all sorted" leave
 * the original category alone.
 *
 * `body_text IS NOT NULL` because an attachment-only message contributes an
 * empty element the classifier would only have to filter out again.
 */
const INBOUND_TEXTS = `(
  SELECT array_agg(cm.body_text ORDER BY cm.source_ts, cm.source_pk::bigint)
  FROM cst_app.conversation_messages cm
  WHERE cm.conversation_id = c.id AND cm.direction = 'inbound' AND cm.body_text IS NOT NULL
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
       ${LAST_DIRECTION}           AS last_direction,
       ${INBOUND_TEXT}             AS inbound_text,
       ${INBOUND_TEXTS}            AS inbound_texts
FROM cst_app.conversations c
WHERE c.marketplace = $1
  AND ($2::text IS NULL OR c.inbox_visibility = $2::text)
ORDER BY c.last_source_ts DESC, c.id DESC
LIMIT $3
OFFSET $4`;

/**
 * Conversations nobody has answered yet, before the category is read.
 *
 * THE SAME PROJECTION `LIST_CONVERSATIONS` USES, plus the newest customer
 * message, plus two exclusions. It is a separate statement rather than a
 * parameter on the existing one on purpose: the inbox's contract is "every
 * stored conversation, whatever its placement", and adding a predicate that
 * could ever narrow it is exactly how 3,046 conversations became unreachable
 * once before. Nothing here touches that query, its callers or its shape.
 *
 * THE INNER LATERAL IS THE "A CUSTOMER MESSAGE EXISTS" CONDITION. It resolves
 * the newest inbound message by the same (source_ts, source_pk) ordering every
 * other view orders by, and being an inner join it drops any conversation with
 * no inbound message at all — the 981 outbound-only threads — without a second
 * predicate that could disagree with `inbound_count`.
 *
 * ONE NOT EXISTS CLAUSE IS THE WHOLE FILTER, and it is an absence:
 *
 *   No reply after the customer's newest message. Row-value comparison against
 *   that same (source_ts, source_pk) pair, so a reply sent in the same second as
 *   the customer's message is ordered by the source PK rather than being counted
 *   twice or missed. An OLDER reply does not exclude the conversation: the
 *   customer has written since, and that is unanswered.
 *
 * A DRAFT NO LONGER EXCLUDES ANYTHING, and removing that predicate is the point
 * of this query's second revision. It used to carry a `NOT EXISTS` on
 * `cst_app.draft_replies`, which read the existence of a draft as an answer —
 * so generating one made the customer disappear from the notification feed
 * while they were still waiting. THIS SYSTEM CANNOT SEND: `reviewed` is the
 * terminal workflow state and there is no transport, so a draft is by
 * construction work in progress and never evidence that anybody replied. The
 * only thing that can retire a notification is an actual outbound message,
 * which is what the surviving clause tests.
 *
 * `has_draft` IS STILL READ, AS A LABEL. It moved from the WHERE clause to the
 * projection: the drawer distinguishes "waiting, nothing written" from
 * "waiting, draft ready" without either of them leaving the list. Reading it in
 * the outer query keeps it off the rows the window discards.
 *
 * `workflow_state` REMAINS A PROXY AND IS STILL NOT THE TEST. A saved human
 * edit appends a revision and advances no state, so a conversation carrying an
 * edited draft still reads `received`. It is projected for display and nothing
 * here filters on it.
 *
 * ACROSS MARKETPLACES, by an explicit list. `= ANY($1::text[])` rather than
 * `= $1`, so one statement serves the global notification feed and a
 * single-marketplace read alike. The array is always built from a fixed
 * allowlist of literals in `marketplace-capabilities.ts` — nothing a caller
 * supplies reaches it — and it is never omitted, so this cannot degrade into an
 * unbounded scan of whatever marketplace strings happen to be stored.
 *
 * THE BOUND IS PER MARKETPLACE, AND THAT IS THE WHOLE REASON FOR THE CTE.
 * Measured on live data, the unanswered conversations are wildly uneven:
 * Shopify 3,342, eBay 309, Amazon 44. A single global `LIMIT 100` over the
 * newest is therefore ~90% Shopify, and the one Amazon conversation waiting for
 * an order-change reply fell outside it entirely — the global feed returned
 * nothing for Amazon while the old per-marketplace feed returned it. A
 * notification that disappears because a busier marketplace is noisier is worse
 * than no notification.
 *
 * So `row_number() OVER (PARTITION BY c.marketplace ...)` gives every
 * marketplace its own window of the same size, and the outer query attaches the
 * expensive per-row reads — the three correlated subqueries — only to the rows
 * that survive it. Ranking in the CTE and projecting outside it is what keeps
 * the text aggregation off the thousands of rows that will be discarded.
 *
 * `inbox_visibility <> 'filtered'` EXCLUDES WHAT THE INGESTION LAYER ALREADY
 * DECIDED IS NOT REPLY WORK — a bounce, a courier notice, another channel's
 * notification, unsolicited mail — each with its reason recorded beside it.
 * 4,452 of Shopify's 7,794 unanswered conversations are these, so without the
 * predicate more than half of every window is spent on mail nobody is waiting
 * on a reply to. This is NOT the `reply_inbox`-only filter the inbox query
 * removed on purpose: that one decided what EXISTS, and hid conversations from
 * every view in the application. This decides what NOTIFIES. Every one of these
 * conversations is still listed, still labelled and still openable in the inbox;
 * what it no longer does is claim a customer is waiting for an answer.
 *
 * Newest customer message first, ACROSS the marketplaces asked for — the
 * ordering a triage list is read in. A notification about the oldest unanswered
 * eBay message is not more urgent than a newer Amazon one, so the OUTPUT is not
 * grouped by marketplace even though the bound is.
 */
const LIST_AWAITING_RESPONSE = `
WITH unanswered AS (
  SELECT c.id,
         latest.source_ts                AS latest_ts,
         latest.body_text                AS latest_body,
         latest.body_decode_status       AS latest_decode_status,
         row_number() OVER (
           PARTITION BY c.marketplace
           ORDER BY latest.source_ts DESC, c.id DESC
         )                               AS rank_in_marketplace
  FROM cst_app.conversations c
  JOIN LATERAL (
    SELECT cm.source_ts,
           cm.source_pk::bigint AS source_pk,
           cm.body_text,
           cm.body_decode_status
    FROM cst_app.conversation_messages cm
    WHERE cm.conversation_id = c.id
      AND cm.direction = 'inbound'
    ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
    LIMIT 1
  ) latest ON TRUE
  WHERE c.marketplace = ANY($1::text[])
    AND c.inbox_visibility <> 'filtered'
    AND NOT EXISTS (
      SELECT 1
      FROM cst_app.conversation_messages o
      WHERE o.conversation_id = c.id
        AND o.direction = 'outbound'
        AND (o.source_ts, o.source_pk::bigint) > (latest.source_ts, latest.source_pk)
    )
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
       ${INBOUND_TEXT}             AS inbound_text,
       ${INBOUND_TEXTS}            AS inbound_texts,
       u.latest_ts::text           AS latest_inbound_ts,
       u.latest_body               AS latest_inbound_body,
       u.latest_decode_status      AS latest_inbound_decode_status,
       -- PROJECTED, NOT FILTERED. See the header: a draft is work in progress,
       -- not an answer, so it decides how the row is LABELLED and never whether
       -- it appears. Evaluated in the outer query so it costs only the rows that
       -- survived the window, like the three correlated reads above it.
       EXISTS (
         SELECT 1
         FROM cst_app.draft_replies d
         WHERE d.conversation_id = c.id
       )                           AS has_draft,
       u.rank_in_marketplace
FROM unanswered u
JOIN cst_app.conversations c ON c.id = u.id
WHERE u.rank_in_marketplace <= $2
ORDER BY u.latest_ts DESC, c.id DESC`;

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
       lg.revision_id::text        AS revision_id,
       lg.created_at::text         AS analysed_at,
       'no_citation'::text         AS reason
FROM latest_generated lg
JOIN cst_app.conversations c ON c.id = lg.conversation_id
WHERE c.marketplace = $1
  AND NOT EXISTS (
    SELECT 1 FROM cst_app.conversation_rule_analysis ra WHERE ra.conversation_id = c.id
  )
ORDER BY lg.created_at DESC, c.id DESC`;

/**
 * Every `cst_document` ref stored against a batch of draft revisions, keyed
 * by revision so the caller can resolve each candidate independently.
 *
 * A stored ref row is not itself proof of grounding — see `resolveEvidence`
 * and its caller below. This query only fetches what was cited; whether it
 * still resolves against the current corpus is decided in application code,
 * the same place `/draft/evidence` decides it, so the two can never
 * disagree about the same conversation.
 */
const LIST_CITED_REFS = `
SELECT draft_revision_id::text AS revision_id,
       source_ref
FROM cst_app.draft_revision_sources
WHERE source_kind = 'cst_document'
  AND draft_revision_id = ANY($1::bigint[])`;

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
  /** Absent (not merely null) wherever a query does not select it — `LIST_CONVERSATIONS` is the only one that does. */
  inbound_text?: string | null;
  inbound_texts?: (string | null)[] | null;
};

type NoRuleConversationRow = ConversationRow & {
  case_type: string | null;
  analysed_at: string;
  reason: string;
};

/**
 * An awaiting-response row: every inbox field plus the newest customer message.
 * The body arrives here so the preview is built once, server-side, from the
 * same `previewOf` the domain already exposes.
 */
type AwaitingResponseRow = ConversationRow & {
  latest_inbound_ts: string;
  latest_inbound_body: string | null;
  latest_inbound_decode_status: string;
  /**
   * Whether a draft has been written for this conversation.
   *
   * A LABEL, NEVER A FILTER. It says what state the work is in, not whether the
   * customer has been answered — only an outbound message says that. See
   * `LIST_AWAITING_RESPONSE`.
   */
  has_draft: boolean;
  /** Position within its OWN marketplace's window. See `LIST_AWAITING_RESPONSE`. */
  rank_in_marketplace: number | string;
};

/** The `no_citation` query's row: same shape, minus the case type it doesn't have yet. */
type UngroundedDraftRow = ConversationRow & {
  revision_id: string;
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

/**
 * Marketplaces whose stored `body_text` is known to carry unfiltered
 * non-customer content (raw email transport headers, corporate boilerplate)
 * with no structural filter yet in place to remove it — see the Phase 1
 * ingestion-quality investigation. Category output for these would be noise
 * dressed up as a finding, so it is suppressed rather than shown wrong.
 */
const CATEGORY_SUPPRESSED_MARKETPLACES = new Set(["bandq", "temu"]);

/**
 * The category shown beside a conversation.
 *
 * FOUR OUTCOMES, and the order matters:
 *
 *   1. A SUPPRESSED MARKETPLACE gets nothing. Their stored text is known to
 *      carry non-customer content, and any fallback would turn that noise into
 *      findings.
 *   2. READABLE CUSTOMER TEXT is classified, and whatever that returns stands —
 *      INCLUDING null. The classifier returns null on purpose for a thread that
 *      is only the customer saying it is sorted, and overriding that here would
 *      undo the conversation-history work that put it there.
 *   3. NO READABLE TEXT BUT THE CUSTOMER DID WRITE — every inbound body arrived
 *      empty, which is what the interface shows as "Message content
 *      unavailable". The conversation is real and needs handling, so it gets
 *      `UNREADABLE_CONTENT_CATEGORY` rather than a blank. 97 conversations,
 *      87 of them in the reply inbox.
 *   4. NO INBOUND MESSAGE AT ALL stays blank. These are the 981 threads the
 *      ingestion layer already marks `outbound_only`: nobody wrote to us, so
 *      there is no customer request to categorise and inventing one would be a
 *      claim about a message that does not exist.
 *
 * Steps 3 and 4 are told apart by `inbound_count`, which is trustworthy —
 * it matches the actual inbound row count on 9,696 of 9,700 conversations.
 */
function categoryFor(row: ConversationRow): MessageCategory | null {
  if (CATEGORY_SUPPRESSED_MARKETPLACES.has(row.marketplace)) return null;

  // The per-message array is preferred where the projection supplies it,
  // because reading the thread in order is what keeps a closing "found it, all
  // sorted" from costing the conversation the category its opening message
  // earned. The concatenated column remains the fallback for any caller or
  // older projection that does not select the array.
  const readable =
    row.inbound_texts != null
      ? row.inbound_texts.filter((text) => (text ?? "").trim() !== "")
      : (row.inbound_text ?? "").trim() === ""
        ? []
        : [row.inbound_text!];

  if (readable.length > 0) {
    return row.inbound_texts != null
      ? classifyConversationCategory(readable)
      : classifyMessageCategoryWithFallback(readable[0]!);
  }

  return Number(row.inbound_count) > 0 ? UNREADABLE_CONTENT_CATEGORY : null;
}

/**
 * How urgently the conversation needs handling.
 *
 * A SECOND, INDEPENDENT READING OF THE SAME COLUMN. It is deliberately not part
 * of `categoryFor` above and shares no code with it: the two answer different
 * questions ("what is this about" and "how soon"), they disagree on purpose,
 * and folding them together would make one unable to change without the other.
 * Nothing here reads or alters the category.
 *
 * NO NEW QUERY, NO NEW COLUMN. `INBOUND_TEXTS` is already selected for the
 * category, so this costs one more pass over text the row is already carrying.
 *
 * THE PER-MESSAGE ARRAY OR NOTHING. `classifyConversationPriority` reads each
 * customer message on its own — that is what stops two unrelated sentences in
 * two unrelated messages forming a phrase neither contains, and it is what lets
 * a closing "all sorted" drop a thread's urgency. The concatenated
 * `inbound_text` column cannot supply that, so a projection that selects only
 * that one yields null rather than a reading taken from glued-together text.
 * `GET_CONVERSATION` selects neither, so a single-conversation read is
 * unranked; the inbox list is where priority is shown.
 *
 * SUPPRESSED THE SAME WAY THE CATEGORY IS, and for the same measured reason.
 * B&Q's and Temu's stored `body_text` is known to carry raw email transport
 * headers and corporate boilerplate with no structural filter in front of it —
 * see `CATEGORY_SUPPRESSED_MARKETPLACES`. Ranking that would not produce a
 * blank, it would produce confident HIGHs off supplier marketing that happens
 * to say "urgent". The constant is read here, never modified.
 *
 * WHAT IS LEFT BLANK, AND ONLY WHAT. Past those two gates the engine now ranks
 * every conversation carrying readable customer text — an ordinary enquiry the
 * specific rules cannot place falls back to MEDIUM rather than to null, so a
 * genuine reply-inbox row always wears a ribbon. Three cases still come back
 * null, and each is an absence rather than a judgement:
 *
 *   1. A SUPPRESSED MARKETPLACE, above.
 *   2. NO PER-MESSAGE ARRAY. `GET_CONVERSATION` selects neither text column, and
 *      a conversation with no inbound row at all aggregates to SQL NULL. Neither
 *      is a conversation this function was given anything to read.
 *   3. AN ARRAY WITH NO READABLE TEXT IN IT — every inbound body stored empty,
 *      the 97 threads `categoryFor` step 3 describes. The engine's own
 *      readability test declines these, and that suppression is deliberate: an
 *      urgency invented for a message nobody can read is a claim about text that
 *      is not there. They keep `UNREADABLE_CONTENT_CATEGORY` and no ribbon.
 */
function priorityFor(row: ConversationRow): MessagePriority | null {
  if (CATEGORY_SUPPRESSED_MARKETPLACES.has(row.marketplace)) return null;
  const messages = row.inbound_texts;
  if (messages === null || messages === undefined) return null;
  return classifyConversationPriority(messages);
}

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
    // The strict phrase table first, then the intent fallback behind it, so a
    // conversation the table cannot name still reaches the inbox with a tag
    // rather than as a blank. Suppressed marketplaces short-circuit before
    // either: their stored text is known to carry non-customer content, and a
    // fallback that never returns null would turn that noise into findings.
    //
    // The per-message array is preferred where the projection supplies it,
    // because reading the thread in order is what keeps a closing "found it,
    // all sorted" from costing the conversation the category its opening
    // message earned. The concatenated column remains the fallback for any
    // caller or older projection that does not select the array.
    category: categoryFor(row),
    // Alongside the category, not derived from it. See `priorityFor`.
    priority: priorityFor(row),
  };
}

/**
 * Adds the newest customer message to an inbox item.
 *
 * `toInboxItem` is called, never reimplemented, so the category and the
 * priority on a notification row are the SAME readings the inbox shows for the
 * same conversation — there is one classifier call site and this is not a
 * second one.
 */
function toAwaitingResponseItem(row: AwaitingResponseRow): AwaitingResponseConversationItem {
  return {
    ...toInboxItem(row),
    latestCustomerMessageAt: row.latest_inbound_ts,
    // Truncated here rather than in the browser: the row displays a preview, so
    // a preview is what crosses the boundary. An undecodable body renders as
    // the shared "content unavailable" copy, exactly as the thread view does.
    latestCustomerMessagePreview: previewOf({
      bodyText: row.latest_inbound_body,
      bodyDecodeStatus:
        row.latest_inbound_decode_status as ConversationMessageView["bodyDecodeStatus"],
    }),
    // Coerced rather than trusted: a driver that hands back "t"/"f" or 1/0
    // would otherwise make every row read as drafted.
    hasDraft: row.has_draft === true,
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

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

export type ConversationPage = {
  readonly items: InboxItem[];
  /**
   * Whether a conversation older than the last one in `items` still exists
   * for this marketplace. Read from a one-extra-row overfetch rather than a
   * separate COUNT query — cheap, and it cannot drift from what was actually
   * returned the way a count taken before or after could.
   */
  readonly hasMore: boolean;
};

/**
 * Lists one marketplace's customer-reply inbox, newest activity first, one
 * page at a time.
 *
 * The marketplace is required, not optional: a mixed default inbox would put
 * conversations from different sources — with different direction guarantees —
 * side by side, which is exactly what the tabbed workspace exists to prevent.
 * Callers pass a value already validated against the capability allowlist.
 *
 * PAGED, NOT WINDOWED BY DATE. A high-volume marketplace can put hundreds of
 * conversations inside even a short date range, so "the last 30 days" is not
 * a fixed row count and cannot be a single fixed-size request. `offset` lets
 * a caller keep asking for the next page until `hasMore` is false, however
 * far back that turns out to be, rather than guessing a limit large enough
 * up front.
 */
export async function listConversations(
  client: Queryable,
  options: {
    readonly marketplace: Marketplace;
    readonly limit?: number;
    /** How many conversations to skip, for the second and later pages. */
    readonly offset?: number;
    /**
     * Narrow to one placement. Omit to list everything, which is the default:
     * hiding a stored conversation from every view is how one becomes
     * impossible to find.
     */
    readonly placement?: InboxItem["inboxPlacement"] | null;
  },
): Promise<ConversationPage> {
  const limit = clampLimit(options.limit);
  const { rows } = await client.query({
    text: LIST_CONVERSATIONS,
    values: [
      options.marketplace,
      options.placement ?? null,
      // One extra row, never returned, purely to learn whether the next
      // page would be non-empty.
      limit + 1,
      clampOffset(options.offset),
    ],
  });
  const hasMore = rows.length > limit;
  const items = (rows as ConversationRow[]).slice(0, limit).map(toInboxItem);
  return { items, hasMore };
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
 * reply has no citation that actually resolves) are read separately — see
 * the queries above — and combined here into one newest-first list, because
 * both leave a reviewer with the same next action.
 *
 * A STORED `cst_document` ROW IS NOT PROOF OF GROUNDING. It used to be: a
 * conversation was excluded from `no_citation` as soon as any such row
 * existed for its latest generated revision, whatever the ref inside it
 * said. That let a draft through with citations that were malformed, or
 * that named a rule the current documents no longer contain — exactly as
 * ungrounded as no citation at all, but invisible to this list. Every
 * candidate's refs are now resolved against the SAME corpus and the SAME
 * `resolveEvidence` function the `/draft/evidence` sidebar uses, so the two
 * can never disagree about the same conversation: a ref that fails to
 * resolve there fails to resolve here, and the conversation belongs in No
 * Rule either way.
 *
 * `no_citation` rows do not carry a stored case type, so it is produced the
 * same way `NoRuleFlag` produces it for an open conversation: read that
 * conversation's messages and call the SAME classifier. This is the one place
 * that costs an extra query per row, and it runs only for rows that survive
 * the citation check, not for every generated draft in the marketplace.
 */
export async function listNoRuleConversations(
  client: Queryable,
  options: {
    readonly marketplace: Marketplace;
    readonly limit?: number;
    /**
     * Loads the CST rule corpus for one marketplace. Defaults to the real
     * file-backed corpus (`loadRulesForConversation`); tests inject a fake
     * one so this stays a query test, not a filesystem test.
     */
    readonly loadRules?: (marketplace: string) => LoadedRules;
  },
): Promise<NoRuleConversationItem[]> {
  const limit = clampLimit(options.limit);

  const [corpusResult, citationResult] = await Promise.all([
    client.query({ text: LIST_NO_RULE_CONVERSATIONS, values: [options.marketplace, limit] }),
    client.query({ text: LIST_UNGROUNDED_DRAFT_CONVERSATIONS, values: [options.marketplace] }),
  ]);

  const corpusItems = (corpusResult.rows as NoRuleConversationRow[]).map(toNoRuleItem);

  const candidateRows = citationResult.rows as UngroundedDraftRow[];
  const ungroundedRows = await filterToUnresolvedCitations(
    client,
    candidateRows,
    options.marketplace,
    options.loadRules ?? loadRulesForConversation,
  );

  const citationItems = await Promise.all(
    ungroundedRows.map(async (row): Promise<NoRuleConversationItem> => {
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

/**
 * Narrows candidates (every marketplace conversation whose newest generated
 * draft stored at least one `cst_document` row, or none at all) down to the
 * ones where nothing actually resolves.
 *
 * Skips the corpus load entirely when there are no candidates — the common
 * case for a quiet marketplace — since loading fourteen workbooks is not
 * free even cached, and a check with nothing to check is not worth it.
 */
async function filterToUnresolvedCitations(
  client: Queryable,
  candidates: readonly UngroundedDraftRow[],
  marketplace: string,
  loadRules: (marketplace: string) => LoadedRules,
): Promise<UngroundedDraftRow[]> {
  if (candidates.length === 0) return [];

  const { knowledge } = loadRules(marketplace);
  const rules = knowledge.state === "available" ? knowledge.rules : [];

  const { rows: refRows } = await client.query({
    text: LIST_CITED_REFS,
    values: [candidates.map((row) => row.revision_id)],
  });

  const refsByRevision = new Map<string, string[]>();
  for (const { revision_id, source_ref } of refRows as {
    revision_id: string;
    source_ref: string;
  }[]) {
    const existing = refsByRevision.get(revision_id);
    if (existing) existing.push(source_ref);
    else refsByRevision.set(revision_id, [source_ref]);
  }

  return candidates.filter((row) => {
    const refs = refsByRevision.get(row.revision_id) ?? [];
    return resolveEvidence(rules, refs).cited.length === 0;
  });
}

/**
 * One page of awaiting-response conversations, and what it took to find them.
 *
 * `scanned` and `hasMore` describe the CANDIDATE set, not `items`. The category
 * is not a stored column and cannot be a SQL predicate (see
 * `listAwaitingResponseByCategory`), so the database bounds the unanswered
 * conversations and the classifier narrows them afterwards — which means a page
 * can legitimately return two items out of a hundred candidates. Both numbers
 * are returned so an interface can say that plainly instead of presenting a
 * short list as a complete one.
 */
export type AwaitingResponsePage = {
  readonly items: AwaitingResponseConversationItem[];
  /** How many unanswered conversations were read and classified. */
  readonly scanned: number;
  /** Whether an unanswered conversation older than the last one scanned exists. */
  readonly hasMore: boolean;
  /**
   * The marketplaces actually queried, after the suppressed ones were dropped.
   *
   * Returned rather than assumed, because it is NOT the list the caller passed:
   * a marketplace whose category is suppressed can never match and is not
   * scanned. An interface saying "checked every marketplace" would otherwise be
   * saying something untrue.
   */
  readonly marketplaces: readonly Marketplace[];
};

/**
 * Conversations in one case area that nobody has answered yet.
 *
 * THREE CONDITIONS, AND TWO OF THEM ARE IN SQL:
 *
 *   a customer message exists      the inner LATERAL in `LIST_AWAITING_RESPONSE`
 *   no reply after that message    NOT EXISTS, row-value compared
 *   the category matches           HERE, in application code
 *
 * THERE IS DELIBERATELY NO DRAFT CONDITION. A draft is not a reply and this
 * system cannot send one, so a conversation stays here until an outbound
 * message actually lands. Whether a draft exists travels on the row as
 * `hasDraft`, for the interface to label with — see `LIST_AWAITING_RESPONSE`.
 *
 * THE CATEGORY CANNOT BE A PREDICATE, and this is the design constraint the
 * whole function is shaped around. There is no category column: it is read on
 * every request by `classifyConversationCategory` from the customer's own text
 * — see the header of `lib/knowledge/message-category.ts` for why nothing is
 * stored, and `categoryFor` above for the four outcomes. So the filter below
 * compares against the value `toInboxItem` already produced, and no second
 * detector, no keyword match and no stored copy exists anywhere in this path.
 *
 * ACROSS MARKETPLACES, AND NOT SCOPED TO A SELECTED TAB. The caller passes the
 * marketplaces to read; the notification feed passes every conversation-backed
 * one. Each item already carries its own `marketplace`, so a global list needs
 * no second query and no merge step.
 *
 * A SUPPRESSED MARKETPLACE IS DROPPED BEFORE THE QUERY, NOT AFTER. B&Q and Temu
 * classify to null by construction (`CATEGORY_SUPPRESSED_MARKETPLACES`), so no
 * row of theirs can equal a requested category — scanning them would spend the
 * classifier on candidates that cannot match and, worse, would consume the row
 * bound that marketplaces which CAN match are competing for. The rule is
 * inherited rather than decided here: this reads the same constant
 * `categoryFor` reads, and the filter below is a consequence of it, not a
 * second opinion about it.
 *
 * BOUNDED, AND IT SAYS SO. Classification is pure but not free — four witnesses
 * over every customer message in the candidate set — so the SQL bound applies to
 * the unanswered conversations, not to the matches, and the caller is told how
 * many were scanned and which marketplaces were actually read. A silent cap here
 * would read as "there are none".
 */
export async function listAwaitingResponseByCategory(
  client: Queryable,
  options: {
    /**
     * Which marketplaces to read. A list rather than one value, because the
     * notification feed is global: it is deliberately independent of whichever
     * marketplace tab happens to be on screen.
     */
    readonly marketplaces: readonly Marketplace[];
    /**
     * The case area to watch. A `MessageCategory`, so a value outside the
     * classifier's own vocabulary is a compile error rather than a list that is
     * always empty.
     */
    readonly category: MessageCategory;
    /** How many unanswered conversations to read and classify. Bounded as everywhere else. */
    readonly limit?: number;
  },
): Promise<AwaitingResponsePage> {
  const marketplaces = options.marketplaces.filter(
    (marketplace) => !CATEGORY_SUPPRESSED_MARKETPLACES.has(marketplace),
  );
  // Nothing classifiable was asked for. Answer without a round trip rather than
  // issuing a query whose result cannot contain a match.
  if (marketplaces.length === 0) {
    return { items: [], scanned: 0, hasMore: false, marketplaces };
  }

  const limit = clampLimit(options.limit);
  const { rows } = await client.query({
    text: LIST_AWAITING_RESPONSE,
    // One extra row PER MARKETPLACE, never returned and never classified,
    // purely to learn whether that marketplace has an older unanswered
    // conversation past its own window.
    values: [[...marketplaces], limit + 1],
  });

  /**
   * The overfetched row of each marketplace is dropped here rather than in SQL.
   *
   * `hasMore` means "at least one marketplace was truncated", which is the only
   * honest summary a single flag can carry when each has its own window: the
   * drawer uses it to say it did not reach the end, and saying so when ANY
   * marketplace was cut is the reading that cannot understate the gap.
   */
  const withinWindow = (rows as AwaitingResponseRow[]).filter(
    (row) => Number(row.rank_in_marketplace) <= limit,
  );
  const hasMore = withinWindow.length < rows.length;

  const items = withinWindow
    .map(toAwaitingResponseItem)
    .filter((item) => item.category === options.category);

  return { items, scanned: withinWindow.length, hasMore, marketplaces };
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
