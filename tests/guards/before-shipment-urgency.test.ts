import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ResponseSlaTimer } from "@/components/response-sla-timer";
import { UrgentFlag } from "@/components/urgent-flag";
import {
  BEFORE_SHIPMENT_MARKETPLACE,
  BEFORE_SHIPMENT_RECENCY_HOURS,
  BEFORE_SHIPPING_CATEGORY,
  type BeforeShipmentInput,
  beforeShipmentEligibility,
} from "@/lib/domain/before-shipment-urgency";
import { ORDER_CHANGE_CATEGORY } from "@/lib/domain/inbox";
import {
  RESPONSE_SLA_MINUTES,
  SLA_NOT_CONFIGURED_TEXT,
  formatDuration,
  formatSlaDueAt,
  isSlaCritical,
  responseSlaStatus,
} from "@/lib/domain/response-sla";
import { staffClosedTheOrder } from "@/lib/knowledge/staff-resolution";
import { type Queryable, listConversations } from "@/lib/repositories/conversation-repository";

/**
 * The before-shipment urgent rule and the response SLA.
 *
 * Synthetic data throughout. No real customer message, order or address appears.
 */

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/** An eligible conversation. Each test spoils exactly one condition. */
function eligible(overrides: Partial<BeforeShipmentInput> = {}): BeforeShipmentInput {
  return {
    lastDirection: "inbound",
    inboxPlacement: "reply_inbox",
    platformNotice: false,
    staffClosedTheOrder: false,
    marketplace: "amazon",
    everReplied: false,
    ageHours: 2,
    orderChangeIntent: true,
    orderNumber: "LED65289",
    shipment: { dispatched: false },
    ...overrides,
  };
}

/* ------------------------------------------------------------------------- *
 * THE RULE
 * ------------------------------------------------------------------------- */

describe("a customer message on a linked, unshipped order is urgent", () => {
  it("fires when all three conditions hold", () => {
    expect(beforeShipmentEligibility(eligible())).toBe("eligible");
  });

  /** The case area is the classifier's own value, not a second spelling of it. */
  it("tags it Order change, before shipping queries", () => {
    expect(BEFORE_SHIPPING_CATEGORY).toBe(ORDER_CHANGE_CATEGORY);
    expect(BEFORE_SHIPPING_CATEGORY).toBe("Order change, before shipping queries");
  });

  /**
   * NO TEXT REACHES THIS MODULE. The intent is supplied as a BOOLEAN the
   * repository computed from the newest inbound message, so the cancellation
   * vocabulary still lives only in `message-category.ts` and
   * `message-priority.ts` — there is no string here for a keyword to arrive
   * through and no second detector to drift from the first.
   */
  it("takes no customer text as input at all", () => {
    expect(Object.keys(eligible()).sort()).toEqual(
      [
        "ageHours",
        "everReplied",
        "inboxPlacement",
        "marketplace",
        "orderChangeIntent",
        "lastDirection",
        "orderNumber",
        "platformNotice",
        "shipment",
        "staffClosedTheOrder",
      ].sort(),
    );
    // Comments stripped first: the doc-comment explaining WHY cancellation
    // wording is not read names that wording, and must not trip its own guard.
    const source = read("lib", "domain", "before-shipment-urgency.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/new RegExp|\.test\(|cancel|stop dispatch/i);
  });
});

describe("the rule does not fire", () => {
  /** REQUIRED CASE: no matching order. */
  it("when no order number could be established", () => {
    for (const orderNumber of [null, "", "   "]) {
      expect(
        beforeShipmentEligibility(eligible({ orderNumber })),
        JSON.stringify(orderNumber),
      ).toBe("no_matching_order");
    }
  });

  /**
   * An order the SOURCE has no record of is ALSO "no matching order", and
   * deliberately not "not dispatched". An absence is not a window: reading it
   * as one would promise that a parcel nobody can find can still be stopped.
   */
  it("when the source has no record of the matched order", () => {
    expect(beforeShipmentEligibility(eligible({ shipment: null }))).toBe("no_matching_order");
  });

  /** REQUIRED CASE: already dispatched. */
  it("when the order has already shipped", () => {
    expect(beforeShipmentEligibility(eligible({ shipment: { dispatched: true } }))).toBe(
      "already_dispatched",
    );
  });

  /** REQUIRED CASE: a promotional or system email mentioning cancellation. */
  it("for a platform or system notice, whatever it says", () => {
    expect(beforeShipmentEligibility(eligible({ platformNotice: true }))).toBe(
      "not_a_customer_conversation",
    );
    for (const placement of ["filtered", "outbound_only"] as const) {
      expect(
        beforeShipmentEligibility(eligible({ inboxPlacement: placement })),
        placement,
      ).toBe("not_a_customer_conversation");
    }
  });

  /**
   * AMAZON ONLY: a thread we have already replied in is a conversation in
   * progress, not an untouched request.
   */
  it("on Amazon, when we have replied in the thread at all", () => {
    expect(
      beforeShipmentEligibility(eligible({ marketplace: "amazon", everReplied: true })),
    ).toBe("already_replied");
  });

  /**
   * EVERY OTHER MARKETPLACE KEEPS ITS EXISTING BEHAVIOUR. The same thread — we
   * replied, the customer came back — is still urgent on eBay, Shopify, B&Q and
   * Temu, because "the customer spoke last" is the condition those have always
   * used. The restriction is Amazon's alone.
   */
  it.each(["ebay", "shopify", "bandq", "temu"])(
    "but %s still counts a thread we replied in",
    (marketplace) => {
      expect(beforeShipmentEligibility(eligible({ marketplace, everReplied: true }))).toBe(
        "eligible",
      );
    },
  );

  it("the scoped marketplace is stated once", () => {
    expect(BEFORE_SHIPMENT_MARKETPLACE).toBe("amazon");
  });

  it("when we answered last, so nobody is waiting on us", () => {
    expect(beforeShipmentEligibility(eligible({ lastDirection: "outbound" }))).toBe(
      "no_customer_action_needed",
    );
    expect(beforeShipmentEligibility(eligible({ lastDirection: null }))).toBe(
      "no_customer_action_needed",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * THE RECENCY WINDOW — 24h / 48h / 72h all count; older does not
 * ------------------------------------------------------------------------- */

describe("every before-shipping query in the window counts", () => {
  it("includes 24, 48 and 72 hours old alike", () => {
    for (const ageHours of [0, 1, 24, 48, 71, 72]) {
      expect(beforeShipmentEligibility(eligible({ ageHours })), `${ageHours}h`).toBe("eligible");
    }
  });

  it("drops anything past the window", () => {
    for (const ageHours of [72.5, 100, 24 * 30]) {
      expect(beforeShipmentEligibility(eligible({ ageHours })), `${ageHours}h`).toBe("too_old");
    }
  });

  /** An unknown age cannot satisfy a recency condition. */
  it("drops a conversation whose arrival time is unknown", () => {
    expect(beforeShipmentEligibility(eligible({ ageHours: null }))).toBe("too_old");
  });

  it("states the window as one number", () => {
    expect(BEFORE_SHIPMENT_RECENCY_HOURS).toBe(72);
  });
});

/* ------------------------------------------------------------------------- *
 * RESOLVED THREADS — our own reply said it was dispatched or cancelled
 * ------------------------------------------------------------------------- */

describe("a thread CST already closed is not urgent", () => {
  it("drops it when our last reply said the order went out or was stopped", () => {
    expect(beforeShipmentEligibility(eligible({ staffClosedTheOrder: true }))).toBe(
      "thread_resolved",
    );
  });

  it.each([
    "Your order has been dispatched this morning.",
    "This has now been despatched.",
    "We have cancelled your order as requested.",
    "Your order has been cancelled.",
    "The refund has been processed.",
    "Shipment is done, tracking number is AB123456789GB.",
    "It is on its way to you.",
  ])("reads %j as closing the order", (text) => {
    expect(staffClosedTheOrder(text)).toBe(true);
  });

  /**
   * THE SENTENCE THIS EXISTS FOR. "Your order has NOT been dispatched yet" is
   * the commonest reply in a before-shipment thread, and a phrase match would
   * read it as the exact opposite — closing the very conversations the feature
   * is meant to raise.
   */
  it.each([
    "Your order has not been dispatched yet.",
    "It has not been shipped so far.",
    "Your order has not been cancelled.",
    "Would you like us to cancel it?",
    "Shall I check whether it has been dispatched?",
    "Our dispatch team will look at this today.",
    "Please see our cancellation policy for details.",
    "",
  ])("does not read %j as closing the order", (text) => {
    expect(staffClosedTheOrder(text)).toBe(false);
  });

  it("reads our reply and never the customer's message", () => {
    const source = read("lib", "knowledge", "staff-resolution.ts");
    expect(source).toContain("outboundText");
  });
});

/* ------------------------------------------------------------------------- *
 * OLD CANCELLATION TEXT DOES NOT KEEP A THREAD URGENT
 * ------------------------------------------------------------------------- */

describe("old text cannot keep a conversation urgent", () => {
  /**
   * THE DEFECT THIS RULE REPLACED. Urgency used to be read across every customer
   * message in the thread, so a cancellation asked for months ago kept its
   * conversation red forever — including after the parcel was delivered.
   *
   * There is now no path from any message, old or new, to the flag. What
   * decides is the order's CURRENT state and the thread's CURRENT state, so an
   * answered thread, a shipped order or an old one each drop out on their own.
   */
  it("has no text input that an old message could reach", () => {
    const shipped = beforeShipmentEligibility(
      eligible({ shipment: { dispatched: true }, ageHours: 24 * 90 }),
    );
    expect(shipped).not.toBe("eligible");

    // The same conversation, answered: still not urgent, whatever was said.
    expect(beforeShipmentEligibility(eligible({ lastDirection: "outbound" }))).not.toBe(
      "eligible",
    );
  });

  it("evaluates the newest inbound message only, never the thread's history", () => {
    const repository = read("lib", "repositories", "conversation-repository.ts");
    // The clock and the closing signal both read ONE message, with LIMIT 1.
    expect(repository).toContain("LATEST_INBOUND_INSTANT");
    expect(repository).toContain("LATEST_OUTBOUND_TEXT");
    // The sweep does not feed thread-wide text into the urgency decision.
    expect(repository).toContain("beforeShipmentEligibility");
  });
});

/* ------------------------------------------------------------------------- *
 * ORDERING — URGENT ABOVE NORMAL, ACROSS PAGINATION
 * ------------------------------------------------------------------------- */

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    marketplace: "ebay",
    sub_source_id: 7,
    counterparty_ref: "buyer-a",
    listing_item_ref: "listing-1",
    workflow_state: "received",
    needs_context: false,
    inbox_visibility: "reply_inbox",
    first_source_ts: "2026-09-20 10:00:00",
    last_source_ts: "2026-09-20 10:00:00",
    message_count: 1,
    inbound_count: 1,
    last_direction: "inbound",
    inbound_texts: ["Can I change the delivery address?"],
    latest_inbound_text: "Please cancel my order.",
    ...overrides,
  };
}

/**
 * A sweep candidate: a conversation row plus its verified order.
 *
 * The order number is SYNTHETIC and shaped like eBay's only in that it is a
 * string. A real one used to sit here; `no-customer-data.test.ts` is right that it
 * should not, and nothing in this file depends on the format.
 */
function candidate(overrides: Record<string, unknown> = {}) {
  return row({
    order_number: "ORDER-SWEEP-1",
    sla_starts_at: new Date("2026-09-22T08:00:00Z"),
    latest_outbound_text: null,
    ever_replied: false,
    ...overrides,
  });
}

const NOW = new Date("2026-09-22T10:00:00Z");
const isSweep = (sql: string) => sql.includes("context_snapshots");

function fake(page: unknown[][], sweep: unknown[][] = []) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let p = 0;
  let s = 0;
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      return { rows: isSweep(config.text) ? (sweep[s++] ?? []) : (page[p++] ?? []) };
    },
  };
  return { calls, client };
}

/** A source that reports the given orders as dispatched or not. */
function fakeSource(dispatched: boolean) {
  return {
    query: async (config: { values?: readonly unknown[] }) => {
      const numbers = (config.values?.[0] ?? []) as string[];
      return {
        rows: numbers.map((orderNumber) => ({
          sub_source_id: 104,
          order_number: orderNumber,
          order_status: "Inprogress",
          shipped_time: dispatched ? "2026-09-21 09:00:00" : null,
          has_completed_shipment: dispatched,
        })),
      };
    },
  };
}

describe("an urgent conversation is ordered above the ordinary stream", () => {
  it("puts an unshipped-order conversation above newer ordinary ones", async () => {
    const { client } = fake(
      [
        [
          row({ id: "new-1", last_source_ts: "2026-09-22 09:00:00" }),
          row({ id: "new-2", last_source_ts: "2026-09-22 08:00:00" }),
        ],
      ],
      [[candidate({ id: "unshipped", last_source_ts: "2026-09-20 10:00:00" })]],
    );
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    expect(page.items.map((item) => item.id)).toEqual(["unshipped", "new-1", "new-2"]);
    expect(page.items[0]!.urgent).toBe(true);
    expect(page.items[0]!.beforeShipmentOutcome).toBe("eligible");
    // Re-tagged with the case area, from the classifier's own vocabulary.
    expect(page.items[0]!.category).toBe(BEFORE_SHIPPING_CATEGORY);
    // And the SLA clock start travels with it.
    expect(page.items[0]!.slaStartsAt).toBe("2026-09-22T08:00:00.000Z");
    expect(page.urgentCount).toBe(1);
  });

  /**
   * URGENCY AND THE TAG ARE SEPARATE, and this is the table that proves it.
   *
   * Every row here is an unanswered customer on a real, UNSHIPPED order, so
   * every row is URGENT — the window is open whatever they asked about. Only
   * the ones actually asking to change or stop the order are RE-TAGGED.
   *
   * Run through `listConversations` rather than the pure function, so these
   * assert the vocabulary the system actually uses rather than a boolean a
   * fixture set.
   */
  it.each([
    ["Please cancel my order.", true],
    ["Stop dispatch, I ordered the wrong size.", true],
    ["Can I change the delivery address before it goes out?", true],
    // Ordinary traffic on an unshipped order: urgent, but NOT an order change.
    ["Where is my parcel?", false],
    ["Is this light dimmable?", false],
    ["The shade arrived cracked.", false],
    ["Can I have a VAT invoice?", false],
  ])("is urgent for %j, and re-tags only when it is an order change (%s)", async (latest, retagged) => {
    const { client } = fake([[]], [[candidate({ id: "c1", inbound_texts: [latest], latest_inbound_text: latest })]]);
    const page = await listConversations(client, {
      marketplace: "amazon",
      source: fakeSource(false),
      now: NOW,
    });
    // The window is open regardless of the subject.
    expect(page.items[0]!.urgent, latest).toBe(true);
    expect(page.items[0]!.category === BEFORE_SHIPPING_CATEGORY, latest).toBe(retagged);
  });

  /**
   * THE AMAZON OVER-TAGGING DEFECT, PINNED.
   *
   * A pre-sales question on an unshipped order must not be filed as an order
   * change just because the parcel has not left the warehouse. It stays urgent
   * — the customer is waiting and we can still help — and keeps the category
   * the phrase table read.
   */
  it("does not file a pre-sales question as an order change", async () => {
    const latest =
      "This link shows white ceiling fittings. Is there an option for a dome cone the same colour as the shade?";
    const { client } = fake([[]], [[candidate({ id: "c1", inbound_texts: [latest], latest_inbound_text: latest })]]);
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    expect(page.items[0]!.urgent).toBe(true);
    expect(page.items[0]!.category).not.toBe(BEFORE_SHIPPING_CATEGORY);
  });

  /**
   * OLD TEXT CANNOT DECIDE THE TAG. The thread's history contains a
   * cancellation; the newest message does not. Only the newest is read, so the
   * conversation is urgent on the open window but is not filed as an order
   * change on a request that is no longer being made.
   */
  it("reads the newest message only when deciding the tag", async () => {
    const { client } = fake(
      [[]],
      [
        [
          candidate({
            id: "c1",
            inbound_texts: ["Please cancel my order.", "Actually, where is my parcel?"],
            latest_inbound_text: "Actually, where is my parcel?",
          }),
        ],
      ],
    );
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    expect(page.items[0]!.category).not.toBe(BEFORE_SHIPPING_CATEGORY);
  });

  /** REQUIRED CASE: a dispatched order is not lifted. */
  it("does not lift a candidate whose order has already shipped", async () => {
    const { client } = fake([[row({ id: "ordinary" })]], [[candidate({ id: "shipped" })]]);
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: fakeSource(true),
      now: NOW,
    });
    expect(page.items.map((item) => item.id)).toEqual(["ordinary"]);
    expect(page.urgentCount).toBe(0);
  });

  /**
   * NO SOURCE, NO FLAG. An unknown dispatch state is never read as "not
   * dispatched" — the inbox still loads and nothing is urgent.
   */
  it("flags nothing when the dispatch state cannot be read", async () => {
    const { client } = fake([[row({ id: "ordinary" })]], [[candidate({ id: "unknown" })]]);
    const page = await listConversations(client, {
      marketplace: "ebay",
      source: null,
      now: NOW,
    });
    expect(page.items.map((item) => item.id)).toEqual(["ordinary"]);
    expect(page.urgentCount).toBe(0);
  });

  /** The sweep reads the whole marketplace, not the loaded page. */
  it("scans past the current page", async () => {
    const { calls, client } = fake([[row()]]);
    await listConversations(client, {
      marketplace: "ebay",
      limit: 2,
      offset: 40,
      source: fakeSource(false),
      now: NOW,
    });
    const sweep = calls.find((call) => isSweep(call.text))!;
    expect(sweep.text).not.toContain("OFFSET");
    expect(sweep.values).toContain(BEFORE_SHIPMENT_RECENCY_HOURS);
    expect(sweep.values).not.toContain(40);
  });

  it("holds the urgent ids out of the ordinary stream, and serves the block once", async () => {
    const sweep = [[candidate({ id: "urgent-1" })]];
    const first = fake([[row({ id: "ordinary" })]], sweep);
    await listConversations(first.client, {
      marketplace: "ebay",
      source: fakeSource(false),
      now: NOW,
    });
    const pageCall = first.calls.find((call) => !isSweep(call.text))!;
    expect(pageCall.values![4]).toEqual(["urgent-1"]);

    const second = await listConversations(
      fake([[row({ id: "older" })]], sweep).client,
      { marketplace: "ebay", offset: 100, source: fakeSource(false), now: NOW },
    );
    expect(second.items.map((item) => item.id)).toEqual(["older"]);
    expect(second.urgentCount).toBe(0);
  });
});

/* ------------------------------------------------------------------------- *
 * THE RED INDICATOR AND THE SLA TIMER
 * ------------------------------------------------------------------------- */

describe("the urgent indicator", () => {
  const classNameOf = (element: unknown) =>
    String((element as { props: { className: unknown } }).props.className);

  it("renders a red badge for an urgent conversation", () => {
    const element = UrgentFlag({ urgent: true });
    expect(element).not.toBeNull();
    expect(classNameOf(element)).toMatch(/\bbg-red-\d{3}\b/);
    expect(classNameOf(element)).toContain("text-white");
  });

  it("renders nothing for an ordinary conversation", () => {
    expect(UrgentFlag({ urgent: false })).toBeNull();
  });

  it("is not interactive", () => {
    expect(read("components", "urgent-flag.tsx")).not.toMatch(
      /onClick|onSubmit|<button|<a\s|href=|<form/,
    );
  });
});

describe("the response SLA timer", () => {
  const received = new Date("2026-09-22T09:00:00Z");

  /** BLOCKER, PINNED. No approved duration exists, so none was invented. */
  it("has no invented duration", () => {
    expect(RESPONSE_SLA_MINUTES).toBeNull();
  });

  it("says so rather than showing a countdown, while that is true", () => {
    const status = responseSlaStatus({
      targetMinutes: RESPONSE_SLA_MINUTES,
      receivedAt: received,
      now: NOW,
    });
    expect(status.state).toBe("not_configured");
    expect(isSlaCritical(status)).toBe(false);
  });

  it("reports an unestablished arrival time rather than guessing one", () => {
    const status = responseSlaStatus({ targetMinutes: 30, receivedAt: null, now: NOW });
    expect(status.state).toBe("unknown_received_time");
    expect(isSlaCritical(status)).toBe(false);
  });

  /** Minutes-based, with an explicit target so the unit is proved today. */
  it("counts down in minutes", () => {
    const status = responseSlaStatus({
      targetMinutes: 90,
      receivedAt: received,
      now: new Date("2026-09-22T09:30:00Z"),
    });
    expect(status).toEqual({
      state: "within",
      targetMinutes: 90,
      dueAt: new Date("2026-09-22T10:30:00Z"),
      minutesLeft: 60,
    });
    expect(isSlaCritical(status)).toBe(false);
  });

  /** REQUIRED CASE: the overdue state. */
  it("expires, and reports how far overdue", () => {
    const status = responseSlaStatus({
      targetMinutes: 30,
      receivedAt: received,
      now: new Date("2026-09-22T10:38:00Z"),
    });
    expect(status.state).toBe("expired");
    expect(status.state === "expired" && status.minutesOver).toBe(68);
    expect(isSlaCritical(status)).toBe(true);
  });

  /** Landing exactly on the deadline is met, not missed. */
  it("treats the deadline moment itself as met", () => {
    const status = responseSlaStatus({
      targetMinutes: 60,
      receivedAt: received,
      now: new Date("2026-09-22T10:00:00Z"),
    });
    expect(status.state).toBe("within");
    expect(isSlaCritical(status)).toBe(false);
  });

  it("states the due time in SL time, always labelled", () => {
    const rendered = formatSlaDueAt(new Date("2026-09-22T10:30:00Z"));
    // 10:30 UTC is 16:00 in Asia/Colombo (UTC+5:30).
    expect(rendered).toContain("16:00");
    expect(rendered).toContain("SL time");
  });

  it("keeps minutes visible at every scale", () => {
    expect(formatDuration(8)).toBe("8m");
    expect(formatDuration(90)).toBe("1h 30m");
    expect(formatDuration(0)).toBe("0m");
  });

  /* --- the panel --- */

  const panel = (status: Parameters<typeof ResponseSlaTimer>[0]["status"]) =>
    ResponseSlaTimer({ status }) as {
      props: { className: string; children: unknown[]; "aria-label": string };
    };

  it("renders the heading and the not-configured line today", () => {
    const element = panel({ state: "not_configured" });
    expect(element.props["aria-label"]).toBe("Response SLA");
    expect(JSON.stringify(element.props.children)).toContain(SLA_NOT_CONFIGURED_TEXT);
    // An absence is never red.
    expect(element.props.className).not.toMatch(/\bborder-red-|\bbg-red-/);
  });

  it("goes red and says CRITICAL / ESCALATE with the overdue duration", () => {
    const element = panel({
      state: "expired",
      targetMinutes: 30,
      dueAt: new Date("2026-09-22T09:30:00Z"),
      minutesOver: 68,
    });
    expect(element.props.className).toMatch(/\bborder-red-\d{3}\b/);
    const rendered = JSON.stringify(element.props.children);
    expect(rendered).toContain("Critical");
    expect(rendered).toContain("Escalate");
    expect(rendered).toContain("1h 8m");
    expect(rendered).toContain("Time expired");
  });

  it("shows the due time and time left while within the target", () => {
    const rendered = JSON.stringify(
      panel({
        state: "within",
        targetMinutes: 30,
        dueAt: new Date("2026-09-22T10:30:00Z"),
        minutesLeft: 12,
      }).props.children,
    );
    expect(rendered).toContain("Due");
    expect(rendered).toContain("Time left");
    expect(rendered).toContain("12m");
  });

  it("reads no clock of its own", () => {
    const source = read("components", "response-sla-timer.tsx");
    expect(source).not.toMatch(/Date\.now|new Date\(/);
  });
});

/* ------------------------------------------------------------------------- *
 * IT PRIORITISES WORK AND DOES NOTHING ELSE
 * ------------------------------------------------------------------------- */

describe("no sending, cancellation or order-changing capability was added", () => {
  const NEW_FILES = [
    ["lib", "domain", "before-shipment-urgency.ts"],
    ["lib", "domain", "response-sla.ts"],
    ["lib", "knowledge", "staff-resolution.ts"],
    ["lib", "repositories", "order-shipment-state-repository.ts"],
    ["components", "urgent-flag.tsx"],
    ["components", "response-sla-timer.tsx"],
  ];

  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("contains no verb that would act on an order", () => {
    for (const file of [...NEW_FILES, ["lib", "repositories", "conversation-repository.ts"]]) {
      const source = stripComments(read(...file));
      for (const pattern of [
        /\bcancelOrder\b/i,
        /\bcancelShipment\b/i,
        /\bstopDispatch\b/i,
        /\bholdDispatch\b/i,
        /\bupdateOrderStatus\b/i,
        /\bsetOrderStatus\b/i,
        /\bsendReply\b/i,
        /\bsendMessage\b/i,
        /\bsendToMarketplace\b/i,
        /\bnotifyCustomer\b/i,
        /\bmarketplaceCredentials\b/i,
      ]) {
        expect(source, `${file.join("/")} :: ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("opens no network connection", () => {
    for (const file of NEW_FILES) {
      expect(stripComments(read(...file)), file.join("/")).not.toMatch(
        /\bfetch\s*\(|XMLHttpRequest|axios|https?:\/\/|WebSocket|nodemailer|smtp/i,
      );
    }
  });

  /**
   * THE SOURCE DATABASE IS READ, NEVER WRITTEN. The one new statement against it
   * is a SELECT, and the pool it runs on pins `default_transaction_read_only`.
   */
  it("writes to no database, and only reads the source", () => {
    const shipment = stripComments(read("lib", "repositories", "order-shipment-state-repository.ts"));
    expect(shipment).toContain("SELECT");
    expect(shipment).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|TRUNCATE)\s/);
    expect(
      stripComments(read("lib", "repositories", "conversation-repository.ts")),
    ).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE)\s/);
  });

  it("adds no mutating endpoint", () => {
    const route = read("app", "api", "conversations", "route.ts");
    expect(route).toContain("export async function GET");
    expect(route).not.toMatch(/export async function (?:POST|PUT|PATCH|DELETE)/);
  });

  /** The flag is observed, never set: no override, no stored column, no endpoint. */
  it("cannot be set by hand", () => {
    expect(read("app", "api", "conversations", "route.ts")).not.toMatch(
      /setUrgent|markUrgent|urgentOverride/i,
    );
  });
});
