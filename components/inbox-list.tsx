"use client";

import {
  type InboxItem,
  NEEDS_CONTEXT_LABEL,
  conversationTitle,
  formatSourceTimestamp,
  workflowLabel,
} from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";

/**
 * The customer-reply inbox.
 *
 * Only conversations the API returns are listed, and the API returns only
 * `reply_inbox` placements — outbound-only groups never appear here.
 *
 * Every item belongs to the selected marketplace: the list is passed one
 * marketplace's conversations and the capability that describes them, so a row
 * cannot be labelled with a source guarantee it does not have.
 *
 * No source table or column name is shown; the marketplace is presented by its
 * business name.
 */
export function InboxList({
  items,
  error,
  selectedId,
  onSelect,
  capability,
}: {
  items: InboxItem[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  capability: MarketplaceCapability;
}) {
  if (error !== null) {
    return <p className="p-5 text-sm opacity-70">{error}</p>;
  }
  if (items === null) {
    return <p className="p-5 text-sm opacity-60">Loading conversations…</p>;
  }
  if (items.length === 0) {
    return <p className="p-5 text-sm opacity-60">No conversations to review.</p>;
  }

  const everyItemNeedsContext = items.every((item) => item.needsContext);

  return (
    <>
      <h2 className="px-4 pt-4 pb-2 text-xs font-medium tracking-wide uppercase opacity-55">
        Inbox · {items.length}
      </h2>
      <ul>
        {items.map((item) => {
          const stamp = formatSourceTimestamp(item.lastSourceTimestamp);
          const selected = item.id === selectedId;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={selected ? "true" : undefined}
                data-marketplace={item.marketplace}
                className={`flex w-full flex-col gap-1 border-b border-black/5 px-4 py-3 text-left transition-colors dark:border-white/10 ${
                  selected ? "bg-black/[0.06] dark:bg-white/[0.10]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  {/* Never the bare stored reference — see conversationTitle. */}
                  <span className="truncate text-sm font-medium">
                    {conversationTitle(item, capability)}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums opacity-55">
                    {stamp.date} {stamp.time}
                  </span>
                </span>

                <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded bg-black/[0.07] px-1.5 py-0.5 opacity-80 dark:bg-white/[0.12]">
                    {capability.label}
                  </span>
                  <span className="opacity-55">
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
                  <span className="ml-auto opacity-45">{workflowLabel(item.workflowState)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
