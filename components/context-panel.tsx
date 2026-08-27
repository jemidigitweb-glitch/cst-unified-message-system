"use client";

import { useEffect, useMemo, useState } from "react";

import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import {
  CUSTOMER_PRODUCT_DATA_HEADING,
  type CustomerMessage,
  extractCustomerProductData,
  panelCustomerProductData,
} from "@/lib/domain/customer-product-data";
import {
  CONTEXT_NOT_LOADED_TEXT,
  MULTIPLE_ORDERS_TEXT,
  type InboxItem,
  formatSourceTimestamp,
} from "@/lib/domain/inbox";
import type { MarketplaceCapability } from "@/lib/domain/marketplace-capabilities";
import {
  ORDER_DETAIL_FIELDS,
  type ConversationOrderContext,
  type OrderContextResponse,
  type OrderDetail,
  orderDetailsFrom,
} from "@/lib/domain/order";
import {
  MATCH_EVIDENCE_HEADING,
  type OrderMatchEvidence,
} from "@/lib/domain/order-match-evidence";
import {
  browserOrderSelectionStorage,
  readStoredSelection,
  restorableSelection,
  saveStoredSelection,
} from "@/lib/domain/order-selection-storage";

import { StatusBadge } from "./status-badge";

/**
 * Context summary.
 *
 * Order context comes from the draft context pipeline
 * (`resolveEbayOrderContext`, via `/api/conversations/:id/order-context`) and
 * from nowhere else. Nothing here decides what counts as verified, resolves an
 * order, or picks between matches — that stays entirely in the resolver
 * already used to ground a draft.
 *
 * ONE FORMAT, HOWEVER MANY ORDERS MATCHED. A conversation that resolved to a
 * single order renders one detail block; a conversation whose buyer bought the
 * same listing three times renders three, in the same layout, under the same
 * labels, in the order the backend stored them. There is no second,
 * lesser-looking "ambiguous" presentation, because the orders are not lesser —
 * every one of them is a real, verified purchase. What is unresolved is which
 * one the customer is writing about, and that is said in a sentence rather
 * than implied by styling a block differently.
 *
 * BLANK MEANS NOT RECORDED. Each block shows the same field list, and a field
 * the pipeline never captured is left empty rather than filled from a sibling
 * order, from the listing, or from a plausible default. That is the whole
 * reason several blocks can safely sit side by side: no value in one of them
 * can have come from another.
 *
 * NOTHING HERE PICKS, AND NOTHING HERE MERGES. No selection control, no
 * default, no highlighted "most likely" block, and no combined block built out
 * of several orders' fields. The schema has no place to record a choice no
 * human made (migration 0001 omits a `selected` column on purpose), and a
 * merged block would assert a purchase that never happened.
 *
 * References are shown only when the source actually recorded one, and always
 * under the neutral noun the capability supplies. A source reference is not a
 * confirmed purchase, so it never appears as "Order No", and the
 * unresolved-grouping sentinel is not a reference at all and is never shown.
 */

/**
 * Fetches and renders every matching order for one conversation.
 *
 * A separate component, mounted with `key={conversationId}` by the caller, so
 * switching conversations remounts it rather than reusing state across two
 * different conversations' context. That is what lets every state update below
 * happen after an await -- matching `DraftEvidencePanel` -- with no
 * synchronous `setState` in the effect body.
 */
function OrderContextFacts({
  conversationId,
  conversationContext,
  selectedOrderNumber,
  onSelectOrder,
}: {
  conversationId: string;
  conversationContext: ConversationOrderContext;
  selectedOrderNumber: string | null;
  onSelectOrder: (orderNumber: string | null) => void;
}) {
  const [context, setContext] = useState<OrderContextResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/order-context`);
        if (!response.ok) throw new Error("request failed");
        const payload = (await response.json()) as OrderContextResponse;
        if (!cancelled) setContext(payload);
      } catch {
        if (!cancelled) setContext(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  /**
   * Restores a selection this reviewer made before reloading the page.
   *
   * Runs once the orders are known, because restoring requires checking the
   * remembered value against them: an order that is no longer in the list is
   * discarded and forgotten rather than silently re-armed. Without that check
   * a stale value would tick nothing on screen while still travelling with the
   * next Generate request.
   *
   * Only ever fills an empty selection. If the reviewer has already picked
   * something in this session that is what stands — this must not undo a live
   * choice with a remembered one.
   */
  useEffect(() => {
    if (context === null || selectedOrderNumber !== null) return;

    const storage = browserOrderSelectionStorage();
    const stored = readStoredSelection(storage, conversationId);
    if (stored === null) return;

    const available = context.orders.map((order) => order.orderNumber);
    const restorable = restorableSelection(stored, available);
    if (restorable === null) {
      saveStoredSelection(storage, conversationId, null);
      return;
    }
    onSelectOrder(restorable);
    // `onSelectOrder` is the workspace's stable state setter; including it
    // would re-run this on every parent render for no behavioural difference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, conversationId, selectedOrderNumber]);

  /** Remembers the choice for this conversation, and forgets it when cleared. */
  function chooseOrder(orderNumber: string | null): void {
    saveStoredSelection(browserOrderSelectionStorage(), conversationId, orderNumber);
    onSelectOrder(orderNumber);
  }

  // Loading and "nothing matched" read identically on purpose: there is no
  // honest way to tell them apart from the screen, and a spinner that flips to
  // the exact same sentence a moment later would be motion for no reason.
  if (loading || context === null) {
    return <p className="text-sm opacity-60">{CONTEXT_NOT_LOADED_TEXT}</p>;
  }

  const orders = orderDetailsFrom(context, conversationContext);
  if (orders.length === 0) {
    return <p className="text-sm opacity-60">{CONTEXT_NOT_LOADED_TEXT}</p>;
  }

  /**
   * Choosing is offered only where there is a choice to make.
   *
   * A single matching order needs no radio beside it — the conversation
   * already resolved to it on the backend's own evidence, and a control there
   * would invite a reviewer to "confirm" something that needs no confirming
   * and would change nothing if they did.
   */
  const selectable = orders.length > 1;

  return (
    <div className="flex flex-col gap-2">
      <SectionHeading tone="order">Order context</SectionHeading>
      {/* Said once, above the list: the choice is over the set, not per order. */}
      {selectable && <p className="text-xs opacity-70">{MULTIPLE_ORDERS_TEXT}</p>}
      <ul className="flex flex-col gap-2">
        {orders.map((order, index) => (
          <li
            key={order.orderNumber ?? index}
            className="rounded border border-current/15 px-2 py-1.5"
          >
            {selectable && order.orderNumber !== null && (
              <OrderChoice
                conversationId={conversationId}
                orderNumber={order.orderNumber}
                checked={selectedOrderNumber === order.orderNumber}
                onChoose={chooseOrder}
              />
            )}
            <OrderDetailBlock order={order} />
            <MatchEvidence reasons={reasonsFor(context.evidence, order.orderNumber)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One order's radio.
 *
 * A RADIO, NOT A CHECKBOX, and every radio in one conversation shares a
 * `name`, so the browser itself enforces that at most one order can be chosen.
 * Two orders cannot be combined because there is no state in which two are
 * held — the choice is a single order number or nothing.
 *
 * NOTHING IS SAVED. Clicking sets a value this page holds until the reviewer
 * moves on; it writes to no database and confirms nothing. The choice is
 * carried on the next Generate request and re-validated there against the
 * orders the conversation actually matched, so what the browser sends is
 * checked rather than trusted.
 *
 * Clicking the chosen order again clears the choice, which is how a reviewer
 * undoes a misclick back to "no order context" without a second control.
 */
function OrderChoice({
  conversationId,
  orderNumber,
  checked,
  onChoose,
}: {
  conversationId: string;
  orderNumber: string;
  checked: boolean;
  onChoose: (orderNumber: string | null) => void;
}) {
  return (
    <label className="mb-1 flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="radio"
        name={`order-choice-${conversationId}`}
        checked={checked}
        onChange={() => onChoose(orderNumber)}
        onClick={() => {
          if (checked) onChoose(null);
        }}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer"
      />
      <span className="font-medium">{orderNumber}</span>
    </label>
  );
}

/**
 * One order, as the same field list every time.
 *
 * Every field is rendered whether or not it carries a value, so two blocks
 * line up row for row and a reviewer comparing them is comparing like with
 * like. A blank right-hand side is the statement that nothing was recorded —
 * it is deliberately not a dash, "N/A", or "unknown", each of which reads as a
 * value the system checked and settled on.
 */
function OrderDetailBlock({ order }: { order: OrderDetail }) {
  return (
    <dl className="flex flex-col gap-0.5 text-sm">
      {ORDER_DETAIL_FIELDS.map((field) => (
        <Row key={field.key} label={field.label} value={order[field.key]} />
      ))}
    </dl>
  );
}

/** This order's evidence, or none when the payload carried none for it. */
function reasonsFor(
  evidence: readonly OrderMatchEvidence[],
  orderNumber: string | null,
): readonly string[] {
  if (orderNumber === null) return [];
  return evidence.find((entry) => entry.orderNumber === orderNumber)?.reasons ?? [];
}

/**
 * Why this order matched, under the order it explains.
 *
 * Rendered per block rather than once above the list, because the evidence
 * differs per order — that difference is the entire value. Absent for a single
 * matching order, and absent for any order the backend produced no evidence
 * for; an empty "Why this order matched" heading would read as "no reason",
 * which is a different claim from "not compared".
 *
 * Descriptive only. No emphasis on the order with the most lines, no ordering
 * by strength, no control: a reviewer reads the reasons and decides, and this
 * component has no way to record that they did.
 */
function MatchEvidence({ reasons }: { reasons: readonly string[] }) {
  if (reasons.length === 0) return null;

  return (
    <div className="mt-1.5 border-t border-current/10 pt-1.5">
      <h4 className="text-[10px] font-medium tracking-wide uppercase opacity-50">
        {MATCH_EVIDENCE_HEADING}
      </h4>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {reasons.map((reason) => (
          <li key={reason} className="text-xs opacity-70">
            {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the customer said about the product, in their own words.
 *
 * A SEPARATE SECTION FROM ORDER CONTEXT, deliberately. Everything above was
 * verified against the source database; this was asserted by a member of the
 * public. Putting a colour the customer asked for in the same list as a SKU
 * the backend confirmed would make the two read as one kind of thing, and the
 * reviewer's whole job here is telling them apart.
 *
 * ABSENT, NOT EMPTY. Most conversations mention no dimensions or colours at
 * all. An empty box headed "Customer product data" would suggest the customer
 * gave none when in fact none was looked for, so the section simply does not
 * render.
 *
 * Values are slices of the customer's own messages — nothing here paraphrases,
 * normalises or converts, so every row can be checked by reading the thread.
 */
function CustomerProductData({ messages }: { messages: readonly CustomerMessage[] }) {
  const details = useMemo(
    () => panelCustomerProductData(extractCustomerProductData(messages)),
    [messages],
  );
  if (details.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading tone="customer">{CUSTOMER_PRODUCT_DATA_HEADING}</SectionHeading>
      <dl className="flex flex-col gap-0.5 text-sm">
        {details.map((detail) => (
          <Row key={`${detail.label}:${detail.value}`} label={detail.label} value={detail.value} />
        ))}
      </dl>
    </section>
  );
}

export function ContextPanel({
  conversation,
  capability,
  messages,
  selectedOrderNumber,
  onSelectOrder,
}: {
  conversation: InboxItem | null;
  capability: MarketplaceCapability;
  /**
   * The thread, already loaded by the view above — read ONLY to surface what
   * the customer said about the product. Nothing here fetches it again, and
   * nothing derived from it is stored.
   */
  messages: readonly CustomerMessage[];
  /**
   * The order a reviewer picked, held by the workspace rather than here so the
   * draft panel -- a sibling, not a child -- can send it with the next
   * generation.
   *
   * BOTH PROPS ARE REQUIRED, and were briefly optional. Optional was a mistake
   * with a real cost: the workspace passed the selection to this panel and
   * forgot to pass it down the other branch to the draft panel, which compiled
   * cleanly and defaulted to null. The reviewer saw their choice highlighted
   * here while every generation ran ungrounded. Required props make that same
   * omission a type error instead of a silent wrong answer.
   */
  selectedOrderNumber: string | null;
  onSelectOrder: (orderNumber: string | null) => void;
}) {
  if (conversation === null) {
    return <p className="p-5 text-sm opacity-70">No conversation selected.</p>;
  }

  const first = formatSourceTimestamp(conversation.firstSourceTimestamp);
  const last = formatSourceTimestamp(conversation.lastSourceTimestamp);

  /**
   * The two things the resolver matched ON, so they are true of every order it
   * returned. `buyer` is supplied only where the capability says the stored
   * reference is a real customer identity -- a source reference is not a
   * person, and must not appear under "Buyer".
   */
  const conversationContext: ConversationOrderContext = {
    buyer:
      capability.counterpartyIdentityVerified &&
      !isUnresolvedReference(conversation.counterpartyRef)
        ? conversation.counterpartyRef
        : null,
    market: capability.label,
  };

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
        <SectionHeading tone="context">Context</SectionHeading>
        {conversation.listingItemRef !== null && (
          <Row label="Item reference" value={conversation.listingItemRef} />
        )}
        {capability.referenceNoun !== undefined &&
          !isUnresolvedReference(conversation.counterpartyRef) && (
            <Row label={capability.referenceNoun} value={conversation.counterpartyRef} />
          )}
        <OrderContextFacts
          key={conversation.id}
          conversationId={conversation.id}
          conversationContext={conversationContext}
          selectedOrderNumber={selectedOrderNumber}
          onSelectOrder={onSelectOrder}
        />
      </section>

      {/*
        Its own section, a sibling of Context rather than nested inside it.
        Nested, its heading sat at the same indent as the order-context heading
        directly above and read as a second heading for the same block. It is
        conversation-level anyway — what the customer asked for is true of the
        thread whichever order a reviewer picks — so a section of its own is
        also the more honest placement. Renders nothing at all when the
        customer stated no product details.
      */}
      <CustomerProductData messages={messages} />
    </div>
  );
}

/**
 * A sidebar section heading, tinted so each section is its own.
 *
 * TEXT COLOUR ONLY — no background, no pill, no radius. The sidebar already
 * carries status pills and category chips; giving the headings a filled
 * background too would put three more boxes on a panel whose job is to be
 * read straight down, and would compete with the badges that are the thing
 * actually worth noticing.
 *
 * ONE TABLE, THREE TONES, so a reviewer scrolling past several short lists
 * of label/value rows can see where one section ends and the next begins
 * without reading the words.
 */
const SECTION_TONE = {
  context: "text-indigo-700 dark:text-indigo-300",
  order: "text-teal-700 dark:text-teal-300",
  customer: "text-amber-700 dark:text-amber-300",
} as const;

function SectionHeading({
  tone,
  children,
}: {
  tone: keyof typeof SECTION_TONE;
  children: string;
}) {
  return (
    <h2 className={`text-[11px] font-medium tracking-wide uppercase ${SECTION_TONE[tone]}`}>
      {children}
    </h2>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs opacity-70">{label}</dt>
      <dd className="truncate text-right text-sm">{value ?? ""}</dd>
    </div>
  );
}
