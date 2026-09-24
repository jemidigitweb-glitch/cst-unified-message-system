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
  classifyMessageCategory,
  classifyMessageCategoryWithFallback,
  isPleasantryOnly,
} from "@/lib/knowledge/message-category";
import {
  type PriorityReading,
  explainConversationPriority,
  explainMessagePriority,
} from "@/lib/knowledge/message-priority";
/*
 * `BEFORE_SHIPMENT_MARKETPLACE` and `BEFORE_SHIPMENT_RECENCY_HOURS` were
 * imported here and are no longer: this file passed both to the urgent sweep as
 * query parameters, and neither predicate survives. The constants still exist —
 * the response SLA is measured against the window — they are simply not this
 * module's business any more.
 */
import {
  BEFORE_SHIPPING_CATEGORY,
  beforeShipmentEligibility,
  isBeforeShipmentUrgent,
} from "@/lib/domain/before-shipment-urgency";
import { staffClosedTheOrder } from "@/lib/knowledge/staff-resolution";
import {
  type OrderKey,
  type OrderShipmentState,
  type SourceQueryable,
  orderKeyOf,
  shipmentStateForOrders,
} from "@/lib/repositories/order-shipment-state-repository";
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
  -- The urgent conversations are lifted out of the ordinary stream entirely
  -- and served as a block on the first page. Excluding them here on EVERY
  -- page is what stops one appearing twice: once at the top and once again
  -- in its date position four pages later. See listConversations.
  AND NOT (c.id = ANY($5::bigint[]))
ORDER BY c.last_source_ts DESC, c.id DESC
LIMIT $3
OFFSET $4`;

/**
 * When the newest customer message became ours to answer, as a real INSTANT.
 *
 * `COALESCE(source_ts_utc, ingested_at)`, and both halves are deliberate:
 *
 *   source_ts_utc  the customer's own send moment, normalised to UTC by the
 *                  ingestion layer. The right answer, and preferred whenever it
 *                  is there. Measured against the live store it is currently
 *                  populated for 0 of 23,338 inbound messages — the column pair
 *                  exists and nothing fills it yet — so today it never wins.
 *   ingested_at    when the message landed here. NOT NULL, defaulted to now(),
 *                  populated for all 23,338.
 *
 * NEITHER IS `source_ts`. That column is naive and its zone is unconfirmed, and
 * the migrations README forbids casting it until the ingestion owner says so.
 * An hour of zone error means nothing to a two-day reply target and everything
 * to a minutes-based one, so a response clock must not start from it.
 *
 * THE HONEST CAVEAT, and it is a real one: for conversations backfilled by a
 * historical sync, `ingested_at` is when that sync ran rather than when the
 * customer wrote. Their elapsed time is measured from the import. For live
 * traffic — a sync running continuously — the two are close, and "when we could
 * first have seen it" is arguably the right start for a clock measuring OUR
 * response anyway. It is stated here rather than buried so nobody reads an old
 * conversation's timer as a fact about the customer.
 */
const LATEST_INBOUND_INSTANT = `(
  SELECT COALESCE(cm.source_ts_utc, cm.ingested_at)
  FROM cst_app.conversation_messages cm
  WHERE cm.conversation_id = c.id AND cm.direction = 'inbound'
  ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
  LIMIT 1
)`;

/**
 * The marketplace whose `counterparty_ref` is a PERSON, not an order.
 *
 * Every other marketplace keys its threads by the order number — Shopify
 * conversation 46268 is keyed `LED65289`, which is `orders.order_id` in the
 * source — so the thread's own reference is a usable order key there. eBay
 * keys by the buyer's username (`david_tuck_ward`), which is not an order
 * number and never resolves to one.
 *
 * A VALUE, not a string repeated in two SQL statements that could drift apart,
 * for the same reason as `BEFORE_SHIPMENT_MARKETPLACE`.
 */
const USERNAME_KEYED_MARKETPLACE = "ebay";

/**
 * What to look up as this conversation's order number.
 *
 * The verified snapshot order wherever one exists. The thread's own reference
 * as a fallback — EXCEPT on eBay, where that reference is a buyer username.
 *
 * TAKES ITS PLACEHOLDER rather than inlining the marketplace, because the two
 * statements that use it number their parameters differently and because
 * `awaiting-response.test.ts` rightly forbids a marketplace literal in this
 * SQL. The value bound is always `USERNAME_KEYED_MARKETPLACE` from this module;
 * nothing a caller supplies reaches it.
 */
function orderRefExpression(marketplaceParam: string): string {
  return `COALESCE(
         CASE WHEN cs.resolution = 'single_order' THEN cs.order_number END,
         CASE WHEN c.marketplace <> ${marketplaceParam}::text
              THEN c.counterparty_ref END
       )`;
}

/**
 * WHICH half of the COALESCE above actually answered.
 *
 * The same subquery, the same ordering, the same one row — so it can never
 * describe a different message than the instant it explains. It is a separate
 * projection rather than a second COALESCE arm because the two answer different
 * questions: one is WHEN, this is HOW WE KNOW.
 *
 * Today it returns `ingest` for every conversation, because `source_ts_utc` is
 * populated for 0 of 23,412 inbound messages. That is precisely why it is
 * carried: a fallback that is invisible is a fallback nobody can challenge, and
 * a 48-hour deadline measured from the import rather than from the customer is
 * a fact an agent disputing a breach is entitled to see. See `SlaStartSource`.
 */
const LATEST_INBOUND_INSTANT_SOURCE = `(
  SELECT CASE WHEN cm.source_ts_utc IS NOT NULL THEN 'customer_message' ELSE 'ingest' END
  FROM cst_app.conversation_messages cm
  WHERE cm.conversation_id = c.id AND cm.direction = 'inbound'
  ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
  LIMIT 1
)`;

/**
 * The customer's NEWEST message, and only that one.
 *
 * THE WHOLE POINT IS THAT IT IS ONE MESSAGE. Whether the customer is asking to
 * change or stop the order is a question about what they are asking NOW.
 * Reading the thread — which is what `INBOUND_TEXTS` supplies and what priority
 * is computed from — is how the previous version of this feature kept a
 * conversation urgent for months after a cancellation had been dealt with.
 * `LIMIT 1`, newest first, is that rule made structural.
 */
const LATEST_INBOUND_TEXT = `(
  SELECT cm.body_text
  FROM cst_app.conversation_messages cm
  WHERE cm.conversation_id = c.id AND cm.direction = 'inbound'
  ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
  LIMIT 1
)`;

/**
 * OUR most recent reply in the thread.
 *
 * Read so `staffClosedTheOrder` can ask whether CST already told this customer
 * the order was dispatched or cancelled. The NEWEST outbound only: an early
 * "we will dispatch today" does not close a thread that carried on for another
 * four messages, and the last thing we said is what the customer is responding
 * to.
 *
 * OUTBOUND, AND THAT IS THE POINT. This is the one text column the urgent rule
 * reads, and it is OUR writing rather than the customer's — see
 * `lib/knowledge/staff-resolution.ts` for why that distinction is what makes
 * reading it safe at all.
 */
const LATEST_OUTBOUND_TEXT = `(
  SELECT cm.body_text
  FROM cst_app.conversation_messages cm
  WHERE cm.conversation_id = c.id AND cm.direction = 'outbound'
  ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC
  LIMIT 1
)`;

/**
 * The before-shipment urgent sweep: one marketplace, ALL of it.
 *
 * ------------------------------------------------------------------------
 * WHY A SECOND QUERY EXISTS AT ALL
 * ------------------------------------------------------------------------
 * The page has already been chosen by the time anything is evaluated per row,
 * so an urgent conversation sitting four pages back could never reach the top
 * of page 1. This looks at the whole marketplace BEFORE the page is cut, which
 * is the difference between server-side ordering and a client-side filter over
 * whatever happened to be loaded.
 *
 * ------------------------------------------------------------------------
 * NOT ONE WORD OF THE MESSAGE IS READ
 * ------------------------------------------------------------------------
 * The previous version of this sweep matched cancellation vocabulary with `~*`
 * and then classified the candidates. It was wrong in the way the rule is now
 * written to prevent: a promotional email saying "cancel" could reach the top of
 * the inbox, and a cancellation asked for months ago kept its thread red long
 * after the parcel was delivered.
 *
 * What decides now is stored, verified STATE, and all of it is SQL:
 *
 *   condition 1  `inbox_visibility = 'reply_inbox'` and the newest message
 *                inbound — a customer reply thread nobody has answered.
 *   condition 2  an INNER JOIN to a `context_snapshots` row resolved to
 *                `single_order`, which is the resolution the rest of the system
 *                already treats as verified (`mayUseOrderFacts`).
 *   condition 3  not expressible here — dispatch state lives in the source —
 *                so it is applied to these candidates in `listConversations`.
 *
 * The join is what bounds this query. Measured against the live store there are
 * 224 `single_order` snapshots in total across every marketplace, so the
 * candidate set is small by construction rather than by a cap.
 *
 * CAPPED ANYWAY, AND THE CAP IS REPORTED. `urgentScanned`/`urgentScanCapped`
 * travel back with the page for the same reason `scanned`/`hasMore` do on the
 * notification feed: a silent cap reads as "we looked everywhere".
 */
const URGENT_CANDIDATES = `
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
       -- The verified snapshot order where one exists, and the thread's own
       -- reference otherwise -- see BeforeShipmentInput.orderNumber. Either way
       -- the SOURCE decides whether the order is real; this only says what to
       -- look up.
       --
       -- EXCEPT ON eBAY, WHERE counterparty_ref IS A BUYER USERNAME.
       -- The fallback is sound on Shopify, Amazon, B&Q and Temu because those
       -- threads are KEYED BY the order number. eBay threads are keyed by the
       -- buyer -- a username, not an order -- so looking one up as an order
       -- number cannot ever match. Measured 2026-09-23: 1,231 of 1,282 eBay
       -- reply-inbox conversations took this fallback and 1,202 of those were
       -- plainly non-numeric usernames. Every one was a guaranteed-miss round
       -- trip to the source that then reported no_matching_order as though the
       -- order had been checked and found absent.
       ${orderRefExpression("$4")}  AS order_number,
       ${LATEST_INBOUND_INSTANT}   AS sla_starts_at,
       ${LATEST_INBOUND_INSTANT_SOURCE} AS sla_starts_at_source,
       ${LATEST_OUTBOUND_TEXT}     AS latest_outbound_text,
       ${LATEST_INBOUND_TEXT}      AS latest_inbound_text,
       EXISTS (
         SELECT 1
         FROM cst_app.conversation_messages cm
         WHERE cm.conversation_id = c.id AND cm.direction = 'outbound'
       )                           AS ever_replied
FROM cst_app.conversations c
LEFT JOIN cst_app.context_snapshots cs ON cs.conversation_id = c.id
WHERE c.marketplace = $1
  AND ($2::text IS NULL OR c.inbox_visibility = $2::text)
  -- CONDITION 2 IS NO LONGER A FILTER HERE, and removing it is the fix for a
  -- conversation that could never be flagged.
  --
  -- It used to require SOMETHING to look up, which on eBay was satisfied by the
  -- buyer username above -- so the query admitted eBay rows for the wrong
  -- reason and beforeShipmentEligibility then rejected all of them. With the
  -- username fallback correctly removed, that predicate would instead EXCLUDE
  -- every eBay conversation without a single_order snapshot (1,231 of 1,282),
  -- which is the whole population this rule needs to see.
  --
  -- The order is still required -- by beforeShipmentEligibility, which is the
  -- only place conditions 2 and 3 are decided, and which now distinguishes "the
  -- order has gone" from "we cannot see the order yet". A row that fails there
  -- keeps everything it arrived with and rejoins the ordinary stream.
  --
  -- The window below, not this predicate, is what bounds the candidate set.
  --
  -- The ingestion layer's sentinel for a thread it could not key to anything.
  -- It is not an order number and must never be looked up as one.
  AND c.counterparty_ref NOT LIKE 'unresolved:%'
  -- Condition 1: a customer reply thread whose newest message is theirs...
  AND c.inbox_visibility = 'reply_inbox'
  AND ${LAST_DIRECTION} = 'inbound'
  -- THE AMAZON "NEVER REPLIED AT ALL" RESTRICTION IS GONE FROM HERE TOO.
  --
  -- It excluded any Amazon thread containing an outbound message, on the
  -- reasoning that a thread we answered is a conversation in progress rather
  -- than an untouched request. beforeShipmentEligibility no longer applies that
  -- test -- CST's rule is that a before-shipping case area stays urgent until
  -- the message on screen is answered, and a thread we replied in a week ago
  -- still has nobody answering the one the customer sent today.
  --
  -- LEAVING IT HERE WOULD BE THE WORST OF BOTH: the rule would admit those
  -- threads and this query would never hand them over, so the two would
  -- disagree silently and only on one marketplace. ever_replied is still
  -- SELECTed, because the acknowledgement test needs it.
  --
  -- Whether we already told them it went out or was stopped is decided in
  -- TypeScript, from the text selected above, because it has to be read through
  -- claimStatus: "your order has NOT been dispatched yet" is the commonest
  -- sentence in one of these threads and a SQL LIKE would read it backwards.
  -- THE RECENCY WINDOW IS NO LONGER A PREDICATE HERE.
  --
  -- It used to compare LATEST_INBOUND_INSTANT against now() minus 48 hours, so
  -- an unanswered before-shipping query stopped being a CANDIDATE two days after
  -- the customer wrote -- it could not be ranked because it was never
  -- transferred. CST's rule is that such a conversation stays urgent until
  -- somebody replies, so the window cannot bound the candidate set any more.
  --
  -- THE WINDOW STILL BINDS THE ORDER-STATE PATH, in beforeShipmentEligibility,
  -- which is the only place it was ever decided. A row that is too old for that
  -- path and is not a before-shipping case area falls out there exactly as it
  -- did before, and rejoins the ordinary stream in its date position.
  --
  -- WHAT BOUNDS THIS QUERY NOW is the LIMIT below, newest-first: the 500 most
  -- recent unanswered reply-inbox threads. urgentScanCapped reports reaching it
  -- rather than letting the list quietly under-report.
ORDER BY c.last_source_ts DESC, c.id DESC
LIMIT $3`;

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
 *
 * ------------------------------------------------------------------------
 * $3: THE RECENCY WINDOW, AND WHY IT IS A PARAMETER RATHER THAN A CONSTANT
 * ------------------------------------------------------------------------
 * NULL means "every age", which is what every case area except one wants: a
 * delivery complaint from last month is still unanswered and still a complaint.
 * The before-shipping feed passes `BEFORE_SHIPMENT_RECENCY_HOURS`, because there
 * the age is part of the definition of the case area rather than a nicety.
 *
 * IT IS APPLIED IN THE CTE, BEFORE `row_number()`, and that placement is the
 * whole value of doing it in SQL at all. The per-marketplace window is the scarce
 * resource here — Shopify alone has thousands of unanswered conversations — so
 * filtering after the ranking would spend the budget on rows that are then thrown
 * away, and the one live Amazon order-change query would again fall outside a
 * window full of stale Shopify threads. Filtering first means the window holds
 * candidates that can still match.
 *
 * `LATEST_INBOUND_INSTANT`, NOT `latest.source_ts`. The naive column is right for
 * ORDERING (it is what every other view sorts by, and a zone error does not
 * reorder a list) and wrong for MEASURING AN ELAPSED TIME against `now()`, which
 * is exactly the distinction the constant's own comment draws. The rule applies
 * the same window again in TypeScript from the same expression, so a row that
 * slipped through could not be flagged anyway — this only stops it being carried.
 *
 * ------------------------------------------------------------------------
 * THE FOUR EXTRA PROJECTIONS ARE THE BEFORE-SHIPMENT RULE'S INPUTS
 * ------------------------------------------------------------------------
 * `order_number`, `sla_starts_at`, `latest_outbound_text`, `latest_inbound_text`
 * and `ever_replied` — the same set `URGENT_CANDIDATES` selects, by the same
 * expressions, because the notification feed now answers the same question the
 * inbox's urgent flag does and must not answer it from a different projection.
 * They are read in the OUTER query, so they cost only the rows that survived the
 * window, exactly like `has_draft` above them.
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
    -- Recent enough to still be this case area's work. NULL disables it. See $3.
    AND (
      $3::int IS NULL
      OR ${LATEST_INBOUND_INSTANT} >= now() - make_interval(hours => $3::int)
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
       -- The before-shipment rule's inputs. Same expression as
       -- URGENT_CANDIDATES, evaluated only for rows that survived the window.
       --
       -- The 'unresolved:' sentinel is the ingestion layer's marker for a thread
       -- it could not key to anything. URGENT_CANDIDATES excludes it with a WHERE
       -- clause; this feed must not drop the conversation from the list, so it
       -- nulls the KEY instead -- the rule then reads no order, which is the
       -- truth, and no sentinel is ever sent to the source as an order number.
       CASE
         WHEN c.counterparty_ref LIKE 'unresolved:%'
           THEN CASE WHEN cs.resolution = 'single_order' THEN cs.order_number END
         ELSE ${orderRefExpression("$4")}
       END                         AS order_number,
       ${LATEST_INBOUND_INSTANT}   AS sla_starts_at,
       ${LATEST_INBOUND_INSTANT_SOURCE} AS sla_starts_at_source,
       ${LATEST_OUTBOUND_TEXT}     AS latest_outbound_text,
       ${LATEST_INBOUND_TEXT}      AS latest_inbound_text,
       EXISTS (
         SELECT 1
         FROM cst_app.conversation_messages cm
         WHERE cm.conversation_id = c.id AND cm.direction = 'outbound'
       )                           AS ever_replied,
       u.rank_in_marketplace
FROM unanswered u
JOIN cst_app.conversations c ON c.id = u.id
LEFT JOIN cst_app.context_snapshots cs ON cs.conversation_id = c.id
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
  /**
   * The verified order behind the conversation, selected only by
   * `URGENT_CANDIDATES`. Absent on every other projection, which is why the
   * urgent flag is false everywhere else rather than being recomputed from
   * whatever a narrower query happened to carry.
   */
  order_resolution?: string | null;
  order_sub_source_id?: number | null;
  order_number?: string | null;
  /** A real instant — see `LATEST_INBOUND_INSTANT`. */
  sla_starts_at?: string | Date | null;
  /** Which half of that COALESCE answered — see `LATEST_INBOUND_INSTANT_SOURCE`. */
  sla_starts_at_source?: string | null;
  /** OUR newest reply, for `staffClosedTheOrder`. See `LATEST_OUTBOUND_TEXT`. */
  latest_outbound_text?: string | null;
  /** The customer's newest message, for the order-change intent. One message. */
  latest_inbound_text?: string | null;
  /** Whether we have ever replied in this thread. Amazon's extra condition. */
  ever_replied?: boolean | null;
};

/**
 * Is the customer's CURRENT message asking to change or stop the order?
 *
 * BOTH READERS ARE THE EXISTING ONES, called on one message. There is no new
 * vocabulary here and no third classifier:
 *
 *   the category classifier's own `Order change, before shipping queries`,
 *   which is what the notification feed and the inbox filter already match on;
 *   or
 *
 *   `cancellation_requested` from the priority engine, which carries the
 *   cancellation and stop-dispatch wording — "cancel my order", "stop
 *   dispatch", "do not send", "stop shipment" — read through `claimStatus`, so
 *   a policy question and a denial do not count.
 *
 * EITHER, because they answer the question from different sides: the phrase
 * table places an address change or an amendment that carries no cancellation
 * wording at all, and the priority engine catches a blunt "stop dispatch" that
 * the phrase table may file elsewhere.
 *
 * ONE MESSAGE, NEVER THE THREAD — see `LATEST_INBOUND_TEXT`.
 */
function asksToChangeTheOrder(latestInboundText: string | null): boolean {
  const text = latestInboundText?.trim() ?? "";
  if (text === "") return false;
  if (classifyMessageCategory(text) === BEFORE_SHIPPING_CATEGORY) return true;
  return explainMessagePriority(text).reasons.includes("cancellation_requested");
}

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

/**
 * How the before-shipment gate treats a case area.
 *
 * `off` is every area but one: a delivery complaint is unanswered work whatever
 * the parcel has done since, and gating it on dispatch state would empty the feed
 * of precisely the cases that only exist after dispatch.
 *
 * `before_shipment` is the order-change area, where "before shipping" is a claim
 * about the ORDER and not just a heading. See `applyBeforeShipmentRule`.
 */
type AwaitingResponseGate = "off" | "before_shipment";

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
 * THE PER-MESSAGE ARRAY OR NOTHING. `explainConversationPriority` reads each
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
/**
 * WHY THIS RETURNS THE WHOLE READING, not just the level.
 *
 * It used to call `classifyConversationPriority`, which is a thin wrapper that
 * keeps `priority` and discards `reasons`. That threw away the answer to "why
 * is this red" one line before the browser, so a cancellation, a recall and a
 * chased-up complaint all arrived as the same ribbon. `explainConversationPriority`
 * is the function that wrapper already calls — reading its full result costs no
 * extra work, no extra query and no second classification, and it is what
 * `urgent` is derived from. See `InboxItem.priorityReasons`.
 */
const NOTHING_READ: PriorityReading = { priority: null, reasons: [], closesTheCase: false };

function priorityReadingFor(row: ConversationRow): PriorityReading {
  if (CATEGORY_SUPPRESSED_MARKETPLACES.has(row.marketplace)) return NOTHING_READ;
  const messages = row.inbound_texts;
  if (messages === null || messages === undefined) return NOTHING_READ;
  return explainConversationPriority(messages);
}

function toInboxItem(row: ConversationRow): InboxItem {
  const priorityReading = priorityReadingFor(row);
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
    // Alongside the category, not derived from it. See `priorityReadingFor`.
    priority: priorityReading.priority,
    // Copied rather than aliased: the reading is frozen-by-convention inside
    // the engine, and the view contract is a plain mutable array on the wire.
    priorityReasons: [...priorityReading.reasons],
    /*
     * URGENCY IS NOT DECIDED HERE, and it cannot be: it needs the dispatch
     * state of the matched order, which lives in the source and is read in one
     * batch per page rather than once per row. Every item therefore leaves this
     * function NOT urgent, and `listConversations` raises the flag on the
     * candidates that pass all of it — see `applyBeforeShipmentRule`.
     *
     * Defaulting to false here rather than to null is what keeps every other
     * projection honest: the No Rule list and the notification feed select no
     * order columns, so they report "not urgent" rather than an urgency
     * invented from whatever they happened to carry.
     */
    urgent: false,
    beforeShipmentOutcome: null,
    slaStartsAt: instantOf(row.sla_starts_at),
    /*
     * VALIDATED, NOT CAST. The column is `text` on the wire and only two values
     * are meaningful, so anything else becomes null — "we did not establish it"
     * — rather than a third string the panel would have to guess at. A
     * projection that does not select it lands here as undefined and gets the
     * same null.
     */
    slaStartsAtSource:
      row.sla_starts_at_source === "customer_message" || row.sla_starts_at_source === "ingest"
        ? row.sla_starts_at_source
        : null,
  };
}

/**
 * A timestamptz column as an ISO string, or null.
 *
 * node-postgres hands back a `Date` for `timestamptz` and a string for text, so
 * both are accepted and normalised to one wire format. An unparseable value
 * becomes null rather than an Invalid Date — a broken clock start must read as
 * "not established", never as 1970.
 */
function instantOf(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Adds the newest customer message to an inbox item.
 *
 * `toInboxItem` is called, never reimplemented, so the category and the
 * priority on a notification row are the SAME readings the inbox shows for the
 * same conversation — there is one classifier call site and this is not a
 * second one.
 *
 * `base` EXISTS SO THE RULE'S VERDICT CAN BE PASSED IN. The before-shipping feed
 * has already run `applyBeforeShipmentRule` over these rows — which needs an await
 * and a batched source read, neither of which belongs in a row mapper — and that
 * produces an item whose `urgent`, `beforeShipmentOutcome` and possibly `category`
 * differ from the bare projection. Accepting it here is what stops the verdict
 * being recomputed, or worse, silently overwritten by a second `toInboxItem` call.
 * Defaulted, so every other caller is unchanged.
 */
function toAwaitingResponseItem(
  row: AwaitingResponseRow,
  base: InboxItem = toInboxItem(row),
): AwaitingResponseConversationItem {
  return {
    ...base,
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
  /**
   * How many urgent (cancellation / stop-dispatch) conversations were lifted
   * to the top of the first page. Zero on every later page, because the block
   * is served once — see `listConversations`.
   */
  readonly urgentCount: number;
  /**
   * How many candidate rows the urgent sweep actually read, and whether it hit
   * its cap.
   *
   * REPORTED RATHER THAN HIDDEN, for the same reason `scanned`/`hasMore` are on
   * the notification feed: the sweep is bounded, so a short urgent block is not
   * by itself evidence that there are no more. An interface that cannot tell
   * "none found" from "stopped looking" will present one as the other.
   */
  readonly urgentScanned: number;
  readonly urgentScanCapped: boolean;
};

/**
 * How many candidate rows the urgent sweep will read before stopping.
 *
 * The join to `context_snapshots` already bounds this hard — 224 `single_order`
 * snapshots exist across every marketplace as measured against the live store —
 * and the recency window bounds it again. 500 is a backstop against a future in
 * which resolution coverage grows by orders of magnitude, not a working limit;
 * if it is ever reached, `urgentScanCapped` says so rather than the list
 * quietly under-reporting.
 */
const URGENT_SCAN_LIMIT = 500;

const MS_PER_HOUR = 3_600_000;

/**
 * Applies conditions 1 and 3 to the sweep's candidates, and raises the flag.
 *
 * THE SWEEP ANSWERED WHAT SQL COULD ANSWER — a reply thread, unanswered, recent,
 * with a verified single order behind it. Two things are left, and neither
 * belongs in that query:
 *
 *   THE CLOSING SIGNAL, because "your order has NOT been dispatched yet" has to
 *   be read through `claimStatus` rather than matched, or the commonest sentence
 *   in a before-shipment thread would close it.
 *
 *   THE DISPATCH STATE, because it lives in the source database. It is fetched
 *   in ONE batched read for every candidate rather than one query per row.
 *
 * AN ELIGIBLE CONVERSATION IS ALSO RE-TAGGED. Its category becomes
 * `BEFORE_SHIPPING_CATEGORY` — the classifier's own value for the case area, so
 * the inbox filter and the notification feed match it exactly as they already
 * do. `beforeShipmentOutcome` records that the rule assigned it, so nothing has
 * to guess later whether the phrase table or this rule named the case.
 *
 * A CANDIDATE THAT FAILS keeps everything it arrived with and rejoins the
 * ordinary stream in its date position, carrying the outcome that explains why.
 */
async function applyBeforeShipmentRule(
  source: SourceQueryable | null,
  rows: readonly ConversationRow[],
  now: Date,
): Promise<InboxItem[]> {
  const items = rows.map(toInboxItem);
  if (rows.length === 0) return items;

  /*
   * NO SOURCE, NO FLAG. Where the source pool is unavailable the dispatch state
   * is unknown, and an unknown dispatch state must not be read as "not
   * dispatched" — that is the one error that would promise a window which has
   * already closed. The inbox still loads; nothing is urgent.
   */
  const orderNumberOf = (row: ConversationRow): string | null => {
    const value = row.order_number;
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed === "" ? null : trimmed;
  };

  const keys: OrderKey[] = [];
  for (const row of rows) {
    const orderNumber = orderNumberOf(row);
    if (orderNumber !== null) keys.push({ orderNumber });
  }
  const shipmentState =
    source === null || keys.length === 0
      ? new Map<string, OrderShipmentState>()
      : await shipmentStateForOrders(source, keys);

  return items.map((item, index) => {
    const row = rows[index]!;
    const orderNumber = orderNumberOf(row);
    const shipment =
      orderNumber === null ? null : (shipmentState.get(orderKeyOf({ orderNumber })) ?? null);

    const startedAt = item.slaStartsAt === null ? null : new Date(item.slaStartsAt);
    /*
     * THE CASE AREA THE ROW ALREADY CARRIES, read once and passed to both
     * calls below. `toInboxItem` has already classified it through
     * `categoryFor`, so this is the same value the inbox prints beside the row
     * and the same one the category filter matches — not a second reading of
     * the text that could drift from the first.
     */
    const beforeShippingCategory = item.category === BEFORE_SHIPPING_CATEGORY;
    /*
     * BOTH HALVES, COMPOSED HERE. The wording test reads the NEWEST inbound
     * message only — never the thread — so an old "thanks" cannot close a live
     * request, and `ever_replied` is what makes it closure rather than an
     * opening pleasantry nobody has answered.
     */
    const customerAcknowledgedOnly =
      row.ever_replied === true && isPleasantryOnly(row.latest_inbound_text ?? null);
    const outcome = beforeShipmentEligibility({
      marketplace: item.marketplace,
      // Read from the row rather than assumed false. The sweep already applies
      // this on Amazon, so it is belt-and-braces there — and it is the real
      // answer for every other marketplace, where the rule does not use it.
      everReplied: row.ever_replied === true,
      lastDirection: item.lastDirection,
      inboxPlacement: item.inboxPlacement,
      platformNotice: isPlatformNotice(item),
      staffClosedTheOrder: staffClosedTheOrder(row.latest_outbound_text ?? null),
      orderChangeIntent: asksToChangeTheOrder(row.latest_inbound_text ?? null),
      beforeShippingCategory,
      customerAcknowledgedOnly,
      ageHours:
        startedAt === null ? null : (now.getTime() - startedAt.getTime()) / MS_PER_HOUR,
      orderNumber,
      shipment: shipment === null ? null : { dispatched: shipment.dispatched },
    });

    /*
     * ASK THE RULE, NEVER COMPARE THE STRING. This was `outcome === "eligible"`,
     * which silently ignored `order_state_unverified` — the rule computed the
     * new outcome, the row carried it, and the flag stayed off. Two places
     * deciding what "urgent" means is exactly how they disagree.
     */
    const urgent = isBeforeShipmentUrgent({
      marketplace: item.marketplace,
      everReplied: row.ever_replied === true,
      lastDirection: item.lastDirection,
      inboxPlacement: item.inboxPlacement,
      platformNotice: isPlatformNotice(item),
      staffClosedTheOrder: staffClosedTheOrder(row.latest_outbound_text ?? null),
      orderChangeIntent: asksToChangeTheOrder(row.latest_inbound_text ?? null),
      beforeShippingCategory,
      customerAcknowledgedOnly,
      ageHours:
        startedAt === null ? null : (now.getTime() - startedAt.getTime()) / MS_PER_HOUR,
      orderNumber,
      shipment: shipment === null ? null : { dispatched: shipment.dispatched },
    });
    /*
     * THE TAG IS A NARROWER QUESTION THAN THE FLAG. Urgency says the window is
     * open; the tag names the case area, so it needs the customer to actually
     * be asking to change or stop the order. A pre-sales question on an
     * unshipped order is urgent — they are waiting and we can still help — and
     * is NOT an order change, so it keeps the category the phrase table read.
     */
    const retag = urgent && asksToChangeTheOrder(row.latest_inbound_text ?? null);
    return {
      ...item,
      urgent,
      beforeShipmentOutcome: outcome,
      // Re-tagged only when the customer asked for a change. A conversation
      // this declines keeps whatever the phrase table read, untouched.
      category: retag ? BEFORE_SHIPPING_CATEGORY : item.category,
    };
  });
}

/**
 * A marketplace's own platform notice rather than a customer.
 *
 * The SAME test the inbox list already applies for display — eBay's policy and
 * order-update notices land in a single-message thread under the sentinel
 * counterparty "eBay", and there is no customer on the other end of one. Kept
 * here as well because a notice must not be able to reach the top of the queue
 * under a response countdown aimed at a person who does not exist.
 */
function isPlatformNotice(item: InboxItem): boolean {
  return item.marketplace === "ebay" && item.counterpartyRef === "eBay";
}

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
    /**
     * The read-only SOURCE pool, for condition 3.
     *
     * OPTIONAL, AND ITS ABSENCE IS SAFE. Without it the dispatch state cannot be
     * read, and an unknown dispatch state is never treated as "not dispatched" —
     * the inbox loads normally and nothing is urgent. That is the right failure
     * direction: a missed highlight, never a promise that a parcel can still be
     * stopped.
     */
    readonly source?: SourceQueryable | null;
    /** Injected so the recency window is testable without freezing time. */
    readonly now?: Date;
  },
): Promise<ConversationPage> {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);
  const now = options.now ?? new Date();

  /**
   * PHASE 1 — the before-shipment sweep, over the WHOLE marketplace.
   *
   * Runs on every page because its result decides what the ordinary stream must
   * exclude, and that exclusion has to be identical on every page or a
   * conversation would slip through the seam between two of them.
   */
  const urgentRows = await client.query({
    text: URGENT_CANDIDATES,
    values: [
      options.marketplace,
      options.placement ?? null,
      URGENT_SCAN_LIMIT,
      // $4: the marketplace whose counterparty_ref is a buyer username rather
      // than an order number, so the fallback is skipped there.
      USERNAME_KEYED_MARKETPLACE,
    ],
  });
  const urgentScanned = urgentRows.rows.length;
  const urgentScanCapped = urgentScanned >= URGENT_SCAN_LIMIT;

  /**
   * The SQL found candidates; this is where the rule is actually applied — the
   * closing signal read through `claimStatus`, and the dispatch state read from
   * the source in one batch. A candidate that fails any condition falls out and
   * rejoins the ordinary stream in its date position.
   */
  const urgentItems = (
    await applyBeforeShipmentRule(options.source ?? null, urgentRows.rows as ConversationRow[], now)
  ).filter((item) => item.urgent);

  /**
   * PHASE 2 — the ordinary stream, with the urgent block held out of it.
   *
   * Excluding by id keeps `offset` meaningful: the non-urgent list is one
   * continuous newest-first sequence that a caller pages through normally,
   * and the urgent block sits above it rather than inside it.
   */
  const urgentIds = urgentItems.map((item) => item.id);
  const { rows } = await client.query({
    text: LIST_CONVERSATIONS,
    values: [
      options.marketplace,
      options.placement ?? null,
      // One extra row, never returned, purely to learn whether the next
      // page would be non-empty.
      limit + 1,
      offset,
      urgentIds,
    ],
  });
  const hasMore = rows.length > limit;
  const pageItems = (rows as ConversationRow[]).slice(0, limit).map(toInboxItem);

  /**
   * The urgent block is served ONCE, on the first page.
   *
   * WHY NOT ON EVERY PAGE. Repeating it would make the same conversation appear
   * at the top of page 1, page 2 and page 3 — a reviewer scrolling for older
   * work would meet the same four red rows over and over, and the list would
   * stop being a sequence. Once, at the top, then the ordinary stream.
   *
   * WHY NOT INTERLEAVED BY DATE. That is what the old behaviour effectively
   * was, and it is the defect this feature exists to fix.
   */
  const isFirstPage = offset === 0;
  return {
    items: isFirstPage ? [...urgentItems, ...pageItems] : pageItems,
    hasMore,
    urgentCount: isFirstPage ? urgentItems.length : 0,
    urgentScanned,
    urgentScanCapped,
  };
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
  /**
   * Whether the dispatch state was actually read, on a feed that depends on it.
   *
   * TRUE on every feed that does not gate on dispatch — nothing was needed, so
   * nothing is missing. On the before-shipping feed it is false when the source
   * pool was unavailable, and then `items` is EMPTY rather than ungated: an
   * unknown dispatch state must never be read as "not dispatched", because that is
   * the one error that puts a shipped order under a "before shipping" heading.
   *
   * Reported rather than swallowed so the drawer can say "dispatch state
   * unavailable" instead of "no order-change queries" — different facts, and only
   * one of them means nobody is waiting.
   */
  readonly dispatchStateRead: boolean;
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
 *
 * ------------------------------------------------------------------------
 * THE BEFORE-SHIPPING AREA IS GATED ON THE ORDER, NOT JUST ON THE WORDING
 * ------------------------------------------------------------------------
 * WHAT WENT WRONG. This feed used to be the phrase table and nothing else:
 * unanswered, plus `classifyConversationCategory` saying order change. Shopify
 * conversation 46268 is what that produces. Serena asked to add a product to
 * LED65289 on the 19th; the order was dispatched on the 20th at 09:11; CST replied
 * on the 21st saying so; she wrote back the same afternoon still believing it had
 * not shipped. Every one of those messages classifies as an order change, so the
 * thread sat in a panel headed "Order Change Before Shipping Queries" a full day
 * after the parcel left — and the one thing the heading asserts was the one thing
 * nobody had checked.
 *
 * The inbox's urgent flag had checked it all along. `applyBeforeShipmentRule` reads
 * the dispatch state from the source and would have returned `already_dispatched`
 * for this very conversation. The two features simply disagreed, because only one
 * of them asked.
 *
 * SO THE GATE IS THE SAME FUNCTION, NOT A SECOND OPINION. When the requested area
 * is `BEFORE_SHIPPING_CATEGORY` this calls `applyBeforeShipmentRule` — the one
 * place the conditions live — and keeps only what it flagged. A conversation the
 * phrase table calls an order change but the rule refuses now drops out, which is
 * the whole fix: the category says what the customer ASKED, and `urgent` says the
 * window is still OPEN. This feed needs both, because its heading claims both.
 *
 * EVERY OTHER AREA IS UNTOUCHED, and deliberately: a delivery complaint is
 * unanswered work whatever the parcel has done since, and gating it on dispatch
 * state would empty the feed of exactly the cases that only exist after dispatch.
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
    /**
     * The source pool, for the dispatch read.
     *
     * REQUIRED IN PRACTICE FOR THE BEFORE-SHIPPING AREA and ignored for every
     * other one. Without it the dispatch state is unknown, and an unknown dispatch
     * state is never read as "not dispatched": the feed comes back EMPTY with
     * `dispatchStateRead: false` rather than listing shipped orders under a
     * before-shipping heading. A missed notification, never a false one.
     */
    readonly source?: SourceQueryable | null;
    /** Injected so the recency window is testable without freezing time. */
    readonly now?: Date;
  },
): Promise<AwaitingResponsePage> {
  const marketplaces = options.marketplaces.filter(
    (marketplace) => !CATEGORY_SUPPRESSED_MARKETPLACES.has(marketplace),
  );
  /**
   * Which questions this area has to answer beyond "is it unanswered".
   *
   * Derived from the requested category rather than passed in, so a caller cannot
   * ask for the before-shipping feed and opt out of the condition that defines it.
   */
  const gate: AwaitingResponseGate =
    options.category === BEFORE_SHIPPING_CATEGORY ? "before_shipment" : "off";
  const source = options.source ?? null;
  const dispatchStateRead = gate === "off" || source !== null;

  // Nothing classifiable was asked for. Answer without a round trip rather than
  // issuing a query whose result cannot contain a match.
  if (marketplaces.length === 0) {
    return { items: [], scanned: 0, hasMore: false, marketplaces, dispatchStateRead };
  }
  /*
   * No source, no before-shipping feed. Answering here rather than querying and
   * discarding keeps the honest answer cheap, and `dispatchStateRead` is already
   * false so the caller can tell this apart from an empty queue.
   */
  if (gate === "before_shipment" && source === null) {
    return { items: [], scanned: 0, hasMore: false, marketplaces, dispatchStateRead };
  }

  const limit = clampLimit(options.limit);
  const { rows } = await client.query({
    text: LIST_AWAITING_RESPONSE,
    // One extra row PER MARKETPLACE, never returned and never classified,
    // purely to learn whether that marketplace has an older unanswered
    // conversation past its own window.
    //
    // $3: the recency window. NULL — see LIST_AWAITING_RESPONSE — and now NULL
    // on the before-shipping feed as well.
    //
    // THIS FEED AND THE INBOX FLAG MOVE TOGETHER, which is the whole reason the
    // window was ever one shared constant. The inbox now keeps an unanswered
    // before-shipping query urgent until somebody replies; a drawer that still
    // dropped it at 48 hours would be the two surfaces disagreeing about what
    // "before shipping" means, which is precisely what sharing the number was
    // meant to prevent. Membership is still decided by the rule below — the
    // `item.urgent` filter — not by an age.
    values: [
      [...marketplaces],
      limit + 1,
      null,
      // $4: the marketplace whose counterparty_ref is a buyer username rather
      // than an order number, so the fallback is skipped there.
      USERNAME_KEYED_MARKETPLACE,
    ],
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

  /**
   * The rule runs ONCE over the whole page, which is why this is not inside the
   * map: it takes a single batched dispatch read for every candidate rather than a
   * query per row. Its verdict is handed to `toAwaitingResponseItem` so nothing
   * recomputes or overwrites it.
   */
  const bases =
    gate === "before_shipment"
      ? await applyBeforeShipmentRule(source, withinWindow, options.now ?? new Date())
      : withinWindow.map(toInboxItem);

  const items = withinWindow
    .map((row, index) => toAwaitingResponseItem(row, bases[index]!))
    // The area still has to match. On the before-shipping feed the rule may have
    // re-tagged a conversation INTO it, exactly as the inbox does.
    .filter((item) => item.category === options.category)
    /*
     * AND, WHERE THE AREA CLAIMS IT, THE WINDOW HAS TO BE OPEN.
     *
     * This is not redundant with the category filter above, and conversation 46268
     * is why: the phrase table calls it an order change on its own, so it passes
     * that filter while the rule has already refused it as `already_dispatched`.
     * `urgent` is the rule's verdict, and here it is a condition of membership.
     */
    .filter((item) => gate === "off" || item.urgent);

  return { items, scanned: withinWindow.length, hasMore, marketplaces, dispatchStateRead };
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
