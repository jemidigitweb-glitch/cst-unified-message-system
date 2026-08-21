"use client";

import { useCallback, useEffect, useState } from "react";

import type { ConversationDetail, InboxItem } from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";
import type { UnresolvedFeed } from "@/lib/domain/unresolved-messages";

import { ContextPanel } from "./context-panel";
import { ConversationView } from "./conversation-view";
import { InboxList } from "./inbox-list";
import { MarketplaceTabs } from "./marketplace-tabs";
import { UnresolvedMessageList } from "./unresolved-message-list";
import { UnresolvedMessageView } from "./unresolved-message-view";

/**
 * CST workspace: marketplace tabs above a shared layout.
 *
 * One workspace serves every marketplace, and every marketplace is active.
 * Every tab gets the same list-left / detail-right arrangement, so switching
 * marketplaces changes the data rather than the interface. What differs is
 * what each source can support, and only that:
 *
 *   `conversations`       inbox, conversation, and a context panel alongside.
 *   `unresolved_messages` message list and the selected message. No context
 *                         panel: with no thread and no verified direction there
 *                         is no conversation to describe, and an empty panel
 *                         would read as "no context" rather than "none yet".
 *
 * Switching tabs clears every piece of per-marketplace state, so one
 * marketplace's messages cannot appear under another's tab — not even for a
 * frame.
 *
 * Everything is fetched from the read-only API. Nothing here can modify a
 * conversation or transmit anything.
 */
export function Workspace() {
  const [marketplace, setMarketplace] = useState<Marketplace>("ebay");
  const [inbox, setInbox] = useState<InboxItem[] | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [feed, setFeed] = useState<UnresolvedFeed | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);

  const capability = capabilityOf(marketplace);
  const conversationBacked = capability.feed === "conversations";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const path = conversationBacked
        ? `/api/conversations?marketplace=${marketplace}`
        : `/api/marketplace-messages?marketplace=${marketplace}`;
      try {
        const response = await fetch(path);
        if (!response.ok) throw new Error("request failed");
        const data: unknown = await response.json();
        if (cancelled) return;
        if (conversationBacked) {
          setInbox((data as { conversations: InboxItem[] }).conversations);
        } else {
          setFeed(data as UnresolvedFeed);
        }
      } catch {
        if (cancelled) return;
        if (conversationBacked) setInboxError("Unable to load the inbox.");
        else setFeedError("Unable to load messages.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [marketplace, conversationBacked]);

  const switchMarketplace = useCallback((next: Marketplace) => {
    setMarketplace(next);
    // Never carry data or a selection across marketplaces. Cleared here in the
    // event handler rather than in an effect, so no stale marketplace's
    // messages can be on screen even for a frame.
    setInbox(null);
    setInboxError(null);
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setFeed(null);
    setFeedError(null);
  }, []);

  /**
   * Selecting an ungrouped message needs no request: the feed already holds
   * every message, and there is no thread to expand it into.
   */
  const selectMessage = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetail(null);
      setDetailError(null);
      setLoadingDetail(true);
      try {
        const response = await fetch(`/api/conversations/${id}?marketplace=${marketplace}`);
        if (response.status === 404) {
          setDetailError("This conversation is not available in this marketplace.");
          return;
        }
        if (!response.ok) throw new Error("request failed");
        setDetail((await response.json()) as ConversationDetail);
      } catch {
        setDetailError("Unable to load this conversation.");
      } finally {
        setLoadingDetail(false);
      }
    },
    [marketplace],
  );

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b border-black/10 pt-3 dark:border-white/15">
        <div className="flex items-baseline gap-3 px-5">
          <h1 className="text-base font-semibold">CST Unified Message System</h1>
          <span className="text-xs opacity-60">Review workspace — read only</span>
        </div>
        <MarketplaceTabs selected={marketplace} onSelect={switchMarketplace} />
      </header>

      {conversationBacked ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_300px]">
          <aside className="min-h-0 overflow-y-auto border-r border-black/10 dark:border-white/15">
            <InboxList
              items={inbox}
              error={inboxError}
              selectedId={selectedId}
              onSelect={(id) => void select(id)}
              capability={capability}
            />
          </aside>

          <main className="min-h-0">
            <ConversationView
              detail={detail}
              error={detailError}
              loading={loadingDetail}
              capability={capability}
            />
          </main>

          <aside className="hidden min-h-0 overflow-y-auto border-l border-black/10 xl:block dark:border-white/15">
            <ContextPanel
              conversation={detail?.conversation ?? null}
              capability={capability}
            />
          </aside>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-r border-black/10 dark:border-white/15">
            <UnresolvedMessageList
              feed={feed}
              error={feedError}
              selectedId={selectedId}
              onSelect={selectMessage}
              capability={capability}
            />
          </aside>

          <main className="min-h-0">
            <UnresolvedMessageView
              message={feed?.messages.find((m) => m.id === selectedId) ?? null}
              capability={capability}
            />
          </main>
        </div>
      )}
    </div>
  );
}
