import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FEED_LIMIT,
  MAX_FEED_LIMIT,
  type Queryable,
  isMissingTableError,
  listUnresolvedMessages,
} from "@/lib/repositories/unresolved-message-repository";

/** Synthetic rows only. No real customer data appears in any test. */
function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "10",
    marketplace: "shopify",
    source_ts: "2026-08-12 08:30:00",
    body_text: "synthetic body",
    body_decode_status: "decoded",
    ...overrides,
  };
}

function fake(responses: unknown[][] | Error) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let index = 0;
  const client: Queryable = {
    query: async (config) => {
      calls.push(config);
      if (responses instanceof Error) throw responses;
      return { rows: responses[index++] ?? [] };
    },
  };
  return { calls, client };
}

function missingTable(): Error {
  return Object.assign(new Error("relation does not exist"), { code: "42P01" });
}

describe("feed listing", () => {
  it("filters to one marketplace, parameterised", async () => {
    const { calls, client } = fake([[messageRow()]]);
    await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(calls[0]!.text).toContain("WHERE marketplace = $1");
    expect(calls[0]!.values![0]).toBe("shopify");
  });

  it("interpolates nothing into the query text", async () => {
    const { calls, client } = fake([[]]);
    await listUnresolvedMessages(client, { marketplace: "shopify", limit: 7 });
    expect(calls[0]!.text).not.toContain("shopify");
    expect(calls[0]!.values).toEqual(["shopify", 7]);
  });

  it("clamps the limit and falls back to the default for a bad one", async () => {
    for (const [limit, expected] of [
      [undefined, DEFAULT_FEED_LIMIT],
      [10_000, MAX_FEED_LIMIT],
      [0, DEFAULT_FEED_LIMIT],
      [-1, DEFAULT_FEED_LIMIT],
      [1.5, DEFAULT_FEED_LIMIT],
    ] as const) {
      const { calls, client } = fake([[]]);
      await listUnresolvedMessages(client, { marketplace: "shopify", limit });
      expect(calls[0]!.values!.at(-1)).toBe(expected);
    }
  });

  it("orders newest first with the source PK as tiebreaker", async () => {
    const { calls, client } = fake([[]]);
    await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(calls[0]!.text).toMatch(/ORDER BY source_ts DESC, id DESC/);
  });

  it("maps rows to the neutral view", async () => {
    const { client } = fake([[messageRow()]]);
    const feed = await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(feed.state).toBe("available");
    expect(feed.messages).toEqual([
      {
        id: "10",
        marketplace: "shopify",
        sourceTimestamp: "2026-08-12 08:30:00",
        bodyText: "synthetic body",
        bodyDecodeStatus: "decoded",
      },
    ]);
  });

  it("returns the stored timestamp verbatim, unconverted and unlabelled", async () => {
    const { client } = fake([[messageRow({ source_ts: "2026-08-12 23:59:59" })]]);
    const feed = await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(feed.messages[0]!.sourceTimestamp).toBe("2026-08-12 23:59:59");
    expect(JSON.stringify(feed)).not.toMatch(/UTC|GMT|BST|Berlin/);
  });
});

describe("no direction or identity is served", () => {
  it("selects no direction, counterparty or conversation column", async () => {
    const { calls, client } = fake([[]]);
    await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(calls[0]!.text).not.toMatch(/direction|counterparty|conversation_id/);
  });

  it("carries no direction in the view it returns", async () => {
    const { client } = fake([[messageRow()]]);
    const feed = await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(feed.messages[0]).not.toHaveProperty("direction");
    expect(JSON.stringify(feed).toLowerCase()).not.toContain("inbound");
    expect(JSON.stringify(feed).toLowerCase()).not.toContain("outbound");
  });

  it("withholds the opaque source reference from the browser", async () => {
    // Its meaning is unproven in this source; shown beside a message it would
    // read as that message's order.
    const { calls, client } = fake([[]]);
    await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(calls[0]!.text).not.toContain("source_reference");
  });
});

describe("store not created yet", () => {
  it("reports not_provisioned rather than raising", async () => {
    const { client } = fake(missingTable());
    const feed = await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(feed.state).toBe("not_provisioned");
    expect(feed.messages).toEqual([]);
  });

  it("distinguishes that from a genuinely empty store", async () => {
    const { client } = fake([[]]);
    const feed = await listUnresolvedMessages(client, { marketplace: "shopify" });
    expect(feed.state).toBe("available");
    expect(feed.messages).toEqual([]);
  });

  it("rethrows any other database error instead of masking it as empty", async () => {
    const { client } = fake(Object.assign(new Error("connection refused"), { code: "08006" }));
    await expect(
      listUnresolvedMessages(client, { marketplace: "shopify" }),
    ).rejects.toThrow(/connection refused/);
  });

  it("recognises only the undefined-table code", () => {
    expect(isMissingTableError({ code: "42P01" })).toBe(true);
    expect(isMissingTableError({ code: "42703" })).toBe(false);
    expect(isMissingTableError(new Error("boom"))).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
  });
});

describe("read-only", () => {
  it("issues no data- or schema-modifying statement", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "repositories", "unresolved-message-repository.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/gm, " ")
      .toUpperCase();
    for (const verb of ["INSERT INTO", "UPDATE ", "DELETE FROM", "TRUNCATE", "DROP ", "ALTER "]) {
      expect(source).not.toContain(verb);
    }
  });
});
