import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPANY_EMAIL_DOMAINS,
  domainOf,
  isCompanyAddress,
  isCompanyDomain,
} from "@/lib/domain/company-domains";
import { UNRESOLVED_REFERENCE_PREFIX } from "@/lib/domain/conversation-reference";
import { unresolvedSourceMessageSchema } from "@/lib/domain/source-message";
import {
  SHOPIFY_SOURCE,
  type ShopifySourceRow,
  directionFromAddresses,
  normalizeAmbiguousRow,
  normalizeRow,
  readBody,
} from "@/lib/marketplaces/shopify/adapter";
import { buildQuery, classifyRows } from "@/lib/marketplaces/shopify/message-repository";
import {
  SHOPIFY_ORDER_THREAD_RULE,
  buildConversations,
} from "@/lib/marketplaces/shopify/thread-builder";

/** Synthetic values only. The external addresses below are invented. */
function row(overrides: Partial<ShopifySourceRow> = {}): ShopifySourceRow {
  return {
    id: "1",
    message_id: "src-1",
    sub_source: 104,
    from_msg: "buyer@example.invalid",
    to_msg: "support@ledsone.co.uk",
    subject: "Re: Order #LED60484",
    order_id: "LED60484",
    message_date: "2026-08-19 04:48:36",
    message_content: "synthetic body",
    ...overrides,
  };
}

/** A CST reply: from one of our domains out to an external address. */
function cstReply(overrides: Partial<ShopifySourceRow> = {}): ShopifySourceRow {
  return row({ from_msg: "support@ledsone.co.uk", to_msg: "buyer@example.invalid", ...overrides });
}

describe("company domain list", () => {
  it("matches a company domain exactly and on a dot boundary", () => {
    expect(isCompanyDomain("ledsone.co.uk")).toBe(true);
    // The platform sends on our behalf from subdomains; those are still us.
    expect(isCompanyDomain("mailernr9.ledsone.co.uk")).toBe(true);
    expect(isCompanyDomain("mailerqhy.ledsone.de")).toBe(true);
  });

  it("never matches on a substring", () => {
    for (const impostor of [
      "notledsone.co.uk",
      "ledsone.co.uk.example.invalid",
      "xledsone.de",
      "ledsone.co.uk.attacker.invalid",
    ]) {
      expect(isCompanyDomain(impostor)).toBe(false);
    }
  });

  it("treats consumer mail providers as external", () => {
    for (const external of ["gmail.com", "yahoo.com", "hotmail.co.uk", "shopify.com"]) {
      expect(isCompanyDomain(external)).toBe(false);
    }
  });

  it("extracts the domain from the last @, and handles absence", () => {
    expect(domainOf("odd@name@ledsone.co.uk")).toBe("ledsone.co.uk");
    expect(domainOf("Support <support@ledsone.co.uk>")).toBe("ledsone.co.uk");
    expect(domainOf("no-at-sign")).toBeNull();
    expect(domainOf(null)).toBeNull();
    expect(isCompanyAddress(null)).toBe(false);
  });

  it("lists every brand domain that receives customer mail", () => {
    for (const owned of [
      "ledsone.co.uk",
      "ledsone.de",
      "ledsone.fr",
      "ledsone.us",
      "dcvoltage.co.uk",
      "electricalsone.co.uk",
      "besbet.co.uk",
      "vintagelite.co.uk",
      "vintageinterior.co.uk",
    ]) {
      expect(COMPANY_EMAIL_DOMAINS).toContain(owned);
    }
  });
});

describe("direction comes from the two addresses", () => {
  it("maps external -> company to a customer message", () => {
    expect(directionFromAddresses(row())).toBe("inbound");
    expect(normalizeRow(row())!.direction).toBe("inbound");
  });

  it("maps company -> external to a CST reply", () => {
    expect(directionFromAddresses(cstReply())).toBe("outbound");
    expect(normalizeRow(cstReply())!.direction).toBe("outbound");
  });

  it("puts a signed CST reply on the outbound side, from the addresses alone", () => {
    // The regression this rule exists to fix: bodies like this were previously
    // rendered as customer messages. Direction must not depend on the wording.
    const signed = cstReply({
      message_content: "Hi,\n\nThank you for your message.\n\nKind regards,\n\nZara",
    });
    expect(normalizeRow(signed)!.direction).toBe("outbound");

    // ...and the identical body from an external sender stays inbound.
    const sameBodyInbound = row({
      message_content: "Hi,\n\nThank you for your message.\n\nKind regards,\n\nZara",
    });
    expect(normalizeRow(sameBodyInbound)!.direction).toBe("inbound");
  });

  it("uses no field other than the two addresses", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "marketplaces", "shopify", "adapter.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(source).not.toMatch(/extraction_method/);
    expect(source).not.toMatch(/from_name|to_name/);
  });
});

describe("ambiguous messages are kept, never guessed", () => {
  const bothOurs = row({ from_msg: "a@ledsone.co.uk", to_msg: "b@ledsone.de" });
  const neitherOurs = row({ from_msg: "a@example.invalid", to_msg: "b@other.invalid" });
  const noRecipient = row({ to_msg: null });

  it("refuses to decide when both sides are ours", () => {
    expect(directionFromAddresses(bothOurs)).toBeNull();
    expect(normalizeRow(bothOurs)).toBeNull();
  });

  it("refuses to decide when neither side is ours", () => {
    expect(directionFromAddresses(neitherOurs)).toBeNull();
  });

  it("refuses to decide when an address is missing", () => {
    expect(directionFromAddresses(noRecipient)).toBeNull();
    expect(directionFromAddresses({ from_msg: null, to_msg: "a@ledsone.co.uk" })).toBeNull();
  });

  it("routes them to the no-direction shape, which has no side to read", () => {
    const ambiguous = normalizeAmbiguousRow(bothOurs);
    expect(ambiguous).not.toHaveProperty("direction");
    expect(ambiguous).not.toHaveProperty("counterpartyRef");
    expect(JSON.stringify(ambiguous).toLowerCase()).not.toContain("inbound");
    expect(() => unresolvedSourceMessageSchema.parse(ambiguous)).not.toThrow();
  });

  it("accounts for every row across the split", () => {
    const result = classifyRows([
      row({ id: "1" }),
      cstReply({ id: "2" }),
      { ...bothOurs, id: "3" },
      { ...neitherOurs, id: "4" },
      { ...noRecipient, id: "5" },
      row({ id: "6", sub_source: null }),
    ]);
    expect(result.rowsExamined).toBe(6);
    expect(result.messages).toHaveLength(2);
    expect(result.ambiguous).toHaveLength(3);
    expect(result.unusableCount).toBe(1);
    expect(result.messages.length + result.ambiguous.length + result.unusableCount).toBe(6);
  });
});

describe("threading", () => {
  it("groups a customer message and its reply under one order reference", () => {
    const { conversations } = buildConversations([
      normalizeRow(row({ id: "1" }))!,
      normalizeRow(cstReply({ id: "2", message_date: "2026-08-19 05:00:00" }))!,
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      marketplace: "shopify",
      threadingRuleVersion: SHOPIFY_ORDER_THREAD_RULE,
      messageCount: 2,
      inboundCount: 1,
      outboundCount: 1,
      inboxPlacement: "reply_inbox",
    });
  });

  it("gives a message with no reference its own conversation", () => {
    const { conversations } = buildConversations([
      normalizeRow(row({ id: "9", order_id: null }))!,
    ]);
    expect(conversations[0]!.counterpartyRef).toBe(`${UNRESOLVED_REFERENCE_PREFIX}9`);
    expect(conversations[0]!.needsContext).toBe(true);
  });

  it("keeps a reply-only thread out of the customer reply inbox", () => {
    const { conversations } = buildConversations([normalizeRow(cstReply({ id: "3" }))!]);
    expect(conversations[0]!.inboxPlacement).toBe("outbound_only");
  });
});

describe("no fabricated identity or context", () => {
  it("never puts an email address into the conversation reference", () => {
    const normalized = normalizeRow(row())!;
    expect(normalized.counterpartyRef).toBe("LED60484");
    expect(JSON.stringify(normalized)).not.toContain("example.invalid");
    expect(JSON.stringify(normalized)).not.toContain("ledsone.co.uk");
  });

  it("claims no listing or item reference, because the source has none", () => {
    expect(normalizeRow(row())!.listingItemRef).toBeNull();
  });

  it("carries the source timestamp through unchanged and unlabelled", () => {
    const normalized = normalizeRow(row({ message_date: "2026-08-19 23:59:59" }))!;
    expect(normalized.sourceTimestamp).toBe("2026-08-19 23:59:59");
    expect(JSON.stringify(normalized)).not.toMatch(/UTC|GMT|BST|Berlin/);
  });

  it("records the full source coordinates that make sync idempotent", () => {
    const normalized = normalizeRow(row({ id: "4321" }))!;
    expect(normalized.sourceDatabase).toBe(SHOPIFY_SOURCE.database);
    expect(normalized.sourceTable).toBe(SHOPIFY_SOURCE.messageTable);
    expect(normalized.sourcePk).toBe("4321");
    expect(normalized.marketplace).toBe("shopify");
  });
});

describe("body handling", () => {
  it("treats the body as plain text, never as JSON", () => {
    expect(readBody("5")).toEqual({ text: "5", status: "decoded" });
  });

  it("reports an absent or blank body as empty rather than failed", () => {
    expect(readBody(null)).toEqual({ text: null, status: "empty" });
    expect(readBody("   ")).toEqual({ text: null, status: "empty" });
  });
});

describe("fetch query", () => {
  it("selects both addresses, which are the direction rule", () => {
    const { text } = buildQuery({ window: { mode: "bootstrap", startAt: "2026-08-19" } });
    expect(text).toMatch(/m\.from_msg\s+AS from_msg/);
    expect(text).toMatch(/m\.to_msg\s+AS to_msg/);
  });

  it("selects no display-name column", () => {
    const { text } = buildQuery({ window: { mode: "bootstrap", startAt: "2026-08-19" } });
    expect(text).not.toMatch(/from_name|to_name/);
  });

  it("is bounded, parameterised and ordered by the shared intent", () => {
    const { text, values } = buildQuery({
      window: { mode: "bootstrap", startAt: "2026-08-19 00:00:00" },
      limit: 250,
    });
    expect(text).toContain("customer_service.shopify_messages");
    expect(text).toMatch(/WHERE m\.date >= \$1::timestamp/);
    expect(text).toMatch(/ORDER BY m\.date ASC, m\.id ASC/);
    expect(text).toMatch(/m\.date::text\s+AS message_date/);
    expect(values).toEqual(["2026-08-19 00:00:00", 250]);
  });
});
