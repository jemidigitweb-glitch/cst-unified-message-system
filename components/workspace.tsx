"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  ConversationDetail,
  InboxItem,
  NoRuleConversationItem,
  ReadState,
} from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";
import type { UnresolvedFeed } from "@/lib/domain/unresolved-messages";

import { ContextPanel } from "./context-panel";
import { DraftEvidencePanel } from "./draft-evidence-panel";
import { ConversationView } from "./conversation-view";
import { InboxList } from "./inbox-list";
import { MarketplaceTabs } from "./marketplace-tabs";
import { NoRuleList } from "./no-rule-list";
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
  /**
   * Read/Unread sub-tab, local to whichever marketplace tab is on screen.
   *
   * Reset on every marketplace switch alongside the rest of the per-marketplace
   * state below, so eBay's filter choice never leaks into Amazon's view.
   * Starts on "unread" — the customer messages nobody has replied to yet are
   * the ones worth triaging first.
   */
  const [readFilter, setReadFilter] = useState<ReadState>("unread");
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
  /**
   * This marketplace's No Rule conversations — every one currently recorded
   * as a stored rule-analysis finding, read back exactly as
   * `lib/sync/rule-analysis-writer.ts` stored it. Loaded alongside the inbox
   * and the unresolved feed, not only when the tab is opened, so switching to
   * it never shows a stale list from a marketplace that no longer matches.
   */
  const [noRule, setNoRule] = useState<NoRuleConversationItem[] | null>(null);
  const [noRuleError, setNoRuleError] = useState<string | null>(null);
  /**
   * Which top-level view is on screen.
   *
   * "status" replaces the inbox entirely (global usage figures, not scoped to
   * a marketplace). "no_rule" keeps the same list-left/detail-right layout as
   * "inbox" and only swaps which list feeds the left column — selecting a
   * conversation from either one opens the same detail pane the same way.
   */
  const [view, setView] = useState<"inbox" | "status" | "no_rule">("inbox");
  /**
   * Bumped when a draft is generated.
   *
   * Part of the evidence panel's `key`, so a successful generation remounts it
   * and it re-reads its own endpoint. The usage figures and the rule list both
   * describe the revision that just landed, and a reviewer should never have to
   * reload the page to see what the draft in front of them cost.
   *
   * A counter rather than a prop carrying the payload: the panel already owns
   * that request and knows how to render every one of its states, and threading
   * a second copy of the same data through three components would give the two
   * paths room to disagree.
   */
  const [draftGeneration, setDraftGeneration] = useState(0);

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

    void (async () => {
      try {
        const response = await fetch(`/api/conversations/no-rule?marketplace=${marketplace}`);
        if (!response.ok) throw new Error("request failed");
        const data = (await response.json()) as { conversations: NoRuleConversationItem[] };
        if (!cancelled) setNoRule(data.conversations);
      } catch {
        if (!cancelled) setNoRuleError("Unable to load No Rule conversations.");
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
    setReadFilter("unread");
    setSelectedId(null);
    setSelectedKind(null);
    setDetail(null);
    setDetailError(null);
    setFeed(null);
    setFeedError(null);
    setNoRule(null);
    setNoRuleError(null);
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
          {/* min-w-0 lets this shrink below the tab bar's natural width on a
              narrow screen, so MarketplaceTabs' own overflow-x-auto scrolls
              the tabs horizontally instead of forcing the whole header wider
              than the viewport. */}
          <div className={`min-w-0 flex-1 ${view === "status" ? "opacity-45" : ""}`}>
            <MarketplaceTabs
              selected={marketplace}
              onSelect={(next) => {
                setView("inbox");
                switchMarketplace(next);
              }}
            />
          </div>
          <div className="flex shrink-0 gap-1">
            {/*
              * Marketplace-scoped, unlike Status: this reads the currently
              * selected marketplace tab's No Rule conversations, so switching
              * marketplace tabs (which already resets `view` to "inbox")
              * always lands back on this same button to reopen it for the
              * new tab rather than silently showing a stale marketplace's list.
              */}
            <button
              type="button"
              role="tab"
              aria-selected={view === "no_rule"}
              onClick={() => setView(view === "no_rule" ? "inbox" : "no_rule")}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                view === "no_rule"
                  ? "border-emerald-600 font-medium dark:border-emerald-400"
                  : "border-transparent opacity-70 hover:border-black/20 hover:opacity-100 dark:hover:border-white/25"
              }`}
            >
              No Rule
            </button>
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
      /*
       * RESPONSIVE, IN THREE TIERS -- xl (>=1280px) is the untouched original:
       * three columns, one implicit row, no outer scrolling. Below that, the
       * context/AI-usage/rules column stops being a side-by-side column (there
       * is no room for it) and instead becomes its own row underneath the
       * conversation -- still every field, still reachable, just reflowed
       * rather than hidden. `xl:grid-rows-none` and `xl:overflow-visible`
       * revert both of those additions back to exactly the original single-row
       * behaviour at desktop width, so nothing here changes what xl+ already
       * looked like.
       *
       * The first row (inbox list beside the conversation) is `minmax(0,1fr)`
       * at every tier below xl too, so it keeps filling the available height
       * and scrolling internally exactly as it does today -- only the extra
       * row for the stacked sidebar content is new, and it is capped with its
       * own max-height + overflow-y-auto so it can never squeeze that first
       * row down to reach it.
       */
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,45dvh)_minmax(0,1fr)_auto] overflow-y-auto md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_300px] xl:grid-rows-none xl:overflow-visible">
        <aside className="flex min-h-0 flex-col overflow-y-auto border-r border-black/10 dark:border-white/15">
          {view === "no_rule" ? (
            /*
             * The No Rule tab replaces the inbox list with a differently
             * filtered one, nothing more: same row shape, same `onSelect`,
             * same detail pane below. The unresolved-message feed does not
             * belong here — those rows have no conversation, so they cannot
             * have a rule-analysis finding either.
             */
            <NoRuleList
              items={noRule}
              error={noRuleError}
              selectedId={selectedKind === "conversation" ? selectedId : null}
              onSelect={(id) => void select(id)}
              capability={capability}
            />
          ) : (
            <>
              <InboxList
                items={inbox}
                error={inboxError}
                selectedId={selectedKind === "conversation" ? selectedId : null}
                onSelect={(id) => void select(id)}
                capability={capability}
                readFilter={readFilter}
                onReadFilterChange={setReadFilter}
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
            </>
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
              onDraftGenerated={() => setDraftGeneration((n) => n + 1)}
            />
          )}
        </main>

        {/*
          * The context panel describes a conversation, so it is not shown for an
          * unresolved message: there is no thread and no verified direction to
          * describe, and an empty panel would read as "no context" rather than
          * "not applicable".
          *
          * ONE ELEMENT, REPOSITIONED BY CSS -- below xl it spans the full row
          * as a capped, independently-scrollable strip under the conversation
          * (see the grid comment above); at xl+ `xl:col-auto` returns it to
          * being the third column exactly as before. A second mounted copy
          * would double the DraftEvidencePanel's own fetch on every open, so
          * this stays a single instance that CSS moves rather than two that
          * agree by convention.
          */}
        <aside className="col-span-full max-h-[45dvh] min-h-0 overflow-y-auto border-t border-black/10 xl:col-auto xl:max-h-none xl:border-t-0 xl:border-l dark:border-white/15">
          {selectedKind !== "message" && (
            <>
              <ContextPanel conversation={detail?.conversation ?? null} capability={capability} />
              {/* After the context, because both answer "can I trust this
                  draft?" -- one from the conversation's side, one from the
                  model's. Renders nothing when there is no draft. */}
              {detail !== null && (
                <DraftEvidencePanel
                  key={`${detail.conversation.id}:${draftGeneration}`}
                  conversationId={detail.conversation.id}
                  // The loaded thread. The panel needs it for the no-rule
                  // export, and using it avoids a second request for a
                  // conversation already on screen.
                  detail={detail}
                />
              )}
            </>
          )}
        </aside>
      </div>
      )}
    </div>
  );
}