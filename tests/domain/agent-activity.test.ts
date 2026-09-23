import { describe, expect, it } from "vitest";

import {
  EBAY_SOURCE_ID,
  SHARED_ACCOUNT_SOURCE_USER_IDS,
  actorAttribution,
  mapActivityRow,
  marketplaceOf,
  usableExtMessageId,
  type SourceActivityRow,
} from "@/lib/domain/agent-activity";

/**
 * The two decisions the activity import makes: did this action resolve to a
 * conversation, and can the person who did it be named. Pure, no database.
 *
 * Fixtures use ids and shapes observed in `message_app.message_app_logs`
 * (17,815 eBay rows, ids 1-40,581, 10 distinct users) rather than invented ones.
 */

/** Ids present in cst_app.agent_directory after the staff import. */
const KNOWN = new Set([7, 13, 20, 22, 37, 43, 54, 70, 86, 146, 174, 210, 241, 248]);

const row = (over: Partial<SourceActivityRow> = {}): SourceActivityRow => ({
  sourcePk: "40544",
  sourceUserId: 241,
  action: "reply_to_message",
  actionDate: "2026-09-23",
  sourceId: 2,
  subSourceId: 1,
  extMessageId: "3524071528016",
  ...over,
});

describe("usableExtMessageId", () => {
  it("accepts a digit string", () => {
    expect(usableExtMessageId("3524071528016")).toBe("3524071528016");
  });

  it("trims surrounding whitespace", () => {
    expect(usableExtMessageId("  6465681746019 ")).toBe("6465681746019");
  });

  /**
   * THE TRAP THIS EXISTS FOR. `JSON_EXTRACT` on a JSON null returns the four
   * characters `null`, not SQL NULL. Treating that as a reference would create
   * an `unmatched` row that could never match, and would overstate how much
   * work failed to resolve.
   */
  it('rejects the string "null" that JSON_EXTRACT produces', () => {
    expect(usableExtMessageId("null")).toBeNull();
  });

  it.each([null, "", "   ", "abc", "12a", "-5", "1.5"])("rejects %s", (value) => {
    expect(usableExtMessageId(value)).toBeNull();
  });
});

describe("marketplaceOf", () => {
  it("maps source 2 to ebay", () => {
    expect(marketplaceOf(EBAY_SOURCE_ID)).toBe("ebay");
    expect(EBAY_SOURCE_ID).toBe(2);
  });

  /** Shopify (3) is out of scope; an unknown source is not guessed. */
  it.each([1, 3, 16, 0, null])("does not map source %s", (value) => {
    expect(marketplaceOf(value)).toBeNull();
  });
});

describe("actorAttribution", () => {
  it("attributes a known agent", () => {
    expect(actorAttribution(241, KNOWN)).toBe("attributed");
  });

  /** 86 is a shared login literally named `admin`. It is not a person. */
  it("treats the shared admin account as shared, even though it is in the directory", () => {
    expect(SHARED_ACCOUNT_SOURCE_USER_IDS.has(86)).toBe(true);
    expect(KNOWN.has(86)).toBe(true);
    expect(actorAttribution(86, KNOWN)).toBe("shared_account");
  });

  it("treats an id absent from the directory as an unknown actor", () => {
    expect(actorAttribution(9999, KNOWN)).toBe("unknown_actor");
  });

  it("treats a missing user as no actor", () => {
    expect(actorAttribution(null, KNOWN)).toBe("no_actor");
  });

  it("does not consult the directory for the shared account", () => {
    expect(actorAttribution(86, new Set())).toBe("shared_account");
  });
});

describe("mapActivityRow", () => {
  it("maps a resolved row to matched", () => {
    const { record } = mapActivityRow(row(), 1417, KNOWN);
    expect(record).toEqual({
      sourceDatabase: "message_app",
      sourceTable: "message_app_logs",
      sourcePk: "40544",
      sourceUserId: 241,
      action: "reply_to_message",
      actionDate: "2026-09-23",
      marketplace: "ebay",
      subSourceId: 1,
      conversationId: 1417,
      externalMessageId: "3524071528016",
      matchStatus: "matched",
    });
  });

  /** A reference that did not resolve is kept, so it can resolve later. */
  it("maps an unresolved reference to unmatched and keeps the reference", () => {
    const { record } = mapActivityRow(row(), null, KNOWN);
    expect(record.matchStatus).toBe("unmatched");
    expect(record.conversationId).toBeNull();
    expect(record.externalMessageId).toBe("3524071528016");
  });

  /**
   * 4,757 of 17,815 eBay rows carry no reference — move_to_resolved,
   * mark_as_no_need_reply and the settings actions. Real work, counted.
   */
  it("maps a row with no reference to no_reference", () => {
    const { record } = mapActivityRow(
      row({ action: "move_to_resolved", extMessageId: null }),
      null,
      KNOWN,
    );
    expect(record.matchStatus).toBe("no_reference");
    expect(record.externalMessageId).toBeNull();
    expect(record.conversationId).toBeNull();
  });

  it('treats the literal "null" payload as no_reference, not unmatched', () => {
    const { record } = mapActivityRow(row({ extMessageId: "null" }), null, KNOWN);
    expect(record.matchStatus).toBe("no_reference");
  });

  /**
   * The CHECK `match_status <> 'no_reference' OR external_message_id IS NULL`
   * would reject the opposite, so this keeps the writer from ever trying.
   */
  it("never emits a no_reference row carrying a reference", () => {
    for (const ext of [null, "null", "  "]) {
      const { record } = mapActivityRow(row({ extMessageId: ext }), null, KNOWN);
      expect(record.matchStatus === "no_reference" && record.externalMessageId === null).toBe(true);
    }
  });

  /** A conversation id for a row that never had a reference is a caller bug. */
  it("refuses a conversation id for a row with no reference", () => {
    expect(() => mapActivityRow(row({ extMessageId: null }), 99, KNOWN)).toThrow(
      /no reference but was given conversation 99/,
    );
  });

  /** The raw id is stored; refusing to NAME it is the reader's job. */
  it("stores the shared account id rather than blanking it", () => {
    const { record, attribution } = mapActivityRow(row({ sourceUserId: 86 }), 5, KNOWN);
    expect(record.sourceUserId).toBe(86);
    expect(attribution).toBe("shared_account");
  });

  it("stores an unknown actor's id and flags it", () => {
    const { record, attribution } = mapActivityRow(row({ sourceUserId: 9999 }), null, KNOWN);
    expect(record.sourceUserId).toBe(9999);
    expect(attribution).toBe("unknown_actor");
  });

  it("carries a null user through as null", () => {
    const { record, attribution } = mapActivityRow(row({ sourceUserId: null }), null, KNOWN);
    expect(record.sourceUserId).toBeNull();
    expect(attribution).toBe("no_actor");
  });

  /** The date is passed through verbatim; no Date is constructed anywhere. */
  it("passes the source date through without constructing a Date", () => {
    const { record } = mapActivityRow(row({ actionDate: "2026-03-06" }), null, KNOWN);
    expect(record.actionDate).toBe("2026-03-06");
  });

  it("always stamps the source identity the unique index needs", () => {
    const { record } = mapActivityRow(row({ sourcePk: "1" }), null, KNOWN);
    expect([record.sourceDatabase, record.sourceTable, record.sourcePk]).toEqual([
      "message_app", "message_app_logs", "1",
    ]);
  });

  /** No customer text can reach a record: the shape has nowhere to put it. */
  it("produces exactly eleven fields and no message content", () => {
    const { record } = mapActivityRow(row(), 1, KNOWN);
    expect(Object.keys(record).sort()).toEqual([
      "action", "actionDate", "conversationId", "externalMessageId", "marketplace",
      "matchStatus", "sourceDatabase", "sourcePk", "sourceTable", "sourceUserId", "subSourceId",
    ]);
  });
});
