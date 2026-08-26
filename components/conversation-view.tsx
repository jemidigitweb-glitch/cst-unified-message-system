"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type ConversationDetail,
  conversationTitle,
  displayBody,
  formatSourceTimestamp,
  messageSide,
} from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import type { WorkflowState } from "@/lib/domain/workflow";

import { DraftPanel } from "./draft-panel";
import { PanelIcon } from "./icons";

/** Floor on the draft panel's height: short enough to never be pointless, tall enough that a drag can't hide the action buttons under it. */
const MIN_DRAFT_HEIGHT = 160;
/** Reserved for the header, the resize handle and the footer, so a drag to the ceiling still leaves the message thread visible rather than zeroing it out. */
const RESERVED_FOR_CHROME = 170;
const DEFAULT_DRAFT_HEIGHT = 340;
const KEYBOARD_STEP = 32;

/**
 * Conversation view for marketplaces whose message direction is verified.
 *
 * Messages render oldest → newest in document order. Customer messages sit on
 * the left, previous CST replies on the right. Direction comes from stored
 * application state, never re-derived here — and this component is only ever
 * reached for a source that records direction, because a source that does not
 * is served by the neutral feed instead.
 *
 * For an inbound-only source the right-hand side simply never appears. Nothing
 * is rendered in its place: the guarantee that a reply is never fabricated
 * lives in the data, not in a caption about it.
 *
 * Bodies are rendered as plain text only — never as markup — and an absent or
 * undecodable body shows neutral placeholder copy rather than raw content.
 */
export function ConversationView({
  detail,
  error,
  loading,
  capability,
  onDraftGenerated,
  onWorkflowStateChange,
  detailsOpen,
  onToggleDetails,
}: {
  detail: ConversationDetail | null;
  error: string | null;
  loading: boolean;
  capability: MarketplaceCapability;
  /** Passed through to the draft panel so the sidebar can refresh itself. */
  onDraftGenerated?: () => void;
  /**
   * Fired whenever this conversation's workflow state actually changes —
   * generating a draft, or a reviewer moving it on. Held locally as
   * `workflowState` too (so the draft panel's own transitions show
   * immediately), but a list row showing this same conversation has no way
   * to know unless it is told: without this, "Draft ready" / "Reviewed"
   * only appeared in the list after a full reload re-fetched it.
   */
  onWorkflowStateChange?: (conversationId: string, state: WorkflowState) => void;
  /**
   * Whether the Context / AI Usage / CST Rules Used panel is showing, below
   * desktop width where it is a column that opens and closes rather than a
   * permanent one. Both are optional so this component still works wherever
   * it is used without that panel (there is none for an unresolved message).
   */
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  // Held locally so the draft panel's transitions show immediately; re-seeded
  // whenever a different conversation is opened.
  const [workflowState, setWorkflowState] = useState<WorkflowState>("received");

  /**
   * How tall the draft panel is, in pixels. Purely a display preference —
   * nothing about the draft, its rules, or the workflow depends on this
   * number, and it is never sent anywhere.
   */
  const [draftHeight, setDraftHeight] = useState(DEFAULT_DRAFT_HEIGHT);
  const [resizing, setResizing] = useState(false);

  /**
   * How tall the draft panel is allowed to get right now.
   *
   * Computed from the actual container height rather than a fixed number, so
   * the same drag behaves correctly on a 768px-tall laptop and a 1440px
   * desktop alike: it can always fill "most of the space," never "the whole
   * space," because RESERVED_FOR_CHROME keeps the header/handle/footer and a
   * sliver of the message thread on screen no matter how far it is dragged.
   */
  const maxDraftHeight = useCallback(() => {
    const available = container.current?.clientHeight ?? window.innerHeight;
    return Math.max(MIN_DRAFT_HEIGHT, available - RESERVED_FOR_CHROME);
  }, []);

  const clampDraftHeight = useCallback(
    (value: number) => Math.min(maxDraftHeight(), Math.max(MIN_DRAFT_HEIGHT, value)),
    [maxDraftHeight],
  );

  /**
   * The ceiling, mirrored into state.
   *
   * `maxDraftHeight` reads a ref, and a ref must not be read during render --
   * so this effect is what keeps a render-safe copy around for the `aria-*`
   * attributes below. It also re-clamps a previously dragged height on window
   * resize, so shrinking the browser cannot leave the draft panel taller than
   * the window it is now in.
   */
  const [maxHeight, setMaxHeight] = useState(DEFAULT_DRAFT_HEIGHT);
  useEffect(() => {
    const sync = () => {
      const next = maxDraftHeight();
      setMaxHeight(next);
      setDraftHeight((height) => Math.min(height, next));
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [maxDraftHeight]);

  /**
   * Drag-to-resize on the handle above the draft panel.
   *
   * Pointer events cover mouse, touch and pen with the same handlers, so the
   * same drag works on a laptop trackpad and a tablet touch screen. The
   * listeners are attached to `window` rather than the handle itself so the
   * drag keeps tracking even if the pointer moves off the thin handle mid-drag.
   */
  const startResize = useCallback(
    (startClientY: number) => {
      setResizing(true);
      const startHeight = draftHeight;

      const onMove = (clientY: number) => {
        // Dragging UP (smaller clientY) grows the draft panel.
        setDraftHeight(clampDraftHeight(startHeight + (startClientY - clientY)));
      };
      const onPointerMove = (event: PointerEvent) => onMove(event.clientY);
      const stop = () => {
        setResizing(false);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [draftHeight, clampDraftHeight],
  );

  // Open a thread at its newest message while keeping oldest→newest order.
  useEffect(() => {
    const node = scroller.current;
    if (node && detail) node.scrollTop = node.scrollHeight;
  }, [detail]);

  useEffect(() => {
    if (detail) setWorkflowState(detail.conversation.workflowState);
  }, [detail]);

  if (error !== null) {
    return <p className="p-6 text-sm opacity-70">{error}</p>;
  }
  if (loading) {
    return <p className="p-6 text-sm opacity-60">Loading conversation…</p>;
  }
  if (detail === null) {
    return (
      <p className="p-6 text-sm opacity-60">Select a conversation to review its messages.</p>
    );
  }

  const { conversation, messages } = detail;

  return (
    <div ref={container} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-black/10 px-5 py-3 dark:border-white/15">
        <div>
          {/* Never the bare stored reference: for most sources it is an order
              reference, and printing it where a name belongs presents it as one. */}
          <p className="text-sm font-medium">{conversationTitle(conversation, capability)}</p>
          <p className="text-xs opacity-55">
            {conversation.messageCount} message{conversation.messageCount === 1 ? "" : "s"} ·{" "}
            {conversation.inboundCount} from customer
          </p>
        </div>
        {/* Opens the Context / AI Usage / CST Rules Used panel — open by
            default for a newly selected conversation (see
            `Workspace.select`), and offered from here rather than the app
            header because it describes THIS conversation, not the app as a
            whole. Shown only while the panel is closed: once open, its own
            Close button is the way back, and showing both would be two
            controls for the same one thing. Only exists where the caller
            wired it up (there is no details panel for an unresolved
            message). Shown at every width — the panel is toggleable on
            desktop too, not only below `xl`. */}
        {onToggleDetails && !detailsOpen && (
          <button
            type="button"
            onClick={onToggleDetails}
            aria-label="Show conversation details"
            aria-expanded={false}
            className="shrink-0 rounded-full border border-black/15 p-2 dark:border-white/20"
          >
            <PanelIcon />
          </button>
        )}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <p className="text-sm opacity-60">This conversation has no messages.</p>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {messages.map((message) => {
              const side = messageSide(message);
              const body = displayBody(message);
              const stamp = formatSourceTimestamp(message.sourceTimestamp);
              return (
                <li
                  key={message.id}
                  data-direction={message.direction}
                  className={`flex ${side === "left" ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-2xl px-3.5 py-2 ${
                      side === "left"
                        ? "rounded-bl-sm bg-black/[0.06] dark:bg-white/[0.10]"
                        : "rounded-br-sm bg-emerald-600/15 dark:bg-emerald-400/15"
                    }`}
                  >
                    <p className="mb-1 text-[10px] font-medium tracking-wide uppercase opacity-55">
                      {side === "left" ? "Customer" : "CST reply"}
                    </p>
                    <p
                      className={`text-sm whitespace-pre-wrap ${body.available ? "" : "italic opacity-55"}`}
                    >
                      {body.text}
                    </p>

                    {/*
                     * ATTACHMENTS, inside the bubble.
                     *
                     * Inside rather than beside it because they belong to this
                     * message — the damage rules require photographs, and the
                     * thread previously showed only the word "Photo 1" while
                     * the evidence sat one system away.
                     *
                     * Images render; anything else (the live data holds PDF
                     * invoices too) becomes a link rather than a broken image.
                     * `attachmentsFrom` has already dropped anything that is
                     * not an https URL, so nothing here can issue a request to
                     * a scheme or host the server would not itself allow.
                     */}
                    {message.attachments.length > 0 && (
                      <ul
                        data-testid="message-attachments"
                        className="mt-2 flex flex-wrap gap-2"
                      >
                        {message.attachments.map((attachment) =>
                          attachment.kind === "image" ? (
                            <li key={attachment.url}>
                              <a
                                href={attachment.url}
                                target="_blank"
                                // noreferrer as well as noopener: the URL is
                                // ours, the page the customer photo opens in
                                // does not need to know where it came from.
                                rel="noopener noreferrer"
                                title={attachment.label}
                              >
                                {/* Plain <img>, not next/image. next/image
                                    would need the storage host added to
                                    next.config remotePatterns, and it proxies
                                    every image through the optimiser — routing
                                    customer photographs through an extra hop
                                    for a thumbnail in an internal tool is a
                                    wider change than this warrants. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={attachment.url}
                                  alt={attachment.label}
                                  loading="lazy"
                                  className="max-h-44 max-w-[200px] rounded-lg border border-black/10 object-cover transition-opacity hover:opacity-90 dark:border-white/15"
                                />
                              </a>
                            </li>
                          ) : (
                            <li key={attachment.url}>
                              <a
                                href={attachment.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block max-w-[200px] truncate rounded-lg border border-black/10 px-2 py-1 text-xs underline decoration-dotted underline-offset-2 opacity-80 hover:opacity-100 dark:border-white/15"
                              >
                                {attachment.label}
                              </a>
                            </li>
                          ),
                        )}
                      </ul>
                    )}

                    <p className="mt-1 text-right text-[10px] tabular-nums opacity-50">
                      {stamp.date} {stamp.time}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/*
       * DRAG HANDLE. The border above the draft panel used to be a plain
       * divider; it is now also how a reviewer controls how much of the
       * column the draft gets versus the message thread -- a fixed cap
       * suits most drafts, but a very long one or a very short window
       * sometimes calls for more. The affordance (grip icon + "Drag to
       * resize") only appears on hover/focus so the divider still reads as
       * a plain line the rest of the time, matching the existing look.
       */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize draft panel"
        aria-valuenow={Math.round(draftHeight)}
        aria-valuemin={MIN_DRAFT_HEIGHT}
        aria-valuemax={Math.round(maxHeight)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          startResize(event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setDraftHeight((height) => clampDraftHeight(height + KEYBOARD_STEP));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setDraftHeight((height) => clampDraftHeight(height - KEYBOARD_STEP));
          }
        }}
        className={`group relative flex h-2.5 shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-black/10 outline-none focus-visible:bg-emerald-600/10 dark:border-white/15 dark:focus-visible:bg-emerald-400/10 ${
          resizing ? "bg-emerald-600/10 dark:bg-emerald-400/10" : ""
        }`}
      >
        <span
          aria-hidden
          className={`pointer-events-none absolute -top-7 flex items-center gap-1 rounded bg-black/80 px-2 py-1 text-[10px] whitespace-nowrap text-white opacity-0 transition-opacity dark:bg-white/90 dark:text-black ${
            resizing ? "opacity-100" : "group-hover:opacity-100 group-focus-visible:opacity-100"
          }`}
        >
          {/* Grip glyph: two rows of three dots, the usual "drag" icon. */}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
            <circle cx="2" cy="2" r="1.1" />
            <circle cx="5" cy="2" r="1.1" />
            <circle cx="8" cy="2" r="1.1" />
            <circle cx="2" cy="8" r="1.1" />
            <circle cx="5" cy="8" r="1.1" />
            <circle cx="8" cy="8" r="1.1" />
          </svg>
          Drag to resize
        </span>
        <span
          aria-hidden
          className="h-1 w-10 rounded-full bg-black/15 transition-colors group-hover:bg-black/30 dark:bg-white/20 dark:group-hover:bg-white/35"
        />
      </div>

      <div style={{ height: draftHeight }} className="shrink-0 overflow-hidden">
        <DraftPanel
          conversationId={conversation.id}
          detail={detail}
          workflowState={workflowState}
          onWorkflowChange={(state) => {
            setWorkflowState(state);
            onWorkflowStateChange?.(conversation.id, state);
          }}
          onGenerated={onDraftGenerated}
        />
      </div>

      <div className="shrink-0 border-t border-black/10 px-5 py-3 text-xs opacity-55 dark:border-white/15">
        Review only — this phase has no capability to reply to a customer.
      </div>
    </div>
  );
}
