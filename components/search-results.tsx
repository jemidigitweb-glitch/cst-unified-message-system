"use client";

import {
  type ConversationSearchFeed,
  SEARCH_MATCH_LABEL,
} from "@/lib/domain/conversation-search";
import { conversationTitle, formatSourceTimestamp } from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";

/**
 * Search results, in the shared drawer.
 *
 * EACH ROW SAYS WHY IT IS HERE. "Order number" and "Customer name (order
 * record)" are different degrees of certainty — one is the thread's own key,
 * the other is a name matched in the source's order records and mapped back —
 * and presenting them identically would invite an agent to trust the weaker
 * one as much as the stronger. The badge is that distinction, on every row.
 *
 * NAMES ARE NEVER INVENTED. A row is titled through `conversationTitle`, which
 * decides from THAT marketplace's capability whether the stored reference is a
 * real customer handle or an order reference that must not be printed as a
 * person. The matched name, where one matched, is shown as evidence beneath —
 * labelled as coming from the order record, not presented as the thread's
 * identity.
 *
 * IT SELECTS. IT DOES NOTHING ELSE. A click hands the conversation id and its
 * marketplace to the same selection path a notification row uses.
 */
export function SearchResults({
  feed,
  error,
  searching,
  onSelect,
}: {
  feed: ConversationSearchFeed | null;
  error: string | null;
  searching: boolean;
  onSelect: (id: string, marketplace: Marketplace) => void;
}) {
  if (error !== null) return <p className="p-5 text-sm opacity-70">{error}</p>;
  if (searching) return <p className="p-5 text-sm opacity-60">Searching…</p>;
  if (feed === null) {
    return (
      <p className="p-5 text-sm opacity-60">
        Search by customer name, marketplace handle, order number, conversation ID or message ID.
      </p>
    );
  }

  if (feed.results.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-5 text-sm opacity-70">
        <p>No conversation matches “{feed.query}”.</p>
        {/*
          * "We could not look" is not "there is nothing there", and the
          * difference matters most when somebody is searching for a person.
          */}
        {!feed.nameSearchAvailable && (
          <p className="text-[11px] opacity-80">
            Customer-name search did not run for this query, so a match by name may have been
            missed. Order number, handle and IDs were searched.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul>
        {feed.results.map((result) => {
          const marketplace = result.marketplace as Marketplace;
          const capability = capabilityOf(marketplace);
          const stamp =
            result.lastSourceTimestamp === null
              ? null
              : formatSourceTimestamp(result.lastSourceTimestamp);
          return (
            <li key={`${result.conversationId}-${result.matchKind}`}>
              <button
                type="button"
                onClick={() => onSelect(result.conversationId, marketplace)}
                data-marketplace={marketplace}
                className="flex w-full flex-col gap-1 border-b border-black/5 px-4 py-3 text-left transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.05]"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {conversationTitle({ counterpartyRef: result.counterpartyRef }, capability)}
                  </span>
                  {stamp !== null && (
                    <span className="shrink-0 text-[11px] tabular-nums opacity-70">
                      {stamp.date} {stamp.time}
                    </span>
                  )}
                </span>

                <span className="flex flex-wrap items-center gap-1.5 text-[11px] opacity-70">
                  <span className="rounded-sm border border-black/15 px-1.5 py-0.5 dark:border-white/20">
                    {SEARCH_MATCH_LABEL[result.matchKind]}
                  </span>
                  {/* The evidence: what actually matched. */}
                  <span className="truncate">{result.matchedOn}</span>
                  <span>· {capability.label}</span>
                  <span>
                    · {result.messageCount} message{result.messageCount === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {feed.capped && (
        // A capped list is not "all of it", and an interface that cannot tell
        // those apart will present one as the other.
        <p className="px-4 py-3 text-[11px] opacity-60">
          More matches exist. Narrow the search to see them.
        </p>
      )}
      {!feed.nameSearchAvailable && (
        <p className="px-4 py-3 text-[11px] opacity-60">
          Customer-name search did not run, so results are by order number, handle and IDs only.
        </p>
      )}
    </div>
  );
}
