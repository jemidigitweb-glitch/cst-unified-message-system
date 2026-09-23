import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOOKBACK,
  MYSQL_FEEDS,
  READ_WATERMARK_SQL,
  WRITE_WATERMARK_SQL,
  readWatermark,
  startFrom,
  writeWatermark,
} from "@/lib/sync/mysql-sync-state";
import {
  FIND_EBAY_MESSAGES_WITHOUT_MEDIA_SQL,
  FIND_NEW_EBAY_MESSAGES_SQL,
  FIND_UNMATCHED_ACTIVITY_SQL,
  PROMOTE_MATCHED_SQL,
  promoteMatchedActivity,
} from "@/lib/repositories/mysql-reconcile-repository";
import {
  MAX_MEDIA_REF_LOOKUP,
  SELECT_EBAY_MEDIA_BY_REF_SQL,
  fetchEbayMediaByRefIds,
} from "@/lib/db/message-app-source";

function stub(rows: unknown[], rowCount = rows.length) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: async (config: { text: string; values?: unknown[] }) => {
      calls.push({ text: config.text, values: config.values ?? [] });
      return { rows, rowCount };
    },
  };
}

describe("feed identities", () => {
  /**
   * THE DECISION THIS PINS. `ck_sync_state_marketplace` admits only the five
   * marketplaces, and a staff directory is none of them. Writing 'ebay' to
   * satisfy the CHECK would put a false fact in the table that decides what to
   * sync next, so the directory has no row here at all — it needs no cursor,
   * being one full idempotent upsert of 234 rows.
   */
  it("registers only the two feeds that are genuinely eBay", () => {
    const keys = Object.keys(MYSQL_FEEDS);
    expect(keys).toEqual(["agentActivity", "messageMedia", "messageMediaReconcile"]);
    for (const feed of Object.values(MYSQL_FEEDS)) {
      expect(feed.marketplace).toBe("ebay");
    }
  });

  it("has no staff-directory feed under any marketplace", () => {
    const serialised = JSON.stringify(MYSQL_FEEDS).toLowerCase();
    expect(serialised).not.toContain("directory");
    expect(serialised).not.toContain("staff");
    expect(serialised).not.toContain("order_management");
  });

  /** A reader must not mistake the reconcile cursor for a MariaDB id. */
  it("says in the feed key that the reconcile cursor is a CST id", () => {
    expect(MYSQL_FEEDS.messageMediaReconcile.feedKey).toContain("cst-message-id");
    expect(MYSQL_FEEDS.messageMediaReconcile.watermarkMeaning).toBe(
      "cst_app.conversation_messages.id",
    );
  });

  it("gives each feed a distinct key", () => {
    const keys = Object.values(MYSQL_FEEDS).map((f) => f.feedKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("startFrom — the late-arrival lookback", () => {
  /**
   * MariaDB allocates an auto-increment id at INSERT and publishes it at
   * COMMIT, so a long transaction can commit id 100 after 105 is readable. A
   * plain `id > watermark` would never see 100 again.
   */
  it("restarts below the watermark", () => {
    expect(startFrom(40584, 500)).toBe(40084);
  });

  it("defaults to a non-zero lookback", () => {
    expect(DEFAULT_LOOKBACK).toBeGreaterThan(0);
    expect(startFrom(1000)).toBe(1000 - DEFAULT_LOOKBACK);
  });

  it("never returns a negative id", () => {
    expect(startFrom(100, 500)).toBe(0);
    expect(startFrom(0, 500)).toBe(0);
  });

  it("re-reads nothing extra when the lookback is zero", () => {
    expect(startFrom(40584, 0)).toBe(40584);
  });

  it.each([[-1, 0], [1.5, 0], [0, -1], [0, 2.5]])(
    "rejects non-integer or negative inputs (%s, %s)",
    (watermark, lookback) => {
      expect(() => startFrom(watermark, lookback)).toThrow();
    },
  );
});

describe("readWatermark", () => {
  it("returns 0 when the feed has never run", async () => {
    expect(await readWatermark(stub([]), MYSQL_FEEDS.agentActivity)).toBe(0);
    expect(await readWatermark(stub([{ pk: null }]), MYSQL_FEEDS.agentActivity)).toBe(0);
  });

  it("parses the stored text watermark", async () => {
    expect(await readWatermark(stub([{ pk: "40584" }]), MYSQL_FEEDS.agentActivity)).toBe(40584);
  });

  it("keys the lookup on marketplace and feed", async () => {
    const s = stub([{ pk: "1" }]);
    await readWatermark(s, MYSQL_FEEDS.messageMedia);
    expect(s.calls[0].values).toEqual(["ebay", "message-app-message-media"]);
  });

  /** A corrupt cursor must stop the run, not silently restart from zero. */
  it.each(["abc", "-5", "1.5"])("refuses a corrupt watermark %s", async (pk) => {
    await expect(readWatermark(stub([{ pk }]), MYSQL_FEEDS.agentActivity)).rejects.toThrow(
      /not a positive integer/,
    );
  });
});

describe("writeWatermark", () => {
  it("upserts on the existing unique feed key", () => {
    expect(WRITE_WATERMARK_SQL).toMatch(/ON CONFLICT \(marketplace, feed_key\) DO UPDATE/);
  });

  /** These feeds order by id; claiming a timestamp ordering would be a lie. */
  it("never writes watermark_source_ts", () => {
    expect(WRITE_WATERMARK_SQL).not.toMatch(/watermark_source_ts/);
  });

  it("binds every value", () => {
    expect(READ_WATERMARK_SQL).toMatch(/\$1[\s\S]*\$2/);
    expect(WRITE_WATERMARK_SQL).toMatch(/\$1, \$2, \$3/);
    expect(WRITE_WATERMARK_SQL).not.toMatch(/\$\{/);
  });

  it("records a successful run", async () => {
    const s = stub([]);
    await writeWatermark(s, MYSQL_FEEDS.agentActivity, { watermark: 40584, status: "ok" });
    expect(s.calls[0].values).toEqual(["ebay", "message-app-agent-activity", "40584", "ok", null]);
  });

  /**
   * A failed run must not advance the cursor, or the rows it failed on are
   * skipped forever. Passing null keeps the stored value via COALESCE.
   */
  it("keeps the previous watermark on failure", async () => {
    const s = stub([]);
    await writeWatermark(s, MYSQL_FEEDS.agentActivity, {
      watermark: null, status: "error", error: "connection lost",
    });
    expect(s.calls[0].values[2]).toBeNull();
    expect(s.calls[0].values[4]).toBe("connection lost");
    expect(WRITE_WATERMARK_SQL).toMatch(/COALESCE\(EXCLUDED\.watermark_source_pk/);
  });

  /** ck_sync_state_error_detail requires a reason whenever status is error. */
  it("refuses an error status with no reason", async () => {
    await expect(
      writeWatermark(stub([]), MYSQL_FEEDS.agentActivity, { watermark: null, status: "error" }),
    ).rejects.toThrow(/requires a reason/);
  });
});

describe("reconciliation reads", () => {
  /** Retrying unmatched activity costs no MariaDB budget at all. */
  it("finds unmatched activity from stored references only", () => {
    expect(FIND_UNMATCHED_ACTIVITY_SQL).toMatch(/match_status = 'unmatched'/);
    expect(FIND_UNMATCHED_ACTIVITY_SQL).toMatch(/external_message_id IS NOT NULL/);
    expect(FIND_UNMATCHED_ACTIVITY_SQL).toMatch(/LIMIT \$1/);
  });

  it("walks new eBay messages by id, not by ingested_at", () => {
    expect(FIND_NEW_EBAY_MESSAGES_SQL).toMatch(/id > \$1/);
    expect(FIND_NEW_EBAY_MESSAGES_SQL).toMatch(/ORDER BY id/);
    expect(FIND_NEW_EBAY_MESSAGES_SQL).not.toMatch(/ingested_at/);
  });

  it("pins both reconciliation reads to eBay", () => {
    for (const sql of [FIND_NEW_EBAY_MESSAGES_SQL, FIND_EBAY_MESSAGES_WITHOUT_MEDIA_SQL]) {
      expect(sql).toMatch(/source_table = 'ebay_message_headers'/);
      expect(sql).toMatch(/LIMIT/);
    }
  });

  /** The sweep catches messages ingested before the cursor first ran. */
  it("sweeps older media-less messages below the cursor", () => {
    expect(FIND_EBAY_MESSAGES_WITHOUT_MEDIA_SQL).toMatch(/id <= \$1/);
    expect(FIND_EBAY_MESSAGES_WITHOUT_MEDIA_SQL).toMatch(/NOT EXISTS/);
    expect(FIND_EBAY_MESSAGES_WITHOUT_MEDIA_SQL).toMatch(/ORDER BY m\.id DESC/);
  });

  it("all reconciliation reads are SELECTs", () => {
    for (const sql of [
      FIND_UNMATCHED_ACTIVITY_SQL, FIND_NEW_EBAY_MESSAGES_SQL, FIND_EBAY_MESSAGES_WITHOUT_MEDIA_SQL,
    ]) {
      for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP"]) {
        expect(sql.toUpperCase()).not.toContain(verb);
      }
    }
  });
});

describe("promoteMatchedActivity", () => {
  /**
   * It can only move unmatched -> matched. A re-resolution must not rewrite a
   * row that was already correct, and must not be able to reach a
   * `no_reference` row — whose CHECK forbids carrying a conversation.
   */
  it("only ever promotes an unmatched row", () => {
    expect(PROMOTE_MATCHED_SQL).toMatch(/a\.match_status = 'unmatched'/);
    expect(PROMOTE_MATCHED_SQL).toMatch(/match_status\s*=\s*'matched'/);
  });

  it("batches with unnest and binds every value", () => {
    expect(PROMOTE_MATCHED_SQL).toMatch(/unnest\(\$1::bigint\[\], \$2::bigint\[\]\)/);
    expect(PROMOTE_MATCHED_SQL).not.toMatch(/\$\{/);
  });

  it("writes only agent_activity", () => {
    expect(PROMOTE_MATCHED_SQL).toMatch(/UPDATE cst_app\.agent_activity/);
    expect(PROMOTE_MATCHED_SQL).not.toMatch(/conversation_messages|agent_directory|app_users/);
  });

  it("sends one statement for a whole batch", async () => {
    const s = stub([], 2);
    const promoted = await promoteMatchedActivity(s, [
      { id: 1, conversationId: 10 },
      { id: 2, conversationId: 20 },
    ]);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].values).toEqual([[1, 2], [10, 20]]);
    expect(promoted).toBe(2);
  });

  it("issues no query for an empty batch", async () => {
    const s = stub([]);
    expect(await promoteMatchedActivity(s, [])).toBe(0);
    expect(s.calls).toHaveLength(0);
  });
});

describe("targeted media lookup", () => {
  it("asks for named messages instead of scanning the table", () => {
    expect(SELECT_EBAY_MEDIA_BY_REF_SQL).toMatch(/WHERE type = \? AND ref_id IN \(\?\)/);
    expect(SELECT_EBAY_MEDIA_BY_REF_SQL).not.toMatch(/LIMIT|OFFSET/);
  });

  it("selects the same four columns as the paged reader", () => {
    expect(SELECT_EBAY_MEDIA_BY_REF_SQL.match(/\bAS\s+\w+/g)).toHaveLength(4);
    for (const column of ["submitter", "path", "name", "format"]) {
      expect(SELECT_EBAY_MEDIA_BY_REF_SQL).not.toContain(column);
    }
  });

  it("spends a query only when there is something to ask for", async () => {
    const budget = { spent: 0 };
    const conn = { query: async () => [[], null] as [unknown, unknown] };
    expect(await fetchEbayMediaByRefIds(conn, { refIds: [], budget })).toEqual([]);
    expect(budget.spent).toBe(0);
  });

  it("counts one query against the budget when it does ask", async () => {
    const budget = { spent: 0 };
    const conn = { query: async () => [[], null] as [unknown, unknown] };
    await fetchEbayMediaByRefIds(conn, { refIds: ["1", "2"], budget });
    expect(budget.spent).toBe(1);
  });

  it("de-duplicates the requested ids", async () => {
    let values: unknown[] = [];
    const conn = {
      query: async (_sql: string, v?: readonly unknown[]) => {
        values = [...(v ?? [])];
        return [[], null] as [unknown, unknown];
      },
    };
    await fetchEbayMediaByRefIds(conn, { refIds: ["1", "1", "2"] });
    expect(values[1]).toEqual(["1", "2"]);
  });

  /** One statement per call: an unbounded list would be an unbounded statement. */
  it("refuses an unbounded id list", async () => {
    const conn = { query: async () => [[], null] as [unknown, unknown] };
    const tooMany = Array.from({ length: MAX_MEDIA_REF_LOOKUP + 1 }, (_, i) => String(i));
    await expect(fetchEbayMediaByRefIds(conn, { refIds: tooMany })).rejects.toThrow(/at most/);
  });
});
