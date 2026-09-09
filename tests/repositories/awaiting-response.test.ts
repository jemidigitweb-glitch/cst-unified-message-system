import { describe, expect, it } from "vitest";

import { ORDER_CHANGE_CATEGORY, UNAVAILABLE_BODY_TEXT } from "@/lib/domain/inbox";
import { CONVERSATION_MARKETPLACES } from "@/lib/domain/marketplace-capabilities";
import { classifyConversationCategory } from "@/lib/knowledge/message-category";
import {
  DEFAULT_INBOX_LIMIT,
  MAX_INBOX_LIMIT,
  type Queryable,
  listAwaitingResponseByCategory,
} from "@/lib/repositories/conversation-repository";

/**
 * The order-change notification read layer.
 *
 * WHAT A FAKE CLIENT CAN AND CANNOT PROVE, stated once so no assertion below
 * is read as more than it is.
 *
 *   CAN  — the category condition, in full. It runs in application code, over
 *          the classifier itself, so "a cancellation appears and a delivery
 *          chase does not" is a real behavioural test with a real classifier
 *          behind it.
 *   CAN  — every mapping, bound, ordering and parameter, and the read-only
 *          guarantee.
 *   CANNOT — execute SQL. The draft and reply exclusions are predicates in the
 *          statement, so they are asserted STRUCTURALLY: the exact text is
 *          pinned here, and a change to it fails this file. That is the same
 *          standard `conversation-repository.test.ts` already holds the No Rule
 *          queries to; a live check belongs in the source-validation suite.
 *
 * Every row below is synthetic. No customer text, address or reference appears.
 */

/** A candidate row: the inbox projection plus the newest customer message. */
function awaitingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    marketplace: "ebay",
    sub_source_id: 7,
    counterparty_ref: "counterparty-a",
    listing_item_ref: "listing-1",
    workflow_state: "received",
    needs_context: false,
    inbox_visibility: "reply_inbox",
    first_source_ts: "2026-08-01 10:00:00",
    last_source_ts: "2026-08-02 10:00:00",
    message_count: 1,
    inbound_count: 1,
    last_direction: "inbound",
    inbound_texts: ["Please cancel my order."],
    latest_inbound_ts: "2026-08-02 10:00:00",
    latest_inbound_body: "Please cancel my order.",
    latest_inbound_decode_status: "decoded",
    /**
     * Whether a draft has been written. Defaults to false — the ordinary case —
     * and is a LABEL on the row, never a reason to omit it. Override it to
     * true to represent a conversation that has been drafted but not answered.
     */
    has_draft: false,
    /**
     * Position within its OWN marketplace's window. The query gives every
     * marketplace a window of the same size and overfetches one row of each, so
     * the repository drops anything past the bound — a fixture with no rank
     * would be silently dropped, which is what this default prevents.
     */
    rank_in_marketplace: 1,
    ...overrides,
  };
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

const listOrderChange = (rows: unknown[], limit?: number) => {
  const { calls, client } = fake([rows]);
  return listAwaitingResponseByCategory(client, {
    marketplaces: ["ebay"],
    category: ORDER_CHANGE_CATEGORY,
    limit,
  }).then((page) => ({ page, calls }));
};

/** The global feed: every conversation-backed marketplace, as the route asks for it. */
const listGlobal = (rows: unknown[], limit?: number) => {
  const { calls, client } = fake([rows]);
  return listAwaitingResponseByCategory(client, {
    marketplaces: CONVERSATION_MARKETPLACES,
    category: ORDER_CHANGE_CATEGORY,
    limit,
  }).then((page) => ({ page, calls }));
};

/* ------------------------------------------------------------------------- *
 * THE CATEGORY CONDITION — behavioural, against the real classifier
 * ------------------------------------------------------------------------- */

describe("category matching", () => {
  it("watches the classifier's own vocabulary, not a hand-typed string", () => {
    // A compile error if the wording ever moves, and proof here that the
    // constant is the same value the classifier produces for this text.
    expect(ORDER_CHANGE_CATEGORY).toBe("Order change, before shipping queries");
    expect(classifyConversationCategory(["Please cancel my order."])).toBe(
      ORDER_CHANGE_CATEGORY,
    );
  });

  it("includes an unanswered order-change conversation", async () => {
    const { page } = await listOrderChange([awaitingRow()]);
    expect(page.items.map((item) => item.id)).toEqual(["1"]);
    expect(page.items[0]!.category).toBe(ORDER_CHANGE_CATEGORY);
  });

  it("excludes every other category", async () => {
    const others = [
      ["Where is my parcel?", "Delivery queries"],
      ["The item arrived damaged.", "Damage queries"],
      ["Is this light dimmable?", "Pre sales queries"],
      ["I would like to return this item.", "Return and refunds"],
    ] as const;

    for (const [text, expected] of others) {
      const { page } = await listOrderChange([
        awaitingRow({ inbound_texts: [text], latest_inbound_body: text }),
      ]);
      // Read from the classifier itself, so this compares the repository's
      // filter against the category authority rather than a second copy of it.
      expect(classifyConversationCategory([text]), text).toBe(expected);
      expect(page.items, text).toEqual([]);
    }
  });

  it("keeps the matching conversation and drops the rest from one page", async () => {
    const { page } = await listOrderChange([
      awaitingRow({ id: "1", inbound_texts: ["Where is my parcel?"] }),
      awaitingRow({ id: "2" }),
      awaitingRow({ id: "3", inbound_texts: ["The item arrived damaged."] }),
    ]);
    expect(page.items.map((item) => item.id)).toEqual(["2"]);
    // ...and it says how many it had to read to find that one.
    expect(page.scanned).toBe(3);
  });

  /**
   * Inherited from `categoryFor`, not decided here. These marketplaces' stored
   * text is known to carry non-customer content, so they classify to null by
   * construction and no row of theirs can equal a requested category.
   */
  it("returns nothing for a marketplace whose category is suppressed", async () => {
    for (const marketplace of ["bandq", "temu"] as const) {
      const { calls, client } = fake([[awaitingRow({ marketplace })]]);
      const page = await listAwaitingResponseByCategory(client, {
        marketplaces: [marketplace],
        category: ORDER_CHANGE_CATEGORY,
      });
      expect(page.items, marketplace).toEqual([]);
      // Dropped BEFORE the query, so nothing is read and nothing is scanned:
      // a round trip whose result cannot contain a match is not worth making.
      expect(calls, marketplace).toHaveLength(0);
      expect(page.scanned, marketplace).toBe(0);
      expect(page.marketplaces, marketplace).toEqual([]);
    }
  });

  it("creates no second category detector", async () => {
    const { calls } = await listOrderChange([]);
    const sql = calls[0]!.text.toLowerCase();
    // The category is neither selected, stored, joined nor compared in SQL.
    expect(sql).not.toContain("category");
    expect(sql).not.toContain("order change");
    expect(sql).not.toContain("cancel");
  });
});

/* ------------------------------------------------------------------------- *
 * A DRAFT IS NOT A REPLY
 *
 * THE BUG THIS SECTION EXISTS FOR. The statement used to carry a second
 * exclusion — `NOT EXISTS (SELECT 1 FROM cst_app.draft_replies ...)` — so
 * generating a draft removed the conversation from the notification feed. The
 * customer had not been answered; nothing had been sent, and nothing in this
 * application CAN send. The badge simply stopped mentioning them.
 *
 * A draft now decides how a row is LABELLED and never whether it appears.
 * ------------------------------------------------------------------------- */

describe("a draft does not retire a notification", () => {
  it("keeps a drafted conversation on the list", async () => {
    const { page } = await listOrderChange([awaitingRow({ has_draft: true })]);
    expect(page.items.map((item) => item.id)).toEqual(["1"]);
    expect(page.items[0]!.hasDraft).toBe(true);
  });

  /**
   * The regression, stated as the property that failed: two conversations
   * identical but for the draft must both be listed. Before the fix the second
   * one vanished.
   */
  it("lists a drafted and an undrafted conversation alike", async () => {
    const { page } = await listOrderChange([
      awaitingRow({ id: "1", has_draft: false }),
      awaitingRow({ id: "2", has_draft: true }),
    ]);
    expect(page.items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(page.items.map((item) => item.hasDraft)).toEqual([false, true]);
  });

  /**
   * The draft table must not be filtered on again. Pinned structurally because
   * a fake client cannot execute SQL: `draft_replies` may be SELECTed for the
   * label, but it may never appear inside a NOT EXISTS.
   */
  it("never excludes on the draft row", async () => {
    const { calls } = await listOrderChange([]);
    const sql = calls[0]!.text;
    expect(sql).toContain("cst_app.draft_replies");
    expect(sql).not.toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+cst_app\.draft_replies/i);
  });

  /**
   * `workflow_state` is a PROXY and must not become the filter either — least
   * of all now. A saved human edit appends a revision and advances no state, and
   * `reviewed` is this system's terminal state with no transport after it, so
   * neither value says a customer was answered.
   */
  it("does not substitute the workflow state for a reply", async () => {
    const { calls } = await listOrderChange([]);
    expect(calls[0]!.text).not.toMatch(/workflow_state\s*=/);
    expect(calls[0]!.text).not.toContain("'received'");
    expect(calls[0]!.text).not.toContain("'reviewed'");
  });

  /** A reviewed conversation with no reply on the thread is still someone waiting. */
  it("keeps a reviewed conversation that was never replied to", async () => {
    const { page } = await listOrderChange([
      awaitingRow({ workflow_state: "reviewed", has_draft: true }),
    ]);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.workflowState).toBe("reviewed");
    expect(page.items[0]!.hasDraft).toBe(true);
  });

  /** Only a true boolean counts, so a driver returning "t" or 1 cannot mislabel every row. */
  it("reads the draft flag strictly", async () => {
    for (const raw of [false, null, undefined, 0, "f"]) {
      const { page } = await listOrderChange([awaitingRow({ has_draft: raw })]);
      expect(page.items[0]!.hasDraft, String(raw)).toBe(false);
    }
  });
});

describe("no reply after the customer's newest message", () => {
  it("excludes a conversation replied to after that message", async () => {
    const { calls } = await listOrderChange([]);
    const sql = calls[0]!.text;
    expect(sql).toContain("FROM cst_app.conversation_messages o");
    expect(sql).toContain("o.direction = 'outbound'");
    // Row-value comparison against the newest inbound message's own
    // (timestamp, source pk), so a reply landing in the same second is ordered
    // rather than missed.
    expect(sql).toContain(
      "(o.source_ts, o.source_pk::bigint) > (latest.source_ts, latest.source_pk)",
    );
  });

  it("resolves the newest customer message the way every other view orders", async () => {
    const { calls } = await listOrderChange([]);
    const sql = calls[0]!.text;
    expect(sql).toContain("cm.direction = 'inbound'");
    expect(sql).toContain("ORDER BY cm.source_ts DESC, cm.source_pk::bigint DESC");
    expect(sql).toContain("LIMIT 1");
  });

  /**
   * An inner lateral, so a conversation with no customer message at all — the
   * outbound-only threads — cannot reach this list. That is the "a customer
   * message exists" condition, expressed once.
   */
  it("requires a customer message through the join itself", async () => {
    const { calls } = await listOrderChange([]);
    expect(calls[0]!.text).toContain("JOIN LATERAL");
    expect(calls[0]!.text).not.toContain("LEFT JOIN LATERAL");
  });

  it("orders the list by the customer's newest message, newest first", async () => {
    const { calls } = await listOrderChange([]);
    expect(calls[0]!.text).toContain("ORDER BY latest.source_ts DESC, c.id DESC");
  });
});

/* ------------------------------------------------------------------------- *
 * WHAT A ROW CARRIES
 * ------------------------------------------------------------------------- */

describe("the notification row", () => {
  it("carries every inbox field plus the newest customer message", async () => {
    const { page } = await listOrderChange([awaitingRow()]);
    expect(page.items[0]).toEqual({
      id: "1",
      marketplace: "ebay",
      subSourceId: 7,
      counterpartyRef: "counterparty-a",
      listingItemRef: "listing-1",
      workflowState: "received",
      needsContext: false,
      inboxPlacement: "reply_inbox",
      firstSourceTimestamp: "2026-08-01 10:00:00",
      lastSourceTimestamp: "2026-08-02 10:00:00",
      messageCount: 1,
      inboundCount: 1,
      lastDirection: "inbound",
      category: ORDER_CHANGE_CATEGORY,
      priority: "HIGH",
      latestCustomerMessageAt: "2026-08-02 10:00:00",
      latestCustomerMessagePreview: "Please cancel my order.",
      hasDraft: false,
    });
  });

  it("keeps the stored timestamp verbatim, applying no timezone", async () => {
    const { calls, page } = await listOrderChange([awaitingRow()]);
    expect(calls[0]!.text).toContain("u.latest_ts::text");
    expect(calls[0]!.text).not.toMatch(/AT TIME ZONE/i);
    expect(page.items[0]!.latestCustomerMessageAt).toBe("2026-08-02 10:00:00");
  });

  it("truncates the preview rather than shipping the whole message", async () => {
    // Only the body column is long. The classification column is left alone so
    // this measures the preview and nothing else.
    const long = `Please cancel my order. ${"x".repeat(500)}`;
    const { page } = await listOrderChange([awaitingRow({ latest_inbound_body: long })]);
    const preview = page.items[0]!.latestCustomerMessagePreview;
    expect(preview.length).toBeLessThan(long.length);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("renders an unreadable body as the shared copy, never as raw content", async () => {
    const { page } = await listOrderChange([
      awaitingRow({ latest_inbound_body: '{"raw":1}', latest_inbound_decode_status: "failed" }),
    ]);
    expect(page.items[0]!.latestCustomerMessagePreview).toBe(UNAVAILABLE_BODY_TEXT);
  });

  it("exposes no source table, ranking or connection metadata", async () => {
    const { page } = await listOrderChange([awaitingRow()]);
    for (const leaked of [
      "source_database",
      "source_schema",
      "source_table",
      "source_pk",
      "latest_inbound_body",
      // The per-marketplace rank is bookkeeping for the bound. It decides
      // nothing a reader should see and must not reach the browser.
      "rank_in_marketplace",
      "password",
      "host",
    ]) {
      expect(page.items[0]).not.toHaveProperty(leaked);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * BOUNDS, PARAMETERS AND THE READ-ONLY GUARANTEE
 * ------------------------------------------------------------------------- */

describe("bounding and paging", () => {
  it("bounds the candidate set, not the matches", async () => {
    const { calls } = await listOrderChange([]);
    expect(calls[0]!.values![1]).toBe(DEFAULT_INBOX_LIMIT + 1);

    const capped = await listOrderChange([], 99_999);
    expect(capped.calls[0]!.values![1]).toBe(MAX_INBOX_LIMIT + 1);
  });

  it("reports hasMore from the one-extra-row-per-marketplace overfetch", async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      awaitingRow({ id: String(index + 1), rank_in_marketplace: index + 1 }),
    );

    const exact = await listOrderChange(rows.slice(0, 2), 2);
    expect(exact.page.items).toHaveLength(2);
    expect(exact.page.scanned).toBe(2);
    expect(exact.page.hasMore).toBe(false);

    const overflow = await listOrderChange(rows, 2);
    // The third row is rank 3 in a window of 2 — it proved an older unanswered
    // conversation exists and is neither returned nor classified.
    expect(overflow.page.items).toHaveLength(2);
    expect(overflow.page.scanned).toBe(2);
    expect(overflow.page.hasMore).toBe(true);
  });

  /**
   * THE POINT OF PARTITIONING. Measured live, Shopify has 3,342 unanswered
   * conversations to Amazon's 44, so one shared window is ~90% Shopify and the
   * Amazon conversation waiting for a reply falls out of it entirely. Each
   * marketplace gets a window of the same size instead.
   */
  it("gives every marketplace its own window, so a busy one cannot crowd out a quiet one", async () => {
    const rows = [
      awaitingRow({ id: "1", marketplace: "shopify", rank_in_marketplace: 1 }),
      awaitingRow({ id: "2", marketplace: "shopify", rank_in_marketplace: 2 }),
      // Rank 3 of Shopify's own window: past a bound of 2, so dropped.
      awaitingRow({ id: "3", marketplace: "shopify", rank_in_marketplace: 3 }),
      // Amazon's FIRST row. Under one shared bound of 2 it would never be
      // reached; under its own window it is rank 1 and always is.
      awaitingRow({ id: "4", marketplace: "amazon", rank_in_marketplace: 1 }),
    ];
    const { page } = await listGlobal(rows, 2);
    expect(page.items.map((item) => item.id)).toEqual(["1", "2", "4"]);
    expect(page.items.map((item) => item.marketplace)).toContain("amazon");
    expect(page.scanned).toBe(3);
    // Shopify was truncated, so the drawer must say it did not reach the end.
    expect(page.hasMore).toBe(true);
  });

  it("asks for one row past the bound, per marketplace", async () => {
    const { calls } = await listGlobal([], 2);
    expect(calls[0]!.values![1]).toBe(3);
    expect(calls[0]!.text).toContain("WHERE u.rank_in_marketplace <= $2");
    expect(calls[0]!.text).toContain("PARTITION BY c.marketplace");
  });

  it("reports a full scan that matched nothing as scanned, not as empty", async () => {
    const { page } = await listOrderChange([
      awaitingRow({ id: "1", inbound_texts: ["Where is my parcel?"] }),
      awaitingRow({ id: "2", inbound_texts: ["Where is my parcel?"] }),
    ]);
    expect(page.items).toEqual([]);
    expect(page.scanned).toBe(2);
  });
});

/* ------------------------------------------------------------------------- *
 * GLOBAL, NOT SCOPED TO A SELECTED TAB
 * ------------------------------------------------------------------------- */

describe("the feed spans marketplaces", () => {
  it("reads every marketplace asked for in one query, parameterised", async () => {
    const { calls } = await listGlobal([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("WHERE c.marketplace = ANY($1::text[])");
    // The list is an array parameter, never interpolated into the statement.
    for (const marketplace of CONVERSATION_MARKETPLACES) {
      expect(calls[0]!.text).not.toContain(marketplace);
    }
    expect(calls[0]!.values![0]).toEqual(["ebay", "amazon", "shopify"]);
  });

  it("drops the suppressed marketplaces from the query rather than the results", async () => {
    const { calls, page } = await listGlobal([]);
    // B&Q and Temu cannot match, so they are not scanned — which matters
    // because they would otherwise consume the row bound that the
    // marketplaces which CAN match are competing for.
    expect(calls[0]!.values![0]).not.toContain("bandq");
    expect(calls[0]!.values![0]).not.toContain("temu");
    // ...and the caller is told what was actually read, rather than assuming
    // it got what it asked for.
    expect(page.marketplaces).toEqual(["ebay", "amazon", "shopify"]);
  });

  it("returns an eBay and an Amazon conversation from the same request", async () => {
    const { page } = await listGlobal([
      awaitingRow({ id: "1", marketplace: "ebay" }),
      awaitingRow({ id: "2", marketplace: "amazon" }),
      awaitingRow({ id: "3", marketplace: "shopify" }),
    ]);
    expect(page.items.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(page.items.map((item) => item.marketplace)).toEqual(["ebay", "amazon", "shopify"]);
  });

  it("carries each item's own marketplace, so a row can name where it came from", async () => {
    const { page } = await listGlobal([awaitingRow({ id: "9", marketplace: "amazon" })]);
    expect(page.items[0]!.marketplace).toBe("amazon");
  });

  /**
   * The ordering is by the customer's newest message ACROSS marketplaces. An
   * older unanswered eBay message is not more urgent than a newer Amazon one,
   * so nothing groups or ranks by marketplace.
   */
  it("orders by the customer's newest message, not by marketplace", async () => {
    const { calls } = await listGlobal([]);
    const sql = calls[0]!.text;
    expect(sql).toContain("ORDER BY latest.source_ts DESC, c.id DESC");
    // The statement's OWN ordering, not the lateral's — sliced from the last
    // ORDER BY so the inner one (which resolves the newest inbound message)
    // cannot satisfy or defeat this.
    const outerOrderBy = sql.slice(sql.lastIndexOf("ORDER BY"));
    expect(outerOrderBy).not.toContain("marketplace");
  });

  it("still serves a single-marketplace read, unchanged", async () => {
    const { calls, page } = await listOrderChange([awaitingRow()]);
    expect(calls[0]!.values![0]).toEqual(["ebay"]);
    expect(page.marketplaces).toEqual(["ebay"]);
    expect(page.items).toHaveLength(1);
  });

  it("issues no query at all when nothing classifiable was asked for", async () => {
    const { calls, client } = fake([[]]);
    const page = await listAwaitingResponseByCategory(client, {
      marketplaces: ["bandq", "temu"],
      category: ORDER_CHANGE_CATEGORY,
    });
    expect(calls).toHaveLength(0);
    expect(page).toEqual({ items: [], scanned: 0, hasMore: false, marketplaces: [] });
  });

  it("issues exactly one query per request", async () => {
    const { calls } = await listOrderChange([awaitingRow(), awaitingRow({ id: "2" })]);
    expect(calls).toHaveLength(1);
  });
});

describe("read-only guarantee", () => {
  it("issues no write statement", async () => {
    const { calls } = await listOrderChange([awaitingRow()]);
    for (const call of calls) {
      for (const statement of [
        "INSERT INTO",
        "UPDATE CST_APP",
        "DELETE FROM",
        "TRUNCATE",
        "DROP TABLE",
        "ALTER TABLE",
        "CREATE TABLE",
      ]) {
        expect(call.text.toUpperCase()).not.toContain(statement);
      }
    }
  });

  it("reads only from cst_app, and never from the marketplace source", async () => {
    const { calls } = await listOrderChange([awaitingRow()]);
    for (const call of calls) {
      const tables = [...call.text.matchAll(/FROM\s+([\w.]+)/g)]
        .map((match) => match[1]!)
        .filter((name) => name.includes("."));
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) expect(table.startsWith("cst_app.")).toBe(true);
      for (const foreign of ["customer_service", "order_management", "issue_tracking", "listings."]) {
        expect(call.text).not.toContain(foreign);
      }
    }
  });

  it("touches no draft, workflow or analysis table beyond asking whether a draft exists", async () => {
    const { calls } = await listOrderChange([awaitingRow()]);
    const sql = calls[0]!.text;
    expect(sql).toContain("cst_app.draft_replies");
    for (const untouched of [
      "draft_revisions",
      "draft_revision_sources",
      "conversation_rule_analysis",
      "ai_usage_log",
      "context_snapshots",
      "audit_log",
    ]) {
      expect(sql).not.toContain(untouched);
    }
  });
});
