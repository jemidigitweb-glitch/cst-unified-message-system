"use client";

import { displayBody, formatSourceTimestamp } from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import {
  type UnresolvedMessageView as MessageView,
  unresolvedMessageTitle,
} from "@/lib/domain/unresolved-messages";

/**
 * The selected message, for a source whose direction is not verified.
 *
 * Occupies the same pane as the conversation view, and every difference from it
 * is a refusal to imply something the source does not support:
 *
 *   A full-width card, not a bubble. A bubble on the left means "the customer
 *   said this" and one on the right means "we replied"; both are claims this
 *   source cannot back. Alignment is a statement, so nothing is aligned.
 *
 *   No "Customer" or "CST reply" label, and no inbound/outbound wording. There
 *   is nothing to label.
 *
 *   One message, not a thread. Nothing in the source groups these, so none is
 *   presented as a conversation — not even a one-message one.
 *
 * That restraint needs no caption, and there is deliberately no banner
 * explaining which internal check has not run. The body is rendered as plain
 * text only, never as markup.
 */
export function UnresolvedMessageView({
  message,
  capability,
}: {
  message: MessageView | null;
  capability: MarketplaceCapability;
}) {
  if (message === null) {
    return <p className="p-6 text-sm opacity-60">Select a message to review it.</p>;
  }

  const body = displayBody(message);
  const stamp = formatSourceTimestamp(message.sourceTimestamp);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-black/10 px-5 py-3 dark:border-white/15">
        <p className="truncate text-sm font-medium">
          {unresolvedMessageTitle(message, capability)}
        </p>
        <p className="text-xs tabular-nums opacity-55">
          {stamp.date} {stamp.time}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Full width and no alignment: see the component note above. */}
        <div className="rounded-lg border border-black/10 bg-black/[0.03] px-4 py-3 dark:border-white/15 dark:bg-white/[0.05]">
          <p
            className={`text-sm whitespace-pre-wrap ${body.available ? "" : "italic opacity-55"}`}
          >
            {body.text}
          </p>
          <p className="mt-1.5 text-[10px] tabular-nums opacity-50">
            {stamp.date} {stamp.time}
          </p>
        </div>
      </div>

      <div className="shrink-0 border-t border-black/10 px-5 py-3 text-xs opacity-55 dark:border-white/15">
        Review only — this phase has no capability to reply to a customer.
      </div>
    </div>
  );
}
