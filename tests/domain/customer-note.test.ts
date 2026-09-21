import { describe, expect, it } from "vitest";

import {
  CUSTOMER_NOTE_TYPE,
  DEFAULT_CUSTOMER_NOTE_CHANNEL,
  INTERNAL_NOTE_TYPE,
  NOTE_RESOLUTION_MESSAGE,
  type CustomerNote,
  customerNoteChannelTabs,
  customerNotesForChannel,
  isDisplayableCustomerNote,
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
