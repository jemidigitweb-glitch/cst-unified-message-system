import { describe, expect, it } from "vitest";

import type { MediaRecord } from "@/lib/domain/conversation-message-media";
import { mapMediaRow } from "@/lib/domain/conversation-message-media";
import {
  UPSERT_MESSAGE_MEDIA_SQL,
  toColumnArrays,
  upsertMessageMedia,
} from "@/lib/sync/conversation-message-media-writer";
import { SELECT_EBAY_MEDIA_SQL, EBAY_MESSAGE_MEDIA_TYPE } from "@/lib/db/message-app-source";
import { resolveMessagesByExtMessageId } from "@/lib/repositories/ebay-message-link-repository";

const record = (over: Partial<MediaRecord> = {}): MediaRecord => ({
  conversationMessageId: 106403,
  sourceDatabase: "message_app",
  sourceTable: "files",
  sourcePk: "17806",
  sourceRefId: "3524071528016",
  mediaUrl: "https://i.ebayimg.com/00/s/x.jpg",
  viewOrder: 0,
  ...over,
});

function stubTx(insertedFlags: boolean[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: async (config: { text: string; values?: unknown[] }) => {
      calls.push({ text: config.text, values: config.values ?? [] });
      return { rows: insertedFlags.map((inserted) => ({ inserted })) };
    },
  };
}

describe("the media SELECT", () => {
  it("selects exactly the four approved columns", () => {
    for (const c of ["id", "ref_id", "real_url", "view_order"]) {
      expect(SELECT_EBAY_MEDIA_SQL).toContain(c);
    }
    expect(SELECT_EBAY_MEDIA_SQL.match(/\bAS\s+\w+/g)).toHaveLength(4);
  });

  /**
   * `submitter` carries BUYER/SELLER only on RETURN images and is NULL on all
   * 12,965 message-media rows. Not selecting it is how authorship stays the
   * parent message's business.
   */
  it.each(["submitter", "path", "name", "format", "file_id", "date"])(
    "never selects %s",
    (column) => {
      expect(SELECT_EBAY_MEDIA_SQL).not.toContain(column);
    },
  );

  it("filters to message media with a bound type", () => {
    expect(SELECT_EBAY_MEDIA_SQL).toMatch(/WHERE id > \? AND type = \?/);
    expect(EBAY_MESSAGE_MEDIA_TYPE).toBe(0);
  });

  it("paginates on the primary key, never OFFSET", () => {
    expect(SELECT_EBAY_MEDIA_SQL).toMatch(/ORDER BY id ASC/);
    expect(SELECT_EBAY_MEDIA_SQL).toMatch(/LIMIT \?/);
    expect(SELECT_EBAY_MEDIA_SQL).not.toMatch(/OFFSET/i);
  });

  it("is a SELECT and nothing else", () => {
    for (const verb of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE"]) {
      expect(SELECT_EBAY_MEDIA_SQL.toUpperCase()).not.toContain(verb);
    }
  });
});

describe("resolving a media row's parent message", () => {
  const source = {
    query: async () => ({ rows: [{ ext_message_id: "3524071528016", message_id: "211890155062" }] }),
  };
  const app = {
    query: async () => ({
      rows: [
        {
          external_message_id: "211890155062",
          conversation_message_id: 106403,
          conversation_id: 1417,
          direction: "inbound",
        },
      ],
    }),
  };

  /** cst_app stores message_id, not ext_message_id — the trap this guards. */
  it("resolves through message_id and returns the message row and direction", async () => {
    const links = await resolveMessagesByExtMessageId(source, app, ["3524071528016"]);
    expect(links.get("3524071528016")).toEqual({
      conversationMessageId: 106403,
      conversationId: 1417,
      direction: "inbound",
    });
  });

  it("returns nothing when the message is not in cst_app", async () => {
    const empty = { query: async () => ({ rows: [] }) };
    expect((await resolveMessagesByExtMessageId(source, empty, ["3524071528016"])).size).toBe(0);
  });

  it("costs two queries for a whole page", async () => {
    let calls = 0;
    const counting = {
      query: async () => {
        calls += 1;
        return { rows: [] };
      },
    };
    await resolveMessagesByExtMessageId(counting, counting, ["1", "2", "3"]);
    // Second hop is skipped when the first returns nothing.
    expect(calls).toBe(1);
  });
});

describe("the upsert statement", () => {
  it("conflicts on the unique index 0016 created", () => {
    expect(UPSERT_MESSAGE_MEDIA_SQL).toMatch(
      /ON CONFLICT \(source_database, source_table, source_pk\) DO UPDATE/,
    );
  });

  /**
   * `ingested_at` is when CST first saw the image; `last_seen_at` is when the
   * sync last confirmed it upstream. Only the second may be rewritten.
   */
  it("refreshes last_seen_at but never ingested_at", () => {
    const doUpdate = UPSERT_MESSAGE_MEDIA_SQL.slice(UPSERT_MESSAGE_MEDIA_SQL.indexOf("DO UPDATE"));
    expect(doUpdate).toMatch(/last_seen_at\s*=\s*now\(\)/);
    expect(doUpdate).not.toMatch(/ingested_at/);
  });

  it("binds every value through unnest and interpolates none", () => {
    expect(UPSERT_MESSAGE_MEDIA_SQL).toMatch(/unnest\(\s*\$1::bigint\[\]/);
    expect(UPSERT_MESSAGE_MEDIA_SQL).toMatch(/\$7::integer\[\]/);
    expect(UPSERT_MESSAGE_MEDIA_SQL).not.toMatch(/\$\{/);
  });

  /** 0007's column carries Shopify and B&Q attachments and must be untouched. */
  it("writes only conversation_message_media", () => {
    expect(UPSERT_MESSAGE_MEDIA_SQL).toContain("cst_app.conversation_message_media");
    expect(UPSERT_MESSAGE_MEDIA_SQL).not.toMatch(/attachments/i);
    expect(UPSERT_MESSAGE_MEDIA_SQL).not.toMatch(/INSERT INTO cst_app\.conversation_messages/);
  });

  /** URLs only: no bytes are ever stored. */
  it("stores no image data", () => {
    expect(UPSERT_MESSAGE_MEDIA_SQL).not.toMatch(/bytea|blob/i);
  });

  it("contains no DELETE", () => {
    expect(UPSERT_MESSAGE_MEDIA_SQL).not.toMatch(/\bDELETE\b/i);
    expect(UPSERT_MESSAGE_MEDIA_SQL).not.toMatch(/\bTRUNCATE\b/i);
  });
});

describe("toColumnArrays", () => {
  it("produces seven parallel arrays in statement order", () => {
    const arrays = toColumnArrays([record(), record({ sourcePk: "17807", viewOrder: 1 })]);
    expect(arrays).toHaveLength(7);
    expect(arrays.every((a) => a.length === 2)).toBe(true);
    expect(arrays[0]).toEqual([106403, 106403]);
    expect(arrays[3]).toEqual(["17806", "17807"]);
    expect(arrays[6]).toEqual([0, 1]);
  });

  /** Display order survives the round trip, including the 0 that starts it. */
  it("keeps view_order 0 rather than dropping it as falsy", () => {
    expect(toColumnArrays([record({ viewOrder: 0 })])[6]).toEqual([0]);
  });
});

describe("upsertMessageMedia", () => {
  it("sends one statement for a whole batch", async () => {
    const tx = stubTx([true, true, true]);
    await upsertMessageMedia(tx, [
      record({ sourcePk: "1" }), record({ sourcePk: "2" }), record({ sourcePk: "3" }),
    ]);
    expect(tx.calls).toHaveLength(1);
  });

  it("reports inserts and updates separately", async () => {
    const tx = stubTx([true, false]);
    expect(await upsertMessageMedia(tx, [record({ sourcePk: "1" }), record({ sourcePk: "2" })]))
      .toEqual({ inserted: 1, updated: 1 });
  });

  /** A second run must update, never duplicate — keyed on files.id. */
  it("reports a re-run as all updates", async () => {
    const tx = stubTx([false, false]);
    expect(await upsertMessageMedia(tx, [record({ sourcePk: "1" }), record({ sourcePk: "2" })]))
      .toEqual({ inserted: 0, updated: 2 });
  });

  it("does nothing and issues no query when given nothing", async () => {
    const tx = stubTx([]);
    expect(await upsertMessageMedia(tx, [])).toEqual({ inserted: 0, updated: 0 });
    expect(tx.calls).toHaveLength(0);
  });

  /** End to end through the domain, so the writer never sees an illegal row. */
  it("carries a mapped row through with both source ids intact", async () => {
    const mapped = mapMediaRow(
      { sourcePk: "17806", sourceRefId: "3524071528016", mediaUrl: "https://i.ebayimg.com/x.jpg", viewOrder: 2 },
      { conversationMessageId: 999, conversationId: 1, direction: "inbound" },
    );
    expect(mapped.ok).toBe(true);
    const tx = stubTx([true]);
    await upsertMessageMedia(tx, [mapped.ok ? mapped.record : record()]);
    const values = tx.calls[0].values as unknown[][];
    expect(values[0][0]).toBe(999);            // conversation_message_id
    expect(values[3][0]).toBe("17806");        // source_pk  = files.id
    expect(values[4][0]).toBe("3524071528016"); // source_ref_id = files.ref_id
    expect(values[6][0]).toBe(2);              // view_order
  });
});
