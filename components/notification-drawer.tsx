"use client";

import {
  type AwaitingResponseFeed,
  ORDER_CHANGE_NOTIFICATION_TITLE,
  conversationTitle,
  formatSourceTimestamp,
} from "@/lib/domain/inbox";
import type { Marketplace } from "@/lib/domain/marketplace";
import { capabilityOf } from "@/lib/domain/marketplace-capabilities";

import { PRIORITY_RIBBON_CLASS, priorityDescription } from "./priority-ribbon";

/**
 * How far the work has got — which is NOT how far the customer has got.
 *
 * Every row in this drawer is a customer still waiting: the feed retires a
 * conversation only when an outbound reply lands after their message. This
 * label says what exists on our side meanwhile, and it exists because the feed
 * used to answer that question by REMOVING the row — generating a draft made a
 * waiting customer disappear. Nothing here can take a row off the list.
 *
 * `reviewed` is named plainly rather than being treated as finished: it is this
 * system's terminal state and there is no transport after it, so a reviewed
 * conversation with no reply on the thread is still someone waiting.
 */
function draftStatus(item: {
  hasDraft: boolean;
  workflowState: string;
}): { label: string; title: string } | null {
  if (!item.hasDraft) return null;
  if (item.workflowState === "pending_review") {
    return { label: "Needs review", title: "A draft is written and waiting for a reviewer." };
  }
  if (item.workflowState === "reviewed") {
    return {
      label: "Reviewed · not sent",
      title:
        "The draft was reviewed here. No reply from us has appeared on the thread yet, so the customer is still waiting.",
    };
  }
  return { label: "Draft ready", title: "A draft exists for this conversation." };
}

/**
 * The notification drawer: order-change conversations nobody has answered,
 * across EVERY marketplace.
 *
 * GLOBAL BY CONSTRUCTION, NOT BY FILTERING. It is handed one list that already
 * spans marketplaces and renders it whole — there is no marketplace prop, no
 * grouping and nothing to narrow it by, so it cannot accidentally become
 * tab-scoped again. An Amazon customer waiting on an order change is waiting
 * whether or not the reviewer is looking at the eBay tab, and this is the one
 * list in the workspace that says so.
 *
 * EACH ROW READS ITS OWN CAPABILITY. `capabilityOf(item.marketplace)` decides
 * the business name to show and — through `conversationTitle` — whether the
 * stored reference is a real customer handle or a source reference that must
 * never be printed as a person. That has to be per row here, because two rows
 * side by side can come from sources with different guarantees.
 *
 * OBSERVES, DECIDES NOTHING. Every value was produced by a workflow this
 * component is not part of. It fetches nothing, classifies nothing, writes
 * nothing, and records no read, dismissed or acknowledged state.
 *
 * SELECTING A ROW USES THE EXISTING PATH. It hands back the conversation id AND
 * its marketplace, and the workspace does the rest — switching tab where the
 * conversation belongs to another one, then calling the SAME `select()` the
 * inbox list calls. The conversation view, context panel and draft panel are
 * reached exactly as they always were and know nothing about this.
 *
 * AN OVERLAY, NOT A COLUMN. `fixed` over the workspace with its own backdrop at
 * every width — deliberately unlike the Details panel, which earns a real grid
 * column because it is read ALONGSIDE a conversation. This is read INSTEAD of
 * one: a reviewer opens it, picks something and it closes.
 *
 * Dismissed by the backdrop or the Close button, the same two ways the list
 * drawer and the details panel are already dismissed.
 */
export function NotificationDrawer({
  feed,
  error,
  open,
  onClose,
  onSelect,
}: {
  feed: AwaitingResponseFeed | null;
  error: string | null;
  open: boolean;
  onClose: () => void;
  /**
   * Handed the conversation id and the marketplace it belongs to. The
   * marketplace is not optional and not inferred: the workspace has to know
   * which tab the conversation lives in before it can open it.
   */
  onSelect: (id: string, marketplace: Marketplace) => void;
}) {
  if (!open) return null;

  const items = feed?.conversations ?? [];

  return (
    <>
      {/* Dims and closes. Tapping outside a drawer is how the other two in
          this workspace are already dismissed. */}
      <div onClick={onClose} aria-hidden className="fixed inset-0 z-40 bg-black/40" />
      <div
        role="dialog"
        aria-label={ORDER_CHANGE_NOTIFICATION_TITLE}
        className="fixed inset-y-0 right-0 z-50 flex w-[90vw] max-w-sm flex-col overflow-y-auto border-l border-black/10 bg-[var(--background)] shadow-xl dark:border-white/15"
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-black/10 px-4 py-3 dark:border-white/15">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold">{ORDER_CHANGE_NOTIFICATION_TITLE}</h2>
            {/* What being on this list actually means, in the reviewer's own
                terms rather than in the query's — and that it is not scoped to
                the tab behind the drawer, which is the one thing a reviewer
                would otherwise assume. */}
            <p className="text-[11px] opacity-70">
              All marketplaces · no reply sent yet
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full border border-black/15 px-2.5 py-1 text-xs dark:border-white/20"
          >
            Close
          </button>
        </div>

        {error !== null ? (
          <p className="p-5 text-sm opacity-70">{error}</p>
        ) : feed === null ? (
          <p className="p-5 text-sm opacity-60">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-5 text-sm opacity-60">
            Nothing waiting for a reply on any marketplace.
          </p>
        ) : (
          <ul>
            {items.map((item) => {
              // Per row, not per drawer: two rows side by side can come from
              // sources with different guarantees about identity and direction.
              const capability = capabilityOf(item.marketplace);
              const stamp = formatSourceTimestamp(item.latestCustomerMessageAt);
              const draft = draftStatus(item);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id, item.marketplace)}
                    data-marketplace={item.marketplace}
                    className="flex w-full flex-col gap-1 border-b border-black/5 px-4 py-3 text-left transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.05]"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      {/* Never the bare stored reference — see conversationTitle,
                          which decides from THIS row's capability whether the
                          stored value is a real customer handle or a source
                          reference. */}
                      <span className="truncate text-sm font-medium">
                        {conversationTitle(item, capability)}
                      </span>
                      {/* The CUSTOMER's newest message, which is what makes this
                          timestamp answer "how long have they been waiting". */}
                      <span className="shrink-0 text-[11px] tabular-nums opacity-70">
                        {stamp.date} {stamp.time}
                      </span>
                    </span>

                    {/* Already truncated server-side; an undecodable body renders
                        as the shared "content unavailable" copy rather than as an
                        empty line. */}
                    <span className="line-clamp-2 text-xs opacity-70">
                      {item.latestCustomerMessagePreview}
                    </span>

                    <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {/*
                        * WHICH MARKETPLACE, ON EVERY ROW.
                        *
                        * On the per-tab lists this chip is near-redundant — every
                        * row came from the tab you are looking at. Here it is the
                        * point: a reviewer on eBay seeing an Amazon notification
                        * needs to know that before they click, because clicking
                        * moves them to another tab.
                        */}
                      <span className="rounded bg-black/[0.07] px-1.5 py-0.5 font-medium opacity-80 dark:bg-white/[0.12]">
                        {capability.label}
                      </span>
                      {/*
                        * HOW FAR THE WORK HAS GOT, BESIDE THE MARKETPLACE.
                        *
                        * The row is here because the customer has had no reply.
                        * This says whether anything is written yet, so a
                        * reviewer can tell "nobody has touched this" from
                        * "there is a draft waiting for you" WITHOUT either one
                        * being hidden from the list. Absent where no draft
                        * exists: a chip reading "no draft" would be noise on
                        * what is already the default.
                        */}
                      {draft !== null && (
                        <span
                          title={draft.title}
                          className="rounded bg-black/[0.07] px-1.5 py-0.5 font-medium opacity-80 dark:bg-white/[0.12]"
                        >
                          {draft.label}
                        </span>
                      )}
                      {/*
                        * THE SAME COLOUR SCALE THE INBOX RIBBON USES, read from
                        * the same exported table so the two can never disagree
                        * about what red means. A dot rather than the ribbon
                        * shape itself: the ribbon hangs off a row's right edge
                        * and that edge here belongs to the timestamp.
                        *
                        * Rendered only where a priority was established. Null
                        * means there was no readable customer text to rank, and
                        * a grey dot claiming "no priority" would be a third
                        * level this scale does not have.
                        */}
                      {item.priority !== null && (
                        <span
                          role="img"
                          aria-label={priorityDescription(item.priority)}
                          title={priorityDescription(item.priority)}
                          className="flex items-center gap-1 opacity-80"
                        >
                          <span
                            aria-hidden
                            className={`inline-block h-2 w-2 rounded-full ${PRIORITY_RIBBON_CLASS[item.priority]}`}
                          />
                          {priorityDescription(item.priority)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/*
         * NO SILENT CAP. The case area is read from the customer's own words on
         * every request rather than stored, so it cannot be a database filter:
         * the query bounds the unanswered conversations and the reading narrows
         * them afterwards. Where an older unanswered conversation exists past
         * that bound, the drawer says so — a short list must not be mistaken
         * for a quiet queue, and the bell's badge has nowhere to put a caveat.
         */}
        {feed?.hasMore && (
          <p className="px-4 py-3 text-[11px] opacity-55">
            Checked the {feed.scanned} most recent conversations with no reply yet, across{" "}
            {feed.marketplaces.map((marketplace) => capabilityOf(marketplace).label).join(", ")}.
            Older ones are not included.
          </p>
        )}
      </div>
    </>
  );
}
