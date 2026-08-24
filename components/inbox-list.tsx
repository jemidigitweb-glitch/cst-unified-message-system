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
}: {
  items: InboxItem[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  capability: MarketplaceCapability;
  readFilter: ReadState;
  onReadFilterChange: (next: ReadState) => void;
}) {
  if (error !== null) {
    return <p className="p-5 text-sm opacity-70">{error}</p>;
  }
  if (items === null) {
    return <p className="p-5 text-sm opacity-60">Loading conversations…</p>;
  }

  const filtered = items.filter((item) => readStateOf(item) === readFilter);
  const everyItemNeedsContext = filtered.every((item) => item.needsContext);

  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <h2 className="text-xs font-medium tracking-wide uppercase opacity-55">
          Inbox · {filtered.length}
        </h2>
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
                  : "opacity-55 hover:opacity-100"
              }`}
            >
              {readStateLabel(state)}
            </button>
          ))}
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
      )}
    </>
  );
}
