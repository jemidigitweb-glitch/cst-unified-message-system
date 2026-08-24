"use client";

import { type NoRuleConversationItem, conversationTitle, formatSourceTimestamp } from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";

/**
 * The No Rule list: this marketplace's conversations the CST knowledge base
 * could not ground a reply for.
 *
 * Same row shape and interaction as the inbox list on purpose — a reviewer
 * moving between the two should not have to relearn how to read a row. The
 * difference is the source: every item here is one of two findings merged by
 * `listNoRuleConversations` (a marketplace with no corpus at all, or this
 * conversation's own reply citing nothing), not inbox placement — and the
 * case-type chip replaces the workflow chip because "what kind of request is
 * this" is the more useful thing to triage on in a list built for exactly
 * that.
 *
 * Selecting a row calls the SAME `onSelect` the inbox list uses, which opens
 * the SAME conversation view — the No Rule flag, the export button and
 * everything else on that screen is unchanged, already reads its state from
 * the same finding this list is built from.
 */
export function NoRuleList({
  items,
  error,
  selectedId,
  onSelect,
  capability,
}: {
  items: NoRuleConversationItem[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  capability: MarketplaceCapability;
}) {
  if (error !== null) {
    return <p className="p-5 text-sm opacity-70">{error}</p>;
  }
  if (items === null) {
    return <p className="p-5 text-sm opacity-60">Loading No Rule conversations…</p>;
  }

  return (
    <>
      <h2 className="px-4 pt-4 pb-2 text-xs font-medium tracking-wide uppercase opacity-55">
        No Rule · {items.length}
      </h2>
      {items.length === 0 ? (
        <p className="px-4 pb-4 text-sm opacity-60">
          No conversations flagged for {capability.label} yet.
        </p>
      ) : (
        <ul>
          {items.map((item) => {
            const stamp = formatSourceTimestamp(item.analysedAt);
            const selected = item.id === selectedId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-current={selected ? "true" : undefined}
                  data-marketplace={item.marketplace}
                  className={`flex w-full flex-col gap-1 border-b border-black/5 px-4 py-3 text-left transition-colors dark:border-white/10 ${
                    selected
                      ? "bg-black/[0.06] dark:bg-white/[0.10]"
                      : "hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
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
                    {/*
                     * Shown only for the rarer of the two reasons: the whole
                     * marketplace had nothing to generate from, not just this
                     * conversation. `no_citation` is the ordinary case — a
                     * corpus existed, generation ran, nothing in it applied
                     * here — and gets no extra label, so the common row stays
                     * as quiet as it already was.
                     */}
                    {item.reason === "no_corpus" && (
                      <span className="rounded bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-700 dark:text-rose-300">
                        No rules for {capability.label}
                      </span>
                    )}
                    {/* The classifier's label for the case, read back from the
                        stored finding — the same label NoRuleFlag shows once
                        the conversation is open. Omitted when the classifier
                        declined to name one, rather than showing a blank chip. */}
                    {item.caseType !== null && (
                      <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">
                        {item.caseType}
                      </span>
                    )}
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
