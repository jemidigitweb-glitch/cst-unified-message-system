import { describe, expect, it } from "vitest";

import {
  CUSTOMER_NOTES_EMPTY,
  CUSTOMER_NOTES_NO_MATCH,
  CUSTOMER_NOTE_TYPE,
  DEFAULT_CUSTOMER_NOTE_CHANNEL,
  INTERNAL_NOTE_TYPE,
  NOTE_RESOLUTION_MESSAGE,
  type CustomerNote,
  customerNoteChannelTabs,
  customerNoteMatchesElsewhere,
  customerNotesForChannel,
  isDisplayableCustomerNote,
  searchCustomerNotes,
} from "@/lib/domain/customer-note";

/** Synthetic values only. No real order number or customer name appears here. */
function note(overrides: Partial<CustomerNote> = {}): CustomerNote {
  return {
    id: "1",
    orderRowId: "900001",
    orderNumber: "TEST-ORDER-0001",
    customerName: "Sam Tester",
    noteText: "Please leave it with a neighbour.",
    createdAt: "2026-09-20 08:00:00",
    storefront: "storefront-a",
    channel: "ebay",
    ...overrides,
  };
}

describe("only a buyer's own note is displayable", () => {
  it("accepts a buyer note with text", () => {
    expect(isDisplayableCustomerNote({ noteType: CUSTOMER_NOTE_TYPE, noteText: "Hello" })).toBe(
      true,
    );
  });

  it("rejects a team note, whatever it says", () => {
    expect(
      isDisplayableCustomerNote({ noteType: INTERNAL_NOTE_TYPE, noteText: "Chased the courier" }),
    ).toBe(false);
  });

  it("rejects an unknown or missing note type rather than assuming buyer", () => {
    expect(isDisplayableCustomerNote({ noteType: null, noteText: "Hello" })).toBe(false);
    expect(isDisplayableCustomerNote({ noteType: "something_new", noteText: "Hello" })).toBe(false);
  });

  it("rejects a blank note", () => {
    for (const noteText of [null, "", "   ", "\n\t "]) {
      expect(isDisplayableCustomerNote({ noteType: CUSTOMER_NOTE_TYPE, noteText })).toBe(false);
    }
  });
});

describe("the marketplace tabs", () => {
  const notes = [
    note({ id: "1", channel: "ebay" }),
    note({ id: "2", channel: "ebay" }),
    note({ id: "3", channel: "shopify" }),
    note({ id: "4", channel: null }),
  ];

  it("opens on eBay, with no 'all' tab", () => {
    expect(DEFAULT_CUSTOMER_NOTE_CHANNEL).toBe("ebay");
    const values = customerNoteChannelTabs(notes, "ebay").map((tab) => tab.value);
    expect(values).not.toContain("all");
  });

  it("gives every marketplace a tab and a count, including zero", () => {
    const tabs = customerNoteChannelTabs(notes, "ebay");
    const counts = Object.fromEntries(tabs.map((tab) => [tab.value, tab.count]));
    expect(counts).toMatchObject({ ebay: 2, shopify: 1, amazon: 0, bandq: 0, temu: 0 });
  });

  it("files a platform with no channel under Other, rather than hiding it", () => {
    const tabs = customerNoteChannelTabs(notes, "ebay");
    expect(tabs.find((tab) => tab.value === "other")?.count).toBe(1);
  });

  it("omits Other when nothing needs it", () => {
    const tabs = customerNoteChannelTabs([note({ channel: "ebay" })], "ebay");
    expect(tabs.some((tab) => tab.value === "other")).toBe(false);
  });

  it("keeps the selected tab present even when it is empty", () => {
    // Opening on eBay in a week with no eBay notes must still show eBay
    // selected, rather than a strip with nothing chosen.
    const tabs = customerNoteChannelTabs([note({ channel: "shopify" })], "ebay");
    expect(tabs.find((tab) => tab.value === "ebay")?.count).toBe(0);
  });

  it("filters to exactly one marketplace", () => {
    expect(customerNotesForChannel(notes, "ebay").map((row) => row.id)).toEqual(["1", "2"]);
    expect(customerNotesForChannel(notes, "shopify").map((row) => row.id)).toEqual(["3"]);
  });

  it("filters Other to the notes with no channel", () => {
    expect(customerNotesForChannel(notes, "other").map((row) => row.id)).toEqual(["4"]);
  });
});

describe("searching the notes by order or name", () => {
  const notes = [
    note({ id: "1", orderNumber: "12-34567-89012", customerName: "Sam Tester", channel: "ebay" }),
    note({ id: "2", orderNumber: "LED65289", customerName: "Alex Sample", channel: "shopify" }),
    note({ id: "3", orderNumber: null, customerName: "Sam Other", channel: "ebay" }),
    note({ id: "4", orderNumber: "TEST-0004", customerName: null, channel: "amazon" }),
  ];

  const ids = (query: string) => searchCustomerNotes(notes, query).map((row) => row.id);

  it("finds a note by its order reference", () => {
    expect(ids("LED65289")).toEqual(["2"]);
  });

  it("ignores the punctuation the marketplaces do not agree on", () => {
    // eBay prints 12-34567-89012; an agent reading it off a slip types either.
    expect(ids("1234567")).toEqual(["1"]);
    expect(ids("12-34567")).toEqual(["1"]);
    expect(ids("test 0004")).toEqual(["4"]);
  });

  it("finds a note by part of the name, in any case", () => {
    expect(ids("tester")).toEqual(["1"]);
    expect(ids("ALEX")).toEqual(["2"]);
  });

  /**
   * A TERM MATCHES INSIDE A WORD, deliberately: "tuck" has to find
   * "Tuckward", because a name read off a slip is rarely the whole name. The
   * cost is that "sam" also finds "Sample", and a second term is the answer to
   * that — which is what this pins.
   */
  it("narrows on a second term rather than widening", () => {
    expect(ids("sam")).toEqual(["1", "2", "3"]);
    expect(ids("sam tester")).toEqual(["1"]);
    expect(ids("sam 1234567")).toEqual(["1"]);
  });

  it("returns the list unchanged for a blank query", () => {
    for (const blank of ["", "   ", "\n\t"]) {
      expect(searchCustomerNotes(notes, blank)).toBe(notes);
    }
  });

  it("matches nothing on a query of pure punctuation", () => {
    // An empty needle is inside every string. A reference must not match all.
    expect(ids("---")).toEqual([]);
  });

  it("does not fill in an absent reference or name", () => {
    expect(ids("TEST-0004")).toEqual(["4"]);
    expect(ids("nobody-at-all")).toEqual([]);
  });

  /**
   * THE NOTE TEXT IS NOT SEARCHED, and that is a decision rather than an
   * omission: typing an order number would otherwise return the note that
   * MENTIONS it beside the note that IS it, and the row prints only the
   * reference and the name, so a reader could not see why it matched.
   */
  it("does not search the note body", () => {
    const quoted = [note({ id: "9", noteText: "Same as order LED65289", orderNumber: "X1" })];
    expect(searchCustomerNotes(quoted, "LED65289")).toEqual([]);
  });

  it("says which silence it is", () => {
    expect(CUSTOMER_NOTES_NO_MATCH).not.toBe(CUSTOMER_NOTES_EMPTY);
    expect(customerNoteMatchesElsewhere(1)).toBe(
      "No matches on this marketplace. 1 on another marketplace.",
    );
    expect(customerNoteMatchesElsewhere(3)).toBe(
      "No matches on this marketplace. 3 on other marketplaces.",
    );
  });

  /**
   * THE SEARCH RUNS BEFORE THE TABS ARE COUNTED, which is what lets an agent
   * holding an order number find it without knowing its marketplace: the tab
   * they are on reads 0 and the tab it is on reads 1.
   */
  it("leaves the tab counts describing the search", () => {
    const matched = searchCustomerNotes(notes, "LED65289");
    const counts = Object.fromEntries(
      customerNoteChannelTabs(matched, "ebay").map((tab) => [tab.value, tab.count]),
    );
    expect(counts).toMatchObject({ ebay: 0, shopify: 1 });
  });
});

describe("a refusal is explained in words", () => {
  it("has a sentence for every failure, and never shows a code", () => {
    for (const [reason, message] of Object.entries(NOTE_RESOLUTION_MESSAGE)) {
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toContain(reason);
      expect(message).toMatch(/[.]$/);
    }
  });

  it("says plainly that an ambiguous order is not guessed at", () => {
    expect(NOTE_RESOLUTION_MESSAGE.ambiguous).toMatch(/more than one conversation/i);
  });
});
