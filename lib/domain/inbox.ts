import { z } from "zod";

import { attachmentSchema } from "@/lib/domain/attachment";
import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import { marketplaceSchema } from "@/lib/domain/marketplace";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import { messageDirectionSchema } from "@/lib/domain/message";
import { bodyDecodeStatuses } from "@/lib/domain/source-message";
import { workflowStateSchema } from "@/lib/domain/workflow";

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
  counterpartyRef: z.string(),
  listingItemRef: z.string().nullable(),
  workflowState: workflowStateSchema,
  needsContext: z.boolean(),
  inboxPlacement: inboxPlacementSchema,
  firstSourceTimestamp: z.string(),
  lastSourceTimestamp: z.string(),
  messageCount: z.number().int(),
  inboundCount: z.number().int(),
});

export type InboxItem = z.infer<typeof inboxItemSchema>;

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

/** Plain-English copy for context that has not been resolved yet. */
export const CONTEXT_NOT_LOADED_TEXT = "Order and product details not loaded yet.";
export const NEEDS_CONTEXT_LABEL = "No order linked";

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
