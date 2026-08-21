import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SHOPIFY_FILTER_REASONS,
  type FilterableRow,
  filterReasonFor,
} from "@/lib/marketplaces/shopify/inbox-filter";
import { normalizeRow } from "@/lib/marketplaces/shopify/adapter";
import { buildConversations } from "@/lib/marketplaces/shopify/thread-builder";
import type { ShopifySourceRow } from "@/lib/marketplaces/shopify/adapter";

/** Synthetic values only. Every address and subject below is invented. */
function row(overrides: Partial<FilterableRow> = {}): FilterableRow {
  return {
    from_msg: "buyer@gmail.com",
    to_msg: "support@ledsone.co.uk",
    subject: "Where is my order?",
    order_id: null,
    ...overrides,
  };
}

function sourceRow(overrides: Partial<ShopifySourceRow> = {}): ShopifySourceRow {
  return {
    id: "1",
    message_id: "src-1",
    sub_source: 104,
    from_msg: "buyer@gmail.com",
    to_msg: "support@ledsone.co.uk",
    subject: "Where is my order?",
    order_id: "LED60484",
    message_date: "2026-08-19 04:48:36",
    message_content: "synthetic body",
    ...overrides,
  };
}

describe("shown: real customer contact", () => {
  it("shows a consumer mailbox even with no order reference", () => {
    // Four fifths of genuine customer contact carries none, so requiring one
    // would hide most customers.
    for (const domain of [
      "gmail.com",
      "yahoo.com",
      "hotmail.co.uk",
      "icloud.com",
      "outlook.com",
      "gmx.de",
      "web.de",
      "btinternet.com",
      "googlemail.com",
      "t-online.de",
    ]) {
      expect(filterReasonFor(row({ from_msg: `person@${domain}`, order_id: null }))).toBeNull();
    }
  });

  it("never filters our own reply", () => {
    expect(
      filterReasonFor({
        from_msg: "support@ledsone.co.uk",
        to_msg: "buyer@gmail.com",
        subject: "Re: your order",
        order_id: null,
      }),
    ).toBeNull();
  });

  it("shows a business sender that carries an order signal", () => {
    const business = { from_msg: "buyer@somecompany.invalid" };
    expect(filterReasonFor(row({ ...business, order_id: "LED60484" }))).toBeNull();
    expect(filterReasonFor(row({ ...business, subject: "Re: Order #LED61105" }))).toBeNull();
    expect(filterReasonFor(row({ ...business, subject: "RE: #LED60010" }))).toBeNull();
    expect(filterReasonFor(row({ ...business, subject: "AW: Bestellung #12345" }))).toBeNull();
    expect(
      filterReasonFor(row({ ...business, subject: "Request for Quotation - Dining Room" })),
    ).toBeNull();
    expect(filterReasonFor(row({ ...business, subject: "Enquiry about bulk pricing" }))).toBeNull();
  });
});

describe("hidden: not reply work", () => {
  it("hides a bounce, whatever domain relayed it", () => {
    for (const subject of [
      "Mail delivery failed: returning message to sender",
      "Undeliverable: Your order",
      "Delivery Status Notification (Failure)",
      "Unzustellbar: Ihre Bestellung",
    ]) {
      expect(filterReasonFor(row({ from_msg: "mailer@kundenserver.de", subject }))).toBe("bounce");
    }
    // Even from a consumer domain, a bounce is still a bounce.
    expect(
      filterReasonFor(row({ from_msg: "x@gmail.com", subject: "Mail delivery failed: oops" })),
    ).toBe("bounce");
  });

  it("hides courier notifications", () => {
    for (const domain of ["evri.com", "dpd.co.uk", "royalmail.com", "dhlecommerce.co.uk", "parcel2go.com", "kitepackaging.co.uk"]) {
      expect(filterReasonFor(row({ from_msg: `noreply@${domain}` }))).toBe("courier");
    }
  });

  it("hides Shopify and app alerts", () => {
    for (const domain of ["shopify.com", "mailer.shopify.com", "t.shopifyemail.com", "judge.me"]) {
      expect(filterReasonFor(row({ from_msg: `noreply@${domain}` }))).toBe("platform_notice");
    }
  });

  it("hides other channels' notices that land in this mailbox", () => {
    // eBay's belong in the eBay tab, which already holds them from eBay's own
    // source; showing them here would double-count the same correspondence.
    for (const domain of ["ebay.com", "members.ebay.de", "wayfair.com", "avasam.com", "selling.tiktok.com", "faire.com"]) {
      expect(filterReasonFor(row({ from_msg: `noreply@${domain}` }))).toBe("marketplace_notice");
    }
  });

  it("hides an unrecognised business domain with no order signal", () => {
    for (const subject of ["Chips and electronic parts", "Portable LED display", "Your Meta ads receipt"]) {
      expect(filterReasonFor(row({ from_msg: "sales@supplier.invalid", subject }))).toBe(
        "unsolicited",
      );
    }
  });

  it("reports only declared reasons", () => {
    const reason = filterReasonFor(row({ from_msg: "sales@supplier.invalid" }));
    expect(SHOPIFY_FILTER_REASONS).toContain(reason);
  });
});

describe("decides from stored fields only", () => {
  it("reads no message body", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "marketplaces", "shopify", "inbox-filter.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(source).not.toMatch(/message_content|bodyText|body_text/);
  });

  it("ignores the body entirely", () => {
    // Same sender and subject, opposite-looking bodies: identical verdict.
    for (const body of ["Where is my order?", "Buy cheap LEDs now!!!", null]) {
      const normalized = normalizeRow(sourceRow({ message_content: body }))!;
      expect(normalized.sourceMetadata.inboxFilterReason).toBeNull();
    }
  });

  it("handles a missing subject or sender without throwing", () => {
    expect(filterReasonFor(row({ subject: null }))).toBeNull();
    expect(filterReasonFor(row({ from_msg: null, subject: null }))).toBeNull();
  });

  it("matches a domain on a dot boundary, never a substring", () => {
    // A lookalike must not inherit a real domain's verdict.
    expect(filterReasonFor(row({ from_msg: "a@notebay.invalid" }))).toBe("unsolicited");
    expect(filterReasonFor(row({ from_msg: "a@ebay.com.attacker.invalid" }))).toBe("unsolicited");
  });
});

describe("threading applies the filter per conversation", () => {
  it("marks a conversation filtered when every message is", () => {
    const { conversations } = buildConversations([
      normalizeRow(sourceRow({ id: "1", from_msg: "noreply@evri.com", order_id: null }))!,
    ]);
    expect(conversations[0]!.inboxPlacement).toBe("filtered");
    expect(conversations[0]!.inboxFilterReason).toBe("courier");
  });

  it("keeps a conversation visible when any message is real customer contact", () => {
    // One courier notice joining a customer's order thread must not hide it.
    const { conversations } = buildConversations([
      normalizeRow(sourceRow({ id: "1", from_msg: "noreply@evri.com" }))!,
      normalizeRow(sourceRow({ id: "2", from_msg: "buyer@gmail.com" }))!,
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.inboxPlacement).toBe("reply_inbox");
    expect(conversations[0]!.inboxFilterReason).toBeNull();
  });

  it("stores every message, filtered or not", () => {
    const { conversations } = buildConversations([
      normalizeRow(sourceRow({ id: "1", from_msg: "noreply@evri.com", order_id: null }))!,
      normalizeRow(sourceRow({ id: "2", from_msg: "buyer@gmail.com", order_id: null }))!,
    ]);
    expect(conversations.reduce((sum, c) => sum + c.messageCount, 0)).toBe(2);
  });

  it("always pairs a filtered placement with a reason, and never otherwise", () => {
    const built = buildConversations([
      normalizeRow(sourceRow({ id: "1", from_msg: "noreply@evri.com", order_id: null }))!,
      normalizeRow(sourceRow({ id: "2", from_msg: "buyer@gmail.com", order_id: null }))!,
      normalizeRow(sourceRow({ id: "3", from_msg: "sales@supplier.invalid", order_id: null }))!,
    ]);
    for (const conversation of built.conversations) {
      expect(conversation.inboxPlacement === "filtered").toBe(
        conversation.inboxFilterReason !== null,
      );
    }
  });
});

describe("other marketplaces are untouched", () => {
  it("declares no filter rule outside Shopify", async () => {
    for (const path of ["ebay", "amazon", "bandq", "temu"]) {
      const builder = await import(`@/lib/marketplaces/${path}/thread-builder`);
      const rules = Object.values(builder).find(
        (v): v is { filterReasonOf?: unknown } =>
          typeof v === "object" && v !== null && "marketplace" in v,
      );
      if (rules) expect(rules.filterReasonOf).toBeUndefined();
    }
  });
});
