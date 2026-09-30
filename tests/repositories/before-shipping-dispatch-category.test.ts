import { describe, expect, it } from "vitest";

import { RETURNS_REFUND_CATEGORY } from "@/lib/domain/before-shipping-dispatch-rule";
import { ORDER_CHANGE_CATEGORY } from "@/lib/domain/inbox";
import {
  type Queryable,
  listAwaitingResponseByCategory,
  listConversations,
} from "@/lib/repositories/conversation-repository";
import type { SourceQueryable } from "@/lib/repositories/order-shipment-state-repository";

/**
 * The before-shipping dispatch rule, as the inbox actually reaches it.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM THE URGENT RULE'S TESTS
 * ------------------------------------------------------------------------
 * The before-shipment urgent rule runs over ONE query — the urgent sweep — whose
 * candidates are reply-inbox threads whose newest message is the customer's. eBay
 * conversation 50802, the thread that forced this work, is neither: our reply is
 * the newest message, so it is never a candidate and its category has only ever
 * come from the ordinary stream. That is the path asserted here.
 *
 * ------------------------------------------------------------------------
 * WHAT A FAKE CLIENT CAN AND CANNOT PROVE
 * ------------------------------------------------------------------------
 *   CAN  — the correction itself, in full. It runs in application code over the
 *          real classifier and the real domain rule, so "a dispatched
 *          cancellation is filed as a return and an undispatched one is not" is
 *          a behavioural test with the real readers behind it.
 *   CAN  — that the source is asked for the RIGHT order, and is not asked at all
 *          when no row could be corrected.
 *   CANNOT — execute SQL. How the order key is fetched is asserted structurally,
 *          on the statement text the fake records.
 *
 * Every row is synthetic: the order numbers are the documented placeholders and
 * the message text is written for this test. See
 * `tests/guards/no-customer-data.test.ts`.
 */

/** The order the customer is asking to cancel. */
const TARGET = "99-99999-99999";
/** Another order on the same buyer's account. Never the target below. */
const SIBLING = "12-34567-89012";

/** The shape of the reported threads, in words written for this test. */
const CHASE = "Buona sera, il mio ordine non e ancora arrivato. Quando arriva?";
const CANCELLATION =
  "Ho ricevuto il lampadario a 1 luce, grazie. Procedo con la cancellazione dell'altro lampadario a 3 luci.";
/** eBay 40467's shape: a post-delivery swap, not a cancellation. */
const SWAP_REQUEST =
  "Thanks for sending the lights so quickly, but three separate lights might suit better. How do we go about swapping them?";

/** When the customer wrote, in every fixture below. */
const MESSAGE_AT = "2026-09-29T08:20:44.000Z";
/** Eight days earlier: unambiguously before the message arrived. */
const DISPATCHED_BEFORE = "2026-09-21 10:26:16";
/** Eight days later: the request WAS a before-shipping request when it was made. */
const DISPATCHED_AFTER = "2026-10-07 10:26:16";

/** A conversation row as the ordinary inbox projection returns it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    marketplace: "ebay",
    sub_source_id: 4,
    counterparty_ref: "buyer-a",
    listing_item_ref: "listing-1",
    workflow_state: "received",
    needs_context: false,
    inbox_visibility: "outbound_only",
    first_source_ts: "2026-09-28 17:34:37",
    last_source_ts: "2026-09-29 11:41:47",
    message_count: 5,
    inbound_count: 2,
    // OURS is the newest message, which is what keeps this conversation out of
    // the urgent sweep entirely — see the header.
    last_direction: "outbound",
    inbound_texts: [CHASE, CANCELLATION],
    /*
     * NO `order_number`. The ordinary inbox projection does not select one — it
     * deliberately does not join `context_snapshots` — so the repository has to
     * ASK for the key, which `orderKeyFake` below answers. Overriding it to a
     * value represents the feeds whose projection does carry it.
     */
    ...overrides,
  };
}

/**
 * The app database's answer to the order-key lookup, keyed by conversation id.
 *
 * It carries the message instant as well, because "had it shipped YET" needs both
 * halves and the ordinary inbox projection supplies neither.
 */
function orderKeyFake(keys: Readonly<Record<string, string | null>> = { "1": TARGET }) {
  return Object.entries(keys).map(([id, order_number]) => ({
    id,
    order_number,
    sla_starts_at: MESSAGE_AT,
  }));
}

/**
 * The source's answer about dispatch state.
 *
 * `shipped_time` ALONE is dispatch — a printed label settles nothing. Defaults to
 * the target having gone, because that is the case this file is about.
 */
function sourceFake(
  orders: readonly { order_number: string; shipped_time?: string | null }[] = [
    { order_number: TARGET, shipped_time: DISPATCHED_BEFORE },
  ],
) {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  const source: SourceQueryable = {
    query: async (config) => {
      calls.push(config);
      return {
        rows: orders.map((order) => ({
          sub_source_id: 4,
          order_number: order.order_number,
          order_status: "Completed",
          shipped_time: order.shipped_time ?? null,
          has_completed_shipment: false,
        })),
      };
    },
  };
  return { source, sourceCalls: calls };
}

function fake(responses: unknown[][]) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let index = 0;
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows: responses[index++] ?? [] };
    },
  };
  return { calls, client };
}

/**
 * The inbox, with no urgent candidates and one ordinary row.
 *
 * `listConversations` issues the urgent sweep first and the ordinary stream
 * second, so the empty first response is the "nothing is urgent" case this
 * conversation is in.
 */
const listInbox = (
  rows: unknown[],
  orders?: Parameters<typeof sourceFake>[0],
  keys?: Readonly<Record<string, string | null>>,
) => {
  // The sweep, then the page, then the order-key lookup — which is only issued
  // when a row on the page could be corrected at all.
  const { calls, client } = fake([[], rows, orderKeyFake(keys)]);
  const { source, sourceCalls } = sourceFake(orders);
  return listConversations(client, { marketplace: "ebay", source }).then((page) => ({
    page,
    calls,
    sourceCalls,
  }));
};

/* ------------------------------------------------------------------------- *
 * THE ORDINARY STREAM
 * ------------------------------------------------------------------------- */

describe("a request whose target order had already shipped", () => {
  it("is filed under Return and refunds, not Order change before shipping", async () => {
    const { page } = await listInbox([row()]);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.category).toBe(RETURNS_REFUND_CATEGORY);
  });

  /**
   * eBay 40467's shape: a post-delivery swap, not a cancellation. Wrong for the
   * same reason and corrected the same way — the ORDER is what decides.
   */
  it("is corrected for a swap request too, not only a cancellation", async () => {
    const { page } = await listInbox([row({ inbound_texts: [SWAP_REQUEST] })]);
    expect(page.items[0]!.category).toBe(RETURNS_REFUND_CATEGORY);
  });

  it("keeps Order change, before shipping while the target has NOT dispatched", async () => {
    const { page } = await listInbox([row()], [{ order_number: TARGET, shipped_time: null }]);
    expect(page.items[0]!.category).toBe(ORDER_CHANGE_CATEGORY);
  });

  /**
   * AND WHERE THE PARCEL LEFT AFTER THE CUSTOMER WROTE. It was a before-shipping
   * request when it was made, so the category keeps saying so — see
   * `DISPATCH_ORDERING_MARGIN_HOURS`. The message instant travels with the order
   * key, which is what makes this decidable on the ordinary stream at all.
   */
  it("keeps it where the order shipped AFTER the message arrived", async () => {
    const { page } = await listInbox([row()], [
      { order_number: TARGET, shipped_time: DISPATCHED_AFTER },
    ]);
    expect(page.items[0]!.category).toBe(ORDER_CHANGE_CATEGORY);
  });

  /**
   * AN ABSENCE IS NOT A DISPATCH, AND NOT A WINDOW EITHER. The source having no
   * record of the order leaves the classifier's reading exactly where it was.
   */
  it("keeps the classifier's category where the source has no such order", async () => {
    const { page } = await listInbox([row()], []);
    expect(page.items[0]!.category).toBe(ORDER_CHANGE_CATEGORY);
  });

  it("looks up the conversation's own order and nothing else", async () => {
    const { sourceCalls } = await listInbox([row()]);
    expect(sourceCalls).toHaveLength(1);
    expect(sourceCalls[0]!.values).toEqual([[TARGET]]);
  });

  /**
   * THE PAYOFF IS USUALLY ZERO CONNECTIONS. A page with no before-shipping
   * conversation on it must not dial the shared production source at all.
   */
  it("asks the source nothing when no row could be corrected", async () => {
    const { sourceCalls, page } = await listInbox([
      row({ inbound_texts: ["My parcel arrived smashed, the glass is in pieces."] }),
    ]);
    expect(sourceCalls).toHaveLength(0);
    expect(page.items[0]!.category).not.toBe(ORDER_CHANGE_CATEGORY);
  });

  it("asks the source nothing when the conversation has no order key", async () => {
    const { sourceCalls, page } = await listInbox([row()], undefined, { "1": null });
    expect(sourceCalls).toHaveLength(0);
    expect(page.items[0]!.category).toBe(ORDER_CHANGE_CATEGORY);
  });

  /**
   * NO SOURCE, NO CORRECTION — the same failure direction the urgent flag takes.
   * An unknown dispatch state is never read as either answer.
   */
  it("loads normally and corrects nothing without a source pool", async () => {
    const { calls, client } = fake([[], [row()]]);
    const page = await listConversations(client, { marketplace: "ebay" });
    expect(page.items[0]!.category).toBe(ORDER_CHANGE_CATEGORY);
    // ...and it does not even ask for the order key: nothing could be done with it.
    expect(calls).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- *
 * THE NEGATIVE CASE, THROUGH THE REPOSITORY
 * ------------------------------------------------------------------------- */

describe("another order's dispatch state cannot reach the decision", () => {
  /**
   * The source answering about a DIFFERENT order than the one asked for. It
   * cannot happen today — `shipmentStateForOrders` keys the map by the order
   * number the source itself returned — and this asserts that it stays that way:
   * the state is carried with its own order number all the way into the domain
   * rule, which compares it against the target before believing it.
   */
  it("ignores a state that belongs to a sibling order", async () => {
    const { page } = await listInbox([row()], [
      { order_number: SIBLING, shipped_time: DISPATCHED_BEFORE },
    ]);
    expect(page.items[0]!.category).toBe(ORDER_CHANGE_CATEGORY);
  });

  /**
   * TWO CONVERSATIONS ON ONE PAGE, ONE DISPATCHED AND ONE NOT. The batched read
   * answers both in one query, and neither row may take the other's answer.
   */
  it("keeps each row on its own order's state within one batched read", async () => {
    const { page, sourceCalls } = await listInbox(
      [row(), row({ id: "2" })],
      [
        { order_number: TARGET, shipped_time: DISPATCHED_BEFORE },
        { order_number: SIBLING, shipped_time: null },
      ],
      { "1": TARGET, "2": SIBLING },
    );
    expect(sourceCalls).toHaveLength(1);
    expect(sourceCalls[0]!.values).toEqual([[TARGET, SIBLING]]);
    expect(page.items.map((item) => item.category)).toEqual([
      RETURNS_REFUND_CATEGORY,
      ORDER_CHANGE_CATEGORY,
    ]);
  });
});

/* ------------------------------------------------------------------------- *
 * THE PROJECTION, ASSERTED STRUCTURALLY
 * ------------------------------------------------------------------------- */

describe("the order key is asked for separately, for a named few ids", () => {
  /**
   * THE ORDINARY INBOX PROJECTION IS UNTOUCHED, and that is a decision rather
   * than an omission. Two suites tell the page query apart from the urgent sweep
   * by whether it mentions `context_snapshots`, and the page query's own header
   * promises every conversation whatever its placement. So the key is fetched by
   * a third statement scoped to the ids that could actually use one.
   */
  it("leaves the page query as it was", async () => {
    const { calls } = await listInbox([row()]);
    const listing = calls[1]!.text;
    expect(listing).not.toContain("context_snapshots");
    expect(listing).not.toContain("AS order_number");
    // Still every conversation, whatever its placement.
    expect(listing).toContain("($2::text IS NULL OR c.inbox_visibility = $2::text)");
  });

  it("asks only for the conversations whose category could change", async () => {
    const { calls } = await listInbox([row(), row({ id: "2", inbound_texts: [CHASE] })], undefined, {
      "1": TARGET,
    });
    // calls[0] the sweep, calls[1] the page, calls[2] the key lookup.
    expect(calls).toHaveLength(3);
    const lookup = calls[2]!;
    expect(lookup.text).toContain("LEFT JOIN cst_app.context_snapshots cs ON cs.conversation_id = c.id");
    // The ingestion layer's sentinel is never sent to the source as an order.
    expect(lookup.text).toContain("c.counterparty_ref LIKE 'unresolved:%'");
    // The delivery chase is not asked about: its category cannot be corrected.
    expect(lookup.values?.[0]).toEqual(["1"]);
    // ...and it carries WHEN the customer wrote, for the "had it shipped yet" half.
    expect(lookup.text).toContain("AS sla_starts_at");
  });

  it("binds the username-keyed marketplace rather than writing it into the SQL", async () => {
    const { calls } = await listInbox([row()]);
    expect(calls[2]!.text).not.toContain("'ebay'");
    expect(calls[2]!.values?.[1]).toBe("ebay");
  });

  /** A projection that already carries the key is never asked about again. */
  it("does not ask where the row already carries the key", async () => {
    const { calls } = await listInbox([row({ order_number: TARGET })]);
    expect(calls).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- *
 * THE NOTIFICATION FEED AGREES WITH THE INBOX
 * ------------------------------------------------------------------------- */

describe("the awaiting-response feed files it the same way", () => {
  /** The awaiting-response projection: the inbox row plus the newest message. */
  const awaitingRow = (overrides: Record<string, unknown> = {}) => ({
    ...row({ inbox_visibility: "reply_inbox", last_direction: "inbound" }),
    // This projection DOES select the order key — see LIST_AWAITING_RESPONSE —
    // so no second lookup is issued for it.
    order_number: TARGET,
    latest_inbound_ts: "2026-09-29 08:20:44",
    latest_inbound_body: CANCELLATION,
    latest_inbound_decode_status: "decoded",
    latest_inbound_text: CANCELLATION,
    latest_outbound_text: null,
    ever_replied: true,
    has_draft: false,
    rank_in_marketplace: 1,
    sla_starts_at: "2026-09-29T08:20:44Z",
    ...overrides,
  });

  const listArea = (category: typeof ORDER_CHANGE_CATEGORY) => {
    const { client } = fake([[awaitingRow()]]);
    const { source } = sourceFake();
    return listAwaitingResponseByCategory(client, {
      marketplaces: ["ebay"],
      category,
      source,
      now: new Date("2026-09-29T12:00:00Z"),
    });
  };

  it("lists a dispatched cancellation under Return and refunds", async () => {
    const page = await listArea(RETURNS_REFUND_CATEGORY);
    expect(page.items.map((item) => item.category)).toEqual([RETURNS_REFUND_CATEGORY]);
  });

  /**
   * AND NO LONGER UNDER THE BEFORE-SHIPPING HEADING, which is the whole point:
   * that panel asserts the order has not shipped.
   */
  it("does not list it under Order change, before shipping", async () => {
    const page = await listArea(ORDER_CHANGE_CATEGORY);
    expect(page.items).toEqual([]);
  });
});
