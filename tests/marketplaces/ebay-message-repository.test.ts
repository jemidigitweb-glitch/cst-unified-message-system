import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { EbaySourceRow } from "@/lib/marketplaces/ebay/adapter";
import {
  DEFAULT_FETCH_LIMIT,
  MAX_FETCH_LIMIT,
  type Queryable,
  assertSourceReadOnly,
  buildFetchQuery,
  classifyRows,
  fetchMessages,
} from "@/lib/marketplaces/ebay/message-repository";

function row(overrides: Partial<EbaySourceRow> = {}): EbaySourceRow {
  return {
    id: "1",
    ext_message_id: "900",
    message_id: "123456789012",
    sub_source: 1,
    item_id: "555",
    folder_id: 0,
    message_type: "AskSellerQuestion",
    sender_id: "buyer",
    receiver_id: "seller",
    receive_date: "2026-08-01 10:00:00",
    body_raw: JSON.stringify("hello"),
    ...overrides,
  };
}

const BOOTSTRAP = { mode: "bootstrap", startAt: "2026-07-01 00:00:00" } as const;
const RESUME = {
  mode: "after",
  watermark: { sourceTimestamp: "2026-08-01 10:00:00", sourcePk: "42" },
} as const;

describe("fetch query construction", () => {
  it("selects only from the verified eBay source relations", () => {
    const { text } = buildFetchQuery({ window: BOOTSTRAP });
    expect(text).toContain("customer_service.ebay_message_headers");
    expect(text).toContain("customer_service.ebay_messages");
    expect(text.trimStart().startsWith("SELECT")).toBe(true);
  });

  it("joins body to header on the verified relationship", () => {
    const { text } = buildFetchQuery({ window: BOOTSTRAP });
    expect(text).toMatch(/LEFT JOIN[\s\S]*ON b\.message_id = h\.ext_message_id/);
  });

  it("left joins so headers without a body are still seen", () => {
    const { text } = buildFetchQuery({ window: BOOTSTRAP });
    expect(text).toContain("LEFT JOIN");
    expect(text).not.toMatch(/\bINNER JOIN\b/);
  });

  it("keeps the naive source timestamp as text so no zone is applied", () => {
    const { text } = buildFetchQuery({ window: BOOTSTRAP });
    expect(text).toContain("h.receive_date::text");
    expect(text).not.toMatch(/AT TIME ZONE/i);
    expect(text).not.toMatch(/::\s*timestamptz/i);
  });

  it("orders by source timestamp then source PK in every window mode", () => {
    for (const window of [BOOTSTRAP, RESUME, { mode: "unbounded_backfill" } as const]) {
      expect(buildFetchQuery({ window }).text).toMatch(
        /ORDER BY h\.receive_date ASC, h\.id ASC/,
      );
    }
  });

  it("bounds the limit", () => {
    expect(buildFetchQuery({ window: BOOTSTRAP, limit: 99_999 }).values.at(-1)).toBe(
      MAX_FETCH_LIMIT,
    );
    expect(buildFetchQuery({ window: BOOTSTRAP }).values.at(-1)).toBe(DEFAULT_FETCH_LIMIT);
    expect(() => buildFetchQuery({ window: BOOTSTRAP, limit: 0 })).toThrow(/positive integer/);
    expect(() => buildFetchQuery({ window: BOOTSTRAP, limit: -5 })).toThrow(/positive integer/);
    expect(() => buildFetchQuery({ window: BOOTSTRAP, limit: 1.5 })).toThrow(/positive integer/);
  });
});

describe("bootstrap window", () => {
  it("parameterises the bootstrap start timestamp", () => {
    const { text, values } = buildFetchQuery({ window: BOOTSTRAP, limit: 50 });
    expect(values).toEqual(["2026-07-01 00:00:00", 50]);
    expect(text).toContain("h.receive_date >= $1::timestamp");
    expect(text).not.toContain("2026-07-01");
  });

  it("includes the exact boundary instant rather than losing it", () => {
    // `>=`, not `>`: a row landing precisely on the chosen start must be read.
    expect(buildFetchQuery({ window: BOOTSTRAP }).text).toMatch(/receive_date >= \$1/);
    expect(buildFetchQuery({ window: BOOTSTRAP }).text).not.toMatch(/receive_date > \$1/);
  });

  it("excludes rows before the bootstrap start", () => {
    const { text } = buildFetchQuery({ window: BOOTSTRAP });
    expect(text).toContain("WHERE");
    expect(text).toMatch(/WHERE h\.receive_date >= \$1::timestamp/);
  });

  it("hard-codes no business bootstrap duration", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "marketplaces", "ebay", "message-repository.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const pattern of [/interval/i, /\b7\s*days?\b/i, /\b30\s*days?\b/i, /\b90\s*days?\b/i]) {
      expect(source).not.toMatch(pattern);
    }
  });
});

describe("resume window", () => {
  it("parameterises the watermark pair", () => {
    const { text, values } = buildFetchQuery({ window: RESUME, limit: 50 });
    expect(values).toEqual(["2026-08-01 10:00:00", "42", 50]);
    expect(text).not.toContain("2026-08-01 10:00:00");
    expect(text).not.toContain("42");
  });

  it("uses a row-value comparison so the PK breaks a timestamp tie", () => {
    expect(buildFetchQuery({ window: RESUME }).text).toMatch(
      /\(h\.receive_date, h\.id\) > \(\$1::timestamp, \$2::bigint\)/,
    );
  });

  it("is strictly after the pair, so pagination neither skips nor duplicates", () => {
    const { text } = buildFetchQuery({ window: RESUME });
    // `>` on the whole row: the boundary row itself is excluded (no duplicate),
    // while later rows sharing its second are still returned (no skip).
    expect(text).toMatch(/\) > \(/);
    expect(text).not.toMatch(/\) >= \(/);
  });
});

describe("unbounded backfill", () => {
  it("is an explicit opt-in, never a default", () => {
    // The window is a required argument, so there is no way to reach an
    // unbounded read without naming it.
    const { text, values } = buildFetchQuery({ window: { mode: "unbounded_backfill" } });
    expect(text).not.toContain("WHERE");
    expect(values).toEqual([DEFAULT_FETCH_LIMIT]);
  });
});

describe("no value is interpolated into SQL text", () => {
  it("keeps every supplied value in the parameter array", () => {
    for (const options of [
      { window: BOOTSTRAP, limit: 77 },
      { window: RESUME, limit: 77 },
      { window: { mode: "unbounded_backfill" } as const, limit: 77 },
    ]) {
      const { text, values } = buildFetchQuery(options);
      for (const value of values) {
        expect(text).not.toContain(String(value));
      }
    }
  });
});

describe("row classification", () => {
  it("normalizes a usable row", () => {
    const result = classifyRows([row()]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      marketplace: "ebay",
      sourceDatabase: "ledsone",
      sourceSchema: "customer_service",
      sourceTable: "ebay_message_headers",
      sourcePk: "1",
      subSourceId: 1,
      listingItemRef: "555",
      counterpartyRef: "buyer",
      direction: "inbound",
      sourceTimestamp: "2026-08-01 10:00:00",
      bodyText: "hello",
      bodyDecodeStatus: "decoded",
    });
  });

  it("excludes system notices and counts them", () => {
    const result = classifyRows([
      row(),
      row({ id: "2", message_type: null, ext_message_id: null, body_raw: null }),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.systemNoticeCount).toBe(1);
    expect(result.rowsExamined).toBe(2);
  });

  it("keeps a genuine message that merely lacks one notice attribute", () => {
    // Both attributes are required; either alone must not hide a real message.
    const typedButBodiless = classifyRows([row({ message_type: "ContactEbayMember", ext_message_id: null })]);
    expect(typedButBodiless.systemNoticeCount).toBe(0);
    expect(typedButBodiless.messages).toHaveLength(1);

    const untypedWithBody = classifyRows([row({ message_type: null, ext_message_id: "900" })]);
    expect(untypedWithBody.systemNoticeCount).toBe(0);
    expect(untypedWithBody.messages).toHaveLength(1);
  });

  it("counts unusable rows instead of coercing them", () => {
    const result = classifyRows([
      row({ id: "2", folder_id: 7 }),
      row({ id: "3", sub_source: null }),
      row({ id: "4", sender_id: null }),
    ]);
    expect(result.messages).toHaveLength(0);
    expect(result.unusableCount).toBe(3);
  });

  it("treats eBay's zero item sentinel as no listing", () => {
    expect(classifyRows([row({ item_id: "0" })]).messages[0]?.listingItemRef).toBeNull();
    expect(classifyRows([row({ item_id: null })]).messages[0]?.listingItemRef).toBeNull();
  });

  it("reads the counterparty from the side matching the direction", () => {
    const outbound = classifyRows([
      row({ folder_id: 1, sender_id: "seller", receiver_id: "buyer" }),
    ]);
    expect(outbound.messages[0]?.direction).toBe("outbound");
    expect(outbound.messages[0]?.counterpartyRef).toBe("buyer");
  });

  it("adds no order, SKU, or product fact to a message", () => {
    const message = classifyRows([row()]).messages[0]!;
    for (const forbidden of ["orderNumber", "sku", "exactSku", "productTitle", "listingUrl"]) {
      expect(message).not.toHaveProperty(forbidden);
    }
  });
});

describe("body decoding through the repository", () => {
  it("decodes a JSON string body", () => {
    expect(classifyRows([row({ body_raw: '"plain text"' })]).messages[0]).toMatchObject({
      bodyText: "plain text",
      bodyDecodeStatus: "decoded",
    });
  });

  it("treats JSON null and a missing body as empty", () => {
    expect(classifyRows([row({ body_raw: "null" })]).messages[0]).toMatchObject({
      bodyText: null,
      bodyDecodeStatus: "empty",
    });
    expect(classifyRows([row({ body_raw: null })]).messages[0]).toMatchObject({
      bodyText: null,
      bodyDecodeStatus: "empty",
    });
  });

  it("marks an unexpected representation as a decode failure", () => {
    for (const raw of ["{not json", '{"a":1}', "[1,2]", "42"]) {
      expect(classifyRows([row({ body_raw: raw })]).messages[0]).toMatchObject({
        bodyText: null,
        bodyDecodeStatus: "failed",
      });
    }
  });
});

describe("fetchMessages", () => {
  it("passes the built query to the client and classifies the result", async () => {
    const calls: unknown[] = [];
    const client: Queryable = {
      query: async (config) => {
        calls.push(config);
        return { rows: [row(), row({ id: "2", message_type: null, ext_message_id: null })] };
      },
    };
    const result = await fetchMessages(client, { window: BOOTSTRAP, limit: 10 });
    expect(result.messages).toHaveLength(1);
    expect(result.systemNoticeCount).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("read-only guard", () => {
  it("accepts a read-only connection to the expected source database", async () => {
    const client: Queryable = {
      query: async () => ({ rows: [{ read_only: "on", db: "ledsone" }] }),
    };
    await expect(assertSourceReadOnly(client)).resolves.toBeUndefined();
  });

  it("refuses a writable connection", async () => {
    const client: Queryable = {
      query: async () => ({ rows: [{ read_only: "off", db: "ledsone" }] }),
    };
    await expect(assertSourceReadOnly(client)).rejects.toThrow(/not read-only/);
  });

  it("refuses the wrong database", async () => {
    const client: Queryable = {
      query: async () => ({ rows: [{ read_only: "on", db: "somewhere_else" }] }),
    };
    await expect(assertSourceReadOnly(client)).rejects.toThrow(/not the expected source database/);
  });
});

describe("source safety: no write SQL in the marketplace layer", () => {
  const DIR = join(__dirname, "..", "..", "lib", "marketplaces");

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return files(full);
      return extname(entry) === ".ts" ? [full] : [];
    });
  }

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  }

  it("issues no data- or schema-modifying statement", () => {
    const offenders: string[] = [];
    for (const file of files(DIR)) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const verb of [
        "INSERT INTO",
        "UPDATE ",
        "DELETE FROM",
        "CREATE ",
        "ALTER ",
        "DROP ",
        "TRUNCATE",
        "GRANT ",
        "REVOKE ",
      ]) {
        if (source.toUpperCase().includes(verb)) offenders.push(`${file} :: ${verb.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("implements no unsupported marketplace", () => {
    const root = join(__dirname, "..", "..", "lib", "marketplaces");
    const implemented = readdirSync(root).filter((entry) =>
      statSync(join(root, entry)).isDirectory(),
    );
    expect(implemented).toEqual(["ebay"]);
  });
});
