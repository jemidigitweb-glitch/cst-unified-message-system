"use client";

import { useEffect, useRef, useState } from "react";

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
}: {
  detail: ConversationDetail | null;
  error: string | null;
  loading: boolean;
  capability: MarketplaceCapability;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Held locally so the draft panel's transitions show immediately; re-seeded
  // whenever a different conversation is opened.
  const [workflowState, setWorkflowState] = useState<WorkflowState>("received");

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-black/10 px-5 py-3 dark:border-white/15">
        {/* Never the bare stored reference: for most sources it is an order
            reference, and printing it where a name belongs presents it as one. */}
        <p className="text-sm font-medium">{conversationTitle(conversation, capability)}</p>
        <p className="text-xs opacity-55">
          {conversation.messageCount} message{conversation.messageCount === 1 ? "" : "s"} ·{" "}
          {conversation.inboundCount} from customer
        </p>
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

      <DraftPanel
        conversationId={conversation.id}
        workflowState={workflowState}
        onWorkflowChange={setWorkflowState}
      />

      <div className="shrink-0 border-t border-black/10 px-5 py-3 text-xs opacity-55 dark:border-white/15">
        Review only — this phase has no capability to reply to a customer.
      </div>
    </div>
  );
}
