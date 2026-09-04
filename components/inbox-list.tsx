"use client";

import {
  type InboxItem,
  NEEDS_CONTEXT_LABEL,
  READ_STATES,
  type ReadState,
  conversationTitle,
  formatSourceTimestamp,
  readStateLabel,
  readStateOf,
} from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import type { MessageCategory } from "@/lib/knowledge/message-category";
import type { MessagePriority } from "@/lib/knowledge/message-priority";

import { CategoryTag } from "./category-tag";
import { PriorityRibbon } from "./priority-ribbon";
import { StatusBadge } from "./status-badge";

/** The dropdown's "no filter" option — never a value `InboxItem.category` itself holds. */
export const ALL_CATEGORIES = "all" as const;
export type CategoryFilter = MessageCategory | typeof ALL_CATEGORIES;

/**
 * The same idea for priority, and the same reason it is a sentinel string
 * rather than null: `InboxItem.priority` genuinely holds null for a
 * conversation nothing could rank, so null cannot also mean "not filtering".
 */
export const ALL_PRIORITIES = "all" as const;
export type PriorityFilter = MessagePriority | typeof ALL_PRIORITIES;

/**
 * NOT A CUSTOMER CONVERSATION: eBay's own platform notices (order updates,
 * policy alerts — see the eBay adapter's `isPlatformNotice`) flow through as
 * real, stored messages rather than being dropped before they ever reached the
 * database. They still need a thread to live in, so they land in their own
 * single-message conversation under the sentinel counterparty "eBay" — but
 * there is no customer on the other end of that thread, so it does not belong
 * in a reply inbox built for triaging customer conversations.
 *
 * DISPLAY ONLY. Nothing is deleted, re-classified, or excluded from ingestion —
 * the stored conversation is untouched and still reachable by direct query,
 * this just keeps it out of the list a reviewer works through.
 */
function isEbayPlatformNotice(item: InboxItem): boolean {
  return item.marketplace === "ebay" && item.counterpartyRef === "eBay";
}

/**
 * Which of the loaded conversations the reviewer has asked to see.
 *
 * FILTERS ONLY, IN THE ORDER THEY WERE GIVEN. Nothing here sorts, and nothing
 * may: the list arrives newest-first from the API and stays that way, so a
 * reviewer can always find the row they were looking at a moment ago. Priority
 * decides whether a row is shown and what colour it wears — never where it sits.
 *
 * ALL THREE ARE CLIENT-SIDE, over the page already loaded. Everything they read
 * — the last message's direction, the category, the priority — is on the
 * `InboxItem` before this runs, so changing any of them fetches nothing.
 *
 * A NULL PRIORITY IS NOT A LEVEL. It survives "All priorities" and is excluded
 * by High, Medium and Low alike, because "we could not rank this" is not a
 * quieter way of saying Low.
 *
 * Exported so the composition can be tested as the pure function it is, rather
 * than through a DOM this suite does not configure.
 */
export function visibleConversations(
  items: readonly InboxItem[],
  filters: {
    readonly readFilter: ReadState;
    readonly categoryFilter: CategoryFilter;
    readonly priorityFilter: PriorityFilter;
  },
): InboxItem[] {
  return items
    .filter((item) => !isEbayPlatformNotice(item))
    .filter((item) => readStateOf(item) === filters.readFilter)
    .filter(
      (item) =>
        filters.categoryFilter === ALL_CATEGORIES || item.category === filters.categoryFilter,
    )
    .filter(
      (item) =>
        filters.priorityFilter === ALL_PRIORITIES || item.priority === filters.priorityFilter,
    );
}

/**
 * The customer-reply inbox.
 *
 * Every conversation the API has returned so far is listed, whatever its
 * inbox placement — see `listConversations`. It arrives one page at a time:
 * `items` is only what has been loaded, `hasMore` says whether an older page
 * still exists server-side, and `onLoadMore` fetches it. A busy marketplace
 * can hold hundreds of conversations inside even a few weeks, so there is no
 * fixed page size that reliably reaches "a month back" for every marketplace
 * — paging keeps asking until the reviewer has what they need instead.
 *
 * Every item belongs to the selected marketplace: the list is passed one
 * marketplace's conversations and the capability that describes them, so a row
 * cannot be labelled with a source guarantee it does not have.
 *
 * No source table or column name is shown; the marketplace is presented by its
 * business name.
 *
 * READ/UNREAD is a client-side filter over the same list the marketplace tab
 * already loaded — see `readStateOf` for the rule. It triggers no request and
 * no AI call: everything it needs (the last message's direction) is already on
 * each `InboxItem`.
 */
export function InboxList({
  items,
  error,
  selectedId,
  onSelect,
  capability,
  readFilter,
  onReadFilterChange,
  categoryFilter,
  priorityFilter,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: InboxItem[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  capability: MarketplaceCapability;
  readFilter: ReadState;
  onReadFilterChange: (next: ReadState) => void;
  /**
   * Client-side, same as `readFilter` — `category` is already on every loaded
   * `InboxItem`, so narrowing by it changes nothing about what was fetched or
   * when the next page is asked for. The control itself lives in the header
   * beside the No Rule tab; this list only applies the choice.
   */
  categoryFilter: CategoryFilter;
  /**
   * Client-side too, and for the same reason: `priority` is already on every
   * loaded `InboxItem`. The control lives in the header beside the category
   * one; this list only applies the choice. It narrows what is shown and never
   * reorders it — see `visibleConversations`.
   */
  priorityFilter: PriorityFilter;
  /** Whether an older page than what is in `items` still exists server-side. */
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (error !== null) {
    return <p className="p-5 text-sm opacity-70">{error}</p>;
  }
  if (items === null) {
    return <p className="p-5 text-sm opacity-60">Loading conversations…</p>;
  }

  const filtered = visibleConversations(items, { readFilter, categoryFilter, priorityFilter });
  const everyItemNeedsContext = filtered.every((item) => item.needsContext);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 pb-2">
        <h2 className="text-xs font-medium tracking-wide uppercase opacity-70">
          Inbox · {filtered.length}
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex gap-1" role="tablist" aria-label="Read state">
            {READ_STATES.map((state) => (
              <button
                key={state}
                type="button"
                role="tab"
                aria-selected={readFilter === state}
                onClick={() => onReadFilterChange(state)}
                className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  readFilter === state
                    ? "bg-black/[0.09] dark:bg-white/[0.16]"
                    : "opacity-70 hover:opacity-100"
                }`}
              >
                {readStateLabel(state)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="px-4 pb-4 text-sm opacity-60">
          No {readStateLabel(readFilter).toLowerCase()} conversations.
        </p>
      ) : (
      <ul>
        {filtered.map((item) => {
          const stamp = formatSourceTimestamp(item.lastSourceTimestamp);
          const selected = item.id === selectedId;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={selected ? "true" : undefined}
                data-marketplace={item.marketplace}
                /*
                 * `relative` and `pr-7` are what the ribbon needs, and both are
                 * on the ROW rather than on the metadata strip below: the
                 * marker belongs to the conversation, not to the line of chips
                 * inside it.
                 *
                 * THE PADDING IS UNCONDITIONAL, on every row whether it carries
                 * a ribbon or not. Widening only the ranked rows would step the
                 * timestamps in and out down the column and make an unranked
                 * row look like a different kind of thing, which is exactly
                 * what an absent ribbon must not say.
                 */
                className={`relative flex w-full flex-col gap-1 border-b border-black/5 py-3 pr-7 pl-4 text-left transition-colors dark:border-white/10 ${
                  selected ? "bg-black/[0.06] dark:bg-white/[0.10]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                }`}
              >
                {/* Renders nothing when the conversation is unranked. */}
                <PriorityRibbon priority={item.priority} />
                <span className="flex items-baseline justify-between gap-2">
                  {/* Never the bare stored reference — see conversationTitle. */}
                  <span className="truncate text-sm font-medium">
                    {conversationTitle(item, capability)}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums opacity-70">
                    {stamp.date} {stamp.time}
                  </span>
                </span>

                <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded bg-black/[0.07] px-1.5 py-0.5 opacity-80 dark:bg-white/[0.12]">
                    {capability.label}
                  </span>
                  <span className="opacity-70">
                    {item.messageCount} message{item.messageCount === 1 ? "" : "s"}
                  </span>
                  {/* Only worth a chip where it distinguishes this row from
                      its neighbours. On a marketplace where nothing is linked
                      to an order yet it would sit on every row and say
                      nothing, so the panel carries it instead. */}
                  {item.needsContext && !everyItemNeedsContext && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">
                      {NEEDS_CONTEXT_LABEL}
                    </span>
                  )}
                  {/* Same pill styling as the case-type chip in NoRuleList —
                      one visual language for "what kind of request is this"
                      wherever it appears. Omitted, not shown as a placeholder,
                      when the phrase table found nothing or found a tie. */}
                  <CategoryTag category={item.category} />
                  <span className="ml-auto">
                    <StatusBadge state={item.workflowState} />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      )}
      {/*
       * Shown regardless of the current Read/Unread filter and even when it
       * leaves the filtered view empty: the filter only hides what is
       * already loaded, it says nothing about what an older page might
       * contain, so the option to go fetch it must not disappear just
       * because today's filtered view happens to be empty.
       */}
      {hasMore && (
        <div className="px-4 py-3">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="w-full rounded-full border border-black/15 py-1.5 text-xs font-medium disabled:opacity-50 dark:border-white/20"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
