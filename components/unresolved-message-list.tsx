"use client";

import { formatSourceTimestamp } from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import {
  FEED_NOT_PROVISIONED_TEXT,
  type UnresolvedFeed,
  unresolvedMessageTitle,
} from "@/lib/domain/unresolved-messages";

/**
 * Sidebar for a marketplace whose messages are not grouped into threads.
 *
 * Same shape and behaviour as the conversation inbox — a scrolling list of
 * selectable rows, newest first — so switching tabs changes the data rather
 * than the interface. One source message is one row.
 *
 * What it deliberately does NOT carry, unlike the conversation inbox: a message
 * count (every row is one message), a workflow state (an ungrouped message is
 * not review work yet), and any order or context chip. Those columns exist over
 * there because there is something true to put in them.
 */
export function UnresolvedMessageList({
  feed,
  error,
  selectedId,
  onSelect,
  capability,
}: {
  feed: UnresolvedFeed | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  capability: MarketplaceCapability;
}) {
  if (error !== null) {
    return <p className="p-5 text-sm opacity-70">{error}</p>;
  }
  if (feed === null) {
    return <p className="p-5 text-sm opacity-60">Loading messages…</p>;
  }
  // "Not available yet" and "there are none" are different claims, and the
  // sidebar must not render the first as an empty list.
  if (feed.state === "not_provisioned") {
    return (
      <p data-testid="feed-not-provisioned" className="p-5 text-sm opacity-70">
        {FEED_NOT_PROVISIONED_TEXT}
      </p>
    );
  }
  if (feed.messages.length === 0) {
    return <p className="p-5 text-sm opacity-60">No messages to review.</p>;
  }

  return (
    <>
      <h2 className="px-4 pt-4 pb-2 text-xs font-medium tracking-wide uppercase opacity-55">
        Inbox · {feed.messages.length}
      </h2>
      <ul data-testid="unresolved-message-list">
        {feed.messages.map((message) => {
          const stamp = formatSourceTimestamp(message.sourceTimestamp);
          const selected = message.id === selectedId;
          return (
            <li key={message.id}>
              <button
                type="button"
                onClick={() => onSelect(message.id)}
                aria-current={selected ? "true" : undefined}
                data-marketplace={message.marketplace}
                className={`flex w-full flex-col gap-1 border-b border-black/5 px-4 py-3 text-left transition-colors dark:border-white/10 ${
                  selected
                    ? "bg-black/[0.06] dark:bg-white/[0.10]"
                    : "hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {unresolvedMessageTitle(message, capability)}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums opacity-55">
                    {stamp.date} {stamp.time}
                  </span>
                </span>

                <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded bg-black/[0.07] px-1.5 py-0.5 opacity-80 dark:bg-white/[0.12]">
                    {capability.label}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
