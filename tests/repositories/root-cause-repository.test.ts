import { describe, expect, it } from "vitest";

import {
  GET_CONVERSATION_SOURCE_ROWS_SQL,
  type Queryable,
  ROOT_CAUSE_SOURCE_KEYS,
  isSafeSqlIdentifier,
  loadMessageAppRootCause,
} from "@/lib/repositories/root-cause-repository";

/**
 * The lookup, against fake clients. No database is touched.
 *
 * Synthetic identities only: source primary keys are invented numbers and every
 * root cause is a business classification, not customer content.
 */

type Call = { text: string; values?: unknown[] };

/** A client that answers every statement with the same rows, recording calls. */
function client(rows: unknown[]): { calls: Call[]; queryable: Queryable } {
  const calls: Call[] = [];
  return {
    calls,
    queryable: {
      query: async (config) => {
        calls.push(config);
        return { rows };
      },
    },
  };
}

function identity(table: string, sourcePk: string, schema = "customer_service") {
  return { source_schema: schema, source_table: table, source_pk: sourcePk };
}

/** The five marketplaces, each named by the source table CST records for it. */
const MARKETPLACE_TABLES = [
  { marketplace: "eBay", table: "ebay_message_headers", rootCause: "FULFILMENT_CARRIER" },
  { marketplace: "Amazon", table: "amazon_messages", rootCause: "PRODUCT_QUALITY" },
  { marketplace: "Shopify", table: "shopify_messages", rootCause: "OUT OF STOCK" },
  { marketplace: "B&Q", table: "bandq_messages", rootCause: "Delivery Issue" },
  { marketplace: "Temu", table: "temu_messages", rootCause: "RETURN" },
] as const;

describe("every marketplace CST ingests can be read", () => {
  it("covers all five source tables and nothing else", () => {
    expect([...ROOT_CAUSE_SOURCE_KEYS].sort()).toEqual(
      MARKETPLACE_TABLES.map((entry) => `customer_service.${entry.table}`).sort(),
    );
  });

  for (const entry of MARKETPLACE_TABLES) {
    it(`resolves an existing ${entry.marketplace} root cause`, async () => {
      const app = client([identity(entry.table, "4001")]);
      const source = client([{ source_pk: "4001", root_cause: entry.rootCause }]);

      const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "77");

      expect(lookup.rootCause.state).toBe("resolved");
      expect(lookup.rootCause.value).toBe(entry.rootCause);
      expect(lookup.sourceRowCount).toBe(1);
      expect(lookup.unreadableRowCount).toBe(0);

      // Read from the marketplace's own table, by primary key, bound.
      expect(source.calls).toHaveLength(1);
      expect(source.calls[0]!.text).toContain(`FROM customer_service.${entry.table}`);
      expect(source.calls[0]!.text).toContain("WHERE id = ANY($1::bigint[])");
      expect(source.calls[0]!.values).toEqual([["4001"]]);
    });
  }

  it("reads eBay from the header table, which is where the column lives", () => {
    // `ebay_messages` is the BODY table and carries no root cause. It is also
    // never what the sync records as `source_table`; asserting it is absent keeps
    // a future edit from pointing this at the join partner.
    expect(ROOT_CAUSE_SOURCE_KEYS).toContain("customer_service.ebay_message_headers");
    expect(ROOT_CAUSE_SOURCE_KEYS).not.toContain("customer_service.ebay_messages");
  });
});

describe("the conversation's rows come from CST's own threading", () => {
  it("selects source identities for one conversation, newest first", () => {
    expect(GET_CONVERSATION_SOURCE_ROWS_SQL).toContain("FROM cst_app.conversation_messages");
    expect(GET_CONVERSATION_SOURCE_ROWS_SQL).toContain("WHERE conversation_id = $1::bigint");
    // Newest first, with the PK cast for the tiebreak exactly as GET_MESSAGES
    // does -- a text sort would order row 9 after row 10.
    expect(GET_CONVERSATION_SOURCE_ROWS_SQL).toContain(
      "ORDER BY source_ts DESC, source_pk::bigint DESC",
    );
  });

  it("builds no thread of its own from sender, item, subject or mailbox", () => {
    // The message application rebuilds a thread per marketplace at read time.
    // This must not: CST already grouped these rows and stored the decision.
    for (const column of ["sender_id", "item_id", "subject", "mail_id", "receive_date"]) {
      expect(GET_CONVERSATION_SOURCE_ROWS_SQL).not.toContain(column);
    }
  });

  it("asks the conversation's id and nothing about its content", async () => {
    const app = client([]);
    const source = client([]);

    await loadMessageAppRootCause(app.queryable, source.queryable, "1234");

    expect(app.calls).toHaveLength(1);
    expect(app.calls[0]!.values).toEqual(["1234"]);
  });

  it("does not query the source at all when the conversation has no rows", async () => {
    const app = client([]);
    const source = client([]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "5");

    expect(source.calls).toEqual([]);
    expect(lookup.rootCause.state).toBe("unavailable");
    expect(lookup.sourceRowCount).toBe(0);
  });
});

describe("resolution across a conversation's rows", () => {
  it("asks once per table and once per key, however many rows repeat it", async () => {
    const app = client([
      identity("shopify_messages", "9"),
      identity("shopify_messages", "8"),
      identity("shopify_messages", "9"),
    ]);
    const source = client([
      { source_pk: "9", root_cause: "RETURN" },
      { source_pk: "8", root_cause: "RETURN" },
    ]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "31");

    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]!.values).toEqual([["9", "8"]]);
    expect(lookup.rootCause.state).toBe("resolved");
    expect(lookup.sourceRowCount).toBe(3);
  });

  it("does not invent a value when the source row carries none", async () => {
    const app = client([identity("amazon_messages", "11")]);
    const source = client([{ source_pk: "11", root_cause: null }]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "12");

    expect(lookup.rootCause.state).toBe("unavailable");
    expect(lookup.rootCause.value).toBeNull();
    expect(lookup.unreadableRowCount).toBe(0);
  });

  it("does not invent a value when the source no longer has the row", async () => {
    const app = client([identity("temu_messages", "404")]);
    const source = client([]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "13");

    expect(lookup.rootCause.state).toBe("unavailable");
    // An absent row is a legitimate absence, not a failure to report: the source
    // is authoritative and may have removed it.
    expect(lookup.unreadableRowCount).toBe(0);
  });

  it("refuses to choose when the conversation's rows disagree", async () => {
    const app = client([identity("bandq_messages", "3"), identity("bandq_messages", "2")]);
    const source = client([
      { source_pk: "3", root_cause: "INVOICE" },
      { source_pk: "2", root_cause: "Delivery Issue" },
    ]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "14");

    expect(lookup.rootCause.state).toBe("ambiguous");
    expect(lookup.rootCause.value).toBeNull();
    expect(lookup.rootCause.distinctLabelCount).toBe(2);
  });

  it("preserves a free-text root cause through the whole lookup", async () => {
    const prose = "Parcel scanned as delivered but the customer has not received it.";
    const app = client([identity("ebay_message_headers", "60")]);
    const source = client([{ source_pk: "60", root_cause: prose }]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "15");

    expect(lookup.rootCause.value).toBe(prose);
  });
});

describe("rows that cannot be read are counted, never guessed", () => {
  it("skips and counts a source table that is not on the allowlist", async () => {
    const app = client([identity("ebay_messages", "7")]);
    const source = client([]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "16");

    expect(source.calls).toEqual([]);
    expect(lookup.unreadableRowCount).toBe(1);
    expect(lookup.sourceRowCount).toBe(1);
    // "We could not look" must not read as "nothing is recorded" -- the state is
    // the same, and the count is what tells them apart.
    expect(lookup.rootCause.state).toBe("unavailable");
  });

  it("skips and counts a schema that is not the marketplace source schema", async () => {
    const app = client([identity("shopify_messages", "7", "public")]);
    const source = client([]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "17");

    expect(source.calls).toEqual([]);
    expect(lookup.unreadableRowCount).toBe(1);
  });

  it("skips and counts a primary key that is not a number", async () => {
    // The key is cast to bigint so the source can use its primary-key index. A
    // non-numeric key would make the statement throw, taking the whole section
    // down for one bad row.
    const app = client([identity("temu_messages", "not-a-number")]);
    const source = client([]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "18");

    expect(source.calls).toEqual([]);
    expect(lookup.unreadableRowCount).toBe(1);
  });

  it("still resolves from the readable rows beside an unreadable one", async () => {
    const app = client([
      identity("ebay_messages", "1"),
      identity("ebay_message_headers", "2"),
    ]);
    const source = client([{ source_pk: "2", root_cause: "MARKETPLACE_ADMIN" }]);

    const lookup = await loadMessageAppRootCause(app.queryable, source.queryable, "19");

    expect(lookup.rootCause.state).toBe("resolved");
    expect(lookup.rootCause.value).toBe("MARKETPLACE_ADMIN");
    expect(lookup.unreadableRowCount).toBe(1);
  });
});

describe("the source statements are reads, built from reviewed literals", () => {
  it("accepts only a plain lower-case SQL identifier", () => {
    expect(isSafeSqlIdentifier("ebay_message_headers")).toBe(true);
    expect(isSafeSqlIdentifier("customer_service")).toBe(true);
    expect(isSafeSqlIdentifier("id")).toBe(true);
    for (const unsafe of [
      "messages; DROP TABLE orders",
      'messages" --',
      "Messages",
      "public.messages",
      "",
      "1_table",
    ]) {
      expect(isSafeSqlIdentifier(unsafe)).toBe(false);
    }
  });

  it("issues no statement that could modify anything", async () => {
    const app = client([
      identity("ebay_message_headers", "1"),
      identity("shopify_messages", "2"),
    ]);
    const source = client([{ source_pk: "1", root_cause: "RETURN" }]);

    await loadMessageAppRootCause(app.queryable, source.queryable, "20");

    const statements = [...app.calls, ...source.calls].map((call) => call.text);
    expect(statements.length).toBeGreaterThan(1);
    for (const text of statements) {
      expect(text.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
      for (const verb of [
        "INSERT",
        "UPDATE",
        "DELETE",
        "CREATE",
        "ALTER",
        "DROP",
        "TRUNCATE",
        "MERGE",
        "FOR UPDATE",
      ]) {
        expect(text.toUpperCase()).not.toContain(verb);
      }
    }
  });
});
