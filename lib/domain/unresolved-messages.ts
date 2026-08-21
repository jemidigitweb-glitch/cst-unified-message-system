import { z } from "zod";

import { displayBody } from "@/lib/domain/inbox";
import { marketplaceSchema } from "@/lib/domain/marketplace";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import { senderNameFromBody } from "@/lib/domain/message-signature";
import { bodyDecodeStatuses } from "@/lib/domain/source-message";

/**
 * Marketplace-NEUTRAL contract for a source message whose direction, customer
 * identity and conversation grouping are all unproven.
 *
 * Note what this shape does NOT have, and why each absence is load-bearing:
 *
 *   no `direction`        — the source does not state one, and the two allowed
 *                           values are both claims. Omitting the field is the
 *                           only representation that asserts nothing.
 *   no `counterpartyRef`  — company domains appear on both sides of the source,
 *                           so neither address identifies a customer.
 *   no `conversationId`   — nothing in the source groups these messages, so a
 *                           thread cannot be asserted.
 *
 * A message here is not "a conversation with one message". It is a message with
 * no established relationship to any other, which is a weaker and truer claim.
 */
export const unresolvedMessageViewSchema = z.object({
  id: z.string(),
  marketplace: marketplaceSchema,
  /** The stored source timestamp, verbatim. Never converted. */
  sourceTimestamp: z.string(),
  bodyText: z.string().nullable(),
  bodyDecodeStatus: z.enum(bodyDecodeStatuses),
});

export type UnresolvedMessageView = z.infer<typeof unresolvedMessageViewSchema>;

/**
 * Whether the application store backing this feed exists yet.
 *
 * `not_provisioned` is reported plainly rather than as an error or as an empty
 * list. An empty list would say "there are no messages", which is false: the
 * messages exist in the source and are waiting on a reviewed schema change.
 */
export const UNRESOLVED_FEED_STATES = ["available", "not_provisioned"] as const;

export type UnresolvedFeedState = (typeof UNRESOLVED_FEED_STATES)[number];

export const unresolvedFeedSchema = z.object({
  marketplace: marketplaceSchema,
  state: z.enum(UNRESOLVED_FEED_STATES),
  messages: z.array(unresolvedMessageViewSchema),
});

export type UnresolvedFeed = z.infer<typeof unresolvedFeedSchema>;

/**
 * Copy for a feed whose store has not been created yet.
 *
 * Still distinct from "there are no messages" — that remains the point of the
 * separate state — but said without naming storage or verification. "Not
 * available yet" is true and is what an agent needs; the cause belongs in the
 * server log, not on screen.
 */
export const FEED_NOT_PROVISIONED_TEXT =
  "Messages for this marketplace are not available yet.";

/**
 * How a message is titled in the sidebar: whoever signed it, otherwise a
 * neutral "Amazon message" / "Shopify message".
 *
 * There is no sender field to read. The adapters deliberately never select one
 * — not fetching the sender address is what stops a later change quietly
 * deriving a direction from it — so the name comes from the message's own
 * sign-off block, which is a structure rather than a claim about content. See
 * `senderNameFromBody` for how narrowly that is read.
 *
 * The name is whoever WROTE the message, which on these feeds may be a customer
 * or one of our own agents; the source does not establish direction. So it is
 * shown as a plain title and never labelled as the customer.
 */
export function unresolvedMessageTitle(
  message: Pick<UnresolvedMessageView, "bodyText" | "bodyDecodeStatus">,
  capability: MarketplaceCapability,
): string {
  const body = displayBody(message);
  const name = body.available ? senderNameFromBody(body.text) : null;
  return name ?? `${capability.label} message`;
}
