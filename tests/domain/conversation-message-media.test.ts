import { describe, expect, it } from "vitest";

import {
  authorshipOf,
  mapMediaRow,
  usableMediaUrl,
  usableSourceRefId,
  type SourceMediaRow,
} from "@/lib/domain/conversation-message-media";
import type { EbayMessageLink } from "@/lib/repositories/ebay-message-link-repository";

/**
 * What counts as a usable image row, and who attached it. Pure, no database.
 *
 * Fixtures use shapes observed in `message_app.files` type 0 — 12,965 rows,
 * ids 168-17,842, 9,159 distinct messages, all https — rather than invented
 * ones.
 */

const row = (over: Partial<SourceMediaRow> = {}): SourceMediaRow => ({
  sourcePk: "17806",
  sourceRefId: "3524071528016",
  mediaUrl: "https://i.ebayimg.com/00/s/example.jpg",
  viewOrder: 0,
  ...over,
});

const link = (over: Partial<EbayMessageLink> = {}): EbayMessageLink => ({
  conversationMessageId: 106403,
  conversationId: 1417,
  direction: "inbound",
  ...over,
});

describe("usableSourceRefId", () => {
  it("accepts a bare id and trims it", () => {
    expect(usableSourceRefId("3524071528016")).toBe("3524071528016");
    expect(usableSourceRefId(" 6465681746019 ")).toBe("6465681746019");
  });

  it.each([null, "", "  ", "null", "abc", "12a", "-1"])("rejects %s", (value) => {
    expect(usableSourceRefId(value)).toBeNull();
  });
});

describe("usableMediaUrl", () => {
  it.each([
    "https://i.ebayimg.com/00/s/x.jpg",
    "https://zstoreservice.vip.ebay.com/x",
    "https://sin1.contabostorage.com/x/y.jpeg",
  ])("accepts the observed host %s", (url) => {
    expect(usableMediaUrl(url)).toBe(url);
  });

  /** Mirrors ck_conversation_message_media_url_https. */
  it.each(["http://i.ebayimg.com/x.jpg", "ftp://x/y", "//i.ebayimg.com/x", "i.ebayimg.com/x"])(
    "rejects non-https %s",
    (url) => {
      expect(usableMediaUrl(url)).toBeNull();
    },
  );

  it.each([null, "", "   "])("rejects %s", (url) => {
    expect(usableMediaUrl(url)).toBeNull();
  });
});

describe("authorshipOf", () => {
  /**
   * `files.submitter` is NULL on all 12,965 message-media rows. Direction is
   * the only honest source, and inbound is the case the feature exists for:
   * the damage rules require a customer photograph.
   */
  it("reads inbound as the customer", () => {
    expect(authorshipOf("inbound")).toBe("customer");
  });

  it("reads outbound as CST", () => {
    expect(authorshipOf("outbound")).toBe("cst");
  });
});

describe("mapMediaRow", () => {
  it("maps a resolved customer image", () => {
    const result = mapMediaRow(row(), link());
    expect(result).toEqual({
      ok: true,
      direction: "inbound",
      record: {
        conversationMessageId: 106403,
        sourceDatabase: "message_app",
        sourceTable: "files",
        sourcePk: "17806",
        sourceRefId: "3524071528016",
        mediaUrl: "https://i.ebayimg.com/00/s/example.jpg",
        viewOrder: 0,
      },
    });
  });

  /** Authorship comes from the link, never from the file row. */
  it("takes direction from the parent message", () => {
    const outbound = mapMediaRow(row(), link({ direction: "outbound" }));
    expect(outbound.ok && outbound.direction).toBe("outbound");
  });

  /**
   * A PARENT IS NEVER INVENTED. Only ~11.9% of media-bearing messages were in
   * CST at last measurement; the rest are skipped and retried later.
   */
  it("skips an image whose message CST has not ingested", () => {
    expect(mapMediaRow(row(), null)).toEqual({
      ok: false,
      sourcePk: "17806",
      reason: "message_not_in_cst",
    });
  });

  it.each([
    [{ sourceRefId: null }, "no_source_ref"],
    [{ sourceRefId: "null" }, "no_source_ref"],
    [{ mediaUrl: null }, "no_media_url"],
    [{ mediaUrl: "   " }, "no_media_url"],
    [{ mediaUrl: "http://i.ebayimg.com/x.jpg" }, "insecure_media_url"],
    [{ viewOrder: null }, "invalid_view_order"],
    [{ viewOrder: -1 }, "invalid_view_order"],
    [{ viewOrder: 1.5 }, "invalid_view_order"],
  ])("rejects %o as %s", (over, reason) => {
    const result = mapMediaRow(row(over as Partial<SourceMediaRow>), link());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(reason);
  });

  /**
   * Rejection order matters for the report: a row with a bad URL AND no parent
   * is a data problem, not a "wait for history" problem, so it must not be
   * counted as the latter.
   */
  it("reports a data fault ahead of a missing parent", () => {
    const result = mapMediaRow(row({ mediaUrl: "http://x/y.jpg" }), null);
    expect(!result.ok && result.reason).toBe("insecure_media_url");
  });

  /** Display order is preserved verbatim, including 0. */
  it.each([0, 1, 2, 7])("preserves view_order %i", (viewOrder) => {
    const result = mapMediaRow(row({ viewOrder }), link());
    expect(result.ok && result.record.viewOrder).toBe(viewOrder);
  });

  it("preserves both source ids exactly", () => {
    const result = mapMediaRow(row({ sourcePk: "168", sourceRefId: "6466696418019" }), link());
    expect(result.ok && result.record.sourcePk).toBe("168");
    expect(result.ok && result.record.sourceRefId).toBe("6466696418019");
  });

  it("preserves the URL verbatim, neither rewritten nor proxied", () => {
    const url = "https://i.ebayimg.com/00/s/MTYwMFgxMjAw/z/abc~~/$_1.JPG?set_id=8800005007";
    const result = mapMediaRow(row({ mediaUrl: url }), link());
    expect(result.ok && result.record.mediaUrl).toBe(url);
  });

  /** No bytes, no submitter, no path — the shape has nowhere to put them. */
  it("produces exactly seven fields and no image data", () => {
    const result = mapMediaRow(row(), link());
    expect(result.ok && Object.keys(result.record).sort()).toEqual([
      "conversationMessageId", "mediaUrl", "sourceDatabase", "sourcePk",
      "sourceRefId", "sourceTable", "viewOrder",
    ]);
  });
});
