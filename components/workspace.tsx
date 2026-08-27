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
import { HamburgerIcon } from "./icons";
import { ALL_CATEGORIES, type CategoryFilter, InboxList } from "./inbox-list";
import { MarketplaceTabs } from "./marketplace-tabs";
import { NoRuleList } from "./no-rule-list";
import { UnresolvedMessageList } from "./unresolved-message-list";
import { UnresolvedMessageView } from "./unresolved-message-view";
import { UsagePanel } from "./usage-panel";

/**
 * Below this width, a newly selected conversation opens with the details
 * panel closed rather than open — Tailwind's `sm`, the usual line between
 * "phone" and "small laptop / tablet" widths. Both are already below `xl`
 * and share the same drawer/column mechanics; only this one default differs.
 */
const MOBILE_DETAILS_BREAKPOINT = 640;

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
   * Whether an older page of this marketplace's inbox exists past what is
   * currently loaded, and whether one is being fetched right now. Read
   * straight from the API's own `hasMore` (a one-extra-row overfetch on the
   * server), never guessed from a fixed page size — a marketplace busy
   * enough to fill several pages inside one day must not read as "that's
   * everything" just because the count matched a round number.
   */
  const [inboxHasMore, setInboxHasMore] = useState(false);
  const [inboxLoadingMore, setInboxLoadingMore] = useState(false);
  /**
   * Read/Unread sub-tab, local to whichever marketplace tab is on screen.
   *
   * Reset on every marketplace switch alongside the rest of the per-marketplace
   * state below, so eBay's filter choice never leaks into Amazon's view.
   * Starts on "unread" — the customer messages nobody has replied to yet are
   * the ones worth triaging first.
   */
  const [readFilter, setReadFilter] = useState<ReadState>("unread");
  /** Client-side over the same loaded `items` as `readFilter` — see InboxList. */
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(ALL_CATEGORIES);
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

  /**
   * The order a reviewer picked when a conversation matched several.
   *
   * Held here because the two panels that need it are siblings: the context
   * panel in the aside sets it, the draft panel inside the conversation view
   * sends it. Deliberately not persisted -- there is no save step and no
   * confirmation, so the choice lasts as long as the reviewer is looking at
   * the conversation and grounds the generations they run while there.
   *
   * Cleared whenever the selected conversation changes, so a choice made on
   * one conversation can never be sent with another's draft request.
   */
  const [selectedOrderNumber, setSelectedOrderNumber] = useState<string | null>(null);
  useEffect(() => {
    setSelectedOrderNumber(null);
  }, [selectedId]);
  /**
   * Whether the marketplace-and-conversations drawer is open, below desktop
   * width (anything under `xl`, 1280px — a small laptop as much as a phone).
   * Ignored at `xl:` and up, where the list is always visible as the first
   * column exactly as before — this only controls the hamburger-driven
   * drawer when there isn't room for it beside the conversation.
   *
   * "list" is the starting value rather than null: the first thing to see is
   * still the list of conversations, exactly as it already is at desktop
   * width. Selecting a conversation switches this to null so the chat takes
   * over the screen instead of leaving the list on top of it.
   */
  const [mobilePanel, setMobilePanel] = useState<"list" | null>("list");
  /**
   * Whether the Context / AI Usage / CST Rules Used panel is showing —
   * toggleable at every width, including a full desktop, not only below
   * `xl`. From `sm` up (a tablet, a small laptop, or a wide desktop screen)
   * it is a genuine grid column that grows and shrinks the layout itself,
   * never a `fixed`/z-index layer; only below `sm` (a phone) does opening it
   * mean an overlay, because there is no honest way to give it its own
   * column beside a ~360px-wide conversation there.
   *
   * Defaults to open, and `select()` below sets it back to the width-aware
   * default on every new conversation — see `MOBILE_DETAILS_BREAKPOINT`.
   */
  const [detailsOpen, setDetailsOpen] = useState(true);
  /**
   * What actually gets rendered, as opposed to `detailsOpen`'s raw intent.
   *
   * Below `sm` the panel is a full-screen overlay, so rendering it whenever
   * `detailsOpen` happens to be `true` — including with nothing selected, or
   * after switching to No Rule/AI Usage while it was left open — would cover
   * the whole screen with an empty "No conversation selected." pane and
   * nothing reachable behind it. This is the value everything below actually
   * renders from; `detailsOpen` stays the toggle's own remembered state.
   */
  const detailsVisible = detailsOpen && selectedKind === "conversation" && detail !== null;

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
        const data = (await response.json()) as {
          conversations: InboxItem[];
          hasMore: boolean;
        };
        if (!cancelled) {
          setInbox(data.conversations);
          setInboxHasMore(data.hasMore);
        }
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
    setInboxHasMore(false);
    setInboxLoadingMore(false);
    setReadFilter("unread");
    setSelectedId(null);
    setSelectedKind(null);
    setDetail(null);
    setDetailError(null);
    setFeed(null);
    setFeedError(null);
    setNoRule(null);
    setNoRuleError(null);
    // A new marketplace always opens on its list, on a phone exactly as it
    // already does on a wider screen.
    setMobilePanel("list");
  }, []);

  /**
   * Fetches the next page and appends it to what is already loaded.
   *
   * `offset` is the count already on screen, not a stored cursor — the
   * inbox is read-only and newest-first, so a conversation cannot be
   * inserted ahead of what is already loaded between one page and the next.
   * Guarded on `inboxLoadingMore` so a second tap while the first request is
   * still in flight cannot fetch (and append) the same page twice.
   */
  const loadMoreInbox = useCallback(async () => {
    if (inboxLoadingMore || inbox === null) return;
    setInboxLoadingMore(true);
    try {
      const response = await fetch(
        `/api/conversations?marketplace=${marketplace}&offset=${inbox.length}`,
      );
      if (!response.ok) throw new Error("request failed");
      const data = (await response.json()) as { conversations: InboxItem[]; hasMore: boolean };
      setInbox((current) => [...(current ?? []), ...data.conversations]);
      setInboxHasMore(data.hasMore);
    } catch {
      // Leaves `inboxHasMore` as it was, so the button stays and a reviewer
      // can simply try again rather than losing the option to load more.
      setInboxError("Unable to load more conversations.");
    } finally {
      setInboxLoadingMore(false);
    }
  }, [inbox, inboxLoadingMore, marketplace]);

  /**
   * Handles a marketplace tap from either `MarketplaceTabs` instance — the
   * desktop tab strip and the drawer copy below `xl` both call this, so the
   * two can never disagree about what picking a marketplace does.
   */
  const selectMarketplace = useCallback(
    (next: Marketplace) => {
      setView("inbox");
      // Re-clicking the marketplace you're already on (the natural way back
      // from its No Rule or Status view) must not run switchMarketplace:
      // setMarketplace(next) with the SAME value is a no-op in React, so the
      // [marketplace] effect would never re-fire to refetch -- but the rest
      // of switchMarketplace still clears inbox/feed/noRule to null
      // unconditionally, leaving the screen stuck on "Loading..." with
      // nothing left to trigger a reload short of a full page refresh.
      if (next !== marketplace) switchMarketplace(next);
      else setMobilePanel("list");
    },
    [marketplace, switchMarketplace],
  );

  /**
   * Clears whichever conversation or message is open, without touching the
   * loaded lists themselves.
   *
   * Used when the LIST feeding the left column changes but the marketplace
   * does not -- entering or leaving the No Rule view. Without this, a
   * conversation opened from the ordinary inbox stayed on screen after
   * switching to No Rule, showing a detail pane for a conversation that
   * is not even in the list now on screen.
   */
  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setSelectedKind(null);
    setDetail(null);
    setDetailError(null);
    // The list just changed under it (entering/leaving No Rule), so a phone
    // should show that list rather than an empty chat pane.
    setMobilePanel("list");
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
    // On a phone, picking something from the list moves on to reading it —
    // the same "list, then detail" motion a wider screen shows side by side.
    setMobilePanel(null);
  }, []);

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setSelectedKind("conversation");
      setDetail(null);
      setDetailError(null);
      setLoadingDetail(true);
      setMobilePanel(null);
      // Open by default everywhere except a phone-width screen: a small
      // laptop has the room to show the panel a reviewer is meant to check
      // before trusting a draft without an extra tap, but on a phone that
      // panel competing with the conversation for a ~360px-wide screen is
      // exactly the squeeze the drawer/column split exists to avoid — there
      // it opens only when asked for.
      setDetailsOpen(window.innerWidth >= MOBILE_DETAILS_BREAKPOINT);
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
        <div className="flex flex-col gap-0.5 px-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="text-base font-semibold">CST Unified Message System</h1>
            <span className="text-xs opacity-60">Review workspace — read only</span>
          </div>
          {/* One plain sentence for a reviewer who has never opened this
              screen before — where to look first, before anything else on
              the page asks for a decision. */}
          <p className="text-xs opacity-70">
            Pick a marketplace below, then a conversation that needs a reply.
          </p>
        </div>
        <div className="flex items-end justify-between gap-3 pr-5">
          {/* min-w-0 lets this shrink below the tab bar's natural width on a
              narrow screen, so MarketplaceTabs' own overflow-x-auto scrolls
              the tabs horizontally instead of forcing the whole header wider
              than the viewport. Hidden below `xl`, where the tab strip moves
              into the hamburger-triggered drawer instead — there is no room
              for a whole tab row beside the No Rule / AI Usage buttons on a
              small screen, and a horizontally-scrolling strip there was hard
              to use with a thumb. */}
          <div className={`hidden min-w-0 flex-1 xl:block ${view === "status" ? "opacity-45" : ""}`}>
            <MarketplaceTabs selected={marketplace} onSelect={selectMarketplace} />
          </div>
          {/* Opens the marketplace-and-conversations drawer from the left.
              Exists only below `xl`, replacing the tab strip above. Plain,
              not a pill: it sits directly beside the tab strip it replaces,
              and a bordered button there read as a second, competing control
              rather than a stand-in for the row behind it. */}
          <button
            type="button"
            onClick={() => setMobilePanel(mobilePanel === "list" ? null : "list")}
            aria-label="Open marketplaces and conversations"
            aria-expanded={mobilePanel === "list"}
            className="flex shrink-0 items-center gap-2 px-1 py-1.5 text-sm xl:hidden"
          >
            <HamburgerIcon />
            {capabilityOf(marketplace).label}
          </button>
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
              title="Conversations no CST rule could answer yet — export them so the team can write one."
              onClick={() => {
                setView(view === "no_rule" ? "inbox" : "no_rule");
                // Either direction: entering shows a different list than the
                // one the open conversation came from, and leaving would
                // otherwise show a No-Rule-selected conversation under the
                // ordinary inbox list it is not part of.
                clearSelection();
              }}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
                view === "no_rule"
                  ? "border-emerald-600 font-medium dark:border-emerald-400"
                  : "border-transparent opacity-70 hover:border-black/20 hover:opacity-100 dark:hover:border-white/25"
              }`}
            >
              No Rule
            </button>
            {/*
             * Renamed from "Status" — that label promised a general workflow
             * status view, and this has only ever opened AI token/cost
             * accounting (UsagePanel). A first-time reviewer clicking "Status"
             * expecting to see what needs attention would land somewhere
             * unrelated; the label now says what is actually behind it.
             */}
            <button
              type="button"
              role="tab"
              aria-selected={view === "status"}
              title="How much the AI draft generator has cost in tokens, not conversation status."
              onClick={() => setView(view === "status" ? "inbox" : "status")}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
                view === "status"
                  ? "border-emerald-600 font-medium dark:border-emerald-400"
                  : "border-transparent opacity-70 hover:border-black/20 hover:opacity-100 dark:hover:border-white/25"
              }`}
            >
              AI Usage
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
       * LIST vs. DETAILS: two different amounts of "always".
       *
       *   list      always a permanent first column from `xl` up (the
       *             untouched original desktop layout); below `xl` it is a
       *             hamburger-triggered drawer sliding in from the left,
       *             with a backdrop. It competes for the same space the
       *             conversation needs and is naturally a "go pick
       *             something, then come back" action.
       *   details   toggled everywhere, including desktop and wider —
       *             `detailsOpen`/`detailsVisible` decide whether it is on
       *             screen at every width, not only below `xl`. Below `sm`
       *             (a phone) that means a `fixed`/z-index layer over the
       *             conversation with its own backdrop, because there is no
       *             honest way to give a 280–300px column its own space
       *             beside a ~360px-wide conversation. From `sm` up —
       *             through a tablet, a small laptop, and a full desktop —
       *             it is instead a genuine grid column that grows and
       *             shrinks the grid itself, sharing the row rather than
       *             covering it. See `MOBILE_DETAILS_BREAKPOINT` and
       *             `select()` for the default-open/closed split at the
       *             phone width.
       */
      <>
      {/* Dims and closes the list drawer. Tapping the page outside it is the
          expected way to dismiss it; never appears at `xl:`, where the drawer
          does not exist. */}
      {mobilePanel !== null && (
        <div
          onClick={() => setMobilePanel(null)}
          aria-hidden
          className="fixed inset-0 z-30 bg-black/40 xl:hidden"
        />
      )}
      {/* Dims and closes the details panel, but only on a phone (below `sm`)
          where it is the same kind of overlay as the list drawer above. From
          `sm` up — including desktop — it is a normal grid column and needs
          no backdrop. */}
      {detailsVisible && (
        <div
          onClick={() => setDetailsOpen(false)}
          aria-hidden
          className="fixed inset-0 z-30 bg-black/40 sm:hidden"
        />
      )}
      <div
        className={`grid min-h-0 flex-1 grid-rows-1 overflow-y-auto grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] xl:grid-rows-none xl:overflow-visible ${
          detailsVisible ? "sm:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[320px_minmax(0,1fr)_300px]" : ""
        }`}
      >
        <aside
          className={`fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-xs min-h-0 flex-col overflow-y-auto border-r border-black/10 bg-[var(--background)] transition-transform duration-200 xl:static xl:inset-auto xl:z-auto xl:w-auto xl:max-w-none xl:translate-x-0 xl:bg-transparent dark:border-white/15 ${
            mobilePanel === "list" ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {/* Closes back to the chat. Exists only below `xl`, where the list
              is a drawer rather than a permanent column. */}
          <div className="flex shrink-0 items-center justify-between border-b border-black/10 px-4 py-2 xl:hidden dark:border-white/15">
            <span className="text-xs font-medium opacity-70">
              {view === "no_rule" ? "No Rule list" : "Conversations"}
            </span>
            <button
              type="button"
              onClick={() => setMobilePanel(null)}
              className="rounded-full border border-black/15 px-2.5 py-1 text-xs dark:border-white/20"
            >
              Close
            </button>
          </div>
          {/* The same tab strip the header shows at `xl:` — moved here below
              it, not duplicated content, just the other place it reaches the
              screen from. */}
          <div className="shrink-0 border-b border-black/10 xl:hidden dark:border-white/15">
            <MarketplaceTabs selected={marketplace} onSelect={selectMarketplace} />
          </div>
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
                categoryFilter={categoryFilter}
                onCategoryFilterChange={setCategoryFilter}
                hasMore={inboxHasMore}
                loadingMore={inboxLoadingMore}
                onLoadMore={() => void loadMoreInbox()}
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

        {/* min-w-0: a grid item's default min-width is `auto`, which lets
            wide content (a long message bubble, the draft textarea) push
            this column past its track instead of wrapping inside it — never
            visible before the details panel could sit beside a narrow
            conversation column below `xl`. */}
        <main className="min-h-0 min-w-0">
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
              onWorkflowStateChange={(conversationId, state) =>
                setInbox((current) =>
                  current?.map((item) =>
                    item.id === conversationId ? { ...item, workflowState: state } : item,
                  ) ?? current,
                )
              }
              detailsOpen={detailsVisible}
              onToggleDetails={() => setDetailsOpen((open) => !open)}
              /* The order a reviewer picked in the context panel. It has to
                 travel down this branch too: the panel that SETS it is in the
                 aside, and the panel that SENDS it is inside this view. */
              selectedOrderNumber={selectedOrderNumber}
            />
          )}
        </main>

        {/*
          * The context panel describes a conversation, so it is not shown for an
          * unresolved message: there is no thread and no verified direction to
          * describe, and an empty panel would read as "no context" rather than
          * "not applicable".
          *
          * ONE ELEMENT, REPOSITIONED BY CSS -- below `sm` (a phone) it is a
          * `fixed`/z-index layer over the conversation, opened and closed by
          * `detailsOpen`; from `sm` up — including a full desktop —
          * `sm:static`/`sm:inset-auto` cancel that and it becomes a genuine
          * grid column instead, sharing the row rather than covering it (see
          * the grid's own className above, which only grows that column when
          * `detailsVisible`, at every width, not only below `xl`). Visibility
          * itself is `detailsVisible`, unconditionally, at every width — no
          * "always on at xl" case survives here on purpose. A second mounted
          * copy would double the DraftEvidencePanel's own fetch on every
          * open, so this stays a single instance that CSS moves rather than
          * two that agree by convention.
          */}
        <aside
          className={`min-h-0 overflow-y-auto border-l border-black/10 sm:static sm:inset-auto sm:z-auto sm:bg-transparent xl:col-auto dark:border-white/15 ${
            detailsVisible
              ? "fixed inset-0 z-40 bg-[var(--background)] sm:block"
              : "hidden"
          }`}
        >
          {/* Collapses the panel back down. Shown at every width the panel
              can be toggled at — which is all of them, including desktop. */}
          <div className="flex shrink-0 items-center justify-between border-b border-black/10 px-4 py-2 dark:border-white/15">
            <span className="text-xs font-medium opacity-70">Details</span>
            <button
              type="button"
              onClick={() => setDetailsOpen(false)}
              className="rounded-full border border-black/15 px-2.5 py-1 text-xs dark:border-white/20"
            >
              Close
            </button>
          </div>
          {selectedKind !== "message" && (
            <>
              <ContextPanel
                conversation={detail?.conversation ?? null}
                capability={capability}
                selectedOrderNumber={selectedOrderNumber}
                onSelectOrder={setSelectedOrderNumber}
              />
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
      </>
      )}
    </div>
  );
}