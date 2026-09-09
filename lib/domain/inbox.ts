import { z } from "zod";

import { attachmentSchema } from "@/lib/domain/attachment";
import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import { marketplaceSchema } from "@/lib/domain/marketplace";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import { messageDirectionSchema } from "@/lib/domain/message";
import { bodyDecodeStatuses } from "@/lib/domain/source-message";
import { workflowStateSchema } from "@/lib/domain/workflow";
import { MESSAGE_CATEGORIES, type MessageCategory } from "@/lib/knowledge/message-category";
import { MESSAGE_PRIORITIES } from "@/lib/knowledge/message-priority";

/**
 * Marketplace-NEUTRAL view contracts for the workspace.
 *
 * These are the only shapes the browser ever sees. No source table, column, or
 * marketplace encoding appears here, and nothing carries connection details or
 * internal source metadata.
 */
export const inboxPlacementSchema = z.enum(["reply_inbox", "outbound_only", "filtered"]);

export const inboxItemSchema = z.object({
  id: z.string(),
  marketplace: marketplaceSchema,
  /**
   * Which of the marketplace's own accounts the conversation arrived on.
   *
   * An integer the source uses to separate its selling accounts — not a
   * customer, not a person, and not a connection detail. It is here because an
   * exported conversation has to say which account it came from to be
   * actionable; a reviewer chasing a B&Q order needs to know which B&Q account
   * received it. Nullable so a source that attributes nothing stays
   * representable rather than being given a made-up account.
   */
  subSourceId: z.number().int().nullable(),
  counterpartyRef: z.string(),
  listingItemRef: z.string().nullable(),
  workflowState: workflowStateSchema,
  needsContext: z.boolean(),
  inboxPlacement: inboxPlacementSchema,
  firstSourceTimestamp: z.string(),
  lastSourceTimestamp: z.string(),
  messageCount: z.number().int(),
  inboundCount: z.number().int(),
  /**
   * Direction of the most recent message in the thread, by the same
   * (source_ts, source_pk) ordering every other view uses. Null only for a
   * conversation row with no messages yet landed, which the recount step
   * should never leave behind — nullable so that impossible state stays
   * representable rather than lying with a guessed direction.
   */
  lastDirection: messageDirectionSchema.nullable(),
  /**
   * Which of the eleven CST case areas this conversation's customer messages
   * fall under, from `classifyMessageCategory` — computed at list-fetch time
   * from text the query already reads, never stored. Null when the phrase
   * table found nothing, or found two areas equally strongly: an inbox filter
   * showing the wrong category is worse than one honestly showing none.
   */
  category: z.enum(MESSAGE_CATEGORIES).nullable(),
  /**
   * How urgently CST staff should handle this conversation, from
   * `classifyConversationPriority` — computed at list-fetch time from the same
   * customer text the category is read from, never stored and never persisted.
   *
   * INDEPENDENT OF `category`, and of everything else on this item. It is not
   * derived from the category, it does not change it, and nothing in the
   * workflow, draft or sync paths reads it. A recall and an invoice request are
   * both admin work and rank differently; a recall and a cancellation rank the
   * same and are nothing alike.
   *
   * NON-NULL FOR EVERY CONVERSATION CARRYING READABLE CUSTOMER TEXT. An
   * ordinary enquiry the specific rules cannot place ranks MEDIUM — the neutral
   * "somebody has to work this" level — rather than arriving blank, so a genuine
   * reply-inbox row always shows a ribbon.
   *
   * NULL IS NOT "LOW", AND NOW MEANS ONLY "NOTHING TO READ": a marketplace whose
   * stored text is known to carry non-customer content (suppressed for exactly
   * the reason its category is), a conversation with no inbound message, or one
   * whose every stored body arrived empty. An interface must render that as no
   * priority shown, never as the least urgent thing in the inbox — a
   * conversation nobody could read is not one that can wait.
   */
  priority: z.enum(MESSAGE_PRIORITIES).nullable(),
});

export type InboxItem = z.infer<typeof inboxItemSchema>;

/**
 * Why a conversation has no rule-grounded reply. Two different findings,
 * both shown as one "No Rule" list because both leave a reviewer with the
 * same next action:
 *
 *   no_corpus     the marketplace's entire approved rule set was empty when
 *                 generation was attempted, so the model was never called.
 *                 Recorded once, by the pre-generation gate.
 *   no_citation   generation ran and read the whole corpus, but the newest
 *                 generated reply for THIS conversation cited none of it.
 *                 Derived, not recorded — read back from that revision's
 *                 own stored citations every time the list loads.
 */
export const NO_RULE_REASONS = ["no_corpus", "no_citation"] as const;
export type NoRuleReason = (typeof NO_RULE_REASONS)[number];

/**
 * A conversation the CST knowledge base could not ground a reply for.
 *
 * Every field an `InboxItem` has, plus what explains the finding. Deliberately
 * NOT a new normalisation of either finding — `caseType` for `no_corpus` comes
 * back exactly as the writer stored it (the same classifier `NoRuleFlag`
 * calls), and for `no_citation` it is produced by calling that same classifier
 * fresh, never a second implementation of it. `analysedAt` is the finding's
 * own timestamp either way: when it was recorded, or when the ungrounded
 * reply was generated.
 */
export const noRuleConversationSchema = inboxItemSchema.extend({
  /** The classifier's label for the case, or null when it declined to name one. */
  caseType: z.string().nullable(),
  /** When this finding was recorded or last confirmed, verbatim. */
  analysedAt: z.string(),
  reason: z.enum(NO_RULE_REASONS),
});

export type NoRuleConversationItem = z.infer<typeof noRuleConversationSchema>;

/**
 * The one case area the notification list watches.
 *
 * Typed as `MessageCategory`, so this is a compile error rather than a silently
 * empty list if the classifier's vocabulary ever moves. It is DECLARED here and
 * classified nowhere: the value is only ever compared against what
 * `classifyConversationCategory` already returned for the conversation, which is
 * why no second detector exists for it.
 *
 * Note the exact wording — "Order change, before shipping queries" — is the
 * classifier's own. Nothing in the codebase says "Order Change Before Queries".
 */
export const ORDER_CHANGE_CATEGORY: MessageCategory = "Order change, before shipping queries";

/**
 * What the notification is CALLED on screen.
 *
 * DELIBERATELY NOT THE SAME STRING AS `ORDER_CHANGE_CATEGORY`, and the
 * difference is worth stating so nobody "fixes" one to match the other.
 *
 *   ORDER_CHANGE_CATEGORY            the classifier's own value. It is what the
 *                                    filter compares against, what the inbox's
 *                                    category dropdown lists, and what the
 *                                    category chip prints. Never retyped.
 *   ORDER_CHANGE_NOTIFICATION_TITLE  the requested heading for the notification
 *                                    drawer. Display copy only. Nothing is ever
 *                                    matched, filtered or stored against it.
 *
 * They name the same case area in two registers — one is data, one is a title —
 * and only the first may reach a comparison.
 */
export const ORDER_CHANGE_NOTIFICATION_TITLE = "Order Change Before Shipping Queries";

/**
 * A conversation in the requested case area that nobody has answered.
 *
 * Every field an `InboxItem` has, plus the newest customer message itself —
 * a triage list is read to decide what to open next, and the title, the
 * marketplace and a timestamp alone do not say what the customer wants.
 *
 * The preview is built server-side with the SAME `previewOf` the domain
 * already exposes, and only the truncated result crosses the boundary: the
 * browser is given what the row displays and no more.
 *
 * NO ORDER NUMBER, DELIBERATELY. A resolved order is not a property of a stored
 * conversation — it is resolved per conversation against the read-only source
 * database when the context panel opens. Putting one on a list row would mean
 * running that resolution for every row of the list. What the row can honestly
 * carry about the order is what the ingestion layer already recorded: the
 * capability's own reference (through `conversationTitle`) and `needsContext`.
 */
export const awaitingResponseConversationSchema = inboxItemSchema.extend({
  /** The newest inbound message's stored source timestamp, verbatim. */
  latestCustomerMessageAt: z.string(),
  /** Short preview of that message, already truncated. Never the full body. */
  latestCustomerMessagePreview: z.string(),
  /**
   * Whether a draft has been written for this conversation.
   *
   * IT DOES NOT MEAN ANSWERED, and that distinction is the reason this field
   * exists. The feed once excluded any conversation with a draft, so generating
   * one made a waiting customer vanish from the notification list — while this
   * system cannot send anything at all, and `reviewed` is its terminal state. A
   * draft is work in progress; only an outbound message is a reply.
   *
   * So it is a LABEL, never a filter: the drawer separates "waiting, nothing
   * written yet" from "waiting, draft ready" and keeps both on the list.
   */
  hasDraft: z.boolean(),
});

export type AwaitingResponseConversationItem = z.infer<
  typeof awaitingResponseConversationSchema
>;

/**
 * What the notification endpoint returns.
 *
 * GLOBAL. The conversations span every marketplace that could be read, and each
 * one names its own — there is no marketplace on the envelope, because the feed
 * is deliberately independent of whichever tab is on screen.
 *
 * `scanned` and `hasMore` describe how many UNANSWERED conversations were read
 * and classified, not how many matched. They are part of the contract rather
 * than a server-side detail because the category cannot be a SQL predicate, so
 * a short list is not evidence of a quiet queue — and an interface that cannot
 * tell those apart will present one as the other.
 *
 * `marketplaces` is what was actually read, which is not the same as every
 * marketplace: the ones whose category is suppressed at source are dropped
 * before the query, since no row of theirs could match.
 */
export const awaitingResponseFeedSchema = z.object({
  conversations: z.array(awaitingResponseConversationSchema),
  scanned: z.number().int(),
  hasMore: z.boolean(),
  marketplaces: z.array(marketplaceSchema),
});

export type AwaitingResponseFeed = z.infer<typeof awaitingResponseFeedSchema>;

export const conversationMessageViewSchema = z.object({
  id: z.string(),
  direction: messageDirectionSchema,
  /** The stored source timestamp, verbatim. Never converted. */
  sourceTimestamp: z.string(),
  bodyText: z.string().nullable(),
  bodyDecodeStatus: z.enum(bodyDecodeStatuses),
  /**
   * Files the message arrived with, already filtered to what is safe to render.
   *
   * Defaults to empty so every existing caller and stored payload stays valid —
   * a message with no attachments and a message from before the column existed
   * are the same thing to a reader.
   */
  attachments: z.array(attachmentSchema).default([]),
});

export type ConversationMessageView = z.infer<typeof conversationMessageViewSchema>;

export const conversationDetailSchema = z.object({
  conversation: inboxItemSchema,
  messages: z.array(conversationMessageViewSchema),
});

export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

/**
 * Which side of the conversation a message is rendered on.
 * Customer messages left; previous CST replies right.
 */
export function messageSide(message: ConversationMessageView): "left" | "right" {
  return message.direction === "inbound" ? "left" : "right";
}

/** Shown when a body is absent or could not be decoded. Never raw content. */
export const UNAVAILABLE_BODY_TEXT = "Message content unavailable";

/**
 * Takes only the body fields, so it serves both a conversation message and an
 * unverified-direction one. Body handling does not depend on direction, and
 * requiring a direction here would force the neutral feed to supply one.
 */
export type MessageBody = Pick<ConversationMessageView, "bodyText" | "bodyDecodeStatus">;

export function displayBody(message: MessageBody): {
  text: string;
  available: boolean;
} {
  const text = message.bodyText;
  if (message.bodyDecodeStatus !== "decoded" || text === null || text.trim() === "") {
    return { text: UNAVAILABLE_BODY_TEXT, available: false };
  }
  return { text, available: true };
}

/**
 * Splits a stored source timestamp for display.
 *
 * Pure string slicing — deliberately no Date parsing and no arithmetic, because
 * the authoritative source timezone is still unconfirmed. The value is shown as
 * recorded and is never labelled with a zone.
 */
export function formatSourceTimestamp(timestamp: string): { date: string; time: string } {
  const [datePart = "", rest = ""] = timestamp.split(/[ T]/);
  return { date: datePart, time: rest.slice(0, 5) };
}

/** Short preview of the most recent message, for the inbox list. */
export function previewOf(message: MessageBody | null, maxLength = 90): string {
  if (message === null) return "No messages";
  const { text, available } = displayBody(message);
  if (!available) return UNAVAILABLE_BODY_TEXT;
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length <= maxLength ? flattened : `${flattened.slice(0, maxLength - 1)}…`;
}

/**
 * Read/unread, derived from the last message's direction alone.
 *
 * READ:   the last message in the thread is a CST/marketplace outbound reply
 *         — the customer has already been answered.
 * UNREAD: the last message is inbound (or the thread has no messages at
 *         all), meaning the most recent customer message has no reply after
 *         it yet.
 *
 * This intentionally never reads a marketplace's own read/unread flag — the
 * source's notion of "read" tracks whether someone opened it there, not
 * whether the customer got a reply, and the two would disagree for a
 * conversation this application has already answered but the source
 * mailbox still shows unopened.
 */
export const READ_STATES = ["read", "unread"] as const;
export type ReadState = (typeof READ_STATES)[number];

export function readStateOf(conversation: Pick<InboxItem, "lastDirection">): ReadState {
  return conversation.lastDirection === "outbound" ? "read" : "unread";
}

const READ_STATE_LABELS: Readonly<Record<ReadState, string>> = {
  read: "Read",
  unread: "Unread",
};

export function readStateLabel(state: ReadState): string {
  return READ_STATE_LABELS[state];
}

/** Plain-English copy for context that has not been resolved yet. */
export const CONTEXT_NOT_LOADED_TEXT = "Order and product details not loaded yet.";
export const NEEDS_CONTEXT_LABEL = "No order linked";

/**
 * Plain-English copy for a conversation that matched several genuine orders.
 *
 * Says what happened and what to do, in the reviewer's own terms. It
 * deliberately names no internal concept — not the resolution value, not the
 * verification state, not the fact vocabulary — because none of those is
 * something a CST agent can act on, and a sentence about them reads as a
 * system problem rather than a two-second task.
 */
export const MULTIPLE_ORDERS_TEXT =
  "Multiple orders found. Please select the order related to this conversation.";

/**
 * How a conversation is titled in the interface.
 *
 * The priority is what a CST agent can act on, in order:
 *
 *   1. A verified customer handle, where the source proves one (eBay).
 *   2. The marketplace plus its order number — "B&Q Order 1234567890-A".
 *   3. The marketplace plus a plain noun — "Temu enquiry" — where the source
 *      gives nothing to identify the conversation by.
 *
 * The third case is deliberately not blank and deliberately not an internal
 * placeholder. It reads as an ordinary enquiry, which is what it is; the fact
 * that nothing groups it is carried by the flags on the conversation, not by
 * jargon in its title.
 *
 * The capability decides which case applies; this never tests a marketplace by
 * name.
 */
export function conversationTitle(
  conversation: Pick<InboxItem, "counterpartyRef">,
  capability: MarketplaceCapability,
): string {
  const reference = conversation.counterpartyRef;
  if (capability.counterpartyIdentityVerified) return reference;
  if (isUnresolvedReference(reference)) return `${capability.label} enquiry`;
  const noun = capability.referenceNoun;
  return noun === undefined
    ? `${capability.label} ${reference}`
    : `${capability.label} ${noun} ${reference}`;
}

/**
 * Workflow state as a CST agent would say it.
 *
 * The stored values are snake_case identifiers meant for the database; showing
 * them raw put "pending_review" in front of a user.
 */
const WORKFLOW_LABELS: Readonly<Record<InboxItem["workflowState"], string>> = {
  received: "New",
  drafting: "Draft in progress",
  pending_review: "Awaiting review",
  reviewed: "Reviewed",
};

export function workflowLabel(state: InboxItem["workflowState"]): string {
  return WORKFLOW_LABELS[state];
}
