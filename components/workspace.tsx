"use client";

import { useCallback, useEffect, useState } from "react";

import type { ConversationDetail, InboxItem } from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";
import type { UnresolvedFeed } from "@/lib/domain/unresolved-messages";

import { ContextPanel } from "./context-panel";
import { ConversationExportButton } from "./conversation-export-button";
import { DraftEvidencePanel } from "./draft-evidence-panel";
import { ConversationView } from "./conversation-view";
import { InboxList } from "./inbox-list";
import { MarketplaceTabs } from "./marketplace-tabs";
import { UnresolvedMessageList } from "./unresolved-message-list";
import { UnresolvedMessageView } from "./unresolved-message-view";
import { UsagePanel } from "./usage-panel";

/**
 * CST workspace: marketplace tabs above a shared layout.
 *
 * One workspace serves every marketplace, and every marketplace is active.
 * Every tab gets the same list-left / detail-right arrangement, so switching
 * marketplaces changes the data rather than the interface.
 *
 * NOTHING INGESTED IS HIDDEN. Each tab shows two lists:
 *
 *   conversations   threads with a verified direction, whatever their inbox
 *                   placement. Filtered and outbound-only groups are listed
 *                   too, labelled rather than withheld.
 *   other messages  rows the source could not place — direction undecidable,
 *                   so no thread. They get no context panel, because there is
 *                   no conversation to describe.
 *
 * This replaced a design where the two were alternatives chosen per
 * marketplace. Since every marketplace is conversation-backed, the second list
 * was never requested and around 4,200 stored messages were reachable by
 * nothing at all.
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
  /**
   * Which list the selection came from.
   *
   * Both lists are on screen now, and their ids come from different tables —
   * conversation 239 and unresolved message 239 are unrelated rows. Without
   * this the detail pane would guess, and eventually guess wrong.
   */
  const [selectedKind, setSelectedKind] = useState<"conversation" | "message" | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [feed, setFeed] = useState<UnresolvedFeed | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  /** Which top-level view is on screen. "status" replaces the inbox entirely. */
  const [view, setView] = useState<"inbox" | "status">("inbox");

  const capability = capabilityOf(marketplace);

  /**
   * BOTH feeds, for every marketplace. Nothing stored is left unreachable.
   *
   * These used to be alternatives chosen by capability, and because every
   * marketplace is conversation-backed the second one was never requested.
   * 1,164 messages whose direction the source could not decide were stored and
   * shown by nothing — a real German order notification among them. A message
   * this application has ingested must be findable in it.
   *
   * They stay two lists rather than one merged one. A conversation is a thread
   * with a verified direction that can be replied to; an unresolved message is
   * a single row the source could not place. Merging them would present the
   * second as though it carried the guarantees of the first.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/conversations?marketplace=${marketplace}`);
        if (!response.ok) throw new Error("request failed");
        const data = (await response.json()) as { conversations: InboxItem[] };
        if (!cancelled) setInbox(data.conversations);
      } catch {
        if (!cancelled) setInboxError("Unable to load the inbox.");
      }
    })();

    void (async () => {
      try {
        const response = await fetch(`/api/marketplace-messages?marketplace=${marketplace}`);
        if (!response.ok) throw new Error("request failed");
        const data = (await response.json()) as UnresolvedFeed;
        if (!cancelled) setFeed(data);
      } catch {
        // A marketplace with no unresolved store is not an error worth a
        // banner; the section simply does not appear.
        if (!cancelled) setFeedError("Unable to load other messages.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [marketplace]);

  const switchMarketplace = useCallback((next: Marketplace) => {
    setMarketplace(next);
    // Never carry data or a selection across marketplaces. Cleared here in the
    // event handler rather than in an effect, so no stale marketplace's
    // messages can be on screen even for a frame.
    setInbox(null);
    setInboxError(null);
    setSelectedId(null);
    setSelectedKind(null);
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
    setSelectedKind("message");
    // An unresolved message has no thread to expand, so any conversation
    // detail still on screen belongs to a different selection entirely.
    setDetail(null);
    setDetailError(null);
  }, []);

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setSelectedKind("conversation");
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
        <div className="flex items-end justify-between gap-3 pr-5">
          <div className={view === "status" ? "opacity-45" : undefined}>
            <MarketplaceTabs
              selected={marketplace}
              onSelect={(next) => {
                setView("inbox");
                switchMarketplace(next);
              }}
            />
          </div>
          <button
            type="button"
            role="tab"
            aria-selected={view === "status"}
            onClick={() => setView(view === "status" ? "inbox" : "status")}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              view === "status"
                ? "border-emerald-600 font-medium dark:border-emerald-400"
                : "border-transparent opacity-70 hover:border-black/20 hover:opacity-100 dark:hover:border-white/25"
            }`}
          >
            Status
          </button>
        </div>
      </header>

      {/*
        * ONE LAYOUT, BOTH LISTS. There is no longer a conversation-backed
        * branch and an unresolved branch: every marketplace can have both, and
        * choosing one meant the other was invisible.
        *
        * The left column stacks the conversations above the messages the source
        * could not place. The detail pane shows whichever kind is selected.
        */}
      {view === "status" ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <UsagePanel />
        </main>
      ) : (
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_300px]">
        <aside className="flex min-h-0 flex-col overflow-y-auto border-r border-black/10 dark:border-white/15">
          <InboxList
            items={inbox}
            error={inboxError}
            selectedId={selectedKind === "conversation" ? selectedId : null}
            onSelect={(id) => void select(id)}
            capability={capability}
          />

          {/*
            * Rendered only when there is something in it. An empty "Other
            * messages" heading on every marketplace that has none would be
            * noise, and would imply something is being withheld.
            */}
          {/*
            * Continuous with the conversations above, not a separate section.
            *
            * These were briefly headed "Other messages" with an explanation of
            * why the source could not place them. That reads as a holding pen:
            * the messages are real, they were received, and a heading saying so
            * invites them to be skipped. What the source could not establish is
            * a property of the message, not a reason to demote it, and the
            * detail pane already says which guarantees are missing.
            */}
          {(feed?.messages.length ?? 0) > 0 && (
            <UnresolvedMessageList
              feed={feed}
              error={feedError}
              selectedId={selectedKind === "message" ? selectedId : null}
              onSelect={selectMessage}
              capability={capability}
            />
          )}
        </aside>

        <main className="min-h-0">
          {selectedKind === "message" ? (
            <UnresolvedMessageView
              message={feed?.messages.find((m) => m.id === selectedId) ?? null}
              capability={capability}
            />
          ) : (
            <ConversationView
              detail={detail}
              error={detailError}
              loading={loadingDetail}
              capability={capability}
            />
          )}
        </main>

        {/*
          * The context panel describes a conversation, so it is not shown for an
          * unresolved message: there is no thread and no verified direction to
          * describe, and an empty panel would read as "no context" rather than
          * "not applicable".
          */}
        <aside className="hidden min-h-0 overflow-y-auto border-l border-black/10 xl:block dark:border-white/15">
          {selectedKind !== "message" && (
            <>
              <ContextPanel conversation={detail?.conversation ?? null} capability={capability} />
              {/* After the context, because both answer "can I trust this
                  draft?" -- one from the conversation's side, one from the
                  model's. Renders nothing when there is no draft. */}
              {detail !== null && (
                <>
                  <DraftEvidencePanel
                    key={detail.conversation.id}
                    conversationId={detail.conversation.id}
                  />
                  {/* Last, and OUTSIDE the evidence panel. The panel renders
                      nothing until a draft exists; the export must be there on
                      every conversation, drafted or not. It writes the thread
                      already loaded here — no second request. */}
                  <ConversationExportButton detail={detail} />
                </>
              )}
            </>
          )}
        </aside>
      </div>
      )}
    </div>
  );
}