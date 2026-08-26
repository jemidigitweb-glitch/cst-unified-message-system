"use client";

import { useEffect, useState } from "react";

import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import type { VerifiedFact } from "@/lib/domain/draft";
import {
  CONTEXT_NOT_LOADED_TEXT,
  type InboxItem,
  formatSourceTimestamp,
} from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";

import { StatusBadge } from "./status-badge";

/**
 * Context summary.
 *
 * Order and product context is shown ONLY when the draft context pipeline
 * (`resolveEbayOrderContext`, via `/api/conversations/:id/order-context`) has
 * a verified single-order match for this conversation. Nothing here decides
 * what counts as verified, resolves an order, or picks between candidates —
 * that stays entirely in the resolver already used to ground a draft.
 *
 * Until a verified match exists -- no match, more than one candidate, or a
 * marketplace the resolver does not cover -- this panel says so plainly
 * rather than showing a plausible-looking blank field. An empty "Order
 * number" row would read as "no order", which is a different claim from "not
 * looked up yet", and a guessed value from an ambiguous match would be worse.
 *
 * References are shown only when the source actually recorded one, and always
 * under the neutral noun the capability supplies. A source reference is not a
 * confirmed purchase, so it never appears as "Order number", and the
 * unresolved-grouping sentinel is not a reference at all and is never shown.
 */

const ORDER_FACT_LABELS: Readonly<Record<string, string>> = {
  order_number: "Order number",
  order_status: "Order status",
  order_date: "Order date",
  tracking_number: "Tracking number",
  delivery_courier: "Courier",
  delivery_address: "Delivery address",
};

const PRODUCT_FACT_LABELS: Readonly<Record<string, string>> = {
  sku: "SKU",
  product_title: "Product title",
};

/**
 * Fetches and renders the verified facts for one conversation.
 *
 * A separate component, mounted with `key={conversationId}` by the caller, so
 * switching conversations remounts it rather than reusing state across two
 * different conversations' facts. That is what lets every state update below
 * happen after an await -- matching `DraftEvidencePanel` -- with no
 * synchronous `setState` in the effect body.
 */
function OrderContextFacts({ conversationId }: { conversationId: string }) {
  const [facts, setFacts] = useState<VerifiedFact[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/order-context`);
        if (!response.ok) throw new Error("request failed");
        const payload = (await response.json()) as { facts: VerifiedFact[] };
        if (!cancelled) setFacts(payload.facts);
      } catch {
        if (!cancelled) setFacts(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Loading and "nothing verified" read identically on purpose: there is no
  // honest way to tell them apart from the screen, and a spinner that flips to
  // the exact same sentence a moment later would be motion for no reason.
  if (loading || facts === null || facts.length === 0) {
    return <p className="text-sm opacity-60">{CONTEXT_NOT_LOADED_TEXT}</p>;
  }

  const orderFacts = facts.filter((fact) => fact.name in ORDER_FACT_LABELS);
  const productFacts = facts.filter((fact) => fact.name in PRODUCT_FACT_LABELS);

  return (
    <>
      {orderFacts.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-[11px] font-medium tracking-wide uppercase opacity-55">
            Order context
          </h3>
          <dl className="flex flex-col gap-1 text-sm">
            {orderFacts.map((fact) => (
              <Row key={fact.name} label={ORDER_FACT_LABELS[fact.name]!} value={fact.value} />
            ))}
          </dl>
        </div>
      )}
      {productFacts.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-[11px] font-medium tracking-wide uppercase opacity-55">
            Product context
          </h3>
          <dl className="flex flex-col gap-1 text-sm">
            {productFacts.map((fact) => (
              <Row key={fact.name} label={PRODUCT_FACT_LABELS[fact.name]!} value={fact.value} />
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

export function ContextPanel({
  conversation,
  capability,
}: {
  conversation: InboxItem | null;
  capability: MarketplaceCapability;
}) {
  if (conversation === null) {
    return <p className="p-5 text-sm opacity-70">No conversation selected.</p>;
  }

  const first = formatSourceTimestamp(conversation.firstSourceTimestamp);
  const last = formatSourceTimestamp(conversation.lastSourceTimestamp);

  return (
    <div className="flex flex-col gap-5 p-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide uppercase opacity-70">
          Human action needed
        </h2>
        <StatusBadge state={conversation.workflowState} />
        <dl className="mt-1 flex flex-col gap-1 text-sm">
          <Row label="Messages" value={String(conversation.messageCount)} />
          <Row label="First" value={`${first.date} ${first.time}`} />
          <Row label="Latest" value={`${last.date} ${last.time}`} />
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide uppercase opacity-70">Context</h2>
        {conversation.listingItemRef !== null && (
          <Row label="Item reference" value={conversation.listingItemRef} />
        )}
        {capability.referenceNoun !== undefined &&
          !isUnresolvedReference(conversation.counterpartyRef) && (
            <Row label={capability.referenceNoun} value={conversation.counterpartyRef} />
          )}
        <OrderContextFacts key={conversation.id} conversationId={conversation.id} />
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs opacity-70">{label}</dt>
      <dd className="truncate text-right text-sm">{value}</dd>
    </div>
  );
}
