"use client";

import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import {
  CONTEXT_NOT_LOADED_TEXT,
  type InboxItem,
  formatSourceTimestamp,
  workflowLabel,
} from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";

/**
 * Context summary.
 *
 * Order, SKU, product and listing resolution is a later task. Until it exists
 * this panel says so plainly rather than showing a plausible-looking blank
 * field — an empty "Order number" row reads as "no order", which is a different
 * claim from "not looked up yet".
 *
 * References are shown only when the source actually recorded one, and always
 * under the neutral noun the capability supplies. A source reference is not a
 * confirmed purchase, so it never appears as "Order number", and the
 * unresolved-grouping sentinel is not a reference at all and is never shown.
 */
export function ContextPanel({
  conversation,
  capability,
}: {
  conversation: InboxItem | null;
  capability: MarketplaceCapability;
}) {
  if (conversation === null) {
    return <p className="p-5 text-sm opacity-55">No conversation selected.</p>;
  }

  const first = formatSourceTimestamp(conversation.firstSourceTimestamp);
  const last = formatSourceTimestamp(conversation.lastSourceTimestamp);

  return (
    <div className="flex flex-col gap-5 p-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide uppercase opacity-55">Status</h2>
        <dl className="flex flex-col gap-1 text-sm">
          <Row label="Status" value={workflowLabel(conversation.workflowState)} />
          <Row label="Messages" value={String(conversation.messageCount)} />
          <Row label="First" value={`${first.date} ${first.time}`} />
          <Row label="Latest" value={`${last.date} ${last.time}`} />
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide uppercase opacity-55">Context</h2>
        {conversation.listingItemRef !== null && (
          <Row label="Item reference" value={conversation.listingItemRef} />
        )}
        {capability.referenceNoun !== undefined &&
          !isUnresolvedReference(conversation.counterpartyRef) && (
            <Row label={capability.referenceNoun} value={conversation.counterpartyRef} />
          )}
        <p className="text-sm opacity-60">{CONTEXT_NOT_LOADED_TEXT}</p>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs opacity-55">{label}</dt>
      <dd className="truncate text-right text-sm">{value}</dd>
    </div>
  );
}
