import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UNRESOLVED_REFERENCE_PREFIX } from "@/lib/domain/conversation-reference";
import {
  AMAZON_SOURCE,
  type AmazonSourceRow,
  directionFromSender,
  isPlatformNotice,
  normalizeRow,
  readBody,
  senderDomainOf,
} from "@/lib/marketplaces/amazon/adapter";
import { buildQuery, classifyRows } from "@/lib/marketplaces/amazon/message-repository";

/**
 * Synthetic values only. `00-00000-00000` is a placeholder, never a real order,
 * and the sender local-parts below are invented.
 */
function row(overrides: Partial<AmazonSourceRow> = {}): AmazonSourceRow {
  return {
    id: "1",
    message_id: "src-1",
    sub_source: 8,
    from_msg: "a1b2c3@marketplace.amazon.co.uk",
    from_name: "Alex",
    message_type: "General",
    order_id: "00-00000-00000",
    asin: "B000000001",
    message_date: "2026-08-18 05:18:16",
    message_content: "synthetic body",
    ...overrides,
  };
}

/** A CST reply: relayed back into the thread from the Amazon-side domain. */
function cstReply(overrides: Partial<AmazonSourceRow> = {}): AmazonSourceRow {
  return row({ from_msg: "relay@amazon.com", from_name: "Amazon.co.uk", ...overrides });
}

describe("direction comes from the sender fields", () => {
  it("maps the buyer relay domain to a customer message", () => {
    expect(directionFromSender(row())).toBe("inbound");
    expect(normalizeRow(row())!.direction).toBe("inbound");
  });

  it("maps the Amazon-side domain with the seller relay name to a CST reply", () => {
    expect(directionFromSender(cstReply())).toBe("outbound");
    expect(normalizeRow(cstReply())!.direction).toBe("outbound");
  });

  it("is case-insensitive on the domain and the relay name", () => {
    expect(directionFromSender(row({ from_msg: "X@MARKETPLACE.AMAZON.CO.UK" }))).toBe("inbound");
    expect(
      directionFromSender({ from_msg: "r@AMAZON.COM", from_name: "amazon.co.uk" }),
    ).toBe("outbound");
  });

  it("extracts the domain from the last @, not the first", () => {
    expect(senderDomainOf("odd@name@amazon.com")).toBe("amazon.com");
    expect(senderDomainOf("no-at-sign")).toBeNull();
    expect(senderDomainOf(null)).toBeNull();
  });
});

describe("nothing outside the rule is assigned a side", () => {
  it("rejects an unmapped sender rather than defaulting it", () => {
    // A personal name on the Amazon-side domain: 38 such rows exist and none
    // of them is covered by the rule.
    expect(directionFromSender({ from_msg: "someone@amazon.com", from_name: "Chris" })).toBeNull();
    expect(normalizeRow(row({ from_msg: "someone@amazon.com", from_name: "Chris" }))).toBeNull();
  });

  it("rejects an unknown domain entirely", () => {
    expect(directionFromSender({ from_msg: "a@example.invalid", from_name: "Alex" })).toBeNull();
    expect(directionFromSender({ from_msg: null, from_name: null })).toBeNull();
  });

  it("rejects a row with no account attribution", () => {
    expect(normalizeRow(row({ sub_source: null }))).toBeNull();
  });

  it("uses no field other than the two sender fields to decide direction", () => {
    // extraction_method is NOT a direction field: verified CST replies appear
    // under several values of it. It is not even selected. Neither the message
    // wording nor the sign-off name may influence direction.
    const source = readFileSync(
      join(__dirname, "..", "..", "lib", "marketplaces", "amazon", "adapter.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(source).not.toMatch(/extraction_method/);
    expect(source).not.toMatch(/signature|sign-off|regards/i);

    // Direction is stable no matter what the body or message type says.
    for (const content of ["Kind regards,\n\nKarthi", "Where is my order?", null]) {
      expect(normalizeRow(row({ message_content: content }))!.direction).toBe("inbound");
      expect(normalizeRow(cstReply({ message_content: content }))!.direction).toBe("outbound");
    }
    for (const type of ["General", "Return", "Cancellation", "Question", null]) {
      expect(normalizeRow(row({ message_type: type }))!.direction).toBe("inbound");
    }
  });
});

describe("platform notices are separated, not shown as a conversation", () => {
  const notice = row({
    from_msg: "no-reply@amazon.com",
    from_name: "Amazon Seller Central Notifications (Do Not Reply)",
  });

  it("recognises Amazon's own notice traffic", () => {
    expect(isPlatformNotice(notice)).toBe(true);
    expect(isPlatformNotice(row())).toBe(false);
    expect(isPlatformNotice(cstReply())).toBe(false);
  });

  it("keeps notices out of the messages, and counts them", () => {
    const result = classifyRows([row({ id: "1" }), cstReply({ id: "2" }), { ...notice, id: "3" }]);
    expect(result.rowsExamined).toBe(3);
    expect(result.messages).toHaveLength(2);
    expect(result.platformNoticeCount).toBe(1);
    expect(result.unusableCount).toBe(0);
    expect(result.messages.map((m) => m.sourcePk)).toEqual(["1", "2"]);
  });

  it("counts an unmapped row separately from a notice", () => {
    const result = classifyRows([
      { ...notice, id: "1" },
      row({ id: "2", from_msg: "someone@amazon.com", from_name: "Chris" }),
    ]);
    expect(result.platformNoticeCount).toBe(1);
    expect(result.unusableCount).toBe(1);
    expect(result.messages).toHaveLength(0);
  });
});

describe("conversation identity", () => {
  it("groups on the order reference, never the sender address", () => {
    // The address is a shared relay; grouping on it would merge customers.
    expect(normalizeRow(row())!.counterpartyRef).toBe("00-00000-00000");
    expect(normalizeRow(cstReply())!.counterpartyRef).toBe("00-00000-00000");
    const ungrouped = normalizeRow(row({ id: "77", order_id: null }))!;
    expect(ungrouped.counterpartyRef).toBe(`${UNRESOLVED_REFERENCE_PREFIX}77`);
  });

  it("carries the ASIN as an item reference, never as a SKU", () => {
    const normalized = normalizeRow(row())!;
    expect(normalized.listingItemRef).toBe("B000000001");
    expect(JSON.stringify(normalized).toLowerCase()).not.toContain("sku");
  });
});

describe("body handling", () => {
  it("treats the body as plain text, never as JSON", () => {
    expect(readBody("5")).toEqual({ text: "5", status: "decoded" });
    expect(readBody('"quoted"')).toEqual({ text: '"quoted"', status: "decoded" });
  });

  it("reports an absent or blank body as empty rather than failed", () => {
    expect(readBody(null)).toEqual({ text: null, status: "empty" });
    expect(normalizeRow(row({ message_content: null }))!.bodyDecodeStatus).toBe("empty");
  });
});

describe("timestamps and source identity", () => {
  it("carries the source timestamp through unchanged and unlabelled", () => {
    const normalized = normalizeRow(row({ message_date: "2026-08-18 23:59:59" }))!;
    expect(normalized.sourceTimestamp).toBe("2026-08-18 23:59:59");
    expect(JSON.stringify(normalized)).not.toMatch(/UTC|GMT|BST|Berlin/);
  });

  it("records the full source coordinates that make sync idempotent", () => {
    const normalized = normalizeRow(row({ id: "12345" }))!;
    expect(normalized.sourceDatabase).toBe(AMAZON_SOURCE.database);
    expect(normalized.sourceSchema).toBe(AMAZON_SOURCE.schema);
    expect(normalized.sourceTable).toBe(AMAZON_SOURCE.messageTable);
    expect(normalized.sourcePk).toBe("12345");
    expect(normalized.marketplace).toBe("amazon");
  });

  it("never exposes the sender address downstream", () => {
    // It decides direction and is then discarded: it is a shared relay, not a
    // customer identity, and it is personal data with no further use.
    const normalized = normalizeRow(row())!;
    expect(JSON.stringify(normalized)).not.toContain("marketplace.amazon.co.uk");
    expect(Object.keys(normalized.sourceMetadata).sort()).toEqual([
      "itemRef",
      "messageType",
      "orderRef",
    ]);
  });
});

describe("fetch query", () => {
  it("selects the two sender fields the direction rule needs", () => {
    const { text } = buildQuery({ window: { mode: "bootstrap", startAt: "2026-08-18" } });
    expect(text).toMatch(/m\.from_msg\s+AS from_msg/);
    expect(text).toMatch(/m\.from_name\s+AS from_name/);
  });

  it("selects no recipient column, which carries no information here", () => {
    const { text } = buildQuery({ window: { mode: "bootstrap", startAt: "2026-08-18" } });
    expect(text).not.toMatch(/to_msg|to_name/);
  });

  it("is bounded, parameterised and ordered by the shared intent", () => {
    const { text, values } = buildQuery({
      window: { mode: "bootstrap", startAt: "2026-08-18 00:00:00" },
      limit: 100,
    });
    expect(text).toContain("customer_service.amazon_messages");
    expect(text).toMatch(/WHERE m\.date >= \$1::timestamp/);
    expect(text).toMatch(/ORDER BY m\.date ASC, m\.id ASC/);
    expect(text).toMatch(/m\.date::text\s+AS message_date/);
    expect(values).toEqual(["2026-08-18 00:00:00", 100]);
  });

  it("issues only a SELECT", () => {
    const sql = buildQuery({ window: { mode: "bootstrap", startAt: "2026-08-18" } }).text.toUpperCase();
    for (const verb of ["INSERT", "UPDATE ", "DELETE", "TRUNCATE", "DROP ", "ALTER "]) {
      expect(sql).not.toContain(verb);
    }
  });
});
