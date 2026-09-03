"use client";

import { useEffect, useMemo, useState } from "react";

import { isUnresolvedReference } from "@/lib/domain/conversation-reference";
import {
  COLUMN_EXPECTED,
  COLUMN_LISTING,
  COLUMN_REPORTED,
  LISTING_VALUE_ABSENT,
  REPORTED_DETAILS_HEADING,
  type ReportingMessage,
  customerReportedProductDetails,
  imageGapMessage,
  isEmptyReportedDetails,
} from "@/lib/domain/customer-reported-product-details";
import {
  CONTEXT_NOT_LOADED_TEXT,
  MULTIPLE_ORDERS_TEXT,
  type InboxItem,
  formatSourceTimestamp,
} from "@/lib/domain/inbox";
import type { ListingLinkResponse } from "@/lib/domain/listing-link";
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
import {
  NO_HISTORY_TEXT,
  TRACKING_HEADING,
  TRACKING_HISTORY_TOGGLE,
  trackingHistoryEntries,
  trackingSummaryRows,
} from "@/lib/domain/shipment-tracking-display";
import type { TrackingResult } from "@/lib/tracking/provider";

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
 * The item reference, linked to the listing it names when one can be resolved.
 *
 * FETCHES ITS OWN ANSWER, and is remounted per conversation by the caller so
 * switching conversations cannot carry one conversation's link into another's
 * row — the same discipline, and for the same reason, as `OrderContextFacts`
 * below.
 *
 * NOT PART OF THE ORDER CONTEXT REQUEST, deliberately. The link needs only the
 * item reference, so it is just as available on a pre-sales enquiry that
 * matched no order — which is the conversation where a reviewer most often
 * wants to open the listing.
 *
 * THE ROW IS THE SAME ROW WHETHER OR NOT A LINK ARRIVES. Loading, a marketplace
 * whose listings cannot be resolved from a reference, nothing recorded, and a
 * failed request all render exactly what this panel rendered before there were
 * links: the reference, as text. There is no "unavailable" message, because the
 * absence of a link is not news to a reviewer — and no placeholder link, which
 * is the one outcome that could send them to the wrong product.
 */
function ListingReference({
  conversationId,
  itemRef,
  marketplaceLabel,
  resolvable,
}: {
  conversationId: string;
  itemRef: string;
  marketplaceLabel: string;
  /** Whether this marketplace's item reference names exactly one listing. */
  resolvable: boolean;
}) {
  const [listingUrl, setListingUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!resolvable) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/listing`);
        if (!response.ok) throw new Error("request failed");
        const payload = (await response.json()) as ListingLinkResponse;
        if (!cancelled) setListingUrl(payload.listingUrl);
      } catch {
        // A failed lookup is reported as no link, never as a guessed one.
        if (!cancelled) setListingUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, resolvable]);

  return (
    <Row
      label="Item reference"
      value={itemRef}
      href={listingUrl ?? undefined}
      linkTitle={
        listingUrl === null ? undefined : `Open the ${marketplaceLabel} listing for ${itemRef}`
      }
    />
  );
}

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
  onListingResolved,
}: {
  conversationId: string;
  conversationContext: ConversationOrderContext;
  selectedOrderNumber: string | null;
  onSelectOrder: (orderNumber: string | null) => void;
  /**
   * Hands the authoritative listing text up to the reported-details section.
   *
   * ONE ORDER ONLY, and that restriction is the point. Where a conversation
   * matched several genuine purchases, no listing here has been shown to be the
   * one the customer is writing about — comparing their complaint against a
   * guess would produce an expected value with no claim to being expected. The
   * section still renders in that case; its Listing column just stays empty,
   * which is the honest reading of "we do not yet know which order this is".
   */
  onListingResolved: (listingText: string | null) => void;
}) {
  const [context, setContext] = useState<OrderContextResponse | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * REFETCHED WHEN THE REVIEWER PICKS AN ORDER, and that is the point.
   *
   * Everything the backend derives from a resolved order — including the
   * shipment — keys off `facts`, and an ambiguous conversation has none until
   * somebody chooses. Sending the choice is what lets the route resolve it and
   * come back with the tracking for THAT order.
   *
   * NOTHING IS GUESSED WHILE THE ANSWER IS PENDING. With no selection the
   * request carries none, the resolver returns no facts, and the panel shows no
   * shipment — rather than the first, the newest, or the likeliest candidate's.
   * The route re-checks the number against the orders this conversation
   * actually matched, so what the browser sends is validated, not trusted.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const query =
          selectedOrderNumber === null
            ? ""
            : `?selectedOrder=${encodeURIComponent(selectedOrderNumber)}`;
        const response = await fetch(
          `/api/conversations/${conversationId}/order-context${query}`,
        );
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
  }, [conversationId, selectedOrderNumber]);

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

  /**
   * Publishes the resolved listing text, so the reported-details section can
   * put an expected value beside the customer's claim.
   *
   * Reports null as deliberately as it reports a value. Nothing matched, still
   * loading, and "matched several orders" all mean the same thing to the
   * section above: there is no single listing whose specification this
   * conversation is entitled to be compared against, so it must show none.
   */
  useEffect(() => {
    if (context === null) {
      onListingResolved(null);
      return;
    }
    const resolved = orderDetailsFrom(context, conversationContext);
    onListingResolved(resolved.length === 1 ? (resolved[0]?.productDetails ?? null) : null);
    // `conversationContext` is rebuilt by the parent on every render and
    // `onListingResolved` is a plain state setter; including either would
    // re-run this continuously for no behavioural difference. The fetched
    // context is the only input that can actually change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

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

  /*
   * Tracking is shown even where no order block is, and the two are decided
   * separately on purpose. The display lookup that fills `orders` reads the
   * source live and can come back empty on an outage, while `facts` — which is
   * what tracking was resolved from — survived. Hiding a verified shipment
   * because a cosmetic lookup failed would withhold the more useful of the two.
   */
  if (orders.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm opacity-60">{CONTEXT_NOT_LOADED_TEXT}</p>
        <ShipmentTracking tracking={context.tracking} />
      </div>
    );
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

  const list = (
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
  );

  return (
    <div className="flex flex-col gap-5">
      {/*
        COLLAPSIBLE ONLY WHERE THERE IS SOMETHING TO COLLAPSE.

        A single matching order renders exactly as it always has — a heading and
        the block — because a disclosure control there would ask a reviewer to
        open something to find the one answer that was never in doubt. Several
        candidates are the case that fills the sidebar, and the case a reviewer
        is done with once they have chosen, so those get the control.

        OPEN BY DEFAULT WHILE NOTHING IS CHOSEN. The panel's job at that moment
        is to get a choice made; hiding the candidates behind a click would bury
        the one action that unblocks everything below, tracking included. Once a
        choice exists the section starts collapsed, because the chosen order is
        summarised on the control itself.
      */}
      {selectable ? (
        <details open={selectedOrderNumber === null} className="flex flex-col gap-2">
          <summary className="cursor-pointer list-none select-none">
            <span className="flex items-baseline gap-1.5">
              <SectionHeading>Order context</SectionHeading>
              <span aria-hidden="true" className="text-[10px] opacity-50">
                ▼
              </span>
            </span>
            <span className="mt-0.5 block text-xs opacity-70">
              {selectedOrderNumber === null
                ? MULTIPLE_ORDERS_TEXT
                : `Order ${selectedOrderNumber} selected — ${orders.length} matched`}
            </span>
          </summary>
          <div className="mt-2">{list}</div>
        </details>
      ) : (
        <div className="flex flex-col gap-2">
          <SectionHeading>Order context</SectionHeading>
          {list}
        </div>
      )}

      {/* BELOW the orders, never inside one: the shipment is the order's, and
          where several orders matched none of them has been shown to be the one
          this parcel belongs to. The backend enforces that — with no selection
          it resolves no facts, so `tracking` is null here and this renders
          nothing. */}
      <ShipmentTracking tracking={context.tracking} />
    </div>
  );
}

/**
 * Where the parcel has got to, under the orders it belongs to.
 *
 * ABSENT RATHER THAN EMPTY. Nothing renders when `tracking` is null, and null
 * covers every refusal upstream — not a delivery query, no verified reference,
 * an unrecognised carrier, a reference recorded against two orders, an order
 * sent in more than one parcel, a status too old to state. A box reading "no
 * tracking available" on the great majority of conversations would be noise,
 * and worse, it would invite the reader to wonder which of those six things
 * happened when the panel cannot tell them.
 *
 * NOTHING HERE DECIDES ANYTHING. No query, no carrier call, no choosing between
 * shipments. This renders `OrderContextResponse.tracking` exactly as the route
 * produced it, and the route reuses the same gate the draft does — so a reviewer
 * and the model can never be looking at two different accounts of one parcel.
 *
 * WORDING IS LOAD-BEARING and lives in
 * `lib/domain/shipment-tracking-display.ts`, not here: "Last carrier update",
 * never "Live location" or "Current position". Every result on this path is the
 * sync's copy of what a carrier last reported, and a present-tense heading would
 * promise something the data cannot support.
 */
function ShipmentTracking({ tracking }: { tracking: TrackingResult | null }) {
  if (tracking === null) return null;

  const rows = trackingSummaryRows(tracking);
  const history = trackingHistoryEntries(tracking);

  return (
    <section data-testid="shipment-tracking" className="flex flex-col gap-2">
      <SectionHeading>{TRACKING_HEADING}</SectionHeading>

      {/*
        STACKED, not label-left/value-right like the order rows above. A
        tracking reference is long enough to be truncated by a right-aligned
        column, and a truncated reference is worse than no reference — a
        reviewer copies it into a carrier's site character for character.
      */}
      <dl className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-[11px] opacity-60">{row.label}</dt>
            <dd className="text-sm break-all">{row.value}</dd>
          </div>
        ))}
      </dl>

      {/*
        A plain <details>. Collapsed by default because the summary above
        answers the question a reviewer usually has, and the browser's own
        disclosure needs no state, no effect and no keyboard handling of ours.
      */}
      <details className="mt-0.5">
        <summary className="cursor-pointer text-[11px] opacity-70 select-none">
          {TRACKING_HISTORY_TOGGLE}
        </summary>
        {history.length === 0 ? (
          <p className="mt-1.5 text-xs opacity-60">{NO_HISTORY_TEXT}</p>
        ) : (
          /*
            A TIMELINE, newest at the top.

            Date and time stacked on the left, a node on a continuous rule, the
            carrier's wording on the right, alternating row tint. The rule is
            drawn on each row rather than as one absolutely-positioned line so
            it cannot come adrift from the nodes when a description wraps to two
            lines — which, in a sidebar this narrow, most of them do.

            NO PER-SCAN CARRIER BADGE. The reference design shows one, and this
            data cannot honestly support it: the carrier is recorded once per
            SHIPMENT, not per scan, so a badge on every row would be the same
            value repeated — or worse, a guess. The courier is named once, above,
            where it is actually known.
          */
          <ol data-testid="shipment-tracking-history" className="mt-1.5">
            {history.map((entry, index) => (
              <li
                key={`${entry.date}-${entry.time}-${entry.status}-${index}`}
                className={`flex gap-2 ${index % 2 === 1 ? "bg-current/[0.035]" : ""}`}
              >
                <div className="w-[5.5rem] shrink-0 py-1.5 text-right">
                  <p className="text-[11px] font-medium">{entry.date}</p>
                  {entry.time !== "" && (
                    <p className="text-[11px] opacity-50">{entry.time}</p>
                  )}
                </div>

                {/* The rule and its node. `aria-hidden` because it carries no
                    information a screen reader has not already been given. */}
                <div aria-hidden="true" className="relative flex w-3 shrink-0 justify-center">
                  <span
                    className={`absolute w-px bg-current/20 ${
                      index === 0
                        ? "top-3.5 bottom-0"
                        : index === history.length - 1
                          ? "top-0 h-3.5"
                          : "inset-y-0"
                    }`}
                  />
                  <span className="relative mt-2.5 h-2 w-2 rounded-full border border-current/30 bg-current/20" />
                </div>

                <p className="min-w-0 py-1.5 text-sm break-words">
                  {entry.description ?? entry.status}
                </p>
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
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
 * What the listing says, against what the customer says they received.
 *
 * A SEPARATE SECTION FROM ORDER CONTEXT, deliberately. Everything above was
 * verified against the source database; the right-hand value in every row below
 * was asserted by a member of the public. Putting them in one list would make
 * the two read as one kind of thing, and telling them apart is the reviewer's
 * whole job here.
 *
 * TWO VALUES, ALWAYS BOTH LABELLED. A single value under "Dimensions" is
 * ambiguous in the worst way — the reader cannot tell whether the system is
 * reporting the specification or the complaint. Every row names which side each
 * value came from, and a listing value that was never recorded says so in
 * words rather than being left blank next to a populated claim.
 *
 * ABSENT, NOT EMPTY. Most conversations report no discrepancy at all, so the
 * section does not render rather than showing an empty box that would suggest
 * the customer was asked and said nothing.
 */
function CustomerReportedProductDetails({
  listingText,
  messages,
  marketplace,
  marketplaceLabel,
}: {
  listingText: string | null;
  messages: readonly ReportingMessage[];
  /** Decides whether an absent image means "none sent" or "never captured". */
  marketplace: string;
  marketplaceLabel: string;
}) {
  const details = useMemo(
    () => customerReportedProductDetails({ listingText, messages, marketplace }),
    [listingText, messages, marketplace],
  );
  if (isEmptyReportedDetails(details)) return null;

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>{REPORTED_DETAILS_HEADING}</SectionHeading>

      <ul className="flex flex-col gap-2">
        {details.attributes.map((row) => (
          <li
            key={row.attribute}
            className="rounded border border-current/15 px-2 py-1.5"
          >
            <h3 className="text-sm font-medium">{row.attribute}</h3>
            <dl className="mt-1 flex flex-col gap-0.5">
              {/*
                Verified first, then the two customer claims. The order is the
                point: a reviewer reads what the record says before reading what
                anyone remembers, and the customer's two values sit together
                below it as the pair of statements they are.
              */}
              <ComparisonRow
                label={COLUMN_LISTING}
                value={row.listingValue}
                absentText={LISTING_VALUE_ABSENT}
                verified
              />
              {/*
                Rendered only when the customer actually said what they ordered.
                An always-present blank row here would invite it to be read as
                "the customer expected nothing", and worse, would sit in the
                shape of a value waiting to be filled from the listing.
              */}
              {row.expectedValue !== null && (
                <ComparisonRow label={COLUMN_EXPECTED} value={row.expectedValue} />
              )}
              <ComparisonRow label={COLUMN_REPORTED} value={row.reportedValue} />
            </dl>
            {/*
              The sentence the value came from, when the value is not already
              the sentence. A reviewer deciding whether "13 cm" is a wrong item
              or a customer measuring the shade instead of the drop needs the
              words, and they are a few inches from the thread that proves them.
            */}
            {row.customerWording !== null && (
              <p className="mt-1 text-xs opacity-60">
                &ldquo;{row.customerWording}&rdquo;
              </p>
            )}
          </li>
        ))}
      </ul>

      <CustomerEvidenceImages details={details} marketplaceLabel={marketplaceLabel} />
    </section>
  );
}

/**
 * One side of a comparison, with the side it came from always named.
 *
 * `absentText` is supplied only for the listing value. A missing expected value
 * is a real, reportable state — we hold no specification for this attribute —
 * and saying so is what stops the reader assuming the blank means "matches".
 * The customer's own value is never absent, because a row exists only where
 * they stated one.
 */
function ComparisonRow({
  label,
  value,
  absentText,
  verified = false,
}: {
  label: string;
  value: string | null;
  absentText?: string;
  /**
   * Whether this row is the authoritative one.
   *
   * Carried as a flag rather than inferred from the label so the styling cannot
   * drift away from the provenance it signals. Only the listing row sets it,
   * and it is the sole visual difference between the verified value and the two
   * customer claims — which now sit adjacent and would otherwise read as three
   * equivalent facts.
   */
  verified?: boolean;
}) {
  const missing = value === null;
  return (
    <div className="flex items-baseline gap-2">
      <dt
        className={`w-[10.5rem] shrink-0 text-[11px] ${verified ? "font-medium opacity-75" : "opacity-60"}`}
      >
        {label}
      </dt>
      <dd className={`text-sm ${missing ? "italic opacity-50" : ""}`}>
        {missing ? (absentText ?? "") : value}
      </dd>
    </div>
  );
}

/**
 * Photographs the CUSTOMER sent, and nothing else.
 *
 * The images come from `customerEvidenceImages`, whose only input is this
 * conversation's own inbound messages — see that function for why listing and
 * return photographs cannot reach it. Nothing is substituted when there are
 * none: a listing shot standing in for a missing customer photo would be a
 * fabricated piece of evidence in a case that may end in a refund.
 *
 * THE GAP IS STATED, AND WHICH GAP IT IS MATTERS. "The customer sent no
 * photograph" is a fact about the customer and the cue to ask for one, which
 * the damage rules require before anything is offered. "Attachments are not
 * captured" is a fact about our ingestion and says nothing about the customer —
 * on eBay they demonstrably do send photographs, so showing the first sentence
 * there would send a reviewer chasing someone who already complied.
 */
function CustomerEvidenceImages({
  details,
  marketplaceLabel,
}: {
  details: ReturnType<typeof customerReportedProductDetails>;
  marketplaceLabel: string;
}) {
  if (details.imageGap !== null) {
    return (
      <p className="text-xs opacity-60">
        {imageGapMessage(details.imageGap, marketplaceLabel)}
      </p>
    );
  }
  if (details.images.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-[11px] opacity-60">Customer-uploaded images</h3>
      <ul data-testid="customer-evidence-images" className="flex flex-wrap gap-2">
        {details.images.map((attachment) => (
          <li key={attachment.url}>
            <a
              href={attachment.url}
              target="_blank"
              // noreferrer as well as noopener: the URL is ours, and the page
              // the customer's photo opens in does not need to know where it
              // came from. Same rule as the thread view.
              rel="noopener noreferrer"
              title={attachment.label}
            >
              {/* Plain <img> for the same reason as the thread view: next/image
                  would need the storage host in next.config remotePatterns and
                  would route customer photographs through the optimiser. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachment.url}
                alt={attachment.label}
                loading="lazy"
                className="max-h-32 max-w-[120px] rounded border border-black/10 object-cover transition-opacity hover:opacity-90 dark:border-white/15"
              />
            </a>
          </li>
        ))}
      </ul>
    </div>
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
   * the customer reported about the product and which images they attached.
   * Nothing here fetches it again, and nothing derived from it is stored.
   */
  messages: readonly ReportingMessage[];
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
  /**
   * The resolved listing text, TAGGED WITH THE CONVERSATION IT CAME FROM.
   *
   * The tag is not defensive padding. `OrderContextFacts` is keyed by
   * conversation and refetches on a switch, so for the render between "new
   * conversation selected" and "its context arrived" a bare string would still
   * hold the PREVIOUS conversation's listing — and this panel would show one
   * customer's complaint beside another customer's product specification.
   * Comparing the tag makes that unrepresentable rather than merely unlikely.
   */
  const [listing, setListing] = useState<{
    conversationId: string;
    text: string | null;
  } | null>(null);

  if (conversation === null) {
    return <p className="p-5 text-sm opacity-70">No conversation selected.</p>;
  }

  const listingText = listing?.conversationId === conversation.id ? listing.text : null;

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
        <SectionHeading>Human action needed</SectionHeading>
        <StatusBadge state={conversation.workflowState} />
        <dl className="mt-1 flex flex-col gap-1 text-sm">
          <Row label="Messages" value={String(conversation.messageCount)} />
          <Row label="First" value={`${first.date} ${first.time}`} />
          <Row label="Latest" value={`${last.date} ${last.time}`} />
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading>Context</SectionHeading>
        {conversation.listingItemRef !== null && (
          <ListingReference
            // Prefixed, because `OrderContextFacts` below is a sibling in this
            // same section and is keyed by the same conversation id. Two
            // siblings sharing a key is a React error, not a style point.
            key={`item-ref-${conversation.id}`}
            conversationId={conversation.id}
            itemRef={conversation.listingItemRef}
            marketplaceLabel={capability.label}
            resolvable={capability.listingLinkResolvable}
          />
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
          onListingResolved={(text) =>
            setListing({ conversationId: conversation.id, text })
          }
        />
      </section>

      {/*
        Its own section, a sibling of Context rather than nested inside it.
        Nested, its heading sat at the same indent as the order-context heading
        directly above and read as a second heading for the same block. What the
        customer reported is conversation-level anyway — their complaint is true
        of the thread whichever order a reviewer picks — so a section of its own
        is also the more honest placement. Renders nothing at all when the
        customer reported no product details and attached no images.
      */}
      <CustomerReportedProductDetails
        listingText={listingText}
        messages={messages}
        marketplace={conversation.marketplace}
        marketplaceLabel={capability.label}
      />
    </div>
  );
}

/**
 * A sidebar section heading.
 *
 * ONE COLOUR FOR EVERY SECTION. Per-section tints were tried and read as
 * meaning — a reviewer looks for why Context is one colour and Order context
 * another, and there is no answer. A single muted green says "this is a
 * heading" and nothing more, which is all a heading should say.
 *
 * TEXT COLOUR ONLY — no background, no pill, no radius. The sidebar already
 * carries status pills and category chips; boxed headings would compete with
 * the badges that are the thing actually worth noticing.
 */
export const SECTION_HEADING_CLASS = "text-teal-800 dark:text-teal-300";

function SectionHeading({ children }: { children: string }) {
  return (
    <h2
      className={`text-[11px] font-medium tracking-wide uppercase ${SECTION_HEADING_CLASS}`}
    >
      {children}
    </h2>
  );
}

function Row({
  label,
  value,
  href,
  linkTitle,
}: {
  label: string;
  value: string | null;
  /**
   * Makes the VALUE the link, rather than adding a second control beside it.
   *
   * A reference and a "view listing" button next to it would be two things to
   * read where there is one thing to know: this reference names that listing.
   * The row keeps its layout either way, so a linked row and a plain one still
   * line up with every other row in the section.
   */
  href?: string;
  linkTitle?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs opacity-70">{label}</dt>
      <dd className="truncate text-right text-sm">
        {href === undefined || value === null ? (
          (value ?? "")
        ) : (
          <a
            href={href}
            target="_blank"
            // noreferrer as well as noopener, matching the customer-image links
            // above: the marketplace does not need to be told which internal
            // page the agent opened it from.
            rel="noopener noreferrer"
            title={linkTitle}
            // Light blue, and the only coloured value in the sidebar: every
            // other row is body text, so the colour is what says "this one is
            // clickable" before a reviewer has hovered anything. Underlined as
            // well, because colour alone is not an affordance for a reader who
            // cannot distinguish it.
            className="text-sky-500 underline decoration-sky-500/40 underline-offset-2 hover:decoration-sky-500 dark:text-sky-300 dark:decoration-sky-300/40 dark:hover:decoration-sky-300"
          >
            {value}
          </a>
        )}
      </dd>
    </div>
  );
}
